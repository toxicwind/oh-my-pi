/**
 * Obligation ledger mirror — the plan survives the session.
 *
 * The session that produced this constitution was destroyed by a 429 during
 * compaction: 294k tokens of context and twelve todos gone, because the plan
 * lived *inside* the process that died. The obligations — the corrections the
 * human gave — went with it.
 *
 * So the ledger is mirrored to disk as two files:
 *
 *  - `obligations.json` — machine-readable, so a new session can restore the
 *    obligations and keep enforcing them;
 *  - `obligations.md` — human-readable, so a human can see what the session
 *    was told to do without opening a JSON blob.
 *
 * The write returns the path and a digest, so a compaction summary can carry
 * a *reference* to the ledger instead of a lossy prose copy of it. That is
 * what makes the post-compaction agent able to restore the rules rather than
 * re-derive them.
 */

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ObligationSnapshotEntry } from "@oh-my-pi/pi-agent-core/obligation-ledger";

/** The mirror's write result. */
export interface ObligationMirrorResult {
	/** The path of the JSON mirror. */
	readonly path: string;
	/** The path of the Markdown mirror. */
	readonly markdownPath: string;
	/** A digest of the JSON mirror, for referencing it from a summary. */
	readonly digest: string;
}

/** The mirror interface. */
export interface ObligationLedgerMirror {
	/** Writes the ledger to disk. Returns where it went and its digest. */
	write(entries: readonly ObligationSnapshotEntry[]): ObligationMirrorResult;
	/** The directory the mirror writes into. */
	readonly dir: string;
}

/** The obligation kinds a mirror entry may carry. */
const KINDS = new Set(["method", "scope", "artifact", "symbol", "assertion"]);
/** The states a mirror entry may carry. */
const STATES = new Set(["active", "satisfied", "superseded"]);

/** Renders the ledger as a Markdown checklist a human can read. */
export function renderObligationsMarkdown(entries: readonly ObligationSnapshotEntry[]): string {
	const lines = ["# Obligations", ""];
	if (entries.length === 0) {
		lines.push("_No obligations recorded._", "");
		return lines.join("\n");
	}
	for (const entry of entries) {
		const marker = entry.state === "active" ? " " : "x";
		lines.push(`- [${marker}] **${entry.kind}** \`${entry.subject}\` — ${entry.raw} _(${entry.state})_`);
	}
	lines.push("");
	return lines.join("\n");
}

/**
 * Parses a JSON mirror back into ledger entries.
 *
 * Anything malformed yields an empty list rather than throwing: a corrupt
 * mirror must not prevent a session from starting.
 */
export function parseObligationMirror(json: string): ObligationSnapshotEntry[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch {
		return [];
	}
	if (!Array.isArray(parsed)) return [];
	const entries: ObligationSnapshotEntry[] = [];
	for (const item of parsed) {
		if (typeof item !== "object" || item === null) continue;
		const candidate = item as Record<string, unknown>;
		if (typeof candidate.id !== "string" || candidate.id.length === 0) continue;
		if (typeof candidate.subject !== "string" || candidate.subject.length === 0) continue;
		if (typeof candidate.raw !== "string") continue;
		if (typeof candidate.kind !== "string" || !KINDS.has(candidate.kind)) continue;
		if (typeof candidate.state !== "string" || !STATES.has(candidate.state)) continue;
		entries.push({
			id: candidate.id,
			kind: candidate.kind as ObligationSnapshotEntry["kind"],
			subject: candidate.subject,
			raw: candidate.raw,
			state: candidate.state as ObligationSnapshotEntry["state"],
			createdAtTurn: typeof candidate.createdAtTurn === "number" ? candidate.createdAtTurn : undefined,
		});
	}
	return entries;
}

/** Creates a ledger mirror that writes into `dir`. */
export function createObligationLedgerMirror(dir: string): ObligationLedgerMirror {
	return {
		dir,
		write(entries: readonly ObligationSnapshotEntry[]): ObligationMirrorResult {
			mkdirSync(dir, { recursive: true });
			const json = JSON.stringify(entries, null, 2);
			const jsonPath = join(dir, "obligations.json");
			const markdownPath = join(dir, "obligations.md");
			writeFileSync(jsonPath, json, "utf8");
			writeFileSync(markdownPath, renderObligationsMarkdown(entries), "utf8");
			return {
				path: jsonPath,
				markdownPath,
				digest: `sha256:${createHash("sha256").update(json).digest("hex")}`,
			};
		},
	};
}
