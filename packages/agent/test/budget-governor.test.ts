import { describe, expect, it } from "bun:test";
import { createBudgetGovernor, type BudgetGovernor, type NoveltySignal } from "@oh-my-pi/pi-agent-core/budget-governor";

/**
 * T6 — budget governor with novelty accounting.
 *
 * "Maximalize" without a ceiling is a loop wearing a productivity costume.
 * The observed failure: 1520 tool calls, 166 redundant command executions,
 * 9 concurrent threads, and the human saying "still not deep enough" four
 * times — because the agent's depth was repetition dressed as depth.
 *
 * So the governor measures *novelty*, not effort: did this action produce new
 * structural facts (new AST fingerprints, new symbols, new evidence ids)? When
 * the novelty rate collapses, the governor redirects — it does not block.
 */

describe("budget governor", () => {
	it("continues while actions keep producing novelty", () => {
		const governor: BudgetGovernor = createBudgetGovernor({
			maxToolCalls: 100,
			noveltyFloor: 0.05,
			windowSize: 5,
		});
		for (let i = 0; i < 5; i++) {
			const verdict = governor.evaluate({
				toolCall: `read-${i}`,
				novelty: { astFingerprints: [`a${i}`], evidenceIds: [] },
			});
			expect(verdict.verdict).toBe("continue");
		}
	});

	it("redirects when the novelty rate falls below the floor", () => {
		const governor = createBudgetGovernor({ maxToolCalls: 100, noveltyFloor: 0.05, windowSize: 5 });
		for (let i = 0; i < 4; i++) {
			governor.evaluate({ toolCall: `same-${i}`, novelty: { astFingerprints: [], evidenceIds: [] } });
		}
		const verdict = governor.evaluate({ toolCall: "same-4", novelty: { astFingerprints: [], evidenceIds: [] } });
		expect(verdict.verdict).toBe("redirect");
	});

	it("names the novelty rate, the floor and the zero-novelty count in the message", () => {
		const governor = createBudgetGovernor({ maxToolCalls: 100, noveltyFloor: 0.05, windowSize: 5 });
		for (let i = 0; i < 5; i++) {
			governor.evaluate({ toolCall: `same-${i}`, novelty: { astFingerprints: [], evidenceIds: [] } });
		}
		const verdict = governor.evaluate({ toolCall: "same-5", novelty: { astFingerprints: [], evidenceIds: [] } });
		expect(verdict.message).toBeDefined();
		expect(verdict.message).toContain("novelty");
		expect(verdict.message).toContain("0.05");
	});

	it("returns to continue once a genuinely new artifact appears", () => {
		const governor = createBudgetGovernor({ maxToolCalls: 100, noveltyFloor: 0.05, windowSize: 5 });
		for (let i = 0; i < 5; i++) {
			governor.evaluate({ toolCall: `same-${i}`, novelty: { astFingerprints: [], evidenceIds: [] } });
		}
		const verdict = governor.evaluate({
			toolCall: "new",
			novelty: { astFingerprints: ["fingerprint-new"], evidenceIds: ["sha-abc"] },
		});
		expect(verdict.verdict).toBe("continue");
	});

	it("stops when the tool-call budget is exhausted", () => {
		const governor = createBudgetGovernor({ maxToolCalls: 3, noveltyFloor: 0.0, windowSize: 5 });
		let verdict = governor.evaluate({ toolCall: "a", novelty: { astFingerprints: ["x"], evidenceIds: [] } });
		verdict = governor.evaluate({ toolCall: "b", novelty: { astFingerprints: ["y"], evidenceIds: [] } });
		verdict = governor.evaluate({ toolCall: "c", novelty: { astFingerprints: ["z"], evidenceIds: [] } });
		expect(verdict.verdict).toBe("exhausted");
	});

	it("counts tool calls across the whole budget", () => {
		const governor = createBudgetGovernor({ maxToolCalls: 10, noveltyFloor: 0, windowSize: 5 });
		for (let i = 0; i < 4; i++) {
			governor.evaluate({ toolCall: `t-${i}`, novelty: { astFingerprints: [`f${i}`], evidenceIds: [] } });
		}
		const verdict = governor.evaluate({ toolCall: "t-4", novelty: { astFingerprints: ["f4"], evidenceIds: [] } });
		expect(verdict.toolCalls).toBe(5);
	});

	it("computes novelty over a sliding window, so the rate can recover", () => {
		// The window is *recent* work, not all work: a governor that only ever
		// looked at a cumulative rate could never recover after one productive
		// burst, and would keep redirecting an agent that had changed axis.
		const governor = createBudgetGovernor({ maxToolCalls: 100, noveltyFloor: 0, windowSize: 4 });
		governor.evaluate({ toolCall: "a", novelty: { astFingerprints: ["n1"], evidenceIds: [] } });
		governor.evaluate({ toolCall: "b", novelty: { astFingerprints: [], evidenceIds: [] } });
		governor.evaluate({ toolCall: "c", novelty: { astFingerprints: [], evidenceIds: [] } });
		governor.evaluate({ toolCall: "d", novelty: { astFingerprints: [], evidenceIds: [] } });
		// The window now holds only the four unproductive actions.
		const verdict = governor.evaluate({ toolCall: "e", novelty: { astFingerprints: [], evidenceIds: [] } });
		expect(verdict.noveltyRate).toBeCloseTo(0, 5);
		expect(verdict.zeroNoveltyActions).toBe(4);
	});

	it("treats a repeated ast fingerprint as zero novelty", () => {
		const governor = createBudgetGovernor({ maxToolCalls: 100, noveltyFloor: 0, windowSize: 3 });
		// The first sighting introduces the fingerprint; every later sighting is
		// the same fact again, so the window slides to all-zero novelty.
		governor.evaluate({ toolCall: "a", novelty: { astFingerprints: ["same"], evidenceIds: [] } });
		governor.evaluate({ toolCall: "b", novelty: { astFingerprints: ["same"], evidenceIds: [] } });
		governor.evaluate({ toolCall: "c", novelty: { astFingerprints: ["same"], evidenceIds: [] } });
		const verdict = governor.evaluate({ toolCall: "d", novelty: { astFingerprints: ["same"], evidenceIds: [] } });
		expect(verdict.noveltyRate).toBe(0);
	});

	it("accepts an action with no novelty signal as zero novelty", () => {
		const governor = createBudgetGovernor({ maxToolCalls: 100, noveltyFloor: 0, windowSize: 2 });
		governor.evaluate({ toolCall: "a" });
		const verdict = governor.evaluate({ toolCall: "b" });
		expect(verdict.noveltyRate).toBe(0);
	});
});

describe("budget governor typing", () => {
	it("accepts a novelty signal with only evidence ids", () => {
		const signal: NoveltySignal = { astFingerprints: [], evidenceIds: ["sha-1"] };
		expect(signal.evidenceIds).toHaveLength(1);
	});
});
