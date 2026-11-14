/**
 * Structural digest — a summary with no model in it.
 *
 * This is the last tier of the compaction fallback chain, and it exists
 * because of a concrete death: a session with 294k tokens of context and a
 * twelve-item todo list was destroyed when the summarizer returned
 * `AI_APICallError: Too Many Requests` six times in a row. The compaction
 * never completed, and everything that lived only inside it went with it.
 *
 * A digest cannot call a provider, so it cannot be rate-limited. What it
 * preserves is *structure* rather than prose:
 *
 *  - the turn boundaries and the human's own words (the intent),
 *  - the tool calls that were made (the work),
 *  - the files touched and the commands run (the targets),
 *  - the todo state (the plan),
 *  - the obligation ledger reference (the rules).
 *
 * That is exactly what a lossy prose summary loses, and exactly what an agent
 * needs to keep working. It is not as good as a model-written summary. It is
 * better than a dead session, every time.
 */

import type { AgentMessage } from "../types";

/** A todo phase, as the digest needs to see it. */
export interface DigestTodoPhase {
	readonly name: string;
	readonly tasks: readonly { readonly content: string; readonly status: string }[];
}

/** Options for {@link buildStructuralDigest}. */
export interface StructuralDigestOptions {
	/** Where the obligation ledger lives, so the rules survive too. */
	readonly ledgerReference?: { readonly path: string; readonly digest: string };
	/** The todo state at the time of the digest. */
	readonly todoPhases?: readonly DigestTodoPhase[];
	/** Hard ceiling on the digest length. */
	readonly maxChars?: number;
}

/** Default ceiling — a digest must not become the context problem it replaces. */
const DEFAULT_MAX_CHARS = 8000;

/** Extracts the text of a user message. */
function userText(message: AgentMessage): string | undefined {
	if (message.role !== "user") return undefined;
	if (typeof message.content === "string") return message.content;
	const blocks = (message.content ?? []) as { type: string; text?: string }[];
	const text = blocks
		.filter(block => block.type === "text")
		.map(block => block.text ?? "")
		.join("\n")
		.trim();
	return text.length > 0 ? text : undefined;
}

/** Extracts the tool calls of an assistant message. */
function toolCallsOf(message: AgentMessage): { name: string; args: Record<string, unknown> }[] {
	if (message.role !== "assistant") return [];
	const content = (message as { content?: unknown }).content;
	if (!Array.isArray(content)) return [];
	const calls: { name: string; args: Record<string, unknown> }[] = [];
	for (const block of content as { type?: string; name?: string; arguments?: unknown }[]) {
		if (block.type !== "toolCall") continue;
		if (typeof block.name !== "string") continue;
		const args =
			block.arguments && typeof block.arguments === "object" ? (block.arguments as Record<string, unknown>) : {};
		calls.push({ name: block.name, args });
	}
	return calls;
}

/** The file path an argument object names, if any. */
function pathOf(args: Record<string, unknown>): string | undefined {
	for (const key of ["path", "file", "filePath", "file_path"]) {
		const value = args[key];
		if (typeof value === "string" && value.length > 0) return value;
	}
	return undefined;
}

/** The shell command an argument object names, if any. */
function commandOf(args: Record<string, unknown>): string | undefined {
	for (const key of ["command", "cmd", "script"]) {
		const value = args[key];
		if (typeof value === "string" && value.length > 0) return value;
	}
	return undefined;
}

/**
 * Builds a model-free summary of a conversation.
 *
 * The output is deterministic for the same input: it is a ledger, not prose.
 */
export function buildStructuralDigest(
	messages: readonly AgentMessage[],
	options: StructuralDigestOptions = {},
): string {
	const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;

	const userTurns: string[] = [];
	const toolCounts = new Map<string, number>();
	const files = new Set<string>();
	const commands: string[] = [];

	for (const message of messages) {
		const text = userText(message);
		if (text !== undefined) {
			userTurns.push(text.replace(/\s+/g, " ").trim());
			continue;
		}
		for (const call of toolCallsOf(message)) {
			toolCounts.set(call.name, (toolCounts.get(call.name) ?? 0) + 1);
			const path = pathOf(call.args);
			if (path) files.add(path);
			const command = commandOf(call.args);
			if (command && commands.length < 40) commands.push(command.replace(/\s+/g, " ").trim());
		}
	}

	const lines: string[] = [];
	lines.push("## Structural digest (model-free)");
	lines.push("");
	lines.push(`- messages: ${messages.length}`);
	lines.push(`- user turns: ${userTurns.length}`);
	if (toolCounts.size > 0) {
		const tools = [...toolCounts.entries()].map(([name, count]) => `${name}×${count}`).join(", ");
		lines.push(`- tool calls: ${tools}`);
	}
	lines.push("");

	if (userTurns.length > 0) {
		lines.push("### Human turns");
		lines.push("");
		for (const turn of userTurns.slice(-40)) lines.push(`- ${turn}`);
		lines.push("");
	}

	if (files.size > 0) {
		lines.push("### Files touched");
		lines.push("");
		for (const file of [...files].slice(0, 60)) lines.push(`- ${file}`);
		lines.push("");
	}

	if (commands.length > 0) {
		lines.push("### Commands run");
		lines.push("");
		for (const command of commands) lines.push(`- \`${command}\``);
		lines.push("");
	}

	if (options.todoPhases && options.todoPhases.length > 0) {
		lines.push("### Todo state");
		lines.push("");
		for (const phase of options.todoPhases) {
			lines.push(`- ${phase.name}`);
			for (const task of phase.tasks) lines.push(`  - [${task.status}] ${task.content}`);
		}
		lines.push("");
	}

	if (options.ledgerReference) {
		lines.push("### Obligation ledger");
		lines.push("");
		lines.push(`- path: ${options.ledgerReference.path}`);
		lines.push(`- digest: ${options.ledgerReference.digest}`);
		lines.push("");
	}

	let digest = lines.join("\n");
	if (digest.length > maxChars) {
		// Truncate from the tail: the recent turns and the ledger reference
		// matter most, and the header states the totals either way.
		digest = `${digest.slice(0, maxChars)}\n… (digest truncated at ${maxChars} chars)`;
	}
	return digest;
}
