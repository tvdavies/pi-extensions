import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import { Type } from "typebox";

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

function truncate(text: string, maxChars: number) {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n\n[Truncated to ${maxChars} characters from ${text.length}.]`;
}

function normaliseWhitespace(text: string) {
  return text.replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").replace(/[ \t]+/g, " ").trim();
}

function htmlToTextFallback(html: string) {
  return normaliseWhitespace(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
  );
}

async function fetchText(url: string, timeoutMs: number) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "user-agent": DEFAULT_USER_AGENT,
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5",
      },
      redirect: "follow",
    });

    const contentType = response.headers.get("content-type") ?? "";
    const body = await response.text();

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}: ${body.slice(0, 500)}`);
    }

    return { body, contentType, finalUrl: response.url };
  } finally {
    clearTimeout(timeout);
  }
}

function extractArticle(html: string, url: string) {
  const dom = new JSDOM(html, { url });
  const reader = new Readability(dom.window.document);
  const article = reader.parse();

  if (!article?.textContent) {
    return { title: dom.window.document.title || url, text: htmlToTextFallback(html) };
  }

  return {
    title: article.title || dom.window.document.title || url,
    byline: article.byline ?? undefined,
    excerpt: article.excerpt ?? undefined,
    text: normaliseWhitespace(article.textContent),
  };
}

type SearxngResult = {
  title?: string;
  url?: string;
  content?: string;
  engine?: string;
  score?: number;
};

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "web_fetch",
    label: "Web Fetch",
    description:
      "Fetch a URL locally and extract readable article text. Uses direct HTTP fetch; no external AI or search API required.",
    parameters: Type.Object({
      url: Type.String({ description: "The URL to fetch" }),
      maxChars: Type.Optional(Type.Number({ description: "Maximum characters to return", default: 20000 })),
      timeoutMs: Type.Optional(Type.Number({ description: "Request timeout in milliseconds", default: 15000 })),
      raw: Type.Optional(Type.Boolean({ description: "Return raw response text instead of article extraction", default: false })),
    }),
    execute: async (_toolCallId, params) => {
      const maxChars = Math.max(1000, Math.min(Number(params.maxChars ?? 20000), 100000));
      const timeoutMs = Math.max(1000, Math.min(Number(params.timeoutMs ?? 15000), 60000));
      const { body, contentType, finalUrl } = await fetchText(params.url, timeoutMs);

      if (params.raw || !contentType.includes("html")) {
        return {
          content: [{ type: "text", text: truncate(body, maxChars) }],
          details: { url: params.url, finalUrl, contentType, raw: true },
        };
      }

      const article = extractArticle(body, finalUrl);
      const header = [`# ${article.title}`, article.byline ? `By: ${article.byline}` : undefined, article.excerpt].filter(Boolean).join("\n");
      const text = `${header}\n\n${article.text}`;

      return {
        content: [{ type: "text", text: truncate(text, maxChars) }],
        details: { url: params.url, finalUrl, contentType, title: article.title },
      };
    },
  });

  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description:
      "Search the web through a local SearXNG instance. Start SearXNG locally and set format=json support; no paid API required.",
    parameters: Type.Object({
      query: Type.String({ description: "Search query" }),
      searxngUrl: Type.Optional(Type.String({ description: "Base URL of local SearXNG", default: "http://localhost:8080" })),
      limit: Type.Optional(Type.Number({ description: "Maximum results", default: 10 })),
      timeoutMs: Type.Optional(Type.Number({ description: "Request timeout in milliseconds", default: 15000 })),
    }),
    execute: async (_toolCallId, params) => {
      const baseUrl = String(params.searxngUrl ?? "http://localhost:8080").replace(/\/$/, "");
      const limit = Math.max(1, Math.min(Number(params.limit ?? 10), 25));
      const timeoutMs = Math.max(1000, Math.min(Number(params.timeoutMs ?? 15000), 60000));
      const searchUrl = `${baseUrl}/search?q=${encodeURIComponent(params.query)}&format=json`;
      const { body } = await fetchText(searchUrl, timeoutMs);
      const payload = JSON.parse(body) as { results?: SearxngResult[] };
      const results = (payload.results ?? []).slice(0, limit);

      if (results.length === 0) {
        return {
          content: [{ type: "text", text: "No results returned from SearXNG." }],
          details: { query: params.query, searxngUrl: baseUrl, results: 0 },
        };
      }

      const text = results
        .map((result, index) => {
          const title = result.title ?? "Untitled";
          const url = result.url ?? "No URL";
          const snippet = result.content ? `\n${normaliseWhitespace(result.content)}` : "";
          return `${index + 1}. ${title}\n${url}${snippet}`;
        })
        .join("\n\n");

      return {
        content: [{ type: "text", text }],
        details: { query: params.query, searxngUrl: baseUrl, results: results.length },
      };
    },
  });
}
