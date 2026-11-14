import { describe, expect, it } from "bun:test";
import { buildAstFingerprint } from "@oh-my-pi/pi-agent-core/ast-novelty";

/**
 * T15 — novelty fingerprints from the real AST engine.
 *
 * The budget governor measures novelty from fingerprints. Until now the
 * caller supplied them as strings, which meant the caller decided what
 * "new" meant — and could pass the same string twice.
 *
 * The fingerprint is derived from the *parse tree* of the code that was
 * touched: the set of ast-grep structural patterns it matches, plus the
 * shape of its top-level declarations. Two different files with the same
 * structure produce the same fingerprint (they are the same shape); the same
 * file edited into a different shape produces a different one.
 *
 * The fingerprint therefore answers: "has the *structure* of the ground
 * changed?" — which is the question "is this more investigation or the same
 * investigation again?" actually turns on.
 */

describe("ast novelty fingerprint", () => {
	it("produces a fingerprint for a source file", async () => {
		const fingerprint = await buildAstFingerprint("export function a() { return 1; }", "ts");
		expect(fingerprint.length).toBeGreaterThan(0);
	});

	it("produces the same fingerprint for the same structure", async () => {
		const a = await buildAstFingerprint("export function a() { return 1; }", "ts");
		const b = await buildAstFingerprint("export function b() { return 2; }", "ts");
		expect(a).toBe(b);
	});

	it("produces a different fingerprint for a different structure", async () => {
		const a = await buildAstFingerprint("export function a() { return 1; }", "ts");
		const b = await buildAstFingerprint("export class C { m() {} }", "ts");
		expect(a).not.toBe(b);
	});

	it("is stable across calls for the same source", async () => {
		const source = "const x = { a: 1 };";
		const first = await buildAstFingerprint(source, "ts");
		const second = await buildAstFingerprint(source, "ts");
		expect(first).toBe(second);
	});

	it("falls back to a content digest when the language is unknown", async () => {
		const fingerprint = await buildAstFingerprint("some text", "not-a-language");
		expect(fingerprint.length).toBeGreaterThan(0);
	});

	it("produces a different fallback for different content", async () => {
		const a = await buildAstFingerprint("some text", "not-a-language");
		const b = await buildAstFingerprint("other text", "not-a-language");
		expect(a).not.toBe(b);
	});

	it("handles empty source without throwing", async () => {
		const fingerprint = await buildAstFingerprint("", "ts");
		expect(fingerprint.length).toBeGreaterThan(0);
	});

	it("does not include the identifier names in the fingerprint", async () => {
		const a = await buildAstFingerprint("export function alpha() { return 1; }", "ts");
		expect(a).not.toContain("alpha");
	});
});
