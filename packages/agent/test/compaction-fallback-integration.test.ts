import { describe, expect, it } from "bun:test";
import {
	summarizeWithFallback,
	type SummarizeWithFallbackOptions,
} from "@oh-my-pi/pi-agent-core/compaction/fallback-integration";

/**
 * T13 — the fallback chain on the real compaction path.
 *
 * `generateSummary` has a oneshot retry budget, but it retries the *same*
 * model. When the provider is hard-limited, no number of retries against the
 * same route can succeed — which is exactly what happened: six identical
 * `Too Many Requests` errors and a dead session.
 *
 * So the compaction call is wrapped: primary → sibling model → model-free
 * structural digest. This module is that wrapper, kept separate from
 * `generateSummary` so it can be tested without a provider.
 */

describe("summarize with fallback", () => {
	it("uses the primary when it succeeds", async () => {
		const result = await summarizeWithFallback({
			primary: async () => "primary summary",
			structuralDigest: "digest",
		});
		expect(result.summary).toBe("primary summary");
		expect(result.source).toBe("primary");
	});

	it("falls back to the sibling on a rate limit", async () => {
		const result = await summarizeWithFallback({
			primary: async () => {
				throw new Error("AI_APICallError: Too Many Requests");
			},
			sibling: async () => "sibling summary",
			structuralDigest: "digest",
		});
		expect(result.summary).toBe("sibling summary");
		expect(result.source).toBe("sibling");
	});

	it("falls back to the structural digest when every model fails", async () => {
		const result = await summarizeWithFallback({
			primary: async () => {
				throw new Error("Too Many Requests");
			},
			sibling: async () => {
				throw new Error("402 Payment Required");
			},
			structuralDigest: "digest",
		});
		expect(result.summary).toBe("digest");
		expect(result.source).toBe("local-digest");
	});

	it("never throws when a digest is available", async () => {
		const result = await summarizeWithFallback({
			primary: async () => {
				throw new Error("boom");
			},
			structuralDigest: "digest",
		});
		expect(result.summary).toBe("digest");
	});

	it("propagates the failure when no digest is available", async () => {
		await expect(
			summarizeWithFallback({
				primary: async () => {
					throw new Error("boom");
				},
			}),
		).rejects.toThrow();
	});

	it("records which model produced the summary", async () => {
		const result = await summarizeWithFallback({
			primary: async () => ({ summary: "s", model: "mercury-3" }),
			structuralDigest: "digest",
		});
		expect(result.model).toBe("mercury-3");
	});

	it("passes the request through to the summarizer", async () => {
		let seen: string | undefined;
		const options: SummarizeWithFallbackOptions = {
			primary: async request => {
				seen = request.conversation;
				return "s";
			},
			structuralDigest: "digest",
		};
		await summarizeWithFallback({ ...options, conversation: "the conversation" });
		expect(seen).toBe("the conversation");
	});

	it("reports the fallback reason", async () => {
		const result = await summarizeWithFallback({
			primary: async () => {
				throw new Error("Too Many Requests");
			},
			sibling: async () => "sibling",
			structuralDigest: "digest",
		});
		expect(result.fallbackReason).toContain("rate");
	});
});
