import { describe, expect, it } from "bun:test";
import {
	buildIntentFrame,
	type IntentAction,
	type IntentFrame,
	type SymbolResolver,
} from "@oh-my-pi/pi-agent-core/intent-frame";

/**
 * T1 — intent frame extraction.
 *
 * The engine must turn a human turn into a machine-readable statement of what
 * was asked, so that a later action can be checked against it. The frame must
 * never silently drop a named thing: an identifier the resolver cannot place
 * is recorded as unresolved, not as absent.
 */

const stubResolver: SymbolResolver = {
	resolve(identifier: string) {
		if (identifier === "peekLiveSteeredMessages") {
			return {
				name: "peekLiveSteeredMessages",
				kind: "method",
				uri: "file:///repo/packages/agent/src/agent.ts",
				container: "Agent",
				range: { start: { line: 1213, character: 0 }, end: { line: 1213, character: 24 } },
			};
		}
		if (identifier === "TtsrManager") {
			return {
				name: "TtsrManager",
				kind: "class",
				uri: "file:///repo/packages/coding-agent/src/export/ttsr.ts",
				container: undefined,
				range: { start: { line: 559, character: 0 }, end: { line: 559, character: 12 } },
			};
		}
		return undefined;
	},
};

describe("intent frame", () => {
	it("resolves a named symbol through the resolver into the frame", () => {
		const frame = buildIntentFrame("fix peekLiveSteeredMessages in the agent", {
			resolveSymbol: stubResolver.resolve,
		});
		expect(frame.symbols.map(s => s.name)).toEqual(["peekLiveSteeredMessages"]);
		expect(frame.symbols[0]?.kind).toBe("method");
		expect(frame.symbols[0]?.uri).toBe("file:///repo/packages/agent/src/agent.ts");
	});

	it("records an unresolvable identifier instead of dropping it", () => {
		const frame = buildIntentFrame("please look at nonexistentSymbolName", {
			resolveSymbol: stubResolver.resolve,
		});
		expect(frame.symbols).toEqual([]);
		expect(frame.unresolvedIdentifiers).toContain("nonexistentSymbolName");
	});

	it("classifies the action taxonomy from the sentence", () => {
		const frame = buildIntentFrame("find the dart files in the repo", {
			resolveSymbol: stubResolver.resolve,
		});
		expect(frame.actions).toContain<IntentAction>("search");
	});

	it("classifies a terminal request as terminal", () => {
		const frame = buildIntentFrame("lets finish up", { resolveSymbol: stubResolver.resolve });
		expect(frame.terminal).toBe(true);
	});

	it("extracts prohibitions with their subject", () => {
		const frame = buildIntentFrame("stop using head, use rg instead", {
			resolveSymbol: stubResolver.resolve,
		});
		expect(frame.prohibitions.length).toBeGreaterThan(0);
		expect(frame.prohibitions[0]?.kind).toBe("method");
		expect(frame.prohibitions[0]?.subject).toBe("head");
	});

	it("keeps the raw text for the judge path", () => {
		const raw = "commit and push first";
		const frame = buildIntentFrame(raw, { resolveSymbol: stubResolver.resolve });
		expect(frame.raw).toBe(raw);
	});

	it("extracts named paths", () => {
		const frame = buildIntentFrame("fix packages/agent/src/agent.ts please", {
			resolveSymbol: stubResolver.resolve,
		});
		expect(frame.paths.some(p => p.path.includes("packages/agent/src/agent.ts"))).toBe(true);
	});

	it("is deterministic for identical input", () => {
		const a = buildIntentFrame("fix peekLiveSteeredMessages now", { resolveSymbol: stubResolver.resolve });
		const b = buildIntentFrame("fix peekLiveSteeredMessages now", { resolveSymbol: stubResolver.resolve });
		expect(JSON.stringify(a)).toBe(JSON.stringify(b));
	});

	it("exposes an empty frame for an empty turn without throwing", () => {
		const frame = buildIntentFrame("", { resolveSymbol: stubResolver.resolve });
		expect(frame.raw).toBe("");
		expect(frame.symbols).toEqual([]);
		expect(frame.actions).toEqual([]);
	});

	it("does not treat a bare question as a symbol reference", () => {
		const frame = buildIntentFrame("?", { resolveSymbol: stubResolver.resolve });
		expect(frame.unresolvedIdentifiers).toEqual([]);
	});
});

describe("intent frame typing", () => {
	it("accepts a frame produced by the builder", () => {
		const frame: IntentFrame = buildIntentFrame("go", { resolveSymbol: stubResolver.resolve });
		expect(frame.actions).toBeInstanceOf(Array);
	});
});
