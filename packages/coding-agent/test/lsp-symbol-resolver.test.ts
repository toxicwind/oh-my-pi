import { describe, expect, it } from "bun:test";
import { createLspSymbolResolver, type LspSymbolClient } from "@oh-my-pi/pi-coding-agent/lsp/symbol-resolver";

/**
 * T14 — the intent frame's symbol resolver, backed by the language server.
 *
 * The intent frame names the symbols the human mentioned. A name is only
 * useful if it resolves to a *real* definition: `peekLiveSteeredMessages` is a
 * method in `packages/agent/src/agent.ts`, not a word that happens to appear
 * in the sentence.
 *
 * The resolver asks the language server (`textDocument/documentSymbol` for
 * open documents, `workspace/symbol` when the server supports it) and caches
 * what it learns. A name the server cannot resolve stays unresolved — the
 * frame records it rather than dropping it.
 */

interface StubClient extends LspSymbolClient {
	documentSymbols: Map<string, { name: string; kind: number; container?: string }[]>;
	workspaceSymbols: Map<string, { name: string; kind: number; uri: string; container?: string }>;
}

function stubClient(): StubClient {
	return {
		documentSymbols: new Map([
			[
				"file:///repo/packages/agent/src/agent.ts",
				[{ name: "peekLiveSteeredMessages", kind: 6, container: "Agent" }],
			],
		]),
		workspaceSymbols: new Map([
			[
				"peekLiveSteeredMessages",
				{
					name: "peekLiveSteeredMessages",
					kind: 6,
					uri: "file:///repo/packages/agent/src/agent.ts",
					container: "Agent",
				},
			],
		]),
		async documentSymbolsFor(uri: string) {
			return this.documentSymbols.get(uri) ?? [];
		},
		async workspaceSymbol(name: string) {
			return this.workspaceSymbols.get(name);
		},
	};
}

describe("lsp symbol resolver", () => {
	it("resolves a symbol through the workspace symbol index", async () => {
		const resolver = createLspSymbolResolver({ client: stubClient() });
		const resolved = await resolver.resolve("peekLiveSteeredMessages");
		expect(resolved?.name).toBe("peekLiveSteeredMessages");
		expect(resolved?.kind).toBe("method");
		expect(resolved?.uri).toBe("file:///repo/packages/agent/src/agent.ts");
	});

	it("resolves a symbol found in an open document", async () => {
		const client = stubClient();
		client.workspaceSymbols.clear();
		const resolver = createLspSymbolResolver({
			client,
			openDocuments: ["file:///repo/packages/agent/src/agent.ts"],
		});
		const resolved = await resolver.resolve("peekLiveSteeredMessages");
		expect(resolved?.name).toBe("peekLiveSteeredMessages");
		expect(resolved?.container).toBe("Agent");
	});

	it("returns undefined for a symbol the server cannot resolve", async () => {
		const resolver = createLspSymbolResolver({ client: stubClient() });
		expect(await resolver.resolve("notASymbol")).toBeUndefined();
	});

	it("caches a resolution so the server is asked once", async () => {
		const client = stubClient();
		let calls = 0;
		const counting: LspSymbolClient = {
			async documentSymbolsFor() {
				return [];
			},
			async workspaceSymbol(name: string) {
				calls += 1;
				return client.workspaceSymbols.get(name);
			},
		};
		const resolver = createLspSymbolResolver({ client: counting });
		await resolver.resolve("peekLiveSteeredMessages");
		await resolver.resolve("peekLiveSteeredMessages");
		expect(calls).toBe(1);
	});

	it("does not cache a failed resolution as a success", async () => {
		const client = stubClient();
		let calls = 0;
		const counting: LspSymbolClient = {
			async documentSymbolsFor() {
				return [];
			},
			async workspaceSymbol(name: string) {
				calls += 1;
				return client.workspaceSymbols.get(name);
			},
		};
		const resolver = createLspSymbolResolver({ client: counting });
		await resolver.resolve("missing");
		await resolver.resolve("missing");
		expect(calls).toBe(2);
	});

	it("returns undefined when the language server is unreachable", async () => {
		const resolver = createLspSymbolResolver({
			client: {
				async documentSymbolsFor() {
					throw new Error("server down");
				},
				async workspaceSymbol() {
					throw new Error("server down");
				},
			},
		});
		expect(await resolver.resolve("anything")).toBeUndefined();
	});

	it("maps the LSP symbol kind to a readable name", async () => {
		const client = stubClient();
		client.workspaceSymbols.set("aClass", { name: "aClass", kind: 5, uri: "file:///repo/a.ts" });
		const resolver = createLspSymbolResolver({ client });
		const resolved = await resolver.resolve("aClass");
		expect(resolved?.kind).toBe("class");
	});
});
