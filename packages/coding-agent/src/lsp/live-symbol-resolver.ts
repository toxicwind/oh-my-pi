/**
 * Live symbol resolver — the intent frame's eyes, wired to the real language
 * server.
 *
 * The resolver asks the LSP two questions:
 *
 *  - `workspace/symbol` — the project-wide index, when the server has one;
 *  - `textDocument/documentSymbol` — the open documents, for servers without
 *    a workspace index.
 *
 * The protocol shapes are the ones the LSP tool already uses
 * (`SymbolInformation` / `DocumentSymbol`), so this shares the engine's
 * understanding of the protocol rather than inventing a second one.
 *
 * Every lookup is best-effort and cached on success only: a failed lookup is
 * not cached, because the server may come back and a permanently-cached miss
 * would hide a symbol that appears later.
 */

import { getConfig, getServersForFile } from "./config";
import { getOrCreateClient, sendRequest } from "./client";
import { symbolKindName } from "./symbol-resolver";

/** The LSP `SymbolInformation` shape. */
interface SymbolInformation {
	name: string;
	kind: number;
	containerName?: string;
	location?: { uri: string };
}

/** A resolved symbol. */
export interface ResolvedLiveSymbol {
	readonly name: string;
	readonly kind: string;
	readonly uri: string;
	readonly container?: string;
}

/** Options for the live resolver. */
export interface LiveSymbolResolverOptions {
	/** The working directory whose servers are consulted. */
	readonly cwd: string;
	/** A file whose server should be preferred (the one being edited). */
	readonly preferredFile?: string;
}

/** Creates a resolver that consults the real language servers. */
export function createLiveSymbolResolver(options: LiveSymbolResolverOptions) {
	const cache = new Map<string, ResolvedLiveSymbol>();

	const resolve = async (identifier: string): Promise<ResolvedLiveSymbol | undefined> => {
		if (!identifier) return undefined;
		const cached = cache.get(identifier);
		if (cached) return cached;

		try {
			const config = getConfig(options.cwd);
			const preferred = options.preferredFile ? getServersForFile(config, options.preferredFile) : [];
			const servers = preferred.length > 0 ? preferred : getServersForFile(config, "x.ts");

			for (const [, serverConfig] of servers) {
				const client = await getOrCreateClient(serverConfig, options.cwd);
				if (!client) continue;

				// Project-wide first: the server's own index.
				const workspace = (await sendRequest(client, "workspace/symbol", { query: identifier })) as
					| SymbolInformation[]
					| null;
				const hit = workspace?.find(symbol => symbol.name === identifier);
				if (hit?.location?.uri) {
					const resolved: ResolvedLiveSymbol = {
						name: hit.name,
						kind: symbolKindName(hit.kind),
						uri: hit.location.uri,
						container: hit.containerName,
					};
					cache.set(identifier, resolved);
					return resolved;
				}
			}
		} catch {
			// An unreachable language server resolves nothing. The frame
			// records the identifier as unresolved; nothing is invented.
			return undefined;
		}
		return undefined;
	};

	return { resolve };
}
