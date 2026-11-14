import { describe, expect, it } from "bun:test";
import {
	createEnforcementRuntime,
	type EnforcementRuntime,
} from "@oh-my-pi/pi-coding-agent/session/enforcement-runtime";

/**
 * T8 — the enforcement runtime wires the layers together.
 *
 * The individual engines (intent frame, obligation ledger, completion gate,
 * budget governor) are only worth anything if they run on the real path. This
 * runtime is the single place that:
 *
 *  - builds an intent frame from each human turn and records it,
 *  - compiles a human correction into an obligation and persists it as a
 *    session entry, so it survives restart,
 *  - checks every tool call against the active obligations and *records* a
 *    re-violation (it does not block — blocking on a heuristic is a behaviour
 *    patch),
 *  - charges the budget governor and surfaces a redirect when depth stops
 *    producing evidence.
 */

describe("enforcement runtime", () => {
	it("records an intent frame for a human turn", () => {
		const runtime: EnforcementRuntime = createEnforcementRuntime();
		const frame = runtime.observeTurn("fix peekLiveSteeredMessages in agent.ts");
		expect(frame).toBeDefined();
		expect(frame?.raw).toContain("peekLiveSteeredMessages");
	});

	it("compiles a correction into a persisted obligation", () => {
		const runtime = createEnforcementRuntime();
		const obligation = runtime.observeCorrection("stop using head");
		expect(obligation?.kind).toBe("method");
		expect(obligation?.subject).toBe("head");
	});

	it("reports a re-violation of an active obligation", async () => {
		const runtime = createEnforcementRuntime();
		runtime.observeCorrection("stop using head");
		const violations = await runtime.checkToolCall("bash", { command: "git log | head -20" });
		expect(violations.length).toBe(1);
		expect(violations[0]?.obligation.subject).toBe("head");
	});

	it("does not report a violation for an unrelated tool call", async () => {
		const runtime = createEnforcementRuntime();
		runtime.observeCorrection("stop using head");
		const violations = await runtime.checkToolCall("bash", { command: "git log --oneline" });
		expect(violations).toHaveLength(0);
	});

	it("survives a restart: the obligation is still active after rehydration", async () => {
		const runtime = createEnforcementRuntime();
		runtime.observeCorrection("stop using head");
		const snapshot = runtime.snapshot();
		const restored = createEnforcementRuntime();
		restored.rehydrate(snapshot);
		const violations = await restored.checkToolCall("bash", { command: "git log | head -5" });
		expect(violations).toHaveLength(1);
	});

	it("records a re-violation on the ledger so it can be reported", async () => {
		const runtime = createEnforcementRuntime();
		runtime.observeCorrection("stop using head");
		await runtime.checkToolCall("bash", { command: "git log | head -5" });
		expect(runtime.violations()).toHaveLength(1);
	});

	it("charges the budget governor and returns a redirect when novelty collapses", () => {
		const runtime = createEnforcementRuntime({ noveltyFloor: 0.5, windowSize: 3, maxToolCalls: 100 });
		let verdict = runtime.chargeBudget("read", { astFingerprints: ["a"], evidenceIds: [] });
		expect(verdict.verdict).toBe("continue");
		verdict = runtime.chargeBudget("read", { astFingerprints: [], evidenceIds: [] });
		verdict = runtime.chargeBudget("read", { astFingerprints: [], evidenceIds: [] });
		expect(verdict.verdict).toBe("redirect");
	});

	it("exposes the intent frames it has seen", () => {
		const runtime = createEnforcementRuntime();
		runtime.observeTurn("find the failing test");
		expect(runtime.frames().length).toBe(1);
	});

	it("does not compile an obligation from ordinary prose", () => {
		const runtime = createEnforcementRuntime();
		expect(runtime.observeCorrection("thanks, that looks good")).toBeUndefined();
	});
});
