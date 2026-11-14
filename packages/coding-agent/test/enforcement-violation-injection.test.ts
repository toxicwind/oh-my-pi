import { describe, expect, it } from "bun:test";
import { formatViolationNotice, type ViolationNotice } from "@oh-my-pi/pi-coding-agent/session/enforcement-runtime";

/**
 * T16 — the re-violation notice.
 *
 * The obligation ledger detects a re-violation. Recording it is not enough:
 * the agent has to be told, or it will do the same thing again and see a
 * record of it rather than a correction.
 *
 * The notice is injected into the turn the way TTSR injects a rule — not as
 * a blocking error, because the runtime does not decide what the agent
 * should do about it. It states what was forbidden, in the human's own
 * words, and what was observed.
 */

describe("violation notice", () => {
	const violation: ViolationNotice = {
		obligationId: "obl-method-head",
		kind: "method",
		subject: "head",
		raw: "stop using head",
		evidence: "command `git log | head -20` invokes `head` in program position",
		engine: "ast",
	};

	it("names the subject that was violated", () => {
		expect(formatViolationNotice(violation)).toContain("head");
	});

	it("quotes the human's original words", () => {
		expect(formatViolationNotice(violation)).toContain("stop using head");
	});

	it("states what was observed", () => {
		expect(formatViolationNotice(violation)).toContain("program position");
	});

	it("names the engine that detected it", () => {
		expect(formatViolationNotice(violation)).toContain("ast");
	});

	it("is a single line so it can ride on a tool result", () => {
		expect(formatViolationNotice(violation).split("\n")).toHaveLength(1);
	});

	it("marks the obligation id so the agent can name the rule", () => {
		expect(formatViolationNotice(violation)).toContain("obl-method-head");
	});
});
