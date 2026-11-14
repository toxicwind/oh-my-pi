import { describe, expect, it } from "bun:test";
import {
	createProofVerifier,
	type LspDiagnosticsClient,
	type ProofVerifier,
} from "@oh-my-pi/pi-coding-agent/session/proof-verifier";

/**
 * T5 — LSP-clean proof.
 *
 * "Is this file clean?" must be answered by the language server, not by a grep
 * for the word `error`. The proof must also name the engine that produced it,
 * so a later reader knows it was not a heuristic.
 */

/** A stub LSP client reporting a fixed diagnostic set per path. */
function lspStub(
	diagnostics: Record<string, { severity: "error" | "warning"; message: string }[]>,
): LspDiagnosticsClient {
	return {
		async diagnosticsFor(path: string) {
			return diagnostics[path] ?? [];
		},
	};
}

describe("proof verifier", () => {
	it("reports a file with an error diagnostic as not clean", async () => {
		const verifier: ProofVerifier = createProofVerifier({
			lsp: lspStub({ "src/a.ts": [{ severity: "error", message: "TS2304: Cannot find name 'x'" }] }),
		});
		const result = await verifier.verifyDiagnosticsClean("src/a.ts");
		expect(result.ok).toBe(false);
		expect(result.diagnostics).toHaveLength(1);
		expect(result.diagnostics[0]?.message).toContain("TS2304");
	});

	it("reports a file with only warnings as clean of errors", async () => {
		const verifier = createProofVerifier({
			lsp: lspStub({ "src/a.ts": [{ severity: "warning", message: "unused" }] }),
		});
		const result = await verifier.verifyDiagnosticsClean("src/a.ts");
		expect(result.ok).toBe(true);
		expect(result.diagnostics).toHaveLength(1);
	});

	it("records the engine that produced the proof", async () => {
		const verifier = createProofVerifier({ lsp: lspStub({}) });
		const result = await verifier.verifyDiagnosticsClean("src/a.ts");
		expect(result.engine).toBe("lsp");
		expect(result.checkedAt).toBeGreaterThan(0);
	});

	it("fails closed when the language server throws", async () => {
		const verifier = createProofVerifier({
			lsp: {
				async diagnosticsFor() {
					throw new Error("server disconnected");
				},
			},
		});
		const result = await verifier.verifyDiagnosticsClean("src/a.ts");
		expect(result.ok).toBe(false);
		expect(result.error).toContain("server disconnected");
	});

	it("fails closed when no language server is configured", async () => {
		const verifier = createProofVerifier({});
		const result = await verifier.verifyDiagnosticsClean("src/a.ts");
		expect(result.ok).toBe(false);
		expect(result.error).toContain("unavailable");
	});

	it("resolves a symbol through the language server", async () => {
		const verifier = createProofVerifier({
			lsp: lspStub({}),
			symbols: {
				async resolve(name: string) {
					if (name !== "peekLiveSteeredMessages") return undefined;
					return { name, kind: "method", uri: "file:///repo/src/agent.ts" };
				},
			},
		});
		const result = await verifier.verifySymbolResolved("peekLiveSteeredMessages");
		expect(result.ok).toBe(true);
		expect(result.symbol?.uri).toBe("file:///repo/src/agent.ts");
	});

	it("fails when the symbol does not resolve", async () => {
		const verifier = createProofVerifier({
			lsp: lspStub({}),
			symbols: {
				async resolve() {
					return undefined;
				},
			},
		});
		const result = await verifier.verifySymbolResolved("missingSymbol");
		expect(result.ok).toBe(false);
	});
});
