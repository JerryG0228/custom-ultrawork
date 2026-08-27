#!/usr/bin/env node
// stdio MCP server exposing the ulw-loop goal state machine as create_goal /
// get_goal / complete_goal.
//
// No SDK: MCP's stdio transport is newline-delimited JSON-RPC 2.0 on stdin/stdout,
// so the whole transport is `readline` + `JSON.stringify`. JSON.stringify never
// emits a raw newline inside a string, which is exactly the framing invariant the
// transport requires. Anything written to stdout that is not a JSON-RPC message
// would corrupt the stream -- diagnostics go to stderr only.
//
// All goal logic is imported from ../bin/ulw-loop-core.mjs; this file is transport
// plus argument marshalling.

import { createInterface } from "node:readline";

import {
	completeGoal,
	createGoal,
	getGoal,
	resolveRepoRoot,
	resolveSessionIdFromEnv,
	summarizePlan,
	readPlan,
	UlwError,
} from "../bin/ulw-loop-core.mjs";

const SERVER_INFO = { name: "ulw-goal", version: "0.1.0" };
// Fallback only. The negotiated version is whatever the client asked for -- a
// schema-less server has nothing to break across revisions.
const DEFAULT_PROTOCOL_VERSION = "2025-06-18";

/**
 * Plan location. MCP servers get no session id from the host, so the plan lives at
 * the unscoped `.omo/ulw-loop/` unless OMO_ULW_LOOP_SESSION_ID (or a CODEX_* id) is
 * exported into the environment. The Stop hook resolves scope the same way, which is
 * what keeps the two halves pointed at the same goals.json.
 */
export function resolveScope(env = process.env) {
	return { sessionId: resolveSessionIdFromEnv(env) };
}

const TOOLS = [
	{
		name: "create_goal",
		description:
			"Create an ultrawork goal with seeded success criteria (happy / edge / regression) in .omo/ulw-loop/goals.json. Creates the plan file on first call.",
		inputSchema: {
			type: "object",
			properties: {
				title: { type: "string", description: "Short goal title; also seeds the goal id." },
				objective: { type: "string", description: "What done looks like. Defaults to the title." },
				brief: { type: "string", description: "Plan-wide brief. Only used when the plan is created." },
			},
			required: ["title"],
			additionalProperties: false,
		},
	},
	{
		name: "get_goal",
		description: "Read one goal by id, including its success criteria and their captured evidence.",
		inputSchema: {
			type: "object",
			properties: { goal_id: { type: "string", description: "Goal id, e.g. G001-add-login." } },
			required: ["goal_id"],
			additionalProperties: false,
		},
	},
	{
		name: "complete_goal",
		description:
			"Mark a goal complete and bind its evidence directory to HEAD's git tree hash so a later audit can call the evidence stale. A pending goal is started implicitly first.",
		inputSchema: {
			type: "object",
			properties: {
				goal_id: { type: "string", description: "Goal id to complete." },
				evidence: { type: "string", description: "Observable proof the goal is done." },
			},
			required: ["goal_id", "evidence"],
			additionalProperties: false,
		},
	},
];

function callTool(name, args) {
	const repoRoot = resolveRepoRoot();
	const scope = resolveScope();
	switch (name) {
		case "create_goal": {
			const { goal, plan, planCreated } = createGoal(
				repoRoot,
				{ title: args.title, objective: args.objective, brief: args.brief },
				scope,
			);
			return { planCreated, goal, summary: summarizePlan(plan) };
		}
		case "get_goal":
			return { goal: getGoal(repoRoot, args.goal_id, scope) };
		case "complete_goal": {
			const { goal, evidenceBinding } = completeGoal(
				repoRoot,
				{ goalId: args.goal_id, evidence: args.evidence },
				scope,
			);
			return { goal, evidenceBinding, summary: summarizePlan(readPlan(repoRoot, scope)) };
		}
		default:
			return null;
	}
}

const textResult = (payload, isError = false) => ({
	content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
	...(isError ? { isError: true } : {}),
});

/**
 * @param {unknown} message one parsed JSON-RPC message
 * @returns {object | null} the response to write, or null for notifications
 */
export function handleMessage(message) {
	if (typeof message !== "object" || message === null || Array.isArray(message)) {
		return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } };
	}
	const { id, method, params } = message;
	// Notifications (no id) never get a response -- notifications/initialized included.
	if (id === undefined || id === null) return null;

	switch (method) {
		case "initialize":
			return {
				jsonrpc: "2.0",
				id,
				result: {
					protocolVersion:
						typeof params?.protocolVersion === "string" ? params.protocolVersion : DEFAULT_PROTOCOL_VERSION,
					capabilities: { tools: {} },
					serverInfo: SERVER_INFO,
				},
			};
		case "ping":
			return { jsonrpc: "2.0", id, result: {} };
		case "tools/list":
			return { jsonrpc: "2.0", id, result: { tools: TOOLS } };
		case "tools/call": {
			const name = params?.name;
			const args = params?.arguments ?? {};
			try {
				const payload = callTool(name, args);
				if (payload === null) {
					return { jsonrpc: "2.0", id, error: { code: -32602, message: `Unknown tool: ${name}` } };
				}
				return { jsonrpc: "2.0", id, result: textResult(payload) };
			} catch (error) {
				// Tool-level failures come back as isError content, not a JSON-RPC error, so
				// the model sees the message and can correct itself.
				return {
					jsonrpc: "2.0",
					id,
					result: textResult(
						{
							ok: false,
							code: error instanceof UlwError ? error.code : "ULW_LOOP_UNEXPECTED",
							message: error.message,
							...(error instanceof UlwError ? { details: error.details } : {}),
						},
						true,
					),
				};
			}
		}
		default:
			return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } };
	}
}

export function serve({ input = process.stdin, output = process.stdout } = {}) {
	// The host can close the pipe mid-write (it exited, or stopped reading). There is
	// nobody left to tell, so swallow it instead of dying on an unhandled EPIPE.
	// stdin closing right after is what actually ends the process.
	output.on("error", () => {});
	const lines = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
	lines.on("line", (line) => {
		if (line.trim().length === 0) return;
		let message;
		try {
			message = JSON.parse(line);
		} catch {
			output.write(`${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } })}\n`);
			return;
		}
		const response = handleMessage(message);
		if (response !== null) output.write(`${JSON.stringify(response)}\n`);
	});
	return lines;
}

if (import.meta.url === `file://${process.argv[1]}`) serve();
