/**
 * Enforcement runtime — the single place the five layers meet.
 *
 * Each layer on its own is a library. This is where they become behaviour:
 *
 *  - every human turn produces an {@link IntentFrame} (what was asked, in
 *    machine-readable form);
 *  - every human *correction* additionally compiles into an obligation that is
 *    persisted, so it survives a restart instead of evaporating;
 *  - every tool call is checked against the active obligations and a
 *    re-violation is *recorded* — the runtime never blocks, because blocking on
 *    a heuristic would be a behaviour patch rather than a contract;
 *  - every tool call is charged against the budget governor, which redirects
 *    when the investigation stops producing new evidence.
 *
 * What the runtime refuses to do is the important half: it does not decide
 * whether an action was relevant, and it does not lie about completion. The
 * completion gate owns that, and the gate demands proof.
 */

import {
	type ActionProbe,
	compileObligation,
	createObligationLedger,
	type Obligation,
	type ObligationLedger,
	type ObligationSnapshotEntry,
	type ObligationViolation,
} from "@oh-my-pi/pi-agent-core/obligation-ledger";
import { buildIntentFrame, type IntentFrame } from "@oh-my-pi/pi-agent-core/intent-frame";
import {
	type BudgetAction,
	type BudgetGovernor,
	type BudgetVerdict,
	createBudgetGovernor,
	type NoveltySignal,
} from "@oh-my-pi/pi-agent-core/budget-governor";

/** A recorded re-violation. */
export interface RecordedViolation {
	readonly obligationId: string;
	readonly subject: string;
	readonly kind: string;
	readonly evidence: string;
	readonly engine: string;
	readonly toolName: string;
	readonly at: number;
}

/** A plain-data snapshot of the whole runtime. */
export interface EnforcementSnapshot {
	readonly obligations: readonly ObligationSnapshotEntry[];
	readonly violations: readonly RecordedViolation[];
	readonly frames: readonly { raw: string; actions: readonly string[]; symbols: readonly string[] }[];
}

/** The runtime interface. */
export interface EnforcementRuntime {
	/** Builds the intent frame for a human turn. */
	observeTurn(text: string): IntentFrame | undefined;
	/**
	 * Compiles a human correction into an obligation and records it.
	 *
	 * Separate from {@link observeTurn} because a turn and a correction are
	 * different things: almost every turn produces a frame, but only a
	 * correction produces a rule. Collapsing them would force the caller to
	 * guess which one it got back.
	 */
	observeCorrection(text: string): Obligation | undefined;
	/** Checks a tool call against the active obligations. */
	checkToolCall(toolName: string, args: Readonly<Record<string, unknown>>): Promise<ObligationViolation[]>;
	/** Charges the budget governor. */
	chargeBudget(toolName: string, novelty?: NoveltySignal): BudgetVerdict;
	/** The intent frames seen so far. */
	frames(): readonly IntentFrame[];
	/** The re-violations recorded so far. */
	violations(): readonly RecordedViolation[];
	/** A plain-data snapshot for persistence. */
	snapshot(): EnforcementSnapshot;
	/** Restores from a snapshot. */
	rehydrate(snapshot: EnforcementSnapshot): void;
	/** The underlying obligation ledger. */
	ledger(): ObligationLedger;
}

/** Options for {@link createEnforcementRuntime}. */
export interface EnforcementRuntimeOptions {
	/** Resolves an identifier to a symbol (LSP in production). */
	readonly resolveSymbol?: (identifier: string) => { name: string; kind: string; uri: string } | undefined;
	/** Novelty floor for the budget governor. */
	readonly noveltyFloor?: number;
	/** Sliding window size for the novelty rate. */
	readonly windowSize?: number;
	/** Hard ceiling on tool calls. */
	readonly maxToolCalls?: number;
	/** Clock injection for deterministic tests. */
	readonly now?: () => number;
}

/** Tools whose arguments carry a shell command. */
const SHELL_TOOLS = new Set(["bash", "shell", "exec", "run", "bash-interactive"]);

/**
 * Extracts an {@link ActionProbe} from a tool call.
 *
 * Only the probe kinds the obligation predicates understand are produced; an
 * unrecognised tool yields `undefined` and is simply not checked, which is
 * recorded as "not applicable" rather than "passed".
 */
export function probeForToolCall(toolName: string, args: Readonly<Record<string, unknown>>): ActionProbe | undefined {
	if (SHELL_TOOLS.has(toolName)) {
		const command = args.command ?? args.cmd ?? args.script;
		if (typeof command === "string" && command.length > 0) {
			return { kind: "bash", command };
		}
		return undefined;
	}
	if (toolName === "read" || toolName === "edit" || toolName === "write" || toolName === "ast_edit") {
		const path = args.path ?? args.file ?? args.filePath ?? args.file_path;
		if (typeof path === "string" && path.length > 0) {
			return { kind: toolName === "read" ? "file-read" : "file-write", path };
		}
		return undefined;
	}
	return { kind: "tool", tool: toolName, args };
}

/** Creates an enforcement runtime. */
export function createEnforcementRuntime(options: EnforcementRuntimeOptions = {}): EnforcementRuntime {
	const now = options.now ?? (() => Date.now());
	const ledger = createObligationLedger();
	const frames: IntentFrame[] = [];
	const violations: RecordedViolation[] = [];
	const governor: BudgetGovernor = createBudgetGovernor({
		maxToolCalls: options.maxToolCalls ?? 200,
		noveltyFloor: options.noveltyFloor ?? 0.05,
		windowSize: options.windowSize ?? 8,
	});

	return {
		observeTurn(text: string): IntentFrame | undefined {
			if (!text || text.trim().length === 0) return undefined;
			const frame = buildIntentFrame(text, { resolveSymbol: options.resolveSymbol });
			frames.push(frame);
			return frame;
		},

		observeCorrection(text: string): Obligation | undefined {
			const obligation: Obligation | undefined = compileObligation(text);
			if (obligation) ledger.record(obligation);
			return obligation;
		},

		async checkToolCall(toolName: string, args: Readonly<Record<string, unknown>>): Promise<ObligationViolation[]> {
			const probe = probeForToolCall(toolName, args);
			if (!probe) return [];
			const found = await ledger.check(probe);
			for (const violation of found) {
				violations.push({
					obligationId: violation.obligation.id,
					subject: violation.obligation.subject,
					kind: violation.obligation.kind,
					evidence: violation.evidence,
					engine: violation.engine,
					toolName,
					at: now(),
				});
			}
			return found;
		},

		chargeBudget(toolName: string, novelty?: NoveltySignal): BudgetVerdict {
			const action: BudgetAction = novelty ? { toolCall: toolName, novelty } : { toolCall: toolName };
			return governor.evaluate(action);
		},

		frames(): readonly IntentFrame[] {
			return frames;
		},

		violations(): readonly RecordedViolation[] {
			return violations;
		},

		snapshot(): EnforcementSnapshot {
			return {
				obligations: ledger.snapshot(),
				violations: [...violations],
				frames: frames.map(f => ({
					raw: f.raw,
					actions: f.actions,
					symbols: f.symbols.map(s => s.name),
				})),
			};
		},

		rehydrate(snapshot: EnforcementSnapshot): void {
			ledger.rehydrate(snapshot.obligations);
			violations.length = 0;
			violations.push(...snapshot.violations);
			frames.length = 0;
			for (const frame of snapshot.frames) {
				frames.push(
					buildIntentFrame(frame.raw, {
						resolveSymbol: options.resolveSymbol,
					}),
				);
			}
		},

		ledger(): ObligationLedger {
			return ledger;
		},
	};
}
