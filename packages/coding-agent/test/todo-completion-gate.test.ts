import { describe, expect, it } from "bun:test";
import {
	createCompletionGate,
	type CompletionGate,
	type GitProofProvider,
} from "@oh-my-pi/pi-coding-agent/session/completion-gate";

/**
 * T4 — completion gate.
 *
 * The failure this encodes is real: a session finished with the message "All
 * work is complete" while the whole deliverable sat untracked in the worktree,
 * and 12/12 todos read `completed`. Nothing checked.
 *
 * A todo may only be marked done when its artifact is *proven* to exist in git
 * (and, when asked, to be diagnostic-clean). The gate returns the proof, not a
 * boolean, so the completion claim is auditable afterwards.
 */

/** A git provider that reports the given tracked/untracked state. */
function gitStub(tracked: readonly string[], untracked: readonly string[] = []): GitProofProvider {
	return {
		isTracked(path: string): boolean {
			return tracked.includes(path);
		},
		untrackedPaths(): readonly string[] {
			return untracked;
		},
		headSha(): string | undefined {
			return "deadbeef1234567890abcdef1234567890abcdef12";
		},
	};
}

describe("completion gate", async () => {
	it("refuses to complete a task whose artifact is untracked", async () => {
		const gate: CompletionGate = createCompletionGate({
			git: gitStub([], ["docs/audit.md"]),
		});
		const result = await gate.verify({
			task: "write the audit doc",
			artifacts: ["docs/audit.md"],
		});
		expect(result.ok).toBe(false);
		expect(result.failures.some(f => f.path === "docs/audit.md")).toBe(true);
		expect(result.failures[0]?.reason).toContain("not tracked");
	});

	it("allows completion when every artifact is tracked and a head exists", async () => {
		const gate = createCompletionGate({ git: gitStub(["docs/audit.md"]) });
		const result = await gate.verify({ task: "write the audit doc", artifacts: ["docs/audit.md"] });
		expect(result.ok).toBe(true);
		expect(result.proofs).toHaveLength(1);
		expect(result.proofs[0]?.kind).toBe("committed");
	});

	it("records the head sha in the proof so the claim is auditable", async () => {
		const gate = createCompletionGate({ git: gitStub(["docs/audit.md"]) });
		const result = await gate.verify({ task: "write the audit doc", artifacts: ["docs/audit.md"] });
		expect(result.proofs[0]?.commitSha).toBe("deadbeef1234567890abcdef1234567890abcdef12");
	});

	it("fails when there is no head at all", async () => {
		const gate = createCompletionGate({
			git: {
				isTracked: () => true,
				untrackedPaths: () => [],
				headSha: () => undefined,
			},
		});
		const result = await gate.verify({ task: "x", artifacts: ["a.md"] });
		expect(result.ok).toBe(false);
	});

	it("requires every artifact to be tracked, not just one", async () => {
		const gate = createCompletionGate({ git: gitStub(["a.md"], ["b.md"]) });
		const result = await gate.verify({ task: "x", artifacts: ["a.md", "b.md"] });
		expect(result.ok).toBe(false);
		expect(result.failures).toHaveLength(1);
	});

	it("allows a task with no declared artifacts", async () => {
		const gate = createCompletionGate({ git: gitStub([]) });
		const result = await gate.verify({ task: "think about it", artifacts: [] });
		expect(result.ok).toBe(true);
	});

	it("reports a diagnostics failure when the lsp reports an error", async () => {
		const gate = createCompletionGate({
			git: gitStub(["a.ts"]),
			diagnostics: {
				async check(uri: string) {
					return uri.endsWith("a.ts")
						? { ok: false as const, diagnostics: [{ severity: "error", message: "TS2304", uri }] }
						: { ok: true as const, diagnostics: [] };
				},
			},
		});
		const result = await gate.verify({ task: "fix a.ts", artifacts: ["a.ts"] });
		expect(result.ok).toBe(false);
		expect(result.failures.some(f => f.reason.includes("TS2304"))).toBe(true);
	});

	it("passes diagnostics when the lsp is clean", async () => {
		const gate = createCompletionGate({
			git: gitStub(["a.ts"]),
			diagnostics: {
				async check() {
					return { ok: true as const, diagnostics: [] };
				},
			},
		});
		const result = await gate.verify({ task: "fix a.ts", artifacts: ["a.ts"] });
		expect(result.ok).toBe(true);
		expect(result.proofs.some(p => p.kind === "diagnostics-clean")).toBe(true);
	});

	it("fails closed when the diagnostics engine is unavailable", async () => {
		const gate = createCompletionGate({
			git: gitStub(["a.ts"]),
			diagnostics: {
				async check() {
					throw new Error("lsp down");
				},
			},
		});
		const result = await gate.verify({ task: "fix a.ts", artifacts: ["a.ts"], requireDiagnostics: true });
		expect(result.ok).toBe(false);
		expect(result.failures.some(f => f.reason.includes("unavailable"))).toBe(true);
	});

	it("names the engine that produced each proof", async () => {
		const gate = createCompletionGate({
			git: gitStub(["a.ts"]),
			diagnostics: {
				async check() {
					return { ok: true as const, diagnostics: [] };
				},
			},
		});
		const result = await gate.verify({ task: "fix a.ts", artifacts: ["a.ts"] });
		for (const proof of result.proofs) expect(proof.engine.length).toBeGreaterThan(0);
	});
});
