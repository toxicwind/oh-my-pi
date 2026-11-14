import { describe, expect, it } from "bun:test";
import { buildStructuralDigest } from "@oh-my-pi/pi-agent-core/compaction/structural-digest";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core/types";

/**
 * T12 — the model-free structural digest.
 *
 * The last tier of the compaction fallback chain. It must produce a *usable*
 * summary with no model at all, because the failure it exists for is a model
 * that is rate-limited, quota-exhausted, or gone. It cannot call anything.
 *
 * What it preserves is structure, not prose: the turn boundaries, the tool
 * calls that were made, the files that were touched, and the ledger
 * reference. That is enough for an agent to resume working — and it is
 * exactly what a lossy prose summary loses.
 */

function user(text: string): AgentMessage {
	return { role: "user", content: text, timestamp: 1000 };
}

function assistant(text: string, timestamp = 1000): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		timestamp,
		provider: "mock",
		model: "mock",
		api: "mock",
		stopReason: "stop",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	} as AgentMessage;
}

function toolCall(name: string, args: Record<string, unknown>): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id: `t-${name}`, name, arguments: args }],
		timestamp: 1000,
		provider: "mock",
		model: "mock",
		api: "mock",
		stopReason: "toolUse",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	} as unknown as AgentMessage;
}

describe("structural digest", () => {
	it("counts the turns", () => {
		const digest = buildStructuralDigest([user("do it"), assistant("done")]);
		expect(digest).toContain("messages: 2");
	});

	it("lists the tool calls that were made", () => {
		const digest = buildStructuralDigest([user("go"), toolCall("bash", { command: "ls" })]);
		expect(digest).toContain("bash");
	});

	it("lists the files that were touched", () => {
		const digest = buildStructuralDigest([toolCall("edit", { path: "src/a.ts" })]);
		expect(digest).toContain("src/a.ts");
	});

	it("records the commands that were run", () => {
		const digest = buildStructuralDigest([toolCall("bash", { command: "git log --oneline" })]);
		expect(digest).toContain("git log --oneline");
	});

	it("keeps the user turns so the intent survives", () => {
		const digest = buildStructuralDigest([user("fix the peekLiveSteeredMessages crash")]);
		expect(digest).toContain("peekLiveSteeredMessages");
	});

	it("carries the ledger reference when one is given", () => {
		const digest = buildStructuralDigest([user("x")], {
			ledgerReference: { path: "/tmp/obligations.json", digest: "sha256:abc" },
		});
		expect(digest).toContain("/tmp/obligations.json");
		expect(digest).toContain("sha256:abc");
	});

	it("records the todo state when one is given", () => {
		const digest = buildStructuralDigest([user("x")], {
			todoPhases: [{ name: "Tasks", tasks: [{ content: "write the report", status: "completed" }] }],
		});
		expect(digest).toContain("write the report");
		expect(digest).toContain("completed");
	});

	it("handles an empty message list without throwing", () => {
		const digest = buildStructuralDigest([]);
		expect(digest.length).toBeGreaterThan(0);
	});

	it("bounds the output so it cannot blow the context it replaces", () => {
		const many = Array.from({ length: 500 }, (_, i) => user(`message ${i}`));
		const digest = buildStructuralDigest(many, { maxChars: 2000 });
		expect(digest.length).toBeLessThanOrEqual(2200);
	});

	it("is deterministic for the same input", () => {
		const messages = [user("a"), toolCall("bash", { command: "ls" })];
		expect(buildStructuralDigest(messages)).toBe(buildStructuralDigest(messages));
	});
});
