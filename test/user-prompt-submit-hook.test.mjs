import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";

import {
	buildUltraworkAdditionalContext,
	isUltraworkPrompt,
	resolveUltraworkSkillFilePath,
	runUserPromptSubmitHook,
} from "../hooks-handlers/on-user-prompt-submit.mjs";

const HOOK_SCRIPT = fileURLToPath(new URL("../hooks-handlers/on-user-prompt-submit.mjs", import.meta.url));
const CONTEXT_PRESSURE_MARKERS = [
	"context compacted",
	"context_length_exceeded",
	"skill descriptions were shortened",
	"context_too_large",
	"codex ran out of room in the model's context window",
	"your input exceeds the context window",
	"long threads and multiple compactions",
];

const tempDirectories = [];

function tempDir(prefix) {
	const root = mkdtempSync(path.join(tmpdir(), prefix));
	tempDirectories.push(root);
	return root;
}

function writeTranscript(...lines) {
	const transcriptPath = path.join(tempDir("ulw-transcript-"), "transcript.jsonl");
	writeFileSync(transcriptPath, `${lines.join("\n")}\n`);
	return transcriptPath;
}

function writeRawTranscript(contents) {
	const transcriptPath = path.join(tempDir("ulw-transcript-raw-"), "transcript.jsonl");
	writeFileSync(transcriptPath, contents);
	return transcriptPath;
}

const SKILL_BODY = "ULTRAWORK MODE IS ACTIVE FOR THIS TASK.\n\nDo the thing properly.";
const skillFilePath = path.join(tempDir("ulw-skill-"), "SKILL.md");
writeFileSync(skillFilePath, `---\nname: ulw\ndescription: test fixture\n---\n\n${SKILL_BODY}\n`);

const OPTIONS = { skillFilePath };

function run(payload) {
	return runUserPromptSubmitHook(payload, OPTIONS);
}

function parseHookOutput(output) {
	const parsed = JSON.parse(output);
	assert.equal(parsed.hookSpecificOutput.hookEventName, "UserPromptSubmit");
	assert.equal(typeof parsed.hookSpecificOutput.additionalContext, "string");
	return parsed;
}

after(() => {
	for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("guard 1: context pressure recovery prompt", () => {
	for (const marker of CONTEXT_PRESSURE_MARKERS) {
		it(`skips when prompt contains "${marker}"`, () => {
			assert.equal(run({ hook_event_name: "UserPromptSubmit", prompt: `${marker}\nulw fix this` }), "");
		});

		it(`skips case-insensitively for "${marker}"`, () => {
			const scrambled = [...marker].map((c, i) => (i % 2 === 0 ? c.toUpperCase() : c)).join("");
			assert.equal(run({ hook_event_name: "UserPromptSubmit", prompt: `ultrawork now. ${scrambled}` }), "");
		});
	}

	it("skips the reported multi-marker recovery prompt with ulw", () => {
		const prompt = [
			"Warning: Skill descriptions were shortened to fit the 2% skills context budget.",
			"Warning: Long threads and multiple compactions can cause the model to be less accurate.",
			"Context compacted",
			"error context_too_large: Your input exceeds the context window of this model.",
			"ulw tdd commit well",
		].join("\n");
		assert.equal(run({ hook_event_name: "UserPromptSubmit", prompt }), "");
	});

	it("stays quiet for a pressure prompt without ulw", () => {
		assert.equal(run({ hook_event_name: "UserPromptSubmit", prompt: "Context compacted\nplease continue" }), "");
	});
});

describe("guard 2: directive already in transcript", () => {
	it("skips when a hookSpecificOutput line carries the ultrawork marker", () => {
		const transcript_path = writeTranscript(
			JSON.stringify({
				hookSpecificOutput: {
					hookEventName: "UserPromptSubmit",
					additionalContext: "<ultrawork-mode>\nexisting directive",
				},
			}),
		);
		assert.equal(run({ hook_event_name: "UserPromptSubmit", prompt: "ulw this change", transcript_path }), "");
	});

	it("injects when the marker only appears in plain user content", () => {
		const transcript_path = writeTranscript(
			JSON.stringify({ role: "user", content: "Inspect text containing <ultrawork-mode> but do not activate yet." }),
		);
		const parsed = parseHookOutput(
			run({ hook_event_name: "UserPromptSubmit", prompt: "ulw this change", transcript_path }),
		);
		assert.match(parsed.hookSpecificOutput.additionalContext, /^<ultrawork-mode>/);
	});

	it("injects when a different hook's additionalContext is present", () => {
		const transcript_path = writeTranscript(
			JSON.stringify({
				hookSpecificOutput: {
					hookEventName: "UserPromptSubmit",
					additionalContext: "<lazycodex-auto-workflow>\nexisting selector guidance",
				},
			}),
		);
		const parsed = parseHookOutput(
			run({ hook_event_name: "UserPromptSubmit", prompt: "ulw fix this failing test", transcript_path }),
		);
		assert.match(parsed.hookSpecificOutput.additionalContext, /^<ultrawork-mode>/);
	});

	it("injects when the marker sits under a non-UserPromptSubmit hook event", () => {
		const transcript_path = writeTranscript(
			JSON.stringify({
				hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "<ultrawork-mode>\nnope" },
			}),
		);
		assert.notEqual(run({ hook_event_name: "UserPromptSubmit", prompt: "ulw go", transcript_path }), "");
	});

	it("skips unparsable and non-record lines instead of crashing", () => {
		const transcript_path = writeTranscript(
			"not json at all",
			"",
			"[1,2,3]",
			'"a string"',
			"{broken",
			JSON.stringify({
				hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "<ultrawork-mode> here" },
			}),
		);
		assert.equal(run({ hook_event_name: "UserPromptSubmit", prompt: "ulw go", transcript_path }), "");
	});
});

describe("guard 3: context pressure transcript", () => {
	it("skips on the context-pressure transcript", () => {
		const transcript_path = writeTranscript(
			JSON.stringify({ type: "message", payload: { content: "Context compacted" } }),
			JSON.stringify({
				type: "message",
				payload: { content: "Your input exceeds the context window of this model." },
			}),
		);
		assert.equal(run({ hook_event_name: "UserPromptSubmit", prompt: "ulw this change", transcript_path }), "");
	});

	it("skips on the codex context-window transcript", () => {
		const transcript_path = writeTranscript(
			JSON.stringify({ type: "message", payload: { content: { error: { code: "context_length_exceeded" } } } }),
			JSON.stringify({
				type: "message",
				payload: {
					content:
						"Codex ran out of room in the model's context window. Start a new thread or clear earlier history before retrying.",
				},
			}),
		);
		assert.equal(run({ hook_event_name: "UserPromptSubmit", prompt: "ulw this change", transcript_path }), "");
	});
});

describe("trigger matching", () => {
	for (const prompt of [
		"ulw 이거 해줘",
		"ULTRAWORK now",
		"please ultrawork this",
		"ulw",
		"ulw ",
		"Ulw this change",
		"하이ulw",
		"refactor ulw_helper.ts",
		"ulw-loop keep iterating until green",
		"why did ultrawork trigger here?",
	]) {
		it(`injects for ${JSON.stringify(prompt)}`, () => {
			const parsed = parseHookOutput(run({ hook_event_name: "UserPromptSubmit", prompt }));
			assert.equal(isUltraworkPrompt(prompt), true);
			assert.match(parsed.hookSpecificOutput.additionalContext, /^<ultrawork-mode>/);
			assert.ok(parsed.hookSpecificOutput.additionalContext.includes(skillFilePath));
			assert.match(parsed.hookSpecificOutput.additionalContext, /ULTRAWORK MODE ENABLED!/);
		});
	}

	for (const prompt of [
		"$omo:ulw-plan refactor the auth module",
		"omo:ulw-plan",
		"/ulw-plan",
		"ulw-plan",
		"$omo:ulw-research how does the hook pipeline work",
		"ulw-research",
		"please run ULW-PLAN for this",
		"please explain why the banner appeared",
		"",
		"fix the failing build",
	]) {
		it(`stays quiet for ${JSON.stringify(prompt)}`, () => {
			assert.equal(isUltraworkPrompt(prompt), false);
			assert.equal(run({ hook_event_name: "UserPromptSubmit", prompt }), "");
		});
	}

	it("injects a pointer, not the directive body — stdout must stay under Claude Code's 2KB preview cap", () => {
		const parsed = parseHookOutput(run({ hook_event_name: "UserPromptSubmit", prompt: "ulw go" }));
		const ctx = parsed.hookSpecificOutput.additionalContext;
		assert.ok(!ctx.includes("description: test fixture"));
		assert.ok(!ctx.includes(SKILL_BODY));
		assert.ok(Buffer.byteLength(ctx, "utf8") < 2048, `pointer is ${Buffer.byteLength(ctx, "utf8")}B, must stay under 2048B`);
	});

	it("emits exactly one trailing newline", () => {
		const output = run({ hook_event_name: "UserPromptSubmit", prompt: "ulw go" });
		assert.ok(output.endsWith("}\n"));
		assert.equal(output.split("\n").length, 2);
	});
});

describe("512KB transcript tail boundary", () => {
	const directiveLine = JSON.stringify({
		hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "<ultrawork-mode>\nold" },
	});
	const padLine = `${JSON.stringify({ role: "user", content: "x".repeat(200) })}\n`;
	const padding = padLine.repeat(Math.ceil(600_000 / padLine.length));

	it("misses a directive that fell outside the last 512KB", () => {
		const transcript_path = writeRawTranscript(`${directiveLine}\n${padding}`);
		assert.notEqual(run({ hook_event_name: "UserPromptSubmit", prompt: "ulw go", transcript_path }), "");
	});

	it("finds a directive inside the last 512KB of a >512KB transcript", () => {
		const transcript_path = writeRawTranscript(`${padding}${directiveLine}\n`);
		assert.equal(run({ hook_event_name: "UserPromptSubmit", prompt: "ulw go", transcript_path }), "");
	});

	it("misses a pressure marker that fell outside the last 512KB", () => {
		const transcript_path = writeRawTranscript(`Context compacted\n${padding}`);
		assert.notEqual(run({ hook_event_name: "UserPromptSubmit", prompt: "ulw go", transcript_path }), "");
	});

	it("finds a pressure marker inside the last 512KB of a >512KB transcript", () => {
		const transcript_path = writeRawTranscript(`${padding}Context compacted\n`);
		assert.equal(run({ hook_event_name: "UserPromptSubmit", prompt: "ulw go", transcript_path }), "");
	});
});

describe("robustness", () => {
	it("handles a missing, null, or nonexistent transcript_path", () => {
		const payloads = [
			{ hook_event_name: "UserPromptSubmit", prompt: "ulw go" },
			{ hook_event_name: "UserPromptSubmit", prompt: "ulw go", transcript_path: null },
			{ hook_event_name: "UserPromptSubmit", prompt: "ulw go", transcript_path: "/nope/does/not/exist.jsonl" },
			{ hook_event_name: "UserPromptSubmit", prompt: "ulw go", transcript_path: tmpdir() },
			{
				cwd: "C:\\Users\\codex\\project",
				hook_event_name: "UserPromptSubmit",
				model: "gpt-5.5",
				permission_mode: "default",
				prompt: "ulw this change",
				session_id: "s",
				transcript_path: null,
				turn_id: "t",
			},
		];
		for (const payload of payloads) {
			assert.match(parseHookOutput(run(payload)).hookSpecificOutput.additionalContext, /^<ultrawork-mode>/);
		}
	});

	it("returns empty output for malformed input", () => {
		const inputs = [
			undefined,
			null,
			{},
			[],
			"ulw",
			42,
			{ hook_event_name: "Stop", prompt: "ulw go" },
			{ hook_event_name: "UserPromptSubmit" },
			{ hook_event_name: "UserPromptSubmit", prompt: 42 },
			{ hook_event_name: "UserPromptSubmit", prompt: "" },
			{ hook_event_name: "UserPromptSubmit", prompt: "ulw go", transcript_path: 5 },
		];
		assert.deepEqual(
			inputs.map((input) => run(input)),
			inputs.map(() => ""),
		);
	});

	it("stays quiet when the skill file is missing or empty", () => {
		const missing = path.join(tempDir("ulw-missing-"), "SKILL.md");
		const empty = path.join(tempDir("ulw-empty-"), "SKILL.md");
		writeFileSync(empty, "---\nname: ulw\n---\n\n   \n");
		for (const p of [missing, empty, null]) {
			assert.equal(runUserPromptSubmitHook({ hook_event_name: "UserPromptSubmit", prompt: "ulw go" }, { skillFilePath: p }), "");
		}
	});

	it("resolves the default skill path inside the plugin without throwing", () => {
		assert.match(resolveUltraworkSkillFilePath(), /skills[/\\]ulw[/\\]SKILL\.md$/);
		assert.equal(typeof buildUltraworkAdditionalContext(), "string");
	});
});

describe("process round-trip", () => {
	function runScript(stdin) {
		let status = 0;
		let stdout = "";
		try {
			stdout = execFileSync(process.execPath, [HOOK_SCRIPT], { input: stdin, encoding: "utf8" });
		} catch (error) {
			status = error.status ?? 1;
			stdout = error.stdout ?? "";
		}
		return { status, stdout };
	}

	it("exits 0 with empty stdout for a non-matching prompt", () => {
		const { status, stdout } = runScript(JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt: "hello" }));
		assert.equal(status, 0);
		assert.equal(stdout, "");
	});

	it("exits 0 with empty stdout for a context-pressure prompt", () => {
		const { status, stdout } = runScript(
			JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt: "Context compacted, ulw go" }),
		);
		assert.equal(status, 0);
		assert.equal(stdout, "");
	});

	it("exits 0 on garbage stdin", () => {
		for (const stdin of ["", "not json", "[]"]) {
			const { status, stdout } = runScript(stdin);
			assert.equal(status, 0);
			assert.equal(stdout, "");
		}
	});

	it("exits 0 for a matching prompt, emitting valid hook JSON when the skill file exists", () => {
		const { status, stdout } = runScript(JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt: "ulw go" }));
		assert.equal(status, 0);
		if (stdout !== "") {
			assert.match(parseHookOutput(stdout).hookSpecificOutput.additionalContext, /^<ultrawork-mode>/);
		}
	});
});
