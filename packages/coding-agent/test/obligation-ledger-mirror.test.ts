import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createObligationLedgerMirror,
	parseObligationMirror,
	type ObligationLedgerMirror,
} from "@oh-my-pi/pi-coding-agent/session/obligation-ledger-mirror";

/**
 * T11 — the durable mirror.
 *
 * The session that produced this constitution died on a 429 mid-compaction.
 * Its 12 todos and every correction it had received went with it. A ledger
 * that lives only in the session is a ledger that dies with the session.
 *
 * So the mirror writes the obligations to plain files beside the session:
 * a machine-readable JSON and a human-readable Markdown. A dead session then
 * leaves a readable plan on disk, and a new session can pick it up.
 */

describe("obligation ledger mirror", () => {
	it("writes a markdown mirror and a json mirror", () => {
		const dir = mkdtempSync(join(tmpdir(), "obl-mirror-"));
		try {
			const mirror: ObligationLedgerMirror = createObligationLedgerMirror(dir);
			mirror.write([
				{ id: "obl-method-head", kind: "method", subject: "head", raw: "stop using head", state: "active" },
			]);
			expect(readFileSync(join(dir, "obligations.md"), "utf8")).toContain("stop using head");
			expect(readFileSync(join(dir, "obligations.json"), "utf8")).toContain("obl-method-head");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("round-trips the obligations through the json mirror", () => {
		const dir = mkdtempSync(join(tmpdir(), "obl-mirror-"));
		try {
			const mirror = createObligationLedgerMirror(dir);
			const entries = [
				{
					id: "obl-method-head",
					kind: "method" as const,
					subject: "head",
					raw: "stop using head",
					state: "active" as const,
				},
				{
					id: "obl-scope-wide",
					kind: "scope" as const,
					subject: "all history",
					raw: "not just antigravity",
					state: "active" as const,
				},
			];
			mirror.write(entries);
			const restored = parseObligationMirror(readFileSync(join(dir, "obligations.json"), "utf8"));
			expect(restored).toHaveLength(2);
			expect(restored[0]?.id).toBe("obl-method-head");
			expect(restored[1]?.subject).toBe("all history");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("marks a satisfied obligation in the markdown mirror", () => {
		const dir = mkdtempSync(join(tmpdir(), "obl-mirror-"));
		try {
			const mirror = createObligationLedgerMirror(dir);
			mirror.write([
				{ id: "obl-method-head", kind: "method", subject: "head", raw: "stop using head", state: "satisfied" },
			]);
			const md = readFileSync(join(dir, "obligations.md"), "utf8");
			expect(md).toContain("satisfied");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("returns an empty list for an unreadable mirror", () => {
		expect(parseObligationMirror("not json")).toEqual([]);
	});

	it("returns an empty list for an empty mirror", () => {
		expect(parseObligationMirror("[]")).toEqual([]);
	});

	it("rejects entries with an unknown state when parsing", () => {
		expect(
			parseObligationMirror(JSON.stringify([{ id: "x", kind: "method", subject: "s", raw: "r", state: "maybe" }])),
		).toEqual([]);
	});

	it("writes an empty ledger without throwing", () => {
		const dir = mkdtempSync(join(tmpdir(), "obl-mirror-"));
		try {
			const mirror = createObligationLedgerMirror(dir);
			mirror.write([]);
			expect(readFileSync(join(dir, "obligations.json"), "utf8")).toBe("[]");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("reports the digest of what it wrote so a summary can reference it", () => {
		const dir = mkdtempSync(join(tmpdir(), "obl-mirror-"));
		try {
			const mirror = createObligationLedgerMirror(dir);
			const result = mirror.write([
				{ id: "obl-method-head", kind: "method", subject: "head", raw: "stop using head", state: "active" },
			]);
			expect(result.path).toContain("obligations.json");
			expect(result.digest.length).toBeGreaterThan(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
