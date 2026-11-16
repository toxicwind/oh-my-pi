import { classifyModel } from "../compat/taxonomy";
import { type Api } from "../../types";

export type Dialect =
	| "glm"
	| "hermes"
	| "kimi"
	| "xml"
	| "anthropic"
	| "deepseek"
	| "harmony"
	| "qwen3"
	| "gemini"
	| "gemma"
	| "minimax";

export const FALLBACK_DIALECT: Dialect = "xml";

export function preferredDialect(modelId: string, providerApi?: Api): Dialect {
	switch (classifyModel("", modelId, { lenient: true }).class) {
		case "anthropic":
			return "anthropic";
		case "glm":
			return "glm";
		case "gemini":
			return "gemini";
		case "gemma":
			return "gemma";
		case "kimi":
			return "kimi";
		case "qwen":
			return "qwen3";
		case "deepseek":
			return "deepseek";
		case "minimax":
			return "minimax";
		case "openai":
		case "gpt-oss":
			return "harmony";
		default:
			if (providerApi === "openai-completions") return "harmony";
			if (providerApi === "anthropic-messages") return "anthropic";
			return FALLBACK_DIALECT;
	}
}
