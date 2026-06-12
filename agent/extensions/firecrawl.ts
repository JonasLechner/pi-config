import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import Firecrawl from "@mendable/firecrawl-js";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { StringEnum } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";

function readEnvValue(name: string) {
	if (process.env[name]) return process.env[name];

	const envPath = join(homedir(), ".pi", "agent", ".env");
	let envText = "";

	try {
		envText = readFileSync(envPath, "utf8");
	} catch {
		return undefined;
	}

	for (const line of envText.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;

		const match = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
		if (!match || match[1] !== name) continue;

		const value = match[2].trim();
		if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
			return value.slice(1, -1);
		}

		return value.replace(/\s+#.*$/, "");
	}

	return undefined;
}

function createClient() {
	const apiKey = readEnvValue("FIRECRAWL_API_KEY");
	if (!apiKey) {
		throw new Error("Missing FIRECRAWL_API_KEY in environment or ~/.pi/agent/.env");
	}

	return new Firecrawl({ apiKey });
}

function stringify(value: unknown) {
	return JSON.stringify(value, null, 2);
}

function asErrorMessage(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}

function shouldFallback(error: unknown) {
	const message = asErrorMessage(error).toLowerCase();
	return (
		message.includes("credit") ||
		message.includes("quota") ||
		message.includes("rate") ||
		message.includes("limit") ||
		message.includes("429") ||
		message.includes("402") ||
		message.includes("payment") ||
		message.includes("insufficient")
	);
}

function decodeHtml(text: string) {
	return text
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/<[^>]*>/g, "")
		.trim();
}

function decodeDdgUrl(url: string) {
	try {
		const parsed = new URL(url, "https://duckduckgo.com");
		const uddg = parsed.searchParams.get("uddg");
		return uddg ? decodeURIComponent(uddg) : parsed.href;
	} catch {
		return url;
	}
}

async function freeSearch(query: string, limit = 5) {
	const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
	const response = await fetch(url, {
		headers: {
			"user-agent": "Mozilla/5.0 (compatible; pi-coding-agent/1.0)",
			accept: "text/html",
		},
	});

	if (!response.ok) throw new Error(`DuckDuckGo search failed: HTTP ${response.status}`);

	const html = await response.text();
	const results: Array<{ title: string; url: string; description: string }> = [];
	const resultRegex = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;

	for (const match of html.matchAll(resultRegex)) {
		results.push({
			title: decodeHtml(match[2]),
			url: decodeDdgUrl(decodeHtml(match[1])),
			description: decodeHtml(match[3]),
		});
		if (results.length >= limit) break;
	}

	return { provider: "duckduckgo-html", query, results };
}

function jinaUrl(url: string) {
	return `https://r.jina.ai/http://${url}`;
}

async function freeScrape(url: string, timeout = 30000) {
	const controller = new AbortController();
	const id = setTimeout(() => controller.abort(), timeout);
	try {
		const response = await fetch(jinaUrl(url), {
			signal: controller.signal,
			headers: { "user-agent": "Mozilla/5.0 (compatible; pi-coding-agent/1.0)" },
		});
		if (!response.ok) throw new Error(`Jina Reader failed: HTTP ${response.status}`);
		return await response.text();
	} finally {
		clearTimeout(id);
	}
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "search",
		label: "Search Web",
		description:
			"Search the web. Uses Firecrawl first; if credits/quota/rate limits are hit, falls back to free DuckDuckGo HTML search.",
		promptSnippet: "Search the web for current information. Firecrawl is tried first, then a free fallback if needed.",
		promptGuidelines: [
			"Use search when the user asks for current web information, discovery, or sources beyond the local workspace.",
			"Use scrape after search when you need the full markdown content of a specific page.",
		],
		parameters: Type.Object({
			query: Type.String({ description: "The web search query." }),
			limit: Type.Optional(
				Type.Number({ description: "Maximum number of results to return. Defaults to 5.", minimum: 1, maximum: 20 }),
			),
			source: Type.Optional(StringEnum(["web", "news", "images"] as const)),
			scrapeResults: Type.Optional(
				Type.Boolean({ description: "Whether to scrape result pages and include markdown. Defaults to false." }),
			),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			try {
				onUpdate?.({ content: [{ type: "text", text: `Searching Firecrawl for: ${params.query}` }] });
				const client = createClient();
				const result = await client.search(params.query, {
					limit: params.limit ?? 5,
					sources: [params.source ?? "web"],
					scrapeOptions: params.scrapeResults ? { formats: ["markdown"], timeout: 30000 } : undefined,
					timeout: 30000,
				});
				if (signal?.aborted) throw new Error("Search cancelled");
				return { content: [{ type: "text", text: stringify(result) }], details: result };
			} catch (error) {
				if (!shouldFallback(error)) {
					return { content: [{ type: "text", text: `Firecrawl search failed: ${asErrorMessage(error)}` }], details: { error: asErrorMessage(error) }, isError: true };
				}

				try {
					const fallbackMessage = "Firecrawl is out of credits/rate-limited; using free DuckDuckGo search instead.";
					onUpdate?.({ content: [{ type: "text", text: fallbackMessage }] });
					ctx.ui.notify(fallbackMessage, "warning");
					const result = await freeSearch(params.query, params.limit ?? 5);
					return { content: [{ type: "text", text: stringify(result) }], details: result };
				} catch (fallbackError) {
					return { content: [{ type: "text", text: `Search failed. Firecrawl: ${asErrorMessage(error)}. Free fallback: ${asErrorMessage(fallbackError)}` }], details: { error: asErrorMessage(fallbackError) }, isError: true };
				}
			}
		},
	});

	pi.registerTool({
		name: "scrape",
		label: "Scrape Page",
		description: "Fetch a URL as markdown. Uses Firecrawl first; if credits/quota/rate limits are hit, falls back to free Jina Reader.",
		promptSnippet: "Fetch a URL's page content as markdown. Firecrawl is tried first, then a free fallback if needed.",
		promptGuidelines: [
			"Use scrape when you need the full readable markdown content of a known URL.",
			"Prefer scrape over bash/fetch for web pages because scrape returns cleaned markdown suitable for agent context.",
		],
		parameters: Type.Object({
			url: Type.String({ description: "The URL to fetch." }),
			onlyMainContent: Type.Optional(Type.Boolean({ description: "Only return the main page content. Defaults to true." })),
			waitFor: Type.Optional(Type.Number({ description: "Milliseconds to wait before capturing content, useful for JS-heavy pages." })),
			timeout: Type.Optional(Type.Number({ description: "Request timeout in milliseconds. Defaults to 30000." })),
			includeMetadata: Type.Optional(Type.Boolean({ description: "Append page metadata to markdown output. Defaults to false." })),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			try {
				onUpdate?.({ content: [{ type: "text", text: `Scraping page with Firecrawl: ${params.url}` }] });
				const client = createClient();
				const document = await client.scrape(params.url, {
					formats: ["markdown"],
					onlyMainContent: params.onlyMainContent ?? true,
					waitFor: params.waitFor,
					timeout: params.timeout ?? 30000,
				});
				if (signal?.aborted) throw new Error("Scrape cancelled");
				const metadata = params.includeMetadata && document.metadata ? `\n\nMetadata:\n${stringify(document.metadata)}` : "";
				const markdown = document.markdown?.trim() || "No markdown content returned.";
				return { content: [{ type: "text", text: `${markdown}${metadata}` }], details: document };
			} catch (error) {
				if (!shouldFallback(error)) {
					return { content: [{ type: "text", text: `Firecrawl scrape failed: ${asErrorMessage(error)}` }], details: { error: asErrorMessage(error) }, isError: true };
				}

				try {
					const fallbackMessage = "Firecrawl is out of credits/rate-limited; using free Jina Reader instead.";
					onUpdate?.({ content: [{ type: "text", text: fallbackMessage }] });
					ctx.ui.notify(fallbackMessage, "warning");
					const markdown = await freeScrape(params.url, params.timeout ?? 30000);
					return { content: [{ type: "text", text: markdown.trim() || "No markdown content returned." }], details: { provider: "jina-reader", url: params.url } };
				} catch (fallbackError) {
					return { content: [{ type: "text", text: `Scrape failed. Firecrawl: ${asErrorMessage(error)}. Free fallback: ${asErrorMessage(fallbackError)}` }], details: { error: asErrorMessage(fallbackError) }, isError: true };
				}
			}
		},
	});
}
