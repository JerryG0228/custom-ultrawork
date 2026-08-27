#!/usr/bin/env node
// UserPromptSubmit hook: injects the ulw SKILL.md body as additionalContext when
// the prompt asks for ultrawork. 1:1 port of omo's codex-hook.ts, guard order included.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ULTRAWORK_CURRENT_PROMPT_PATTERN = /(?:ultrawork|ulw(?!-(?:plan|research)))/i;
const ULTRAWORK_DIRECTIVE_MARKER = "<ultrawork-mode>";
const TRANSCRIPT_SEARCH_BYTES = 512_000;
const CONTEXT_PRESSURE_MARKERS = [
	"context compacted",
	"context_length_exceeded",
	"skill descriptions were shortened",
	"context_too_large",
	"codex ran out of room in the model's context window",
	"your input exceeds the context window",
	"long threads and multiple compactions",
];

const ULTRAWORK_SKILL_FILE_URL = new URL("../skills/ulw/SKILL.md", import.meta.url);

/** Path of the SKILL.md whose body gets injected. */
export function resolveUltraworkSkillFilePath() {
	return fileURLToPath(ULTRAWORK_SKILL_FILE_URL);
}

/**
 * @param {unknown} input hook event payload
 * @param {{skillFilePath?: string | null}} [options]
 * @returns {string} hook stdout ("" means: stay quiet)
 */
export function runUserPromptSubmitHook(input, options = {}) {
	if (!isUserPromptSubmitInput(input)) return "";
	if (isContextPressureRecoveryPrompt(input.prompt)) return "";
	if (hasUltraworkDirectiveAlreadyInTranscript(input.transcript_path)) return "";
	if (isContextPressureTranscript(input.transcript_path)) return "";
	return isUltraworkPrompt(input.prompt) ? formatAdditionalContextOutput(buildUltraworkAdditionalContext(options)) : "";
}

export function isUltraworkPrompt(prompt) {
	return ULTRAWORK_CURRENT_PROMPT_PATTERN.test(prompt);
}

// Port of omo skill-pointer.ts ULTRAWORK_SKILL_POINTER_TEMPLATE. Step 2's goal tool is
// this plugin's own MCP server (mcp/ulw-goal-server.mjs) instead of Codex's host create_goal.
const ULTRAWORK_SKILL_POINTER_TEMPLATE = `<ultrawork-mode>
ULTRAWORK MODE IS ACTIVE FOR THIS TASK.

MANDATORY BOOTSTRAP: do all three steps, in order, before anything else.

1. First user-visible line this turn MUST be exactly:
\`ULTRAWORK MODE ENABLED!\`

2. Call \`mcp__plugin_ulw_ulw-goal__create_goal\` NOW with \`objective\` set to
the user's request. Send \`objective\` only: no \`status\`, no budget fields.
If that tool is unavailable, open your reply with a binding \`# Goal\`
block instead. Never skip this step.

3. Read the FULL ultrawork directive NOW, before any other tool call,
plan, or edit. It is the \`ulw\` skill (\`/ulw:ulw\`), stored at:

{{ULTRAWORK_SKILL_PATH}}

Read the whole file. If a read result comes back truncated, keep
reading the remaining line ranges until you have seen every line.
Every rule in that file is binding for this entire task: no
compromise, no summarizing from memory, no skipping. If the file does
not exist, tell the user the ulw ultrawork skill is missing and
continue with steps 1 and 2 plus evidence-bound execution.

Do not start the requested work until all three steps are complete.
</ultrawork-mode>
`;

/**
 * Short pointer at the SKILL.md — NOT its body. Claude Code truncates any hook stdout
 * over ~2KB to a preview + file pointer, so injecting the 33KB directive made delivery
 * luck-based (the model only saw the whole thing when it happened to cat the spill file).
 * Tagged with the marker so the transcript dedup guard (guard 2) can see it.
 */
export function buildUltraworkAdditionalContext(options = {}) {
	const skillFilePath = options.skillFilePath === undefined ? resolveUltraworkSkillFilePath() : options.skillFilePath;
	if (skillFilePath === null) return "";

	try {
		if (stripFrontmatter(readFileSync(skillFilePath, "utf8")).length === 0) return "";
	} catch {
		return "";
	}

	return ULTRAWORK_SKILL_POINTER_TEMPLATE.replace("{{ULTRAWORK_SKILL_PATH}}", skillFilePath);
}

function stripFrontmatter(raw) {
	return raw.replace(/^﻿/, "").replace(/^---[ \t]*\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/, "").trim();
}

function hasUltraworkDirectiveAlreadyInTranscript(transcriptPath) {
	if (transcriptPath === undefined || transcriptPath === null) return false;
	let rawTranscript;
	try {
		rawTranscript = readTranscriptTail(transcriptPath);
	} catch {
		return false;
	}

	for (const line of rawTranscript.split(/\r?\n/)) {
		const parsed = parseJsonLine(line);
		if (!isRecord(parsed)) continue;

		const hookSpecificOutput = parsed["hookSpecificOutput"];
		if (!isRecord(hookSpecificOutput)) continue;
		if (hookSpecificOutput["hookEventName"] !== "UserPromptSubmit") continue;

		if (
			typeof hookSpecificOutput["additionalContext"] === "string" &&
			hookSpecificOutput["additionalContext"].includes(ULTRAWORK_DIRECTIVE_MARKER)
		) {
			return true;
		}
	}

	return false;
}

function isContextPressureTranscript(transcriptPath) {
	if (transcriptPath === undefined || transcriptPath === null) return false;
	try {
		return isContextPressureRecoveryPrompt(readTranscriptTail(transcriptPath));
	} catch {
		return false;
	}
}

function readTranscriptTail(transcriptPath) {
	const rawTranscript = readFileSync(transcriptPath);
	return rawTranscript.subarray(Math.max(0, rawTranscript.byteLength - TRANSCRIPT_SEARCH_BYTES)).toString("utf8");
}

function isContextPressureRecoveryPrompt(prompt) {
	const normalizedPrompt = prompt.toLowerCase();
	return CONTEXT_PRESSURE_MARKERS.some((marker) => normalizedPrompt.includes(marker));
}

function formatAdditionalContextOutput(additionalContext) {
	const normalizedContext = additionalContext.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
	if (normalizedContext.length === 0) return "";
	return `${JSON.stringify({
		hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: normalizedContext },
	})}\n`;
}

function parseJsonLine(line) {
	if (line.trim().length === 0) return null;
	try {
		return JSON.parse(line);
	} catch {
		return null;
	}
}

function isUserPromptSubmitInput(value) {
	return (
		isRecord(value) &&
		value["hook_event_name"] === "UserPromptSubmit" &&
		typeof value["prompt"] === "string" &&
		(value["transcript_path"] === undefined ||
			value["transcript_path"] === null ||
			typeof value["transcript_path"] === "string")
	);
}

function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const chunks = [];
	for await (const chunk of process.stdin) chunks.push(chunk);
	process.stdout.write(runUserPromptSubmitHook(parseJsonLine(Buffer.concat(chunks).toString("utf8"))));
}
