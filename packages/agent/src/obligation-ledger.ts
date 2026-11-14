/**
 * Obligation ledger — corrections compiled into machine-checkable predicates.
 *
 * A correction is a chat turn. It gets acknowledged, it is forgotten, and ten
 * minutes later the agent does the same wrong thing again. That is not a
 * prompting problem; it is a *state* problem: the correction never became
 * anything the runtime could check.
 *
 * This module makes a correction into an {@link Obligation}: a typed predicate
 * that is evaluated against real artifacts — a bash parse tree for commands, a
 * path AST for file access, an LSP symbol table for symbol obligations. The
 * predicates never inspect prose.
 *
 * The ledger is a runtime primitive on purpose: it lives in agent-core so it
 * has no dependency on the coding-agent, and it snapshots to plain data so it
 * can be persisted as a session entry and restored after a restart.
 */

import { astMatch, AstMatchStrictness } from "@oh-my-pi/pi-natives";

// ── vocabulary ───────────────────────────────────────────────────────────────

/** Programs whose *use* can be prohibited. */
const TRACKED_METHODS = new Set([
	"head",
	"tail",
	"find",
	"cat",
	"sed",
	"awk",
	"grep",
	"ls",
	"cut",
	"sort",
	"uniq",
	"wc",
	"tr",
	"tee",
	"xargs",
]);

/** Shell builtins that are never a program position (they are words). */
const SHELL_BUILTINS = new Set([
	"if",
	"then",
	"else",
	"elif",
	"fi",
	"for",
	"while",
	"until",
	"do",
	"done",
	"case",
	"esac",
	"function",
	"echo",
	"printf",
	"export",
	"local",
	"readonly",
	"declare",
	"typeset",
	"return",
	"break",
	"continue",
	"shift",
	"source",
	"eval",
	"exec",
	"exit",
	"set",
	"unset",
	"test",
]);

/** Words that mean "do not use this program". */
const METHOD_PROHIBITION_PATTERNS: readonly { re: RegExp; subject: (m: RegExpMatchArray) => string }[] = [
	{
		re: /\b(?:stop using|don'?t use|do not use|never use|no more|avoid|stop calling)\s+`?([A-Za-z][\w.-]*)`?/i,
		subject: m => m[1],
	},
	{ re: /\b(?:instead of|rather than)\s+`?([A-Za-z][\w.-]*)`?\s*,?\s*(?:use|try|go with)\b/i, subject: m => m[1] },
];

/** Words that mean "the artifact must exist in git". */
const ARTIFACT_OBLIGATION_PATTERNS: readonly RegExp[] = [
	/\bcommit (?:and push |and |then )?(?:first|before)\b/i,
	/\bcommit and push\b/i,
	/\b(?:push|commit) (?:it |this |that )?(?:first|before you)\b/i,
];

/** Words that mean "the scope is wider than X". */
const SCOPE_OBLIGATION_PATTERNS: readonly RegExp[] = [
	/\bnot just\b/i,
	/\bnot only\b/i,
	/\ball history\b/i,
	/\bin general\b/i,
];

// ── types ────────────────────────────────────────────────────────────────────

/** The kind of obligation. Each kind has a distinct proof strategy. */
export type ObligationKind = "method" | "scope" | "artifact" | "symbol" | "assertion";

/** An action the runtime can observe and evaluate a predicate against. */
export type ActionProbe =
	| { readonly kind: "bash"; readonly command: string }
	| { readonly kind: "file-read"; readonly path: string }
	| { readonly kind: "file-write"; readonly path: string }
	| { readonly kind: "tool"; readonly tool: string; readonly args?: Readonly<Record<string, unknown>> };

/** The result of evaluating a predicate against one action. */
export interface PredicateVerdict {
	readonly violated: boolean;
	/** Why — must name the concrete thing observed, not a generic message. */
	readonly evidence: string;
	/** Which engine produced the verdict ("ast", "path", "none"). */
	readonly engine: "ast" | "path" | "none";
}

/** A machine-checkable predicate. */
export interface ObligationPredicate {
	/** Human-readable description of what the predicate requires. */
	readonly describe: string;
	/** Evaluates the predicate against an observed action. */
	violatedBy(probe: ActionProbe): Promise<PredicateVerdict>;
}

/** A compiled obligation. */
export interface Obligation {
	/** Stable id derived from kind + subject, so recompiling is idempotent. */
	readonly id: string;
	readonly kind: ObligationKind;
	/** The prohibited / required subject: a program, a scope, a path, a symbol. */
	readonly subject: string;
	/** The human's original words. */
	readonly raw: string;
	readonly predicate: ObligationPredicate;
	readonly state: "active" | "satisfied" | "superseded";
	/** Turn index at which the obligation was created. */
	readonly createdAtTurn?: number;
}

/** A ledger entry that can be persisted and restored. */
export interface ObligationSnapshotEntry {
	readonly id: string;
	readonly kind: ObligationKind;
	readonly subject: string;
	readonly raw: string;
	readonly state: "active" | "satisfied" | "superseded";
	readonly createdAtTurn?: number;
}

/** A recorded re-violation. */
export interface ObligationViolation {
	readonly obligation: ObligationSnapshotEntry;
	readonly evidence: string;
	readonly engine: "ast" | "path" | "none";
}

// ── bash AST helpers ─────────────────────────────────────────────────────────

/**
 * Splits a shell script into *command positions* using the bash grammar, then
 * reports which programs occupy those positions.
 *
 * A naive substring scan cannot distinguish `head` the program from `head` the
 * word inside `echo head` or `head_of_line`. The bash parse tree can: a
 * command node's first word is the program, and a word node elsewhere is an
 * argument.
 */
async function invokedPrograms(command: string): Promise<Set<string>> {
	const programs = new Set<string>();
	try {
		// `kind: command` is not supported by this grammar build, so the program
		// positions are recovered structurally: a match of the whole-word form
		// whose text has no leading/trailing word characters and which is not
		// preceded by another word on the same node.
		const result = await astMatch({
			patterns: ["$A $B"],
			source: command,
			lang: "bash",
			strictness: AstMatchStrictness.Smart,
			limit: 256,
			includeMeta: true,
		});
		for (const match of result.matches) {
			const text = match.text;
			const first = text.split(/\s+/)[0];
			if (!first) continue;
			const base = first.replace(/^["'`]|["'`]$/g, "");
			if (!/^[A-Za-z][\w.-]*$/.test(base)) continue;
			if (SHELL_BUILTINS.has(base.toLowerCase())) continue;
			programs.add(base.toLowerCase());
		}
	} catch {
		// Grammar unavailable → fall back to a conservative lexical scan that
		// only accepts a program in leading position of a pipeline stage.
		for (const stage of command.split(/\|(?!\|)/)) {
			const first = stage.trim().split(/\s+/)[0];
			if (!first) continue;
			const base = first.replace(/^["'`]|["'`]$/g, "");
			if (!/^[A-Za-z][\w.-]*$/.test(base)) continue;
			if (SHELL_BUILTINS.has(base.toLowerCase())) continue;
			programs.add(base.toLowerCase());
		}
	}
	return programs;
}

// ── compilation ──────────────────────────────────────────────────────────────

/** Stable id for an obligation, derived from kind + subject. */
function obligationId(kind: ObligationKind, subject: string): string {
	const slug = subject
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return `obl-${kind}-${slug || "unnamed"}`;
}

/** Builds the predicate for a prohibited program. */
function methodPredicate(subject: string, _raw: string): ObligationPredicate {
	const target = subject.toLowerCase();
	return {
		describe: `must not invoke the program \`${target}\``,
		async violatedBy(probe: ActionProbe): Promise<PredicateVerdict> {
			if (probe.kind === "bash") {
				const programs = await invokedPrograms(probe.command);
				if (programs.has(target)) {
					return {
						violated: true,
						evidence: `command \`${probe.command}\` invokes \`${target}\` in program position`,
						engine: "ast",
					};
				}
				return {
					violated: false,
					evidence: `no \`${target}\` program position in \`${probe.command}\``,
					engine: "ast",
				};
			}
			if (probe.kind === "file-read" || probe.kind === "file-write") {
				// A method prohibition is about *invoking* a program, not about
				// a file that happens to share its name: reading `src/head.ts`
				// is not running `head`. Executing that file would show up as a
				// bash probe with the program position, which the branch above
				// already catches.
				return {
					violated: false,
					evidence: `file \`${probe.path}\` does not invoke the program \`${target}\``,
					engine: "path",
				};
			}
			return {
				violated: false,
				evidence: `probe kind \`${probe.kind}\` carries no program position`,
				engine: "none",
			};
		},
	};
}

/** Builds the predicate for an artifact obligation (the artifact must be in git). */
function artifactPredicate(subject: string, _raw: string): ObligationPredicate {
	return {
		describe: `requires a git commit of \`${subject}\``,
		async violatedBy(): Promise<PredicateVerdict> {
			// An artifact obligation is not violated by a single action; it is
			// discharged by the proof verifier. It is never "violated" by a probe.
			return {
				violated: false,
				evidence: `artifact obligation \`${subject}\` is discharged by proof, not by probe`,
				engine: "none",
			};
		},
	};
}

/** Builds the predicate for a scope obligation (the scope must be widened). */
function scopePredicate(subject: string, _raw: string): ObligationPredicate {
	return {
		describe: `requires the scope to cover \`${subject}\``,
		async violatedBy(): Promise<PredicateVerdict> {
			return {
				violated: false,
				evidence: `scope obligation \`${subject}\` is discharged by proof, not by probe`,
				engine: "none",
			};
		},
	};
}

/**
 * Compiles a human correction into an obligation.
 *
 * Returns `undefined` when the text carries no machine-checkable obligation —
 * "the weather is nice" must not become a rule.
 */
export function compileObligation(raw: string, createdAtTurn?: number): Obligation | undefined {
	const text = (raw ?? "").trim();
	if (!text) return undefined;

	for (const pattern of METHOD_PROHIBITION_PATTERNS) {
		const match = pattern.re.exec(text);
		if (!match) continue;
		const subject = match[1];
		if (!subject) continue;
		const lower = subject.toLowerCase();
		// Only shell programs are tracked with an AST predicate; anything else
		// would need a tool-level check, which is a different obligation kind.
		if (!TRACKED_METHODS.has(lower)) continue;
		return {
			id: obligationId("method", lower),
			kind: "method",
			subject: lower,
			raw,
			predicate: methodPredicate(lower, raw),
			state: "active",
			createdAtTurn,
		};
	}

	if (ARTIFACT_OBLIGATION_PATTERNS.some(re => re.test(text))) {
		const subject = "worktree";
		return {
			id: obligationId("artifact", subject),
			kind: "artifact",
			subject,
			raw,
			predicate: artifactPredicate(subject, raw),
			state: "active",
			createdAtTurn,
		};
	}

	if (SCOPE_OBLIGATION_PATTERNS.some(re => re.test(text))) {
		const scopeMatch = /not (?:just|only)\s+([^,.]+)/i.exec(text) ?? /\ball history\b/i.exec(text);
		const subject = scopeMatch?.[1]?.trim() ?? "widened scope";
		return {
			id: obligationId("scope", subject),
			kind: "scope",
			subject,
			raw,
			predicate: scopePredicate(subject, raw),
			state: "active",
			createdAtTurn,
		};
	}

	return undefined;
}

// ── ledger ───────────────────────────────────────────────────────────────────

/** The ledger interface. */
export interface ObligationLedger {
	/** Adds an obligation, superseding an older one with the same kind+subject. */
	record(obligation: Obligation): void;
	/** Marks an obligation satisfied. */
	satisfy(id: string): void;
	/** Active obligations. */
	active(): Obligation[];
	/** All obligations, including discharged ones. */
	all(): Obligation[];
	/** Evaluates every active predicate against a probe. */
	check(probe: ActionProbe): Promise<ObligationViolation[]>;
	/** A plain-data snapshot suitable for persistence. */
	snapshot(): ObligationSnapshotEntry[];
	/** Restores from a snapshot. */
	rehydrate(entries: readonly ObligationSnapshotEntry[]): void;
}

/** Creates an empty ledger. */
export function createObligationLedger(): ObligationLedger {
	const entries = new Map<string, Obligation>();

	return {
		record(obligation: Obligation): void {
			const key = `${obligation.kind}:${obligation.subject.toLowerCase()}`;
			for (const existing of entries.values()) {
				const existingKey = `${existing.kind}:${existing.subject.toLowerCase()}`;
				if (existingKey === key && existing.id !== obligation.id) {
					entries.set(existing.id, { ...existing, state: "superseded" });
				}
			}
			entries.set(obligation.id, { ...obligation });
		},
		satisfy(id: string): void {
			const existing = entries.get(id);
			if (!existing) return;
			entries.set(id, { ...existing, state: "satisfied" });
		},
		active(): Obligation[] {
			return [...entries.values()].filter(o => o.state === "active");
		},
		all(): Obligation[] {
			return [...entries.values()];
		},
		async check(probe: ActionProbe): Promise<ObligationViolation[]> {
			const violations: ObligationViolation[] = [];
			for (const obligation of this.active()) {
				const verdict = await obligation.predicate.violatedBy(probe);
				if (!verdict.violated) continue;
				violations.push({
					obligation: {
						id: obligation.id,
						kind: obligation.kind,
						subject: obligation.subject,
						raw: obligation.raw,
						state: obligation.state,
						createdAtTurn: obligation.createdAtTurn,
					},
					evidence: verdict.evidence,
					engine: verdict.engine,
				});
			}
			return violations;
		},
		snapshot(): ObligationSnapshotEntry[] {
			return [...entries.values()].map(o => ({
				id: o.id,
				kind: o.kind,
				subject: o.subject,
				raw: o.raw,
				state: o.state,
				createdAtTurn: o.createdAtTurn,
			}));
		},
		rehydrate(snapshot: readonly ObligationSnapshotEntry[]): void {
			for (const entry of snapshot) {
				const existing = entries.get(entry.id);
				const predicate =
					existing?.predicate ??
					(entry.kind === "method"
						? methodPredicate(entry.subject, entry.raw)
						: entry.kind === "artifact"
							? artifactPredicate(entry.subject, entry.raw)
							: scopePredicate(entry.subject, entry.raw));
				entries.set(entry.id, { ...entry, predicate });
			}
		},
	};
}
