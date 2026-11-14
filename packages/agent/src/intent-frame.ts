/**
 * Intent frame — a machine-readable statement of what a human turn asked for.
 *
 * The agent runtime has no structured record of a request: the human's turn is
 * prose that gets appended to the context, and from then on the model decides
 * what it means. That is why a turn can be answered with work on a completely
 * different subject — nothing downstream can say "that was not what I asked".
 *
 * This module turns the prose into a typed frame at the turn boundary:
 *
 *  - **actions** — a small action taxonomy, so "search" can be checked against
 *    the tool kinds that actually search.
 *  - **symbols** — identifiers the human named, *resolved* through an injected
 *    resolver (an LSP symbol table in production). A named identifier that
 *    cannot be resolved is recorded as unresolved; it is never dropped.
 *  - **paths** — file paths the human named, normalised.
 *  - **prohibitions** — the human's negative constraints ("stop using head").
 *  - **terminal** — an explicit "we are done" signal.
 *
 * The frame is a *description*, never a gate. Deciding whether an action was
 * relevant is a semantic judgement; the frame makes the question answerable
 * and the answer checkable, but it does not decide it.
 */

/** Action taxonomy. Deliberately small: each entry must be checkable. */
export type IntentAction = "inspect" | "modify" | "verify" | "explain" | "search" | "stop" | "finish" | "publish";

/** Kind of prohibition the human expressed. */
export type ProhibitionKind = "method" | "scope" | "style";

/** A prohibition the human stated, with the thing that is prohibited. */
export interface Prohibition {
	readonly kind: ProhibitionKind;
	/** The prohibited subject: a tool, a method, a scope boundary. */
	readonly subject: string;
	/** The human's original wording, kept for the judge path and the report. */
	readonly raw: string;
}

/** A symbol the human named, resolved to a real definition. */
export interface ResolvedSymbol {
	readonly name: string;
	/** LSP `SymbolKind`, normalised to a lowercase string. */
	readonly kind: string;
	readonly uri: string;
	readonly container?: string;
	readonly range?: {
		readonly start: { readonly line: number; readonly character: number };
		readonly end: { readonly line: number; readonly character: number };
	};
}

/** A path the human named, normalised to forward slashes. */
export interface ResolvedPath {
	readonly path: string;
}

/** A resolved symbol lookup. */
export interface ResolvedSymbolInfo {
	readonly name: string;
	readonly kind: string;
	readonly uri: string;
	readonly container?: string;
	readonly range?: {
		readonly start: { readonly line: number; readonly character: number };
		readonly end: { readonly line: number; readonly character: number };
	};
}

/**
 * Symbol lookup injected by the host. In production this is backed by the LSP
 * (`textDocument/documentSymbol` + `workspace/symbol`); tests inject a table.
 */
export interface SymbolResolver {
	resolve(identifier: string): ResolvedSymbolInfo | undefined;
}

/** Options for {@link buildIntentFrame}. */
export interface IntentFrameOptions {
	/** Resolves an identifier to a real symbol. Absent → nothing resolves. */
	readonly resolveSymbol?: (identifier: string) => ResolvedSymbolInfo | undefined;
	/** Known symbol names, used to avoid proposing resolution of prose words. */
	readonly knownSymbols?: readonly string[];
}

/** The structured statement of a human turn. */
export interface IntentFrame {
	/** Normalised actions the turn asks for. */
	readonly actions: readonly IntentAction[];
	/** Symbols the turn named, resolved. */
	readonly symbols: readonly ResolvedSymbol[];
	/** Identifiers the turn named that could not be resolved. */
	readonly unresolvedIdentifiers: readonly string[];
	/** Paths the turn named. */
	readonly paths: readonly ResolvedPath[];
	/** Negative constraints the turn stated. */
	readonly prohibitions: readonly Prohibition[];
	/** True when the turn is an explicit wrap-up signal. */
	readonly terminal: boolean;
	/** The human's original text. */
	readonly raw: string;
}

// ── lexical helpers ──────────────────────────────────────────────────────────

const IDENTIFIER_RE = /[A-Za-z_$][A-Za-z0-9_$]*/g;

/** Words that look like identifiers but are never symbol references. */
const STOP_WORDS = new Set([
	"the",
	"and",
	"for",
	"you",
	"that",
	"this",
	"with",
	"have",
	"not",
	"but",
	"its",
	"are",
	"was",
	"were",
	"why",
	"how",
	"what",
	"when",
	"where",
	"can",
	"cant",
	"dont",
	"does",
	"did",
	"do",
	"find",
	"all",
	"any",
	"one",
	"two",
	"new",
	"now",
	"use",
	"make",
	"just",
	"more",
	"ok",
	"yes",
	"yeah",
	"sure",
	"done",
	"here",
	"there",
	"them",
	"they",
	"from",
	"into",
	"please",
	"thanks",
	"stop",
	"lets",
	"let",
	"go",
	"get",
	"put",
	"try",
	"see",
	"look",
	"also",
	"then",
	"than",
	"some",
	"every",
	"each",
	"both",
	"very",
	"still",
	"even",
	"only",
	"same",
	"other",
	"another",
	"need",
	"needs",
	"want",
	"i",
	"im",
	"me",
	"my",
	"we",
	"our",
	"us",
	"it",
	"its",
	"is",
	"was",
	"be",
	"been",
	"has",
	"have",
	"had",
	"will",
	"would",
	"should",
	"could",
	"must",
	"may",
	"might",
	"shall",
	"a",
	"an",
	"as",
	"at",
	"by",
	"in",
	"of",
	"on",
	"or",
	"to",
	"up",
	"out",
	"off",
	"over",
	"under",
	"again",
	"very",
	"much",
	"many",
	"lot",
	"thing",
	"things",
	"stuff",
	"way",
	"one",
]);

/** Method-ish verbs that mean "go and look". */
const SEARCH_VERBS = ["find", "search", "locate", "grep", "look", "locate", "show", "list", "discover"];

/** Verbs that mean "change something". */
const MODIFY_VERBS = [
	"fix",
	"change",
	"edit",
	"update",
	"rewrite",
	"refactor",
	"patch",
	"modify",
	"implement",
	"add",
	"remove",
	"delete",
	"rename",
	"move",
	"replace",
	"convert",
	"port",
	"migrate",
	"clean",
];

/** Verbs that mean "prove something". */
const VERIFY_VERBS = ["verify", "check", "test", "prove", "confirm", "validate", "audit", "ensure", "assert"];

/** Verbs that mean "tell me". */
const EXPLAIN_VERBS = ["explain", "why", "describe", "summarize", "summarise", "clarify", "elaborate"];

/** Verbs that mean "publish". */
const PUBLISH_VERBS = ["publish", "upload", "gist", "post", "release", "push", "ship"];

/** Terminal phrases that mean the human wants closure. */
const TERMINAL_PHRASES = [
	"lets finish up",
	"let's finish up",
	"finish up",
	"lets finish",
	"let's finish",
	"wrap up",
	"we are done",
	"were done",
	"thats all",
	"that's all",
	"finalize",
	"finalise",
	"call it done",
	"stop here",
	"end of work",
];

const PROHIBITION_MARKERS = [
	"stop using",
	"dont use",
	"don't use",
	"do not use",
	"never use",
	"no more",
	"stop doing",
	"dont do",
	"don't do",
	"not just",
	"dont read",
	"don't read",
	"avoid",
	"instead of",
	"rather than",
];

const METHOD_SUBJECTS = [
	"head",
	"tail",
	"find",
	"grep",
	"cat",
	"sed",
	"awk",
	"ls",
	"cd",
	"echo",
	"printf",
	"sudo",
	"docker",
	"npm",
	"bun",
	"cargo",
	"make",
	"git",
];

/** Sentence splitter that keeps the delimiter. */
function sentences(text: string): string[] {
	return text
		.split(/(?<=[.!?…])\s+|\n+/)
		.map(s => s.trim())
		.filter(s => s.length > 0);
}

/** Normalises a path-ish token to forward slashes with no leading "./". */
function normalizePath(raw: string): string {
	let p = raw.replace(/\\/g, "/").trim();
	p = p.replace(/^["'`]|["'`]$/g, "");
	while (p.startsWith("./")) p = p.slice(2);
	return p;
}

/** True when the token looks like a file path rather than prose. */
function looksLikePath(token: string): boolean {
	return token.includes("/") || /\.[A-Za-z0-9]{1,6}$/.test(token);
}

/**
 * Extracts candidate identifiers from a sentence: camelCase / snake_case /
 * dotted names, plus bare CapitalisedWords. Plain lowercase words are prose.
 */
function candidateIdentifiers(sentence: string): string[] {
	const out: string[] = [];
	for (const match of sentence.matchAll(IDENTIFIER_RE)) {
		const token = match[0];
		if (token.length < 3) continue;
		if (STOP_WORDS.has(token.toLowerCase())) continue;
		const hasCaseSignal = /[a-z][A-Z]/.test(token) || token.includes("_") || /^[A-Z]/.test(token);
		if (!hasCaseSignal) continue;
		out.push(token);
	}
	return out;
}

/** Strips a leading dotted qualifier so `foo.bar()` yields `bar`. */
function baseIdentifier(token: string): string {
	const parts = token.split(".");
	return parts[parts.length - 1] ?? token;
}

/** Detects an explicit prohibition and its subject. */
function detectProhibition(sentence: string): Prohibition | undefined {
	const lower = sentence.toLowerCase();
	for (const marker of PROHIBITION_MARKERS) {
		const at = lower.indexOf(marker);
		if (at < 0) continue;
		const rest = sentence.slice(at + marker.length).trim();
		// "stop using head, use rg instead" → subject is the first token after the marker.
		const subjectToken = rest.split(/[\s,.;:]+/).find(t => t.length > 0) ?? "";
		const cleaned = subjectToken.replace(/[^A-Za-z0-9_./-]/g, "");
		if (!cleaned) continue;
		const kind: ProhibitionKind = marker.includes("not just") ? "scope" : "method";
		return { kind, subject: cleaned, raw: sentence };
	}
	return undefined;
}

/** Detects whether the sentence names a scope *expansion* ("not just X, all Y"). */
function detectScopeProhibition(sentence: string): Prohibition | undefined {
	const lower = sentence.toLowerCase();
	if (!lower.includes("not just") && !lower.includes("not only")) return undefined;
	const m = /not (?:just|only)\s+([^,.]+)/i.exec(sentence);
	if (!m) return undefined;
	return { kind: "scope", subject: m[1].trim(), raw: sentence };
}

/**
 * Builds the intent frame for a human turn.
 *
 * Deterministic: the same text and the same resolver always yield the same
 * frame. No model is consulted.
 */
export function buildIntentFrame(raw: string, options: IntentFrameOptions = {}): IntentFrame {
	const text = raw ?? "";
	const resolveSymbol = options.resolveSymbol;
	const known = new Set((options.knownSymbols ?? []).map(s => s.toLowerCase()));

	const actions = new Set<IntentAction>();
	const prohibitions: Prohibition[] = [];
	const symbols: ResolvedSymbol[] = [];
	const unresolved = new Set<string>();
	const paths = new Set<string>();
	const seenSymbols = new Set<string>();

	const lowerText = text.toLowerCase();
	let terminal = false;
	for (const phrase of TERMINAL_PHRASES) {
		if (lowerText.includes(phrase)) {
			terminal = true;
			actions.add("finish");
			break;
		}
	}

	for (const sentence of sentences(text)) {
		const lower = sentence.toLowerCase();

		const words = lower.split(/[^a-z]+/).filter(Boolean);
		const hasVerb = (list: readonly string[]) => list.some(v => words.includes(v));
		if (hasVerb(SEARCH_VERBS)) actions.add("search");
		if (hasVerb(MODIFY_VERBS)) actions.add("modify");
		if (hasVerb(VERIFY_VERBS)) actions.add("verify");
		if (hasVerb(EXPLAIN_VERBS)) actions.add("explain");
		if (hasVerb(PUBLISH_VERBS)) actions.add("publish");
		if (lower.startsWith("stop") || words[0] === "stop") actions.add("stop");
		if (lower.startsWith("find ")) actions.add("search");

		const prohibition = detectScopeProhibition(sentence) ?? detectProhibition(sentence);
		if (prohibition) prohibitions.push(prohibition);

		for (const token of sentence.split(/[\s,;:()[\]"'`]+/)) {
			if (!token) continue;
			if (looksLikePath(token)) {
				const p = normalizePath(token);
				if (p.length > 1 && !p.endsWith("/") && p.includes("/")) paths.add(p);
			}
		}

		for (const candidate of candidateIdentifiers(sentence)) {
			const base = baseIdentifier(candidate);
			if (base.length < 3) continue;
			if (known.has(base.toLowerCase())) {
				// Known to be a symbol but not resolvable right now: still unresolved.
				unresolved.add(base);
				continue;
			}
			const resolved = resolveSymbol?.(base);
			if (resolved) {
				if (!seenSymbols.has(resolved.name)) {
					seenSymbols.add(resolved.name);
					symbols.push({
						name: resolved.name,
						kind: resolved.kind,
						uri: resolved.uri,
						container: resolved.container,
						range: resolved.range,
					});
				}
			} else {
				unresolved.add(base);
			}
		}
	}

	return {
		actions: [...actions],
		symbols,
		unresolvedIdentifiers: [...unresolved].sort(),
		paths: [...paths].sort().map(p => ({ path: p })),
		prohibitions,
		terminal,
		raw: text,
	};
}

/** Method-prohibition subjects the frame recognised (helper for obligation compilation). */
export function methodProhibitionSubjects(frame: IntentFrame): string[] {
	return frame.prohibitions.filter(p => p.kind === "method").map(p => p.subject);
}

/** True when the subject is a known shell method the prohibition system tracks. */
export function isTrackedMethodSubject(subject: string): boolean {
	return METHOD_SUBJECTS.includes(subject.toLowerCase());
}
