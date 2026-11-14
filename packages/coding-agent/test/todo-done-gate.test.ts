import { describe, expect, it } from "bun:test";
import {
	extractArtifactPaths,
	todoDoneGateDecision,
	type TodoGateContext,
} from "@oh-my-pi/pi-coding-agent/tools/todo-gate";

/**
 * T10 — the completion gate, on the real `todo done` path.
 *
 * The gate exists; the question this answers is whether it actually *refuses*.
 * The observed failure was a session that said "All work is complete" over an
 * untracked deliverable with 12/12 todos marked completed — so the gate has
 * to be wired into the transition, not merely exist.
 *
 * The task text names its artifacts ("write docs/a.md and src/b.ts"), because
 * a todo that does not say what it produced cannot be proven. A task that
 * names no artifact is allowed through — the gate proves what it can and
 * never invents a requirement.
 */

describe("artifact extraction", () => {
	it("finds a path in the task text", () => {
		expect(extractArtifactPaths("write docs/a.md")).toEqual(["docs/a.md"]);
	});

	it("finds several paths", () => {
		expect(extractArtifactPaths("write docs/a.md and src/b.ts")).toEqual(["docs/a.md", "src/b.ts"]);
	});

	it("finds a path inside backticks", () => {
		expect(extractArtifactPaths("update `packages/agent/src/agent.ts`")).toEqual(["packages/agent/src/agent.ts"]);
	});

	it("finds no path in prose without one", () => {
		expect(extractArtifactPaths("think about the architecture")).toEqual([]);
	});

	it("ignores a bare word with no path separator", () => {
		expect(extractArtifactPaths("fix the agent")).toEqual([]);
	});

	it("de-duplicates repeated paths", () => {
		expect(extractArtifactPaths("docs/a.md then docs/a.md again")).toEqual(["docs/a.md"]);
	});
});

describe("todo done gate", () => {
	const context = (over: Partial<TodoGateContext> = {}): TodoGateContext => ({
		task: "write docs/a.md",
		artifacts: ["docs/a.md"],
		tracked: false,
		...over,
	});

	it("refuses when the artifact is not tracked", () => {
		const decision = todoDoneGateDecision(context());
		expect(decision.allowed).toBe(false);
		expect(decision.reason).toContain("not tracked");
	});

	it("allows when the artifact is tracked", () => {
		const decision = todoDoneGateDecision(context({ tracked: true }));
		expect(decision.allowed).toBe(true);
	});

	it("allows a task that names no artifact", () => {
		const decision = todoDoneGateDecision(context({ task: "think about it", artifacts: [] }));
		expect(decision.allowed).toBe(true);
	});

	it("names the offending path in the reason", () => {
		const decision = todoDoneGateDecision(context());
		expect(decision.reason).toContain("docs/a.md");
	});

	it("tells the agent what to do next", () => {
		const decision = todoDoneGateDecision(context());
		expect(decision.hint).toContain("git add");
	});

	it("refuses when any one of several artifacts is untracked", () => {
		const decision = todoDoneGateDecision(
			context({ task: "write a.md and b.md", artifacts: ["a.md", "b.md"], tracked: false }),
		);
		expect(decision.allowed).toBe(false);
	});
});
