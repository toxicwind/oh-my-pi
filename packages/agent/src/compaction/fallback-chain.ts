/**
 * Summarization fallback chain — compaction cannot be destroyed by a 429.
 *
 * The observed death, verbatim from the session log:
 *
 *     message="stream error" providerID=kilo modelID=kilo-auto/free
 *     agent=compaction error.error="AI_APICallError: Too Many Requests"
 *
 * Six times in a row, and then the session was gone: 294k tokens of context
 * and a 12-item todo list, unrecoverable, because the only summarizer was one
 * rate-limited free route.
 *
 * The existing `oneshotRetry` budget retries a transient failure against the
 * *same* model. That is necessary and not sufficient: when the provider is
 * hard-limited, retrying the same route cannot succeed. So the chain adds two
 * tiers the engine did not have:
 *
 *  1. a **sibling summarizer** — a second model, tried when the primary is
 *     rate-limited or quota-exhausted;
 *  2. a **local structural digest** — no model at all. Turn boundaries, the
 *     tool-call ledger, the todo state, and a reference to the obligation
 *     ledger on disk. It cannot fail because it calls nothing.
 *
 * A compaction that ends in the local digest is lossy. A compaction that fails
 * is fatal. Lossy beats fatal every time.
 */

/** The request the summarizer is given. */
export interface SummarizationRequest {
	/** The conversation text to summarize. */
	readonly conversation: string;
	/**
	 * A deterministic, model-free digest of the session structure. Supplied by
	 * the caller (it knows the turn boundaries, the tool ledger and the todo
	 * state) and used as the last-resort summary.
	 */
	readonly structuralDigest?: string;
	/**
	 * Where the obligation ledger lives on disk, so a post-compaction agent can
	 * restore its obligations instead of re-deriving them from lossy prose.
	 */
	readonly ledgerReference?: { readonly path: string; readonly digest: string };
}

/** One summarization attempt. */
export interface SummarizationAttempt {
	readonly source: "primary" | "sibling" | "local-digest";
	readonly ok: boolean;
	readonly error?: string;
}

/** The result of a summarization. */
export interface SummarizationResult {
	readonly summary: string;
	/** Which tier produced the summary. */
	readonly source: "primary" | "sibling" | "local-digest";
	/** The model that produced it, when a model was used. */
	readonly model?: string;
	/** Every attempt, in order. */
	readonly attempts: readonly SummarizationAttempt[];
	/** Why the chain fell back, when it did. */
	readonly fallbackReason?: string;
	/** The ledger reference, carried through. */
	readonly ledgerReference?: { readonly path: string; readonly digest: string };
}

/** A summarizer: the conversation in, a summary out. */
export type Summarizer = (request: SummarizationRequest) => Promise<{ summary: string; model?: string }>;

/** The chain interface. */
export interface SummarizationFallbackChain {
	/** Summarizes, falling back down the tiers. Throws only when every tier fails. */
	summarize(request: SummarizationRequest): Promise<SummarizationResult>;
}

/** Options for {@link createSummarizationFallbackChain}. */
export interface SummarizationFallbackChainOptions {
	/** The primary summarizer. */
	readonly primary: Summarizer;
	/** A second model, tried when the primary is rate-limited. */
	readonly sibling?: Summarizer;
}

/** Rate-limit and quota failures — the ones a different route can survive. */
const TRANSIENT_PATTERNS: readonly RegExp[] = [
	/too many requests/i,
	/\b429\b/,
	/rate.?limit/i,
	/\b402\b/,
	/payment required/i,
	/quota/i,
	/\b529\b/,
	/overloaded/i,
	/service unavailable/i,
	/\b503\b/,
	/timeout/i,
	/timed out/i,
	/econnreset/i,
	/socket hang up/i,
];

/** True when the failure is one a different route can survive. */
export function isTransientSummarizationFailure(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return TRANSIENT_PATTERNS.some(re => re.test(message));
}

/** Human-readable reason for the fallback, used in the result and the log. */
export function describeFallbackReason(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	if (/too many requests|\b429\b|rate.?limit/i.test(message)) {
		return `primary summarizer hit a rate limit (${message})`;
	}
	if (/\b402\b|payment required|quota/i.test(message)) {
		return `primary summarizer exhausted its quota (${message})`;
	}
	if (/\b529\b|overloaded|service unavailable|\b503\b/i.test(message)) {
		return `primary summarizer was overloaded (${message})`;
	}
	return `primary summarizer failed (${message})`;
}

/** Creates a summarization fallback chain. */
export function createSummarizationFallbackChain(
	options: SummarizationFallbackChainOptions,
): SummarizationFallbackChain {
	return {
		async summarize(request: SummarizationRequest): Promise<SummarizationResult> {
			const attempts: SummarizationAttempt[] = [];
			let fallbackReason: string | undefined;

			try {
				const primary = await options.primary(request);
				attempts.push({ source: "primary", ok: true });
				return {
					summary: primary.summary,
					source: "primary",
					model: primary.model,
					attempts,
					ledgerReference: request.ledgerReference,
				};
			} catch (error) {
				attempts.push({
					source: "primary",
					ok: false,
					error: error instanceof Error ? error.message : String(error),
				});
				fallbackReason = describeFallbackReason(error);
			}

			if (options.sibling) {
				try {
					const sibling = await options.sibling(request);
					attempts.push({ source: "sibling", ok: true });
					return {
						summary: sibling.summary,
						source: "sibling",
						model: sibling.model,
						attempts,
						fallbackReason,
						ledgerReference: request.ledgerReference,
					};
				} catch (error) {
					attempts.push({
						source: "sibling",
						ok: false,
						error: error instanceof Error ? error.message : String(error),
					});
				}
			}

			// The local digest is the unconditional last resort. It is lossy, but
			// a compaction that fails is *fatal* — the session dies with its
			// context and its plan intact-but-unreachable. Lossy beats fatal, so
			// the digest is used for any failure, transient or hard. Only when
			// there is no digest at all does the failure propagate.
			if (request.structuralDigest !== undefined && request.structuralDigest.length > 0) {
				attempts.push({ source: "local-digest", ok: true });
				return {
					summary: request.structuralDigest,
					source: "local-digest",
					attempts,
					fallbackReason,
					ledgerReference: request.ledgerReference,
				};
			}

			// No digest: a hard failure is reported as-is so the caller sees the
			// real problem rather than a disguised one.
			const lastError = attempts[attempts.length - 1]?.error ?? "no summarizer succeeded";
			throw new Error(`compaction failed: ${fallbackReason ?? lastError}`);
		},
	};
}
