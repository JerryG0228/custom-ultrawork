// Integration: the stdio MCP server and the Stop hook, both driven as real child
// processes over their real transports (JSON-RPC on stdin/stdout, hook JSON on
// stdin/stdout). Everything runs in a mkdtemp sandbox outside any git repo.

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { completeGoal, createGoal } from "../bin/ulw-loop-core.mjs";
import { resolveScope } from "../hooks-handlers/on-stop.mjs";

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MCP_SERVER = join(PLUGIN_ROOT, "mcp", "ulw-goal-server.mjs");
const STOP_HOOK = join(PLUGIN_ROOT, "hooks-handlers", "on-stop.mjs");

// The server and the hook both resolve scope from the environment; the test writes
// plans through the same resolution so all three agree on the plan path.
const SCOPE = resolveScope(process.env);

const sandboxes = [];
function sandbox() {
	const dir = mkdtempSync(join(tmpdir(), "ulw-integration-"));
	sandboxes.push(dir);
	return dir;
}
after(() => {
	for (const dir of sandboxes) rmSync(dir, { recursive: true, force: true });
});

/**
 * Writes newline-delimited JSON-RPC to a freshly spawned server, closes stdin, and
 * returns every parsed message it wrote back.
 */
function mcpExchange(cwd, requests) {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [MCP_SERVER], { cwd, stdio: ["pipe", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		child.on("error", reject);
		child.on("close", (code) => {
			const responses = stdout
				.split("\n")
				.filter((line) => line.trim().length > 0)
				.map((line) => JSON.parse(line));
			resolve({ code, responses, stderr });
		});
		for (const request of requests) child.stdin.write(`${JSON.stringify(request)}\n`);
		child.stdin.end();
	});
}

function runStopHookProcess(payload, cwd) {
	return execFileSync(process.execPath, [STOP_HOOK], {
		cwd,
		input: JSON.stringify(payload),
		encoding: "utf8",
	});
}

const stopPayload = (cwd, stopHookActive) => ({
	session_id: "test-session",
	transcript_path: join(cwd, "transcript.jsonl"),
	cwd,
	hook_event_name: "Stop",
	stop_hook_active: stopHookActive,
});

describe("ulw-goal MCP server", () => {
	test("initialize -> tools/list -> create_goal -> get_goal -> complete_goal -> get_goal", async () => {
		const dir = sandbox();
		const { code, responses, stderr } = await mcpExchange(dir, [
			{
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
				params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "ulw-test", version: "1.0" } },
			},
			{ jsonrpc: "2.0", method: "notifications/initialized" },
			{ jsonrpc: "2.0", id: 2, method: "tools/list" },
			{
				jsonrpc: "2.0",
				id: 3,
				method: "tools/call",
				params: { name: "create_goal", arguments: { title: "Add login", objective: "Users can sign in with email" } },
			},
			{ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "get_goal", arguments: { goal_id: "G001-add-login" } } },
			{
				jsonrpc: "2.0",
				id: 5,
				method: "tools/call",
				params: { name: "complete_goal", arguments: { goal_id: "G001-add-login", evidence: "login e2e passes" } },
			},
			{ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "get_goal", arguments: { goal_id: "G001-add-login" } } },
		]);

		assert.equal(code, 0, `server exited ${code}: ${stderr}`);
		assert.equal(stderr, "", "server must keep stdout/stderr clean of diagnostics");

		const byId = new Map(responses.map((response) => [response.id, response]));
		// The notification must not produce a response.
		assert.equal(responses.length, 6, `expected 6 responses, got ${responses.length}`);
		for (const response of responses) assert.equal(response.jsonrpc, "2.0");

		const init = byId.get(1);
		assert.equal(init.result.serverInfo.name, "ulw-goal");
		assert.equal(init.result.protocolVersion, "2025-06-18");
		assert.deepEqual(init.result.capabilities, { tools: {} });

		const names = byId.get(2).result.tools.map((tool) => tool.name);
		assert.deepEqual(names.sort(), ["complete_goal", "create_goal", "get_goal"]);
		for (const tool of byId.get(2).result.tools) {
			assert.equal(tool.inputSchema.type, "object", `${tool.name} needs an object inputSchema`);
			assert.ok(tool.description.length > 0, `${tool.name} needs a description`);
		}

		const parse = (id) => {
			const response = byId.get(id);
			assert.ok(response.result !== undefined, `id ${id} returned an error: ${JSON.stringify(response.error)}`);
			assert.notEqual(response.result.isError, true, `id ${id} returned isError: ${response.result.content[0].text}`);
			assert.equal(response.result.content[0].type, "text");
			return JSON.parse(response.result.content[0].text);
		};

		const created = parse(3);
		assert.equal(created.planCreated, true);
		assert.equal(created.goal.id, "G001-add-login");
		assert.equal(created.goal.status, "pending");
		assert.equal(created.goal.successCriteria.length, 3);

		assert.equal(parse(4).goal.status, "pending");

		const completed = parse(5);
		assert.equal(completed.goal.status, "complete");
		assert.equal(completed.evidenceBinding.dir, `.omo/evidence/ulw/session/G001-add-login/a1`);
		assert.equal(completed.summary.complete, 1);

		const after = parse(6).goal;
		assert.equal(after.status, "complete");
		assert.equal(after.evidence, "login e2e passes");

		// And it really landed on disk, in the layout the Stop hook reads.
		const plan = JSON.parse(readFileSync(join(dir, ".omo", "ulw-loop", "goals.json"), "utf8"));
		assert.equal(plan.goals[0].status, "complete");
	});

	test("a failing tool call comes back as isError content, an unknown tool as a JSON-RPC error", async () => {
		const dir = sandbox();
		const { responses } = await mcpExchange(dir, [
			{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_goal", arguments: { goal_id: "G404-nope" } } },
			{ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "not_a_tool", arguments: {} } },
			{ jsonrpc: "2.0", id: 3, method: "no/such/method" },
		]);
		const byId = new Map(responses.map((response) => [response.id, response]));

		assert.equal(byId.get(1).result.isError, true);
		assert.equal(JSON.parse(byId.get(1).result.content[0].text).code, "ULW_LOOP_PLAN_MISSING");
		assert.equal(byId.get(2).error.code, -32602);
		assert.equal(byId.get(3).error.code, -32601);
	});
});

describe("Stop hook", () => {
	test("blocks the stop while a goal is incomplete, and names the unmet criteria", () => {
		const dir = sandbox();
		createGoal(dir, { title: "Add login", objective: "Users can sign in with email" }, SCOPE);

		const stdout = runStopHookProcess(stopPayload(dir, false), dir);
		const decision = JSON.parse(stdout);

		assert.equal(decision.decision, "block");
		assert.match(decision.reason, /G001-add-login/);
		assert.match(decision.reason, /\[pending\]/);
		assert.match(decision.reason, /C001/);
		assert.match(decision.reason, /C002/);
		// C003 is the non-essential regression criterion; essentialCriteriaOf() drops it.
		assert.doesNotMatch(decision.reason, /C003/);
	});

	test("stop_hook_active passes through even with the same incomplete plan", () => {
		const dir = sandbox();
		createGoal(dir, { title: "Add login", objective: "Users can sign in with email" }, SCOPE);

		assert.equal(runStopHookProcess(stopPayload(dir, true), dir).trim(), "");
	});

	test("every goal complete passes through", () => {
		const dir = sandbox();
		createGoal(dir, { title: "Add login", objective: "Users can sign in with email" }, SCOPE);
		createGoal(dir, { title: "Add logout", objective: "Users can sign out" }, SCOPE);
		completeGoal(dir, { goalId: "G001-add-login", evidence: "login e2e passes" }, SCOPE);
		completeGoal(dir, { goalId: "G002-add-logout", evidence: "logout e2e passes" }, SCOPE);

		assert.equal(runStopHookProcess(stopPayload(dir, false), dir).trim(), "");
	});

	test("no plan at all passes through", () => {
		assert.equal(runStopHookProcess(stopPayload(sandbox(), false), sandbox()).trim(), "");
	});
});

describe("plugin wiring", () => {
	test("hooks.json keeps UserPromptSubmit and adds Stop", () => {
		const hooks = JSON.parse(readFileSync(join(PLUGIN_ROOT, "hooks", "hooks.json"), "utf8")).hooks;
		assert.deepEqual(Object.keys(hooks).sort(), ["Stop", "UserPromptSubmit"]);
		assert.match(hooks.UserPromptSubmit[0].hooks[0].command, /on-user-prompt-submit\.mjs$/);
		assert.match(hooks.Stop[0].hooks[0].command, /on-stop\.mjs$/);
		for (const entries of Object.values(hooks)) {
			assert.equal(entries[0].hooks[0].type, "command");
			assert.match(entries[0].hooks[0].command, /^node \$\{CLAUDE_PLUGIN_ROOT\}\//);
		}
	});

	test("plugin.json registers the MCP server and no placeholder .mcp.json survives", () => {
		const plugin = JSON.parse(readFileSync(join(PLUGIN_ROOT, ".claude-plugin", "plugin.json"), "utf8"));
		assert.deepEqual(Object.keys(plugin.mcpServers), ["ulw-goal"]);
		assert.equal(plugin.mcpServers["ulw-goal"].command, "node");
		assert.deepEqual(plugin.mcpServers["ulw-goal"].args, ["${CLAUDE_PLUGIN_ROOT}/mcp/ulw-goal-server.mjs"]);
		assert.throws(() => readFileSync(join(PLUGIN_ROOT, ".mcp.json"), "utf8"), /ENOENT/);
	});
});
