// Port of the two upstream contract tests plus the goal state machine / evidence audit.
//
// Upstream sources (oh-my-opencode @ 5.0.0-beta.22, SUL-1.0):
//   tests/ulw-loop-define-goal-reference.test.ts        -> "shipped references" below
//   tests/ulw-plan-review-convergence-contract.test.ts  -> "review convergence contract" below
//
// The upstream byte-identity assertion compared two in-repo copies of define-goal.md.
// Here the plugin copy is pinned to the upstream bytes by SHA-256, so the assertion
// survives the upstream checkout going away; when OMO_REPO points at a checkout the
// bytes are compared directly as well.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
	attemptEvidenceDir,
	auditEvidence,
	completeGoal,
	createGoal,
	currentTreeHash,
	getGoal,
	listGoals,
	recordEvidence,
	UlwError,
} from "../bin/ulw-loop-core.mjs";

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REFERENCES = join(PLUGIN_ROOT, "skills", "ulw", "references");
const CLI = join(PLUGIN_ROOT, "bin", "ulw-loop.mjs");

// sha256 of the upstream files at oh-my-opencode 5.0.0-beta.22.
const UPSTREAM = {
	"define-goal.md": {
		sha256: "4400ba79e52992eb1f619fadd6a6cf7f0783b426ab31de31b30d5f7bf1ac6770",
		upstreamRelPaths: [
			"packages/omo-senpi/skills/ulw-loop/references/define-goal.md",
			"packages/omo-codex/plugin/components/ulw-loop/skills/ulw-loop/references/define-goal.md",
		],
	},
	"full-workflow.md": {
		sha256: "a770b7b8ddf939e6c6e9253bb9f14c8613a264598ca63490eaa97d0d4950cd1f",
		upstreamRelPaths: ["packages/omo-codex/plugin/components/ulw-loop/skills/ulw-loop/references/full-workflow.md"],
	},
	"ulw-plan/full-workflow.md": {
		sha256: "929a2719b61847bc9939fca5f18556c7f4655e70603179eb4a62d68e9c2a676e",
		upstreamRelPaths: [
			"packages/omo-codex/plugin/components/ultrawork/skills/ulw-plan/references/full-workflow.md",
		],
	},
};

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

// ---------------------------------------------------------------- (a) shipped references

describe("shipped references (port of ulw-loop-define-goal-reference.test.ts)", () => {
	test("define-goal.md ships beside full-workflow.md", () => {
		assert.ok(existsSync(join(REFERENCES, "define-goal.md")), "define-goal.md missing");
		assert.ok(existsSync(join(REFERENCES, "full-workflow.md")), "full-workflow.md missing");
	});

	for (const [rel, { sha256: expected }] of Object.entries(UPSTREAM)) {
		test(`${rel} is byte-identical to the upstream copy`, () => {
			assert.equal(sha256(readFileSync(join(REFERENCES, rel))), expected);
		});
	}

	test("bytes match the upstream checkout when OMO_REPO is set", (t) => {
		const repo = process.env.OMO_REPO;
		if (!repo || !existsSync(repo)) return t.skip("OMO_REPO not set to a checkout");
		for (const [rel, { upstreamRelPaths }] of Object.entries(UPSTREAM)) {
			const mine = readFileSync(join(REFERENCES, rel));
			for (const upstreamRel of upstreamRelPaths) {
				assert.deepEqual(readFileSync(join(repo, upstreamRel)), mine, `${rel} != ${upstreamRel}`);
			}
		}
	});
});

// ---------------------------------------------------------------- (b) convergence contract

const BLOCKER_ELIGIBILITY = [
	"explicit_requirement_or_accepted_decision",
	"existing_failing_regression",
	"reproducible_broken_flow",
	"concrete_security_data_loss_or_compatibility_risk",
	"external_api_provider_or_release_contract_conflict",
];

function readJsonContract(workflow, contractName) {
	const fence = "```";
	const pattern = new RegExp(`<!-- ${contractName} -->\\s*${fence}json\\s*([\\s\\S]*?)\\s*${fence}`);
	const match = workflow.match(pattern);
	if (!match?.[1]) throw new Error(`missing ${contractName}`);
	return JSON.parse(match[1]);
}

describe("review convergence contract (port of ulw-plan-review-convergence-contract.test.ts)", () => {
	const workflow = readFileSync(join(REFERENCES, "ulw-plan", "full-workflow.md"), "utf8");
	const contract = () => readJsonContract(workflow, "ulw-plan-review-convergence-contract");

	test("bounded round cap with a user-facing cap action", () => {
		const c = contract();
		assert.equal(Number.isInteger(c.max_rounds), true);
		assert.ok(c.max_rounds >= 2, `max_rounds ${c.max_rounds} < 2`);
		assert.ok(c.max_rounds <= 5, `max_rounds ${c.max_rounds} > 5`);
		assert.equal(c.max_rounds_override, "explicit_user_request_only");
		assert.equal(c.on_cap_reached, "stop_report_outstanding_blockers_ask_user");
	});

	test("only evidence-backed findings are blocker-eligible; the rest are non-blocking notes", () => {
		const c = contract();
		assert.deepEqual(c.blocker_eligibility, BLOCKER_ELIGIBILITY);
		assert.equal(c.ineligible_finding_disposition, "non_blocking_note");
		assert.equal(c.approval_with_notes_counts_as_approval, true);
	});

	test("blocker ledger freezes after the discovery round and fixes stay minimal", () => {
		const c = contract();
		assert.equal(c.ledger_freeze_after_round, 1);
		assert.deepEqual(c.closure_round_scope, [
			"accepted_ledger_blockers",
			"regressions_introduced_by_fixes",
			"new_findings_passing_blocker_eligibility",
		]);
		assert.equal(c.fix_edit_policy, "smallest_edit_no_scope_expansion");
	});

	test("no unconditional resubmit-until-approval loop remains", () => {
		assert.doesNotMatch(workflow, /fix every cited issue and resubmit (?:both )?fresh until (?:each|it) approves/);
	});
});

// ---------------------------------------------------------------- fixtures

const tempRoots = [];

function makeRepo({ git = true } = {}) {
	const root = mkdtempSync(join(tmpdir(), "ulw-test-"));
	tempRoots.push(root);
	if (git) {
		const run = (...args) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
		run("init", "-q", ".");
		run("config", "user.email", "test@example.invalid");
		run("config", "user.name", "ulw test");
		writeFileSync(join(root, "seed.txt"), "seed\n");
		run("add", "-A");
		run("commit", "-qm", "seed");
	}
	return root;
}

after(() => {
	for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
});

const commitAll = (root, message) => {
	execFileSync("git", ["add", "-A"], { cwd: root, stdio: "pipe" });
	execFileSync("git", ["commit", "-qm", message], { cwd: root, stdio: "pipe" });
};

// ---------------------------------------------------------------- (c) goal state machine

describe("goal state machine", () => {
	const scope = { sessionId: "sess-1" };

	test("create -> pending -> complete round trip", () => {
		const root = makeRepo();
		const { goal, planCreated } = createGoal(root, { title: "Ship the widget", objective: "Ship the widget end to end" }, scope);
		assert.equal(planCreated, true);
		assert.equal(goal.id, "G001-ship-the-widget");
		assert.equal(goal.status, "pending");
		assert.equal(goal.attempt, 0);
		assert.equal(goal.successCriteria.length, 3);
		assert.deepEqual(goal.successCriteria.map((c) => c.id), ["C001", "C002", "C003"]);

		assert.equal(getGoal(root, goal.id, scope).status, "pending");

		const done = completeGoal(root, { goalId: goal.id, evidence: "node --test passed" }, scope);
		assert.equal(done.goal.status, "complete");
		assert.equal(done.goal.attempt, 1, "pending goal is implicitly started so evidence never binds to a0");
		assert.equal(done.goal.evidence, "node --test passed");
		assert.ok(done.goal.completedAt);

		const reread = getGoal(root, goal.id, scope);
		assert.equal(reread.status, "complete");
		assert.equal(reread.evidenceBinding.dir, attemptEvidenceDir(goal.id, 1, scope));
	});

	test("plan is compatible with the upstream goals.json shape", () => {
		const root = makeRepo();
		createGoal(root, { title: "Alpha" }, scope);
		const plan = JSON.parse(readFileSync(join(root, ".omo", "ulw-loop", "sess-1", "goals.json"), "utf8"));
		assert.equal(plan.version, 1);
		assert.equal(plan.evidenceLayoutVersion, 2);
		assert.equal(plan.goalsPath, ".omo/ulw-loop/sess-1/goals.json");
		assert.equal(plan.ledgerPath, ".omo/ulw-loop/sess-1/ledger.jsonl");
		assert.equal(plan.briefPath, ".omo/ulw-loop/sess-1/brief.md");
		assert.equal(plan.codexGoalMode, "aggregate");
		assert.match(plan.codexObjective, /^Complete the durable ulw-loop plan in \.omo\/ulw-loop\/sess-1\/goals\.json/);
		assert.ok(existsSync(join(root, ".omo", "ulw-loop", "sess-1", "brief.md")));

		const ledger = readFileSync(join(root, ".omo", "ulw-loop", "sess-1", "ledger.jsonl"), "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		assert.deepEqual(ledger.map((e) => e.kind), ["plan_created", "goal_added"]);
	});

	test("second goal gets G002 and list/summary count both", () => {
		const root = makeRepo();
		createGoal(root, { title: "Alpha" }, scope);
		const second = createGoal(root, { title: "Beta" }, scope);
		assert.equal(second.planCreated, false);
		assert.equal(second.goal.id, "G002-beta");
		const { goals, summary } = listGoals(root, scope);
		assert.equal(goals.length, 2);
		assert.equal(summary.total, 2);
		assert.equal(summary.pending, 2);
		assert.equal(summary.criteria.total, 6);
	});

	test("missing goal raises ULW_LOOP_GOAL_NOT_FOUND", () => {
		const root = makeRepo();
		createGoal(root, { title: "Alpha" }, scope);
		assert.throws(
			() => getGoal(root, "G999-nope", scope),
			(error) => error instanceof UlwError && error.code === "ULW_LOOP_GOAL_NOT_FOUND",
		);
	});

	test("missing plan raises ULW_LOOP_PLAN_MISSING", () => {
		const root = makeRepo();
		assert.throws(
			() => listGoals(root, scope),
			(error) => error instanceof UlwError && error.code === "ULW_LOOP_PLAN_MISSING",
		);
	});

	test("complete-goal rejects empty evidence", () => {
		const root = makeRepo();
		const { goal } = createGoal(root, { title: "Alpha" }, scope);
		assert.throws(
			() => completeGoal(root, { goalId: goal.id, evidence: "   " }, scope),
			(error) => error instanceof UlwError && error.code === "ULW_LOOP_ARGUMENT_MISSING",
		);
	});

	test("record-evidence flips a criterion and writes the ledger kind", () => {
		const root = makeRepo();
		const { goal } = createGoal(root, { title: "Alpha" }, scope);
		const { criterion } = recordEvidence(
			root,
			{ goalId: goal.id, criterionId: "C001", status: "pass", evidence: "ran it" },
			scope,
		);
		assert.equal(criterion.status, "pass");
		assert.equal(criterion.capturedEvidence, "ran it");
		const kinds = readFileSync(join(root, ".omo", "ulw-loop", "sess-1", "ledger.jsonl"), "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line).kind);
		assert.equal(kinds.at(-1), "evidence_captured");
		assert.throws(
			() => recordEvidence(root, { goalId: goal.id, criterionId: "C404", status: "pass", evidence: "x" }, scope),
			(error) => error instanceof UlwError && error.code === "ULW_LOOP_CRITERION_NOT_FOUND",
		);
	});
});

// ---------------------------------------------------------------- (d) evidence audit

describe("evidence audit", () => {
	const scope = { sessionId: "sess-audit" };

	test("fresh while HEAD's tree is unchanged, stale once it moves", () => {
		const root = makeRepo();
		const { goal } = createGoal(root, { title: "Bind me" }, scope);
		const boundTree = currentTreeHash(root);
		assert.ok(boundTree, "expected a tree hash inside a git repo");

		const { evidenceBinding } = completeGoal(root, { goalId: goal.id, evidence: "proof" }, scope);
		assert.equal(evidenceBinding.treeHash, boundTree);

		const fresh = auditEvidence(root, scope);
		assert.equal(fresh.currentTree, boundTree);
		assert.equal(fresh.goals[0].state, "fresh");
		assert.equal(fresh.summary.fresh, 1);
		assert.equal(fresh.summary.stale, 0);

		// An uncommitted edit does not move HEAD's tree, so the binding stays fresh.
		writeFileSync(join(root, "seed.txt"), "dirty\n");
		assert.equal(auditEvidence(root, scope).goals[0].state, "fresh");

		commitAll(root, "move the tree");
		const stale = auditEvidence(root, scope);
		assert.notEqual(stale.currentTree, boundTree);
		assert.equal(stale.goals[0].state, "stale");
		assert.equal(stale.summary.stale, 1);
		assert.equal(stale.summary.fresh, 0);
	});

	test("goals that were never completed are unbound", () => {
		const root = makeRepo();
		createGoal(root, { title: "Never done" }, scope);
		const report = auditEvidence(root, scope);
		assert.equal(report.goals[0].state, "unbound");
		assert.equal(report.summary.unbound, 1);
		assert.equal(report.goals[0].artifactCount, null, "no evidence dir on disk");
		assert.equal(report.summary.missingEvidenceDir, 1);
	});

	test("completing with unresolved essential criteria is reported, not hidden", () => {
		const root = makeRepo();
		const { goal } = createGoal(root, { title: "Half done" }, scope);
		recordEvidence(root, { goalId: goal.id, criterionId: "C001", status: "pass", evidence: "ok" }, scope);
		completeGoal(root, { goalId: goal.id, evidence: "shipped" }, scope);
		const report = auditEvidence(root, scope);
		assert.equal(report.goals[0].criteriaUnmet, true, "C002 is essential and still pending");
		assert.deepEqual(report.goals[0].criteria.unresolvedEssential, ["C002"]);
		assert.equal(report.summary.criteriaUnmet, 1);

		recordEvidence(root, { goalId: goal.id, criterionId: "C002", status: "pass", evidence: "ok" }, scope);
		assert.equal(auditEvidence(root, scope).summary.criteriaUnmet, 0);
	});

	test("outside a git repo audit degrades to unverifiable instead of throwing", () => {
		const root = makeRepo({ git: false });
		assert.equal(currentTreeHash(root), null);
		const { goal } = createGoal(root, { title: "No git here" }, scope);
		const { evidenceBinding } = completeGoal(root, { goalId: goal.id, evidence: "proof" }, scope);
		assert.equal(evidenceBinding.treeHash, null);
		const report = auditEvidence(root, scope);
		assert.equal(report.gitAvailable, false);
		assert.equal(report.currentTree, null);
		assert.equal(report.goals[0].state, "unverifiable");
		assert.equal(report.summary.unverifiable, 1);
	});

	test("evidence dir follows the upstream .omo/evidence/ulw layout and counts artifacts", () => {
		const root = makeRepo();
		const { goal } = createGoal(root, { title: "With artifacts" }, scope);
		const { evidenceBinding } = completeGoal(root, { goalId: goal.id, evidence: "proof" }, scope);
		assert.equal(evidenceBinding.dir, `.omo/evidence/ulw/sess-audit/${goal.id}/a1`);
		execFileSync("mkdir", ["-p", join(root, evidenceBinding.dir)]);
		writeFileSync(join(root, evidenceBinding.dir, "transcript.txt"), "ran it\n");
		assert.equal(auditEvidence(root, scope).goals[0].artifactCount, 1);
	});
});

// ---------------------------------------------------------------- CLI surface

describe("cli", () => {
	const node = process.execPath;
	const cli = (root, args) =>
		execFileSync(node, [CLI, ...args, "--repo-root", root, "--session-id", "cli", "--json"], {
			cwd: root,
			encoding: "utf8",
		});

	test("create-goal / get-goal / complete-goal / list-goals / audit all emit --json", () => {
		const root = makeRepo();
		const created = JSON.parse(cli(root, ["create-goal", "--title", "CLI goal"]));
		assert.equal(created.ok, true);
		assert.equal(created.goal.status, "pending");

		const got = JSON.parse(cli(root, ["get-goal", "--goal-id", created.goal.id]));
		assert.equal(got.goal.status, "pending");

		const done = JSON.parse(cli(root, ["complete-goal", "--goal-id", created.goal.id, "--evidence", "cli proof"]));
		assert.equal(done.goal.status, "complete");

		const listed = JSON.parse(cli(root, ["list-goals"]));
		assert.equal(listed.summary.complete, 1);

		const audited = JSON.parse(cli(root, ["audit"]));
		assert.equal(audited.goals[0].state, "fresh");
	});

	test("unknown goal exits non-zero with a machine-readable error", () => {
		const root = makeRepo();
		cli(root, ["create-goal", "--title", "CLI goal"]);
		let failure;
		try {
			cli(root, ["get-goal", "--goal-id", "G999-nope"]);
		} catch (error) {
			failure = error;
		}
		assert.ok(failure, "expected a non-zero exit");
		assert.equal(failure.status, 1);
		assert.equal(JSON.parse(failure.stderr).code, "ULW_LOOP_GOAL_NOT_FOUND");
	});
});
