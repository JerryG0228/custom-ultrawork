#!/usr/bin/env node
// Stop hook: refuses the stop while the ulw-loop plan still has an incomplete goal,
// so the agent is pushed back into the loop instead of ending mid-plan.
//
// LIMIT -- this is pressure, not a cage. Claude Code stops honouring a Stop hook's
// `block` after 8 consecutive blocks in one turn chain and exits anyway (that ceiling
// is what keeps a buggy hook from wedging a session). So the hook buys at most 8
// returns to the loop; it can never force convergence. `stop_hook_active` is the
// same safety valve one level up: it is true when we are already inside a
// hook-triggered continuation, and we pass immediately on it so the hook can never
// re-block its own continuation.
//
// Any failure in here passes the stop through. A broken hook must not trap a user.

import { essentialCriteriaOf, readPlan, resolveRepoRoot, resolveSessionIdFromEnv } from "../bin/ulw-loop-core.mjs";

/**
 * Same scope resolution as mcp/ulw-goal-server.mjs: unscoped `.omo/ulw-loop/` unless a
 * session id is exported in the environment. Claude Code's own `session_id` is
 * deliberately NOT used -- the MCP server that writes the plan never sees it, and a
 * hook reading a different directory than the writer would block on nothing.
 */
export function resolveScope(env = process.env) {
	return { sessionId: resolveSessionIdFromEnv(env) };
}

/**
 * @param {unknown} input Stop hook event payload
 * @param {{cwd?: string, env?: NodeJS.ProcessEnv}} [options]
 * @returns {string} hook stdout ("" means: let the stop through)
 */
export function runStopHook(input, options = {}) {
	if (!isRecord(input)) return "";
	if (input.stop_hook_active === true) return "";

	const cwd = typeof input.cwd === "string" && input.cwd.length > 0 ? input.cwd : (options.cwd ?? process.cwd());
	let plan;
	try {
		plan = readPlan(resolveRepoRoot(cwd), resolveScope(options.env ?? process.env));
	} catch {
		// No plan, unreadable plan, corrupt JSON -- nothing to enforce.
		return "";
	}

	// ponytail: "not complete" is the whole rule -- failed / blocked / needs_user_decision
	// block the stop too, even though needs_user_decision is exactly the state where
	// handing control back to the user is the right move. The 8-block ceiling caps the
	// damage. Add a terminal-status allowlist here if that turns out to annoy in practice.
	const incomplete = (plan.goals ?? []).filter((goal) => goal.status !== "complete");
	if (incomplete.length === 0) return "";

	return `${JSON.stringify({ decision: "block", reason: buildReason(incomplete) })}\n`;
}

/** Human-readable: which goals are open and which criteria are still unproven. */
export function buildReason(incompleteGoals) {
	const lines = [
		`ultrawork: ${incompleteGoals.length} goal(s) in the ulw-loop plan are not complete. Do not stop -- return to the loop and finish them.`,
		"",
	];
	for (const goal of incompleteGoals) {
		lines.push(`- ${goal.id} [${goal.status}] ${goal.title ?? ""}`.trimEnd());
		const unmet = essentialCriteriaOf(goal).filter((criterion) => criterion.status !== "pass");
		if (unmet.length === 0) {
			lines.push("    essential criteria all pass; call complete_goal with the evidence.");
			continue;
		}
		lines.push("    unmet success criteria:");
		for (const criterion of unmet) {
			lines.push(`      - ${criterion.id} [${criterion.status}] ${criterion.scenario}`);
			if (criterion.expectedEvidence) lines.push(`        expected evidence: ${criterion.expectedEvidence}`);
		}
	}
	lines.push(
		"",
		"Capture the missing evidence, then mark each goal done with the ulw `complete_goal` MCP tool (or `ulw-loop complete-goal --goal-id <id> --evidence \"...\"`).",
	);
	return lines.join("\n");
}

function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJsonLine(line) {
	if (line.trim().length === 0) return null;
	try {
		return JSON.parse(line);
	} catch {
		return null;
	}
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const chunks = [];
	for await (const chunk of process.stdin) chunks.push(chunk);
	try {
		process.stdout.write(runStopHook(parseJsonLine(Buffer.concat(chunks).toString("utf8"))));
	} catch {
		// Never block on a hook bug.
	}
}
