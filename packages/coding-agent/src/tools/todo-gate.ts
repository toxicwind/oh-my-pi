/**
 * The completion gate, on the todo `done` transition.
 *
 * The `todo` tool is where an agent claims a thing is finished. That claim
 * was, in the session that produced this constitution, completely unchecked:
 * 12/12 todos read `completed` over a deliverable that was still untracked in
 * the worktree, and the session closed with "All work is complete".
 *
 * This module is the decision that stops that. It is deliberately small and
 * deliberately *honest*:
 *
 *  - a task that names its artifacts must have them tracked by git;
 *  - a task that names no artifact is allowed through — the gate proves what
 *    it can and never invents a requirement the agent did not state;
 *  - the refusal says exactly which path is unproven and what to do about it.
 *
 * The git truth comes from the caller (the native VCS module); this module
 * only decides.
 */

/** A path-like token: it has a separator or a file extension. */
const PATH_TOKEN_RE = /[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*\.[A-Za-z0-9]{1,8}/g;

/** Words that look like paths but are prose. */
const NOT_A_PATH = new Set(["e.g", "i.e", "etc", "vs", "u.s", "a.m", "p.m"]);

/**
 * Extracts the artifact paths a task names.
 *
 * The task text is the only place the agent states what it produced, so it is
 * where the requirement comes from. A path needs a separator or an extension
 * to count: "fix the agent" names no artifact, "write docs/a.md" names one.
 */
export function extractArtifactPaths(task: string): string[] {
	if (!task) return [];
	const found: string[] = [];
	const seen = new Set<string>();
	for (const match of task.matchAll(PATH_TOKEN_RE)) {
		const raw = match[0].replace(/^["'`]|["'`]$/g, "");
		if (!raw) continue;
		const lower = raw.toLowerCase();
		if (NOT_A_PATH.has(lower)) continue;
		// A bare "word.md" counts; a bare "word" does not. The regex already
		// requires an extension, so a lone lowercase word never matches.
		const normalized = raw.replace(/\\/g, "/");
		if (seen.has(normalized)) continue;
		seen.add(normalized);
		found.push(normalized);
	}
	return found;
}

/** What the gate knows about one completion attempt. */
export interface TodoGateContext {
	/** The task text, as the agent wrote it. */
	readonly task: string;
	/** The artifact paths the task names. */
	readonly artifacts: readonly string[];
	/** Whether every artifact is tracked by git. */
	readonly tracked: boolean;
	/** The untracked paths, when the caller knows them. */
	readonly untrackedPaths?: readonly string[];
}

/** The gate's decision. */
export interface TodoGateDecision {
	/** Whether the transition may proceed. */
	readonly allowed: boolean;
	/** Why, when it may not. */
	readonly reason?: string;
	/** What the agent should do next, when it may not. */
	readonly hint?: string;
}

/**
 * Decides whether a todo may transition to `completed`.
 *
 * The decision is binary and the reason names the concrete path: an
 * unverifiable completion is indistinguishable from a false one, so the gate
 * refuses rather than warns.
 */
export function todoDoneGateDecision(context: TodoGateContext): TodoGateDecision {
	if (context.artifacts.length === 0) {
		return { allowed: true };
	}
	if (context.tracked) {
		return { allowed: true };
	}
	const untracked = context.untrackedPaths ?? [];
	const offending = context.artifacts.filter(artifact => untracked.includes(artifact));
	const named = offending.length > 0 ? offending : context.artifacts;
	const list = named.map(artifact => `\`${artifact}\``).join(", ");
	return {
		allowed: false,
		reason: `artifact ${list} is not tracked by git — uncommitted work cannot be certified as done`,
		hint: `Commit the work first (git add ${named[0] ?? ""} && git commit), then mark the todo done. The completion gate records the commit SHA it verified against.`,
	};
}
