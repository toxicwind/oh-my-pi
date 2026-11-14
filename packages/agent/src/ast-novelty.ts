/**
 * AST novelty fingerprint — "has the shape of the ground changed?".
 *
 * The budget governor needs to know whether an action produced new knowledge
 * or merely repeated old knowledge. The honest way to answer that about
 * *code* is to look at the code's structure, not at the path that was read
 * and not at the words in the output.
 *
 * So the fingerprint is the set of structural patterns the source matches,
 * hashed. Two files with the same shape produce the same fingerprint even
 * when every identifier differs — which is the point: `export function a()`
 * and `export function b()` are the same *kind* of thing, and re-reading a
 * file in a new variable name is not progress.
 *
 * The identifier names are deliberately excluded. A fingerprint that changed
 * whenever a name changed would reward renaming.
 *
 * When the language is unknown or the grammar is missing, the fingerprint
 * falls back to a content digest: coarser, but still honest — different
 * content is different ground.
 */

import { createHash } from "node:crypto";
import { astMatch, AstMatchStrictness } from "@oh-my-pi/pi-natives";

/**
 * Structural patterns, one per declaration form.
 *
 * These are deliberately coarse: they capture *shape*, not detail. `$_A` and
 * `$A` are ast-grep metavariables, so every function matches the same
 * pattern no matter what it is called.
 */
const STRUCTURAL_PATTERNS: readonly string[] = [
	"export function $F($$$A) { $$$B }",
	"function $F($$$A) { $$$B }",
	"export class $C { $$$B }",
	"class $C { $$$B }",
	"export const $X = $V",
	"const $X = $V",
	"export interface $I { $$$B }",
	"interface $I { $$$B }",
	"export type $T = $V",
	"type $T = $V",
	"export enum $E { $$$B }",
	"enum $E { $$$B }",
	"$X = $V",
	"if ($C) { $$$B }",
	"for ($$$A) { $$$B }",
	"while ($C) { $$$B }",
	"try { $$$B } catch ($E) { $$$C }",
	"return $V",
	"await $V",
	"new $C($$$A)",
	"$F($$$A)",
];

/** The separator between pattern buckets in the hashed input. */
const BUCKET = "\u0000";

/**
 * Builds the structural fingerprint of a source file.
 *
 * The result is a hex digest: the same structure always yields the same
 * string, and a different structure never does.
 */
export async function buildAstFingerprint(source: string, lang: string): Promise<string> {
	const text = source ?? "";
	if (text.trim().length === 0) {
		return `empty:${createHash("sha256").update("").digest("hex").slice(0, 16)}`;
	}

	try {
		const buckets: string[] = [];
		for (const pattern of STRUCTURAL_PATTERNS) {
			const result = await astMatch({
				patterns: [pattern],
				source: text,
				lang,
				strictness: AstMatchStrictness.Smart,
				limit: 1,
			});
			if (result.totalMatches > 0) buckets.push(pattern);
		}
		if (buckets.length === 0) {
			// The grammar parsed but matched nothing: the shape is genuinely
			// unknown, so fall back to the content digest rather than claim
			// an empty structure that every file would share.
			return `content:${createHash("sha256").update(text).digest("hex").slice(0, 16)}`;
		}
		return `ast:${createHash("sha256").update(buckets.join(BUCKET)).digest("hex").slice(0, 16)}`;
	} catch {
		// Unknown language, missing grammar, parse failure: the content is
		// the only honest signal left.
		return `content:${createHash("sha256").update(text).digest("hex").slice(0, 16)}`;
	}
}

/**
 * Builds the fingerprints of several files at once.
 *
 * The result is sorted so the fingerprint of a set does not depend on the
 * order the files were visited in.
 */
export async function buildAstFingerprints(
	files: ReadonlyArray<{ path: string; source: string; lang: string }>,
): Promise<string[]> {
	const fingerprints = await Promise.all(
		files.map(async file => `${file.path}:${await buildAstFingerprint(file.source, file.lang)}`),
	);
	return fingerprints.sort();
}
