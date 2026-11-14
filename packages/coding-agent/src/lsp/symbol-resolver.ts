/**
 * LSP symbol resolver — the intent frame's eyes.
 *
 * The intent frame records the identifiers the human named. A bare identifier
 * is a guess; a *resolved* identifier is a fact: `peekLiveSteeredMessages` is
 * a method on `Agent` in `packages/agent/src/agent.ts`. The resolver asks the
 * language server, which is the only component that knows the difference
 * between a symbol and a word.
 *
 * Two sources, in order:
 *
 *  1. `workspace/symbol` — the project-wide index, when the server has one;
 *  2. `textDocument/documentSymbol` — the open documents, when it does not.
 *
 * A name that cannot be resolved stays unresolved. The frame records it as
 * `unresolvedIdentifiers` rather than dropping it, so "the human named
 * something I could not place" is visible rather than silent.
 */

/** A symbol as the language server reports it. */
export interface LspSymbol {
	readonly name: string;
	/** The LSP `SymbolKind` number. */
	readonly kind: number;
	readonly uri: string;
	readonly container?: string;
}

/** The language-server surface the resolver needs. */
export interface LspSymbolClient {
	/** The symbols of the open documents, keyed by URI. */
	documentSymbolsFor(uri: string): Promise<{ name: string; kind: number; container?: string }[]>;
	/** A project-wide symbol lookup. */
	workspaceSymbol(name: string): Promise<{ name: string; kind: number; uri: string; container?: string } | undefined>;
}

/** The resolver interface. */
export interface LspSymbolResolver {
	/** Resolves an identifier to a definition, or undefined. */
	resolve(identifier: string): Promise<{ name: string; kind: string; uri: string; container?: string } | undefined>;
}

/** Options for {@link createLspSymbolResolver}. */
export interface LspSymbolResolverOptions {
	readonly client: LspSymbolClient;
	/** The URIs of the currently open documents. */
	readonly openDocuments?: readonly string[];
}

/** Maps an LSP `SymbolKind` number to a readable name. */
export function symbolKindName(kind: number): string {
	const names: Record<number, string> = {
		1: "file",
		2: "module",
		3: "namespace",
		4: "package",
		5: "class",
		6: "method",
		7: "property",
		8: "field",
		9: "constructor",
		10: "enum",
		11: "interface",
		12: "function",
		13: "variable",
		14: "constant",
		15: "string",
		16: "number",
		17: "boolean",
		18: "array",
		19: "object",
		20: "key",
		21: "null",
		22: "enum-member",
		23: "struct",
		24: "event",
		25: "operator",
		26: "type-parameter",
	};
	return names[kind] ?? `kind-${kind}`;
}

/** Creates a symbol resolver backed by the language server. */
export function createLspSymbolResolver(options: LspSymbolResolverOptions): LspSymbolResolver {
	/** Successful resolutions, so the server is asked once per identifier. */
	const cache = new Map<string, { name: string; kind: string; uri: string; container?: string }>();

	return {
		async resolve(
			identifier: string,
		): Promise<{ name: string; kind: string; uri: string; container?: string } | undefined> {
			if (!identifier) return undefined;
			const cached = cache.get(identifier);
			if (cached) return cached;

			try {
				// Project-wide first: it is the index the server maintains.
				const workspace = await options.client.workspaceSymbol(identifier);
				if (workspace) {
					const resolved = {
						name: workspace.name,
						kind: symbolKindName(workspace.kind),
						uri: workspace.uri,
						container: workspace.container,
					};
					cache.set(identifier, resolved);
					return resolved;
				}

				// Then the open documents, for servers without a workspace index.
				for (const uri of options.openDocuments ?? []) {
					const symbols = await options.client.documentSymbolsFor(uri);
					const hit = symbols.find(symbol => symbol.name === identifier);
					if (!hit) continue;
					const resolved = {
						name: hit.name,
						kind: symbolKindName(hit.kind),
						uri,
						container: hit.container,
					};
					cache.set(identifier, resolved);
					return resolved;
				}
			} catch {
				// An unreachable language server resolves nothing. The frame
				// records the identifier as unresolved; nothing is invented.
				return undefined;
			}

			// A failure is NOT cached: the server may come back, and a
			// permanently-cached miss would hide a symbol that appears later.
			return undefined;
		},
	};
}
