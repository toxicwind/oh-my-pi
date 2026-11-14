/**
 * Proof verifier — answers "is this artifact actually good?" with the engine
 * that can answer it, and names itself when it does.
 *
 * Every check here is delegated to a real engine:
 *
 *  - diagnostics come from the **language server**, not from grepping the
 *    source for the word "error";
 *  - symbol resolution comes from the language server's symbol table, so a
 *    dangling reference is a failure rather than a guess.
 *
 * Every result records the engine that produced it. A proof that cannot say
 * where it came from is not a proof.
 *
 * The verifier fails closed. An unreachable language server yields
 * `{ok: false, error}`, never a silent pass — an unverifiable artifact must
 * not be certified.
 */

/** A diagnostic as reported by the language server. */
export interface ProofDiagnostic {
	readonly severity: "error" | "warning" | "info" | "hint";
	readonly message: string;
	readonly uri?: string;
	readonly line?: number;
}

/** The language-server surface the verifier needs. */
export interface LspDiagnosticsClient {
	/** Diagnostics for a path. Throws when the server is unreachable. */
	diagnosticsFor(path: string): Promise<ProofDiagnostic[]>;
}

/** The symbol surface the verifier needs. */
export interface LspSymbolClient {
	/** Resolves a symbol name to its definition. */
	resolve(name: string): Promise<{ name: string; kind: string; uri: string; container?: string } | undefined>;
}

/** Result of a diagnostics check. */
export interface DiagnosticsVerdict {
	readonly ok: boolean;
	readonly diagnostics: readonly ProofDiagnostic[];
	/** The engine that produced the verdict. */
	readonly engine: string;
	readonly checkedAt: number;
	/** Populated when the check could not run. */
	readonly error?: string;
}

/** Result of a symbol-resolution check. */
export interface SymbolVerdict {
	readonly ok: boolean;
	readonly symbol?: { name: string; kind: string; uri: string; container?: string };
	readonly engine: string;
	readonly checkedAt: number;
	readonly error?: string;
}

/** The verifier interface. */
export interface ProofVerifier {
	/** True when the file has no error-severity diagnostics. */
	verifyDiagnosticsClean(path: string): Promise<DiagnosticsVerdict>;
	/** True when the symbol resolves to a definition. */
	verifySymbolResolved(name: string): Promise<SymbolVerdict>;
}

/** Options for {@link createProofVerifier}. */
export interface ProofVerifierOptions {
	readonly lsp?: LspDiagnosticsClient;
	readonly symbols?: LspSymbolClient;
	readonly now?: () => number;
}

/** Creates a proof verifier. */
export function createProofVerifier(options: ProofVerifierOptions): ProofVerifier {
	const now = options.now ?? (() => Date.now());

	return {
		async verifyDiagnosticsClean(path: string): Promise<DiagnosticsVerdict> {
			if (!options.lsp) {
				return {
					ok: false,
					diagnostics: [],
					engine: "lsp",
					checkedAt: now(),
					error: "language server unavailable: diagnostics cannot be verified",
				};
			}
			try {
				const diagnostics = await options.lsp.diagnosticsFor(path);
				const hasError = diagnostics.some(d => d.severity === "error");
				return { ok: !hasError, diagnostics, engine: "lsp", checkedAt: now() };
			} catch (error) {
				return {
					ok: false,
					diagnostics: [],
					engine: "lsp",
					checkedAt: now(),
					error: error instanceof Error ? error.message : String(error),
				};
			}
		},

		async verifySymbolResolved(name: string): Promise<SymbolVerdict> {
			if (!options.symbols) {
				return {
					ok: false,
					engine: "lsp",
					checkedAt: now(),
					error: "language server unavailable: symbol resolution cannot be verified",
				};
			}
			try {
				const symbol = await options.symbols.resolve(name);
				if (!symbol) {
					return {
						ok: false,
						engine: "lsp",
						checkedAt: now(),
						error: `symbol \`${name}\` does not resolve to a definition`,
					};
				}
				return { ok: true, symbol, engine: "lsp", checkedAt: now() };
			} catch (error) {
				return {
					ok: false,
					engine: "lsp",
					checkedAt: now(),
					error: error instanceof Error ? error.message : String(error),
				};
			}
		},
	};
}
