import { describe, expect, it } from "bun:test";
import {
	createSummarizationFallbackChain,
	type SummarizationFallbackChain,
} from "@oh-my-pi/pi-agent-core/compaction/fallback-chain";

/**
 * T7 — compaction must survive a rate-limited summarizer.
 *
 * The observed death: a 4.3-hour session with 294k tokens of context and a
 * 12-item todo list was destroyed because `/compact` hit a 429 and the
 * compaction never completed. The engine already retries a transient failure
 * against the *same* model; it never switches models and never has a
 * deterministic last resort.
 *
 * The chain therefore has three tiers:
 *
 *  1. the primary summarizer (with the existing retry budget),
 *  2. a configured sibling summarizer,
 *  3. a **local structural digest** — no model at all: turn boundaries, the
 *     tool-call ledger, the todo state and the ledger reference. It cannot
 *     fail because it does not call anything.
 *
 * A compaction that ends in the local digest is degraded but *recoverable*,
 * which is strictly better than a session that cannot be resumed at all.
 */

describe("summarization fallback chain", () => {
	it("uses the primary summarizer when it succeeds", async () => {
		const chain: SummarizationFallbackChain = createSummarizationFallbackChain({
			primary: async () => ({ summary: "primary summary", model: "primary" }),
		});
		const result = await chain.summarize({ conversation: "x" });
		expect(result.summary).toBe("primary summary");
		expect(result.source).toBe("primary");
	});

	it("falls back to the sibling model when the primary is rate limited", async () => {
		const chain = createSummarizationFallbackChain({
			primary: async () => {
				throw new Error("429 Too Many Requests");
			},
			sibling: async () => ({ summary: "sibling summary", model: "sibling" }),
		});
		const result = await chain.summarize({ conversation: "x" });
		expect(result.summary).toBe("sibling summary");
		expect(result.source).toBe("sibling");
	});

	it("falls back to the local structural digest when every model fails", async () => {
		const chain = createSummarizationFallbackChain({
			primary: async () => {
				throw new Error("429 Too Many Requests");
			},
			sibling: async () => {
				throw new Error("402 Payment Required");
			},
		});
		const result = await chain.summarize({
			conversation: "x",
			structuralDigest: "## turns\n- turn 1\n## tools\n- bash x3",
		});
		expect(result.source).toBe("local-digest");
		expect(result.summary).toContain("turn 1");
	});

	it("never throws when a local digest is available", async () => {
		const chain = createSummarizationFallbackChain({
			primary: async () => {
				throw new Error("boom");
			},
		});
		const result = await chain.summarize({ conversation: "x", structuralDigest: "digest" });
		expect(result.summary).toBe("digest");
	});

	it("reports the error when there is no digest to fall back to", async () => {
		const chain = createSummarizationFallbackChain({
			primary: async () => {
				throw new Error("429 Too Many Requests");
			},
		});
		await expect(chain.summarize({ conversation: "x" })).rejects.toThrow();
	});

	it("carries the ledger reference into the summary", async () => {
		const chain = createSummarizationFallbackChain({
			primary: async () => ({ summary: "s", model: "m" }),
		});
		const result = await chain.summarize({
			conversation: "x",
			ledgerReference: { path: "/tmp/obligations.md", digest: "sha256:abc" },
		});
		expect(result.ledgerReference?.path).toBe("/tmp/obligations.md");
		expect(result.ledgerReference?.digest).toBe("sha256:abc");
	});

	it("classifies a rate-limit failure distinctly from a hard failure", async () => {
		const chain = createSummarizationFallbackChain({
			primary: async () => {
				throw new Error("AI_APICallError: Too Many Requests");
			},
			sibling: async () => ({ summary: "sibling", model: "s" }),
		});
		const result = await chain.summarize({ conversation: "x" });
		expect(result.fallbackReason).toContain("rate");
	});

	it("does not fall back on a non-transient failure when a sibling is absent", async () => {
		const chain = createSummarizationFallbackChain({
			primary: async () => {
				throw new Error("invalid request: model not found");
			},
		});
		await expect(chain.summarize({ conversation: "x" })).rejects.toThrow();
	});

	it("records which attempts were made", async () => {
		const chain = createSummarizationFallbackChain({
			primary: async () => {
				throw new Error("429");
			},
			sibling: async () => {
				throw new Error("429");
			},
		});
		const result = await chain.summarize({ conversation: "x", structuralDigest: "d" });
		// Every tier is recorded, including the digest that actually produced
		// the summary — the chain's history is part of the audit trail.
		expect(result.attempts).toHaveLength(3);
		expect(result.attempts[0]?.source).toBe("primary");
		expect(result.attempts[1]?.source).toBe("sibling");
		expect(result.attempts[2]?.source).toBe("local-digest");
	});

	it("does not attempt a sibling that was not configured", async () => {
		const chain = createSummarizationFallbackChain({
			primary: async () => {
				throw new Error("429");
			},
		});
		const result = await chain.summarize({ conversation: "x", structuralDigest: "d" });
		expect(result.attempts.map(a => a.source)).toEqual(["primary", "local-digest"]);
	});
});
