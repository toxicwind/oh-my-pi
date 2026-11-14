/**
 * The compaction fallback, wired.
 *
 * `generateSummary` retries a transient failure against the *same* model,
 * which is necessary and not sufficient: when the provider is hard-limited,
 * no retry against the same route can succeed. The observed death was six
 * identical `Too Many Requests` errors from one free route, and then a
 * session with 294k tokens of context that could not be resumed.
 *
 * So the compaction call goes through this wrapper:
 *
 *   1. the primary summarizer (with its existing retry budget),
 *   2. a sibling summarizer — a different route that may not be limited,
 *   3. the model-free structural digest, which cannot fail.
 *
 * The third tier is what makes compaction non-fatal. It is lossy; a failed
 * compaction is not.
 */

import {
	createSummarizationFallbackChain,
	type SummarizationRequest,
	type SummarizationResult,
} from "./fallback-chain";

/** A summarizer that takes the request and returns a summary. */
export type CompactionSummarizer = (
	request: SummarizationRequest,
) => Promise<string | { summary: string; model?: string }>;

/** Options for {@link summarizeWithFallback}. */
export interface SummarizeWithFallbackOptions {
	/** The primary summarizer. */
	readonly primary: CompactionSummarizer;
	/** A second route, tried when the primary is rate-limited. */
	readonly sibling?: CompactionSummarizer;
	/** The model-free digest used when every model fails. */
	readonly structuralDigest?: string;
	/** The conversation text, forwarded to the summarizers. */
	readonly conversation?: string;
	/** Where the obligation ledger lives, carried into the digest. */
	readonly ledgerReference?: { readonly path: string; readonly digest: string };
}

/** The outcome of a fallback summarization. */
export type CompactionSummaryResult = SummarizationResult;

/**
 * Summarizes with the fallback chain.
 *
 * Never throws when a structural digest is available: the whole point is that
 * a rate-limited provider cannot destroy a session.
 */
export async function summarizeWithFallback(options: SummarizeWithFallbackOptions): Promise<CompactionSummaryResult> {
	const request: SummarizationRequest = {
		conversation: options.conversation ?? "",
		structuralDigest: options.structuralDigest,
		ledgerReference: options.ledgerReference,
	};

	// The chain calls a summarizer with the request; the adapter normalizes
	// the two shapes a summarizer may return into the chain's shape. It must
	// stay a *function* — returning the promise directly would make the chain
	// call a promise instead of a summarizer.
	const normalize = (summarizer: CompactionSummarizer) => async (chainRequest: SummarizationRequest) => {
		const result = await summarizer(chainRequest);
		if (typeof result === "string") return { summary: result };
		return result;
	};

	const chain = createSummarizationFallbackChain({
		primary: normalize(options.primary),
		sibling: options.sibling ? normalize(options.sibling) : undefined,
	});
	return chain.summarize(request);
}
