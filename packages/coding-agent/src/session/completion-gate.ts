/**
 * Completion gate — a todo may only be *done* when its artifact is proven.
 *
 * The failure this exists to prevent is concrete, not hypothetical: a session
 * closed with "All work is complete and documented in …" while the entire
 * deliverable sat untracked in the worktree and every todo read `completed`.
 * A completion claim with nothing behind it is an unbacked assertion that the
 * human has to audit by hand — which is exactly what happened.
 *
 * So completion becomes a *proof*: the gate returns what it checked, which
 * engine checked it, and the commit SHA it was checked against. The proof is
 * stored with the todo, so the claim stays auditable after the session dies.
 *
 * The gate fails closed. If the diagnostics engine is unavailable, the gate
 * refuses rather than waving the artifact through — an unverifiable completion
 * is indistinguishable from a false one.
 */

/** Reads the git state the gate needs. Injected so the gate stays testable. */
export interface GitProofProvider {
	/**
	 * Loads the repository state the provider answers from.
	 *
	 * Required because the git state is read asynchronously while
	 * {@link GitProofProvider.isTracked} is a synchronous decision: the gate
	 * awaits this before it asks anything. A provider with no `prepare` is
	 * assumed to already hold its state (a stub, or an in-memory fixture).
	 */
	prepare?(): Promise<void>;
	/** True when the path is tracked by git at HEAD. */
	isTracked(path: string): boolean;
	/** Paths git reports as untracked. */
	untrackedPaths(): readonly string[];
	/**
	 * The current HEAD sha, or undefined when there is no commit yet.
	 *
	 * Synchronous because the gate reads it after `prepare()` has loaded the
	 * repository state; the provider caches the value it read.
	 */
	headSha(): string | undefined;
}

/** A diagnostic reported by the language server. */
export interface DiagnosticReport {
	readonly severity: "error" | "warning" | "info" | "hint";
	readonly message: string;
	readonly uri?: string;
}

/** Checks a file's diagnostics through the language server. */
export interface DiagnosticsProvider {
	/** Resolves the diagnostic state of a path. Throws when the engine is down. */
	check(path: string): Promise<{ ok: true; diagnostics: [] } | { ok: false; diagnostics: DiagnosticReport[] }>;
}

/** What the gate checks. */
export interface CompletionRequest {
	/** The task text, for the failure message. */
	readonly task: string;
	/** Artifact paths the task produced. */
	readonly artifacts: readonly string[];
	/** When true, the artifacts must also be diagnostic-clean. */
	readonly requireDiagnostics?: boolean;
}

/** A single check that succeeded. */
export interface CompletionProof {
	readonly kind: "committed" | "diagnostics-clean";
	/** The path the proof covers. */
	readonly path: string;
	/** Which engine produced the proof. */
	readonly engine: string;
	/** The commit the artifact was verified against, when known. */
	readonly commitSha?: string;
	/** When the proof was taken. */
	readonly checkedAt: number;
}

/** A single check that failed. */
export interface CompletionFailure {
	readonly path: string;
	readonly reason: string;
	readonly engine: string;
}

/** The gate's verdict. */
export interface CompletionVerdict {
	readonly ok: boolean;
	readonly proofs: readonly CompletionProof[];
	readonly failures: readonly CompletionFailure[];
}

/** The gate interface. */
export interface CompletionGate {
	/** Verifies a task's artifacts. Never throws: failures are returned. */
	verify(request: CompletionRequest): Promise<CompletionVerdict>;
}

/** Options for {@link createCompletionGate}. */
export interface CompletionGateOptions {
	readonly git: GitProofProvider;
	readonly diagnostics?: DiagnosticsProvider;
	/** Clock injection for deterministic tests. */
	readonly now?: () => number;
}

/** Creates a completion gate. */
export function createCompletionGate(options: CompletionGateOptions): CompletionGate {
	const now = options.now ?? (() => Date.now());

	return {
		async verify(request: CompletionRequest): Promise<CompletionVerdict> {
			const proofs: CompletionProof[] = [];
			const failures: CompletionFailure[] = [];

			// The git state is read asynchronously; the decision is not. Load it
			// before asking anything about it.
			try {
				await options.git.prepare?.();
			} catch (error) {
				failures.push({
					path: request.artifacts[0] ?? "",
					reason: `git state unavailable: ${error instanceof Error ? error.message : String(error)}`,
					engine: "git",
				});
				return { ok: false, proofs, failures };
			}

			const headSha = options.git.headSha();
			if (request.artifacts.length > 0 && headSha === undefined) {
				failures.push({
					path: request.artifacts[0] ?? "",
					reason: "cannot prove completion: the repository has no HEAD commit yet",
					engine: "git",
				});
				return { ok: false, proofs, failures };
			}

			for (const artifact of request.artifacts) {
				if (!options.git.isTracked(artifact)) {
					failures.push({
						path: artifact,
						reason: "artifact is not tracked by git (uncommitted work cannot be certified as done)",
						engine: "git",
					});
					continue;
				}
				proofs.push({
					kind: "committed",
					path: artifact,
					engine: "git",
					commitSha: headSha,
					checkedAt: now(),
				});
			}

			// Diagnostics are checked whenever the engine is available: a caller
			// that wired an LSP provider asked for the artifact to be verified
			// with it. `requireDiagnostics` additionally demands a provider — it
			// is how a caller says "no LSP means no completion".
			if (options.diagnostics || request.requireDiagnostics) {
				for (const artifact of request.artifacts) {
					if (!options.diagnostics) {
						failures.push({
							path: artifact,
							reason: "diagnostics engine unavailable: completion cannot be certified",
							engine: "lsp",
						});
						continue;
					}
					try {
						const report = await options.diagnostics.check(artifact);
						if (report.ok) {
							proofs.push({
								kind: "diagnostics-clean",
								path: artifact,
								engine: "lsp",
								commitSha: headSha,
								checkedAt: now(),
							});
							continue;
						}
						const errors = report.diagnostics.filter(d => d.severity === "error");
						const first = errors[0] ?? report.diagnostics[0];
						failures.push({
							path: artifact,
							reason: `language server reports ${errors.length} error(s): ${first?.message ?? "unknown"}`,
							engine: "lsp",
						});
					} catch (error) {
						failures.push({
							path: artifact,
							reason: `diagnostics engine unavailable: ${error instanceof Error ? error.message : String(error)}`,
							engine: "lsp",
						});
					}
				}
			}

			return { ok: failures.length === 0, proofs, failures };
		},
	};
}
