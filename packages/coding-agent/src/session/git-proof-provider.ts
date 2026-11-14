/**
 * Git proof provider — the completion gate's source of truth for "is this
 * work actually committed?".
 *
 * It reads git through the native VCS module (the same one the git TUI uses)
 * rather than shelling out, so the answer is git's own and costs no process
 * spawn. Three facts are enough:
 *
 *  - `headSha` — is there a commit at all? Without one nothing can be proven.
 *  - `lsFiles` — which paths does git track?
 *  - `status --porcelain` — which paths are untracked? (A tracked-but-modified
 *    path is still tracked; the work is committed *somewhere*, and the gate's
 *    question is whether the artifact exists in git, not whether the tree is
 *    pristine.)
 *
 * The provider is deliberately conservative: a path it cannot prove tracked is
 * reported as untracked, because a gate that waves through unproven work is
 * worse than no gate.
 */

import * as vcs from "@oh-my-pi/pi-natives/vcs";
import type { GitProofProvider } from "./completion-gate";

/** The subset of the native git repo this provider needs. */
export interface GitRepo {
	/** The current HEAD sha, or undefined/null when there is no commit. */
	headSha(signal?: unknown): Promise<string | undefined | null>;
	/** Tracked paths (or untracked ones when `others` is set). */
	lsFiles(others: boolean, excludeStandard: boolean, signal?: unknown): Promise<string[]>;
	/** Porcelain status output. */
	statusPorcelain(options: { untracked?: string; nulTerminated?: boolean }, signal?: unknown): Promise<string>;
}

/** Options for {@link createGitProofProvider}. */
export interface GitProofProviderOptions {
	/** The repository to read. */
	readonly repo: GitRepo;
	/** Cancellation handle forwarded to the native calls. */
	readonly signal?: AbortSignal;
}

/** Normalises a path to forward slashes with no leading "./". */
function normalize(path: string): string {
	let p = path.replace(/\\/g, "/").trim();
	while (p.startsWith("./")) p = p.slice(2);
	return p;
}

/** Extracts the untracked paths from porcelain status output. */
export function parseUntrackedPaths(status: string): string[] {
	const untracked: string[] = [];
	for (const line of status.split("\n")) {
		if (line.length < 4) continue;
		// Porcelain v1: two status columns, a space, then the path. "??" is the
		// untracked code; "A " (staged add) is *tracked* — git already knows it.
		if (line.slice(0, 2) !== "??") continue;
		const path = line.slice(3).trim();
		if (!path) continue;
		untracked.push(normalize(path));
	}
	return untracked;
}

/**
 * Creates a git proof provider backed by the native VCS module.
 *
 * `isTracked` is synchronous by contract (the completion gate needs a
 * decision at the transition), so the tracked-file set is loaded once and
 * refreshed on demand through {@link refresh}.
 */
export function createGitProofProvider(options: GitProofProviderOptions): GitProofProvider & {
	/** Reloads the tracked-file set from git. */
	prepare(): Promise<void>;
} {
	const tracked = new Set<string>();
	let untracked = new Set<string>();
	let head: string | undefined;

	const load = async (): Promise<void> => {
		try {
			const files = await options.repo.lsFiles(false, true, options.signal);
			tracked.clear();
			for (const file of files) tracked.add(normalize(file));
		} catch {
			// A repository that cannot be read proves nothing: leave the set
			// empty so every path is treated as untracked and the gate refuses.
			tracked.clear();
		}
		try {
			const status = await options.repo.statusPorcelain({ untracked: "all" }, options.signal);
			untracked = new Set(parseUntrackedPaths(status));
		} catch {
			untracked = new Set();
		}
		try {
			const sha = await options.repo.headSha(options.signal);
			head = sha ?? undefined;
		} catch {
			head = undefined;
		}
	};

	// The provider is created eagerly; the first load is kicked off and the
	// gate awaits `refresh()` before it decides.
	void load();

	return {
		async prepare(): Promise<void> {
			await load();
		},
		isTracked(path: string): boolean {
			const normalized = normalize(path);
			if (untracked.has(normalized)) return false;
			return tracked.has(normalized);
		},
		untrackedPaths(): readonly string[] {
			return [...untracked];
		},
		headSha(): string | undefined {
			return head;
		},
	};
}

/**
 * Creates a git proof provider for a directory, using the native VCS module.
 * Returns undefined when the directory is not inside a git repository.
 */
export function createGitProofProviderForDir(cwd: string): GitProofProvider | undefined {
	const repo = vcs.git(cwd);
	if (!repo) return undefined;
	return createGitProofProvider({ repo });
}
