/**
 * Budget governor — bounds an investigation by *novelty*, not by effort.
 *
 * The failure this encodes is measured, not imagined. A 4.3-hour session made
 * 1520 tool calls with 166 redundant command executions, ran nine investigation
 * threads at once, and the human said "still not deep enough" four separate
 * times. The agent's depth was repetition dressed as depth: the same
 * `git log` re-run produces the same symbols, which is not new knowledge, but
 * nothing in the runtime could tell the difference.
 *
 * So the governor tracks two things:
 *
 *  - **novelty** — did this action surface a fact that was not already known?
 *    Two inputs: structural fingerprints (AST fingerprints, LSP symbol sets)
 *    and evidence ids (commit shas, row ids, new files). A repeated
 *    fingerprint is *zero* novelty, no matter how many times it is produced.
 *  - **budget** — a hard ceiling on tool calls.
 *
 * When the novelty rate collapses the governor *redirects*; it never blocks.
 * Blocking an agent mid-flight on a novelty heuristic would be a behaviour
 * patch, and this is not that. The redirect names the rate, the floor and the
 * count of actions that produced nothing, so the human can redirect the
 * investigation instead of typing "?" for the fortieth time.
 */

/** What an action produced. Absent signal means "no novelty". */
export interface NoveltySignal {
	/**
	 * Structural fingerprints of the code/artifacts the action touched. The
	 * same fingerprint twice is not new knowledge.
	 */
	readonly astFingerprints?: readonly string[];
	/** Identifiers of facts that were not previously known. */
	readonly evidenceIds?: readonly string[];
}

/** One action evaluated by the governor. */
export interface BudgetAction {
	/** The tool call name, for the report. */
	readonly toolCall: string;
	/** What the action produced. */
	readonly novelty?: NoveltySignal;
}

/** What the governor decided. */
export interface BudgetVerdict {
	readonly verdict: "continue" | "redirect" | "exhausted";
	/** The redirect message, when the verdict is `redirect` or `exhausted`. */
	readonly message?: string;
	/** Total tool calls seen. */
	readonly toolCalls: number;
	/** The novelty rate over the window. */
	readonly noveltyRate: number;
	/** How many actions in the window produced nothing new. */
	readonly zeroNoveltyActions: number;
}

/** The governor interface. */
export interface BudgetGovernor {
	/** Evaluates one action and returns the verdict. */
	evaluate(action: BudgetAction): BudgetVerdict;
	/** The current tool-call count. */
	readonly toolCalls: number;
	/** The current novelty rate. */
	readonly noveltyRate: number;
}

/** Options for {@link createBudgetGovernor}. */
export interface BudgetGovernorOptions {
	/** Hard ceiling on tool calls. */
	readonly maxToolCalls: number;
	/** Novelty rate below which the governor redirects. */
	readonly noveltyFloor: number;
	/** Sliding window size for the novelty rate. */
	readonly windowSize: number;
	/** Clock injection for deterministic tests. */
	readonly now?: () => number;
}

/** Creates a budget governor. */
export function createBudgetGovernor(options: BudgetGovernorOptions): BudgetGovernor {
	const windowSize = Math.max(1, options.windowSize);
	/** Per-action novelty verdict inside the sliding window. */
	const window: boolean[] = [];
	/** Fingerprints already seen — a repeat is not new. */
	const seenFingerprints = new Set<string>();
	/** Evidence ids already seen. */
	const seenEvidence = new Set<string>();
	let toolCalls = 0;

	const isNovel = (signal: NoveltySignal | undefined): boolean => {
		if (!signal) return false;
		let novel = false;
		for (const fingerprint of signal.astFingerprints ?? []) {
			if (seenFingerprints.has(fingerprint)) continue;
			seenFingerprints.add(fingerprint);
			novel = true;
		}
		for (const evidenceId of signal.evidenceIds ?? []) {
			if (seenEvidence.has(evidenceId)) continue;
			seenEvidence.add(evidenceId);
			novel = true;
		}
		return novel;
	};

	const rate = (): number => {
		if (window.length === 0) return 1;
		const novel = window.filter(Boolean).length;
		return novel / window.length;
	};

	return {
		get toolCalls(): number {
			return toolCalls;
		},
		get noveltyRate(): number {
			return rate();
		},
		evaluate(action: BudgetAction): BudgetVerdict {
			toolCalls += 1;
			const novel = isNovel(action.novelty);
			window.push(novel);
			if (window.length > windowSize) window.shift();

			const noveltyRate = rate();
			const zeroNoveltyActions = window.filter(n => !n).length;

			if (toolCalls >= options.maxToolCalls) {
				return {
					verdict: "exhausted",
					message:
						`budget exhausted: ${toolCalls}/${options.maxToolCalls} tool calls used. ` +
						`novelty rate ${noveltyRate.toFixed(3)} (floor ${options.noveltyFloor}). ` +
						`State the stop criterion or raise the budget explicitly.`,
					toolCalls,
					noveltyRate,
					zeroNoveltyActions,
				};
			}

			if (noveltyRate < options.noveltyFloor && window.length >= Math.min(windowSize, 3)) {
				return {
					verdict: "redirect",
					message:
						`budget: ${toolCalls} tool calls, novelty ${noveltyRate.toFixed(3)} ` +
						`(floor ${options.noveltyFloor}); ${zeroNoveltyActions} of the last ${window.length} ` +
						`actions produced no new evidence. Change the axis (different host, artifact, ` +
						`or time window) or state the stop criterion.`,
					toolCalls,
					noveltyRate,
					zeroNoveltyActions,
				};
			}

			return { verdict: "continue", toolCalls, noveltyRate, zeroNoveltyActions };
		},
	};
}
