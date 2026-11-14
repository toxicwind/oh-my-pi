import { describe, expect, it } from "bun:test";
import {
	CORRECTION_ENTRY_TYPE,
	isCorrectionEntry,
	type CorrectionEntry,
} from "@oh-my-pi/pi-coding-agent/session/session-entries";

/**
 * T3 — correction persistence.
 *
 * A correction must survive a restart. That means it cannot be prompt text:
 * it has to be a first-class session entry with a stable type, so that a
 * rehydrated branch still knows the rule.
 */

describe("correction entry", () => {
	it("has a stable entry type constant", () => {
		expect(CORRECTION_ENTRY_TYPE).toBe("correction");
	});

	it("recognises a correction entry", () => {
		const entry: CorrectionEntry = {
			type: "correction",
			id: "corr-1",
			parentId: null,
			timestamp: "2026-11-14T00:00:00.000Z",
			obligationId: "obl-method-head",
			kind: "method",
			subject: "head",
			raw: "stop using head",
			state: "active",
		};
		expect(isCorrectionEntry(entry)).toBe(true);
	});

	it("does not recognise a non-correction entry", () => {
		expect(isCorrectionEntry({ type: "label", id: "x", timestamp: 1 } as never)).toBe(false);
	});

	it("rejects a correction entry with an unknown kind", () => {
		expect(
			isCorrectionEntry({
				type: "correction",
				id: "corr-2",
				parentId: null,
				timestamp: "2026-11-14T00:00:00.000Z",
				obligationId: "obl-x",
				kind: "not-a-kind",
				subject: "x",
				raw: "x",
				state: "active",
			} as never),
		).toBe(false);
	});

	it("rejects a correction entry with an unknown state", () => {
		expect(
			isCorrectionEntry({
				type: "correction",
				id: "corr-3",
				parentId: null,
				timestamp: "2026-11-14T00:00:00.000Z",
				obligationId: "obl-x",
				kind: "method",
				subject: "x",
				raw: "x",
				state: "maybe",
			} as never),
		).toBe(false);
	});
});
