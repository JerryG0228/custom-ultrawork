#!/usr/bin/env node
// Thin CLI over ulw-loop-core.mjs. All logic lives in the core module so tests and
// the MCP server call the same functions.

import {
	auditEvidence,
	completeGoal,
	createGoal,
	getGoal,
	listGoals,
	recordEvidence,
	resolveRepoRoot,
	startGoal,
	summarizePlan,
	UlwError,
} from "./ulw-loop-core.mjs";

const USAGE = `ulw-loop <command> [options]

  create-goal     --title "..." [--objective "..."] [--brief "..."]
  get-goal        --goal-id <id>
  start-goal      --goal-id <id>
  record-evidence --goal-id <id> --criterion-id <id> --status pass|fail|blocked --evidence "..." [--notes "..."]
  complete-goal   --goal-id <id> --evidence "..."
  list-goals
  audit

Common: [--session-id <id>] [--repo-root <path>] [--json]
Without --session-id the plan lives at .omo/ulw-loop/, otherwise .omo/ulw-loop/<session-id>/.
`;

function parseArgs(argv) {
	const flags = {};
	for (let i = 0; i < argv.length; i += 1) {
		const token = argv[i];
		if (!token.startsWith("--")) continue;
		const key = token.slice(2);
		const next = argv[i + 1];
		if (next === undefined || next.startsWith("--")) flags[key] = true;
		else {
			flags[key] = next;
			i += 1;
		}
	}
	return flags;
}

export function run(argv, { cwd = process.cwd(), env = process.env } = {}) {
	const [command, ...rest] = argv;
	const flags = parseArgs(rest);
	const repoRoot = typeof flags["repo-root"] === "string" ? flags["repo-root"] : resolveRepoRoot(cwd);
	const scope = typeof flags["session-id"] === "string" ? { sessionId: flags["session-id"] } : undefined;

	switch (command) {
		case "create-goal": {
			const { goal, plan, planCreated } = createGoal(
				repoRoot,
				{ title: flags.title, objective: flags.objective, brief: flags.brief },
				scope,
			);
			return { ok: true, planCreated, goal, summary: summarizePlan(plan), text: `${goal.id} ${goal.status}` };
		}
		case "get-goal": {
			const goal = getGoal(repoRoot, flags["goal-id"], scope);
			return { ok: true, goal, text: `${goal.id} ${goal.status}` };
		}
		case "start-goal": {
			const { goal, resumed } = startGoal(repoRoot, flags["goal-id"], scope);
			return { ok: true, resumed, goal, text: `${goal.id} ${goal.status} attempt=${goal.attempt}` };
		}
		case "record-evidence": {
			const { goal, criterion } = recordEvidence(
				repoRoot,
				{
					goalId: flags["goal-id"],
					criterionId: flags["criterion-id"],
					status: flags.status,
					evidence: flags.evidence,
					...(typeof flags.notes === "string" ? { notes: flags.notes } : {}),
				},
				scope,
			);
			return { ok: true, goalId: goal.id, criterion, text: `${goal.id}/${criterion.id} ${criterion.status}` };
		}
		case "complete-goal": {
			const { goal, evidenceBinding } = completeGoal(
				repoRoot,
				{ goalId: flags["goal-id"], evidence: flags.evidence },
				scope,
			);
			return {
				ok: true,
				goal,
				evidenceBinding,
				text: `${goal.id} complete evidence=${evidenceBinding.dir} tree=${evidenceBinding.treeHash ?? "n/a"}`,
			};
		}
		case "list-goals": {
			const { goals, summary } = listGoals(repoRoot, scope);
			return {
				ok: true,
				goals,
				summary,
				text: goals.map((g) => `${g.id}\t${g.status}\t${g.title}`).join("\n") || "(no goals)",
			};
		}
		case "audit": {
			const report = auditEvidence(repoRoot, scope);
			return {
				ok: true,
				...report,
				text: [
					`tree=${report.currentTree ?? "n/a (not a git repo)"}`,
					...report.goals.map(
						(g) => `${g.goalId}\t${g.state}\t${g.evidenceDir}\tartifacts=${g.artifactCount ?? "missing"}${g.criteriaUnmet ? "\tcriteria-unmet" : ""}`,
					),
				].join("\n"),
			};
		}
		case "help":
		case "--help":
		case "-h":
		case undefined:
			return { ok: true, text: USAGE };
		default:
			throw new UlwError(`Unknown command: ${command}.`, "ULW_LOOP_COMMAND_UNKNOWN", { command });
	}
}

function main(argv) {
	const json = argv.includes("--json");
	try {
		const result = run(argv);
		const { text, ...rest } = result;
		process.stdout.write(json ? `${JSON.stringify(rest)}\n` : `${text}\n`);
		return 0;
	} catch (error) {
		const payload = {
			ok: false,
			code: error instanceof UlwError ? error.code : "ULW_LOOP_UNEXPECTED",
			message: error.message,
			...(error instanceof UlwError ? { details: error.details } : {}),
		};
		process.stderr.write(json ? `${JSON.stringify(payload)}\n` : `${payload.code}: ${payload.message}\n`);
		return 1;
	}
}

if (import.meta.url === `file://${process.argv[1]}`) process.exitCode = main(process.argv.slice(2));
