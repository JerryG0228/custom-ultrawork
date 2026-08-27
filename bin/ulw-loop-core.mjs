// ulw-loop-core.mjs — goal state machine + evidence audit over `.omo/ulw-loop/`.
//
// On-disk format is compatible with @code-yeongyu/codex-ulw-loop 5.0.0-beta.22
// (packages/omo-codex/plugin/components/ulw-loop): same `goals.json` plan shape,
// same `ledger.jsonl` event kinds, same session scoping and evidence dir layout.
//
// Added on top of the original: `evidenceBinding` on a goal, pinning its evidence
// to `git rev-parse --short HEAD^{tree}` at completion time so `audit` can call it
// stale once HEAD's tree moves. Unknown fields survive the JSON round-trip, so the
// original CLI still reads plans this module wrote.
//
// Sync + no lock: this is a single-process CLI / stdio MCP server.
// ponytail: writes are tmp+rename (atomic); add a lockfile only if two hosts ever
// mutate the same plan concurrently.

import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const ULW_DIR = ".omo/ulw-loop";
export const ULW_BRIEF = "brief.md";
export const ULW_GOALS = "goals.json";
export const ULW_LEDGER = "ledger.jsonl";

export const ULW_STATUSES = [
	"pending",
	"in_progress",
	"complete",
	"failed",
	"blocked",
	"review_blocked",
	"needs_user_decision",
];
export const ULW_CRITERION_STATUSES = ["pending", "pass", "fail", "blocked"];
export const ULW_USER_MODELS = ["happy", "edge", "regression", "adversarial"];

const SESSION_ENV_KEYS = ["OMO_ULW_LOOP_SESSION_ID", "CODEX_SESSION_ID", "CODEX_THREAD_ID", "PI_SESSION_ID"];

export class UlwError extends Error {
	constructor(message, code, details = {}) {
		super(message);
		this.name = "UlwError";
		this.code = code;
		this.details = details;
	}
}

const iso = () => new Date().toISOString();

// ---------------------------------------------------------------- paths

/** Mirrors normalizeUlwLoopSessionId() in the original paths.ts. */
export function normalizeSessionId(sessionId) {
	const trimmed = typeof sessionId === "string" ? sessionId.trim() : "";
	if (!trimmed) return null;
	const segments = trimmed.split(/[\\/]+/).filter((s) => s.length > 0 && s !== "." && s !== "..");
	const candidate = (segments.length > 0 ? segments.join("-") : trimmed)
		.replace(/[^A-Za-z0-9._-]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^\.+/, "")
		.replace(/^[.-]+|[.-]+$/g, "");
	return candidate.length > 0 ? candidate : null;
}

export function resolveSessionIdFromEnv(env = process.env) {
	for (const key of SESSION_ENV_KEYS) {
		const normalized = normalizeSessionId(env[key]);
		if (normalized !== null) return normalized;
	}
	return null;
}

export function ulwRelativeDir(scope) {
	const sessionId = normalizeSessionId(scope?.sessionId);
	return sessionId === null ? ULW_DIR : `${ULW_DIR}/${sessionId}`;
}

export const ulwDir = (repoRoot, scope) => join(repoRoot, ulwRelativeDir(scope));
export const goalsRelativePath = (scope) => `${ulwRelativeDir(scope)}/${ULW_GOALS}`;
export const ledgerRelativePath = (scope) => `${ulwRelativeDir(scope)}/${ULW_LEDGER}`;
export const briefRelativePath = (scope) => `${ulwRelativeDir(scope)}/${ULW_BRIEF}`;
export const goalsPath = (repoRoot, scope) => join(repoRoot, goalsRelativePath(scope));
export const ledgerPath = (repoRoot, scope) => join(repoRoot, ledgerRelativePath(scope));
export const briefPath = (repoRoot, scope) => join(repoRoot, briefRelativePath(scope));

/** `.omo/evidence/ulw/<sessionId>/<goalId>/a<attempt>` — same layout as the original. */
export function attemptEvidenceDir(goalId, attempt, scope, env = process.env) {
	const sessionId = normalizeSessionId(scope?.sessionId) ?? resolveSessionIdFromEnv(env) ?? "session";
	return `.omo/evidence/ulw/${sessionId}/${goalId}/a${attempt}`;
}

export function aggregateCodexObjective(scope) {
	return `Complete the durable ulw-loop plan in ${goalsRelativePath(scope)}, including later accepted/appended stories, under the original brief constraints; use ${ledgerRelativePath(scope)} as the audit trail.`;
}

// ---------------------------------------------------------------- git

function git(repoRoot, args) {
	try {
		const r = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8" });
		if (r.error || r.status !== 0) return null;
		return r.stdout.trim() || null;
	} catch {
		return null;
	}
}

/**
 * Short tree hash of HEAD's commit, or null outside a git repo / with no commits /
 * with git unavailable. Never throws — evidence binding degrades to "unverifiable".
 */
export const currentTreeHash = (repoRoot) => git(repoRoot, ["rev-parse", "--short", "HEAD^{tree}"]);

export const resolveRepoRoot = (cwd = process.cwd()) => git(cwd, ["rev-parse", "--show-toplevel"]) ?? cwd;

// ---------------------------------------------------------------- plan io

export function readPlan(repoRoot, scope) {
	const path = goalsPath(repoRoot, scope);
	let raw;
	try {
		raw = readFileSync(path, "utf8");
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
		throw new UlwError(
			`No ulw-loop plan found at ${goalsRelativePath(scope)}. Run \`ulw-loop create-goal ...\` first.`,
			"ULW_LOOP_PLAN_MISSING",
			{ path: goalsRelativePath(scope) },
		);
	}
	const plan = JSON.parse(raw);
	if (plan.version !== 1 || !Array.isArray(plan.goals)) {
		throw new UlwError(`Invalid ulw-loop plan at ${goalsRelativePath(scope)}.`, "ULW_LOOP_PLAN_INVALID", {
			path: goalsRelativePath(scope),
		});
	}
	return plan;
}

export function writePlan(repoRoot, plan, scope) {
	mkdirSync(ulwDir(repoRoot, scope), { recursive: true });
	const path = goalsPath(repoRoot, scope);
	const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
	renameSync(tmp, path);
}

export function appendLedger(repoRoot, entry, scope) {
	mkdirSync(ulwDir(repoRoot, scope), { recursive: true });
	appendFileSync(ledgerPath(repoRoot, scope), `${JSON.stringify(entry)}\n`, "utf8");
}

export function readLedger(repoRoot, scope) {
	let raw;
	try {
		raw = readFileSync(ledgerPath(repoRoot, scope), "utf8");
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
		return [];
	}
	return raw
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line));
}

// ---------------------------------------------------------------- goal factory

function nonEmpty(value, label) {
	const trimmed = typeof value === "string" ? value.trim() : "";
	if (!trimmed) throw new UlwError(`Missing ${label}.`, "ULW_LOOP_ARGUMENT_MISSING", { label });
	return trimmed;
}

const normalizeObjective = (value) => value.replace(/\s+/g, " ").trim();

function goalIdFor(title, index) {
	const slug = title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 36)
		.replace(/-+$/g, "");
	return `G${String(index + 1).padStart(3, "0")}${slug ? `-${slug}` : ""}`;
}

/** Same three seeded criteria the original emits (C001 happy / C002 edge / C003 regression). */
export function seedSuccessCriteria(goalIndex, objective) {
	const full = normalizeObjective(objective) || `Goal ${goalIndex + 1}`;
	const subject = full.length > 80 ? `${full.slice(0, 77).trimEnd()}...` : full;
	return [
		["C001", "happy", `happy path for: ${subject}`, `Replace via revise_criterion with observable happy-path proof for goal ${goalIndex + 1}.`, true],
		["C002", "edge", "edge case (boundary/empty/malformed)", `Replace via revise_criterion with boundary or malformed-input proof for: ${subject}.`, true],
		["C003", "regression", "regression: adjacent surface still works", `Replace via revise_criterion with regression proof for neighboring behavior after: ${subject}.`, false],
	].map(([id, userModel, scenario, expectedEvidence, essential]) => ({
		id,
		scenario,
		userModel,
		expectedEvidence,
		essential,
		capturedEvidence: null,
		status: "pending",
	}));
}

function emptyPlan(now, scope) {
	return {
		version: 1,
		evidenceLayoutVersion: 2,
		createdAt: now,
		updatedAt: now,
		briefPath: briefRelativePath(scope),
		goalsPath: goalsRelativePath(scope),
		ledgerPath: ledgerRelativePath(scope),
		codexGoalMode: "aggregate",
		goals: [],
		codexObjective: aggregateCodexObjective(scope),
	};
}

// ---------------------------------------------------------------- commands

/** Creates the plan on first call, then appends one goal. */
export function createGoal(repoRoot, args, scope) {
	const title = nonEmpty(args.title, "title");
	const objective = nonEmpty(args.objective ?? args.title, "objective");
	const now = iso();
	let plan;
	let planCreated = false;
	try {
		plan = readPlan(repoRoot, scope);
	} catch (error) {
		if (error.code !== "ULW_LOOP_PLAN_MISSING") throw error;
		plan = emptyPlan(now, scope);
		planCreated = true;
	}
	if (planCreated) {
		mkdirSync(ulwDir(repoRoot, scope), { recursive: true });
		writeFileSync(briefPath(repoRoot, scope), `${args.brief?.trim() || objective}\n`, "utf8");
	}
	const index = plan.goals.length;
	const goal = {
		id: goalIdFor(title, index),
		title,
		objective,
		status: "pending",
		successCriteria: seedSuccessCriteria(index, objective),
		attempt: 0,
		createdAt: now,
		updatedAt: now,
	};
	plan.goals.push(goal);
	plan.updatedAt = now;
	writePlan(repoRoot, plan, scope);
	if (planCreated) {
		appendLedger(repoRoot, { at: now, kind: "plan_created", message: `Created ulw-loop plan at ${goalsRelativePath(scope)}.` }, scope);
	}
	appendLedger(repoRoot, { at: now, kind: "goal_added", goalId: goal.id, status: goal.status, message: goal.title }, scope);
	return { plan, goal, planCreated };
}

export function findGoal(plan, goalId) {
	const goal = plan.goals.find((candidate) => candidate.id === goalId);
	if (goal === undefined) {
		throw new UlwError(`UlwLoop goal not found: ${goalId}.`, "ULW_LOOP_GOAL_NOT_FOUND", {
			goalId,
			known: plan.goals.map((candidate) => candidate.id),
		});
	}
	return goal;
}

export function getGoal(repoRoot, goalId, scope) {
	return findGoal(readPlan(repoRoot, scope), nonEmpty(goalId, "goal-id"));
}

export function listGoals(repoRoot, scope) {
	const plan = readPlan(repoRoot, scope);
	return { plan, goals: plan.goals, summary: summarizePlan(plan) };
}

export function summarizePlan(plan) {
	const countStatus = (status) => plan.goals.filter((goal) => goal.status === status).length;
	const countCriteria = (status) =>
		plan.goals.reduce((sum, goal) => sum + goal.successCriteria.filter((c) => c.status === status).length, 0);
	return {
		total: plan.goals.length,
		pending: countStatus("pending"),
		in_progress: countStatus("in_progress"),
		complete: countStatus("complete"),
		failed: countStatus("failed"),
		blocked: countStatus("blocked"),
		review_blocked: countStatus("review_blocked"),
		needs_user_decision: countStatus("needs_user_decision"),
		superseded: plan.goals.filter((goal) => goal.steeringStatus === "superseded").length,
		criteria: {
			total: plan.goals.reduce((sum, goal) => sum + goal.successCriteria.length, 0),
			pass: countCriteria("pass"),
			pending: countCriteria("pending"),
			fail: countCriteria("fail"),
			blocked: countCriteria("blocked"),
		},
	};
}

/** pending -> in_progress, attempt += 1. Resuming an in_progress goal is a no-op. */
export function startGoal(repoRoot, goalId, scope) {
	const plan = readPlan(repoRoot, scope);
	const goal = findGoal(plan, nonEmpty(goalId, "goal-id"));
	const now = iso();
	const resumed = goal.status === "in_progress";
	if (!resumed) {
		goal.status = "in_progress";
		goal.attempt += 1;
		goal.startedAt = now;
	}
	goal.updatedAt = now;
	plan.activeGoalId = goal.id;
	plan.updatedAt = now;
	writePlan(repoRoot, plan, scope);
	appendLedger(
		repoRoot,
		{ at: now, kind: resumed ? "goal_resumed" : "goal_started", goalId: goal.id, status: goal.status, message: `Attempt ${goal.attempt}` },
		scope,
	);
	return { plan, goal, resumed };
}

export function recordEvidence(repoRoot, args, scope) {
	const plan = readPlan(repoRoot, scope);
	const goal = findGoal(plan, nonEmpty(args.goalId, "goal-id"));
	const criterionId = nonEmpty(args.criterionId, "criterion-id");
	const criterion = goal.successCriteria.find((c) => c.id === criterionId);
	if (criterion === undefined) {
		throw new UlwError(`Success criterion not found: ${criterionId}.`, "ULW_LOOP_CRITERION_NOT_FOUND", {
			goalId: goal.id,
			criterionId,
		});
	}
	if (!["pass", "fail", "blocked"].includes(args.status)) {
		throw new UlwError("Invalid criterion status.", "ULW_LOOP_CRITERION_STATUS_INVALID", { status: args.status });
	}
	const evidence = nonEmpty(args.evidence, "evidence");
	const prevStatus = criterion.status;
	const now = iso();
	criterion.status = args.status;
	criterion.capturedEvidence = evidence;
	criterion.capturedAt = now;
	if (args.notes !== undefined) criterion.notes = args.notes;
	goal.updatedAt = now;
	plan.updatedAt = now;
	writePlan(repoRoot, plan, scope);
	const kind = args.status === "pass" ? "evidence_captured" : args.status === "fail" ? "criterion_failed" : "criterion_blocked";
	appendLedger(
		repoRoot,
		{
			at: now,
			kind,
			goalId: goal.id,
			criterionId,
			criterionStatus: args.status,
			evidence,
			capturedEvidence: evidence,
			before: { status: prevStatus },
			after: { goalId: goal.id, criterionId, status: args.status, evidence, capturedAt: now, prevStatus },
		},
		scope,
	);
	return { plan, goal, criterion };
}

/**
 * pending|in_progress -> complete. A still-pending goal is implicitly started so the
 * attempt number (and therefore the evidence dir) is never `a0`. Binds the evidence
 * dir to HEAD's tree hash; see auditEvidence().
 */
export function completeGoal(repoRoot, args, scope) {
	const evidence = nonEmpty(args.evidence, "evidence");
	const goalId = nonEmpty(args.goalId, "goal-id");
	{
		const probe = findGoal(readPlan(repoRoot, scope), goalId);
		if (probe.status === "pending") startGoal(repoRoot, goalId, scope);
	}
	const plan = readPlan(repoRoot, scope);
	const goal = findGoal(plan, goalId);
	const now = iso();
	goal.status = "complete";
	goal.completedAt = now;
	goal.updatedAt = now;
	goal.evidence = evidence;
	goal.evidenceBinding = {
		dir: attemptEvidenceDir(goal.id, goal.attempt, scope),
		treeHash: currentTreeHash(repoRoot),
		boundAt: now,
	};
	if (plan.activeGoalId === goal.id) delete plan.activeGoalId;
	plan.updatedAt = now;
	writePlan(repoRoot, plan, scope);
	appendLedger(
		repoRoot,
		{
			at: now,
			kind: "goal_completed",
			goalId: goal.id,
			status: goal.status,
			evidence,
			after: { evidenceBinding: goal.evidenceBinding },
		},
		scope,
	);
	return { plan, goal, evidenceBinding: goal.evidenceBinding };
}

// ---------------------------------------------------------------- evidence audit

/** essential ?? true; if a goal marks none essential, the happy-path criterion stands in. */
export function essentialCriteriaOf(goal) {
	const explicit = goal.successCriteria.filter((c) => c.essential ?? true);
	if (explicit.length > 0) return explicit;
	const happy = goal.successCriteria.find((c) => c.userModel === "happy");
	return happy === undefined ? [] : [happy];
}

function countArtifacts(absDir) {
	if (!existsSync(absDir)) return null;
	let count = 0;
	const walk = (dir) => {
		for (const name of readdirSync(dir)) {
			const p = join(dir, name);
			if (statSync(p).isDirectory()) walk(p);
			else count += 1;
		}
	};
	walk(absDir);
	return count;
}

/**
 * Evidence freshness per goal, against `git rev-parse --short HEAD^{tree}`:
 *   fresh        - binding tree hash === current tree hash
 *   stale        - binding tree hash !== current tree hash (HEAD moved since completion)
 *   unverifiable - not a git repo / no commits / git unavailable (either side null)
 *   unbound      - goal was never completed, so nothing was bound
 * Working-tree edits alone do NOT flip fresh -> stale; HEAD's tree only moves on commit.
 */
export function auditEvidence(repoRoot, scope) {
	const plan = readPlan(repoRoot, scope);
	const currentTree = currentTreeHash(repoRoot);
	const goals = plan.goals.map((goal) => {
		const binding = goal.evidenceBinding;
		const state =
			binding === undefined || binding === null
				? "unbound"
				: binding.treeHash === null || currentTree === null
					? "unverifiable"
					: binding.treeHash === currentTree
						? "fresh"
						: "stale";
		const dir = binding?.dir ?? attemptEvidenceDir(goal.id, goal.attempt, scope);
		const unresolvedEssential = essentialCriteriaOf(goal)
			.filter((c) => c.status !== "pass")
			.map((c) => c.id);
		return {
			goalId: goal.id,
			status: goal.status,
			attempt: goal.attempt,
			evidenceDir: dir,
			boundTree: binding?.treeHash ?? null,
			boundAt: binding?.boundAt ?? null,
			state,
			artifactCount: countArtifacts(join(repoRoot, dir)),
			criteria: {
				total: goal.successCriteria.length,
				pass: goal.successCriteria.filter((c) => c.status === "pass").length,
				unresolvedEssential,
			},
			criteriaUnmet: goal.status === "complete" && unresolvedEssential.length > 0,
		};
	});
	const count = (state) => goals.filter((g) => g.state === state).length;
	return {
		sessionId: normalizeSessionId(scope?.sessionId) ?? resolveSessionIdFromEnv(),
		currentTree,
		gitAvailable: currentTree !== null,
		goals,
		summary: {
			total: goals.length,
			fresh: count("fresh"),
			stale: count("stale"),
			unbound: count("unbound"),
			unverifiable: count("unverifiable"),
			missingEvidenceDir: goals.filter((g) => g.artifactCount === null).length,
			criteriaUnmet: goals.filter((g) => g.criteriaUnmet).length,
		},
	};
}
