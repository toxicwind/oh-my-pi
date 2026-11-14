import { describe, expect, it } from "bun:test";
import {
	compileObligation,
	createObligationLedger,
	type ObligationLedger,
	type Obligation,
	type ObligationPredicate,
} from "@oh-my-pi/pi-agent-core/obligation-ledger";

/**
 * T2 — obligation compilation.
 *
 * A human correction ("stop using head", "use blackbird", "commit first") must
 * become a *machine-checkable* predicate, not a note. The predicate is checked
 * against a real parse (bash AST for commands, path AST for file access), never
 * against a substring of prose.
 */

describe("obligation compilation", () => {
	it("compiles a method prohibition into a checkable predicate", () => {
		const obligation = compileObligation("stop using head");
		expect(obligation).toBeDefined();
		expect(obligation?.kind).toBe("method");
		expect(obligation?.raw).toBe("stop using head");
	});

	it("compiles a git-artifact obligation", () => {
		const obligation = compileObligation("commit and push first");
		expect(obligation).toBeDefined();
		expect(obligation?.kind).toBe("artifact");
	});

	it("compiles a scope expansion obligation", () => {
		const obligation = compileObligation("not just antigravity fix, like all history");
		expect(obligation).toBeDefined();
		expect(obligation?.kind).toBe("scope");
	});

	it("returns undefined for prose with no obligation in it", () => {
		expect(compileObligation("the weather is nice today")).toBeUndefined();
	});

	it("gives every obligation a stable id", () => {
		const a = compileObligation("stop using head");
		const b = compileObligation("stop using head");
		expect(a?.id).toBe(b?.id);
	});
});

describe("obligation predicates", () => {
	it("detects a shell pipeline that invokes the forbidden program", async () => {
		const obligation = compileObligation("stop using head");
		const predicate = obligation?.predicate as ObligationPredicate;
		expect(predicate).toBeDefined();
		const violation = await predicate.violatedBy({ kind: "bash", command: "git log | head -20" });
		expect(violation.violated).toBe(true);
		expect(violation.evidence).toContain("head");
	});

	it("does not fire on a word that merely contains the forbidden program", async () => {
		const obligation = compileObligation("stop using head");
		const predicate = obligation?.predicate as ObligationPredicate;
		const violation = await predicate.violatedBy({ kind: "bash", command: "git log | head_of_line" });
		expect(violation.violated).toBe(false);
	});

	it("does not fire on a file named after the forbidden program", async () => {
		const obligation = compileObligation("stop using head");
		const predicate = obligation?.predicate as ObligationPredicate;
		const violation = await predicate.violatedBy({ kind: "file-read", path: "src/head.ts" });
		expect(violation.violated).toBe(false);
	});

	it("fires when the forbidden program is a bare command", async () => {
		const obligation = compileObligation("stop using head");
		const predicate = obligation?.predicate as ObligationPredicate;
		const violation = await predicate.violatedBy({ kind: "bash", command: "head -50 file.txt" });
		expect(violation.violated).toBe(true);
	});

	it("distinguishes a program position from an argument position", async () => {
		const obligation = compileObligation("stop using head");
		const predicate = obligation?.predicate as ObligationPredicate;
		// `echo head` passes "head" as a word argument, not as the invoked program.
		const violation = await predicate.violatedBy({ kind: "bash", command: "echo head" });
		expect(violation.violated).toBe(false);
	});
});

describe("obligation ledger", () => {
	it("records an obligation as active", () => {
		const ledger = createObligationLedger();
		const obligation = compileObligation("stop using head");
		ledger.record(obligation as Obligation);
		expect(ledger.active()).toHaveLength(1);
	});

	it("marks an obligation satisfied and drops it from the active set", () => {
		const ledger = createObligationLedger();
		const obligation = compileObligation("stop using head") as Obligation;
		ledger.record(obligation);
		ledger.satisfy(obligation.id);
		expect(ledger.active()).toHaveLength(0);
	});

	it("keeps a ledger entry after rehydration", () => {
		const ledger = createObligationLedger();
		const obligation = compileObligation("stop using head") as Obligation;
		ledger.record(obligation);
		const restored = createObligationLedger();
		restored.rehydrate(ledger.snapshot());
		expect(restored.active()).toHaveLength(1);
		expect(restored.active()[0]?.id).toBe(obligation.id);
	});

	it("detects a re-violation of an active obligation", async () => {
		const ledger = createObligationLedger();
		const obligation = compileObligation("stop using head") as Obligation;
		ledger.record(obligation);
		const violations = await ledger.check({ kind: "bash", command: "git log | head -20" });
		expect(violations).toHaveLength(1);
		expect(violations[0]?.obligation.id).toBe(obligation.id);
	});

	it("does not report a violation for an obligation that was satisfied", async () => {
		const ledger = createObligationLedger();
		const obligation = compileObligation("stop using head") as Obligation;
		ledger.record(obligation);
		ledger.satisfy(obligation.id);
		const violations = await ledger.check({ kind: "bash", command: "git log | head -20" });
		expect(violations).toHaveLength(0);
	});

	it("supersedes an older obligation of the same kind and subject", () => {
		const ledger = createObligationLedger();
		const first = compileObligation("stop using head") as Obligation;
		const second = { ...first, id: `${first.id}-2`, raw: "actually use tail instead" } as Obligation;
		ledger.record(first);
		ledger.record(second);
		const active = ledger.active();
		expect(active).toHaveLength(1);
		expect(active[0]?.id).toBe(second.id);
	});
});

describe("obligation ledger typing", () => {
	it("exposes a class-compatible ledger", () => {
		const ledger: ObligationLedger = createObligationLedger();
		expect(typeof ledger.record).toBe("function");
	});
});
