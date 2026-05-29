import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Api } from "@earendil-works/pi-ai";

type ClaudeOAuthFile = {
  claudeAiOauth?: {
    accessToken?: string;
    refreshToken?: string;
    expiresAt?: number;
    scopes?: string[];
    subscriptionType?: string;
    rateLimitTier?: string;
  };
};

type OAuthToken = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scopes?: string[];
  subscriptionType?: string;
  rateLimitTier?: string;
};

type ProviderModel = {
  id: string;
  name: string;
  reasoning: boolean;
  input: Array<"text" | "image">;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
};

const PROVIDER_NAME = "anthropic-claude-code";
const PROVIDER_API = "anthropic-messages" as Api;
const CREDENTIALS_PATH = path.join(os.homedir(), ".claude", ".credentials.json");
const REFRESH_URL = process.env.PI_CLAUDE_CODE_REFRESH_URL || "https://console.anthropic.com/v1/oauth/token";
const PROVIDER_BASE_URL = process.env.PI_CLAUDE_CODE_BASE_URL || "https://api.anthropic.com";
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const REFRESH_SKEW_MS = 5 * 60 * 1000;
const DISABLE_PI_DOCS_REWRITE = process.env.PI_CLAUDE_CODE_DISABLE_PI_DOCS_REWRITE === "1";
const SYSTEM_PROMPT_MODE = process.env.PI_CLAUDE_CODE_SYSTEM_PROMPT_MODE || "docs-itself-packages";
const DEBUG_PAYLOAD_PATH = process.env.PI_CLAUDE_CODE_DEBUG_PAYLOAD_PATH;

const MODELS: ProviderModel[] = [
  {
    id: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6 (Claude Code creds)",
    reasoning: true,
    input: ["text", "image"],
    // OpenRouter pricing, USD per 1M tokens.
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    contextWindow: 1_000_000,
    maxTokens: 64_000,
  },
  {
    id: "claude-opus-4-6",
    name: "Claude Opus 4.6 (Claude Code creds)",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
    contextWindow: 1_000_000,
    maxTokens: 128_000,
  },
  {
    id: "claude-opus-4-7",
    name: "Claude Opus 4.7 (Claude Code creds)",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
    contextWindow: 1_000_000,
    maxTokens: 128_000,
  },
  {
    id: "claude-opus-4-8",
    name: "Claude Opus 4.8 (Claude Code creds)",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
    contextWindow: 1_000_000,
    maxTokens: 128_000,
  },
  {
    id: "claude-haiku-4-5",
    name: "Claude Haiku 4.5 (Claude Code creds)",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
    contextWindow: 200_000,
    maxTokens: 64_000,
  },
];

let refreshPromise: Promise<string | null> | null = null;

function rewritePiDocsBlock(text: string): string {
  const startMarker = "Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):";
  const endMarker = "# Project Context";
  const start = text.indexOf(startMarker);
  const end = text.indexOf(endMarker, start);
  if (start === -1 || end === -1) return text;

  const before = text.slice(0, start);
  const block = text
    .slice(start, end)
    .replace(
      "Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):",
      "Assistant documentation (read only when the user asks about the assistant itself, its SDK, extensions, themes, skills, or TUI):",
    )
    .replace("pi packages (docs/packages.md)", "assistant packages (docs/packages.md)")
    .replace(
      "- Always read pi .md files completely and follow links to related docs (e.g., tui.md for TUI API details)",
      "- Always read assistant .md files completely and follow links to related docs (e.g., tui.md for TUI API details)",
    );
  const after = text.slice(end);
  return `${before}${block}${after}`;
}

function stripPiDocsBlock(text: string): string {
  const startMarker = "Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):";
  const endMarker = "# Project Context";
  const start = text.indexOf(startMarker);
  const end = text.indexOf(endMarker, start);
  if (start === -1 || end === -1) return text;
  return `${text.slice(0, start)}${text.slice(end)}`;
}

function rewritePiFingerprint(text: string): string {
  return text
    .replace(
      "You are an expert coding assistant operating inside pi, a coding agent harness.",
      "You are an expert coding assistant operating inside Claude Code, Anthropic's official CLI for Claude.",
    )
    .replace(/@mariozechner\/pi-coding-agent/g, "Claude Code")
    .replace(/pi-coding-agent/g, "claude-code")
    .replace(/\b[Pp]i documentation\b/g, "Assistant documentation")
    .replace(/\b[Pp]i packages\b/g, "assistant packages")
    .replace(/\b[Pp]i \.md files\b/g, "assistant .md files")
    .replace(/\b[Pp]i itself\b/g, "the assistant itself")
    .replace(/\binside pi\b/g, "inside Claude Code")
    .replace(/\b[Pp]i's\b/g, "the assistant's")
    .replace(/\b[Pp]i\b/g, "assistant");
}

function scrubPiPrompt(text: string): string {
  if (DISABLE_PI_DOCS_REWRITE) return text.trim();

  if (SYSTEM_PROMPT_MODE === "strip-docs") {
    return stripPiDocsBlock(text).trim();
  }

  if (SYSTEM_PROMPT_MODE === "first-line") {
    return text
      .replace(
        "You are an expert coding assistant operating inside pi, a coding agent harness.",
        "You are an expert coding assistant operating inside Claude Code, Anthropic's official CLI for Claude.",
      )
      .trim();
  }

  if (SYSTEM_PROMPT_MODE === "inside-pi") {
    return text.replace(/\binside pi\b/g, "inside Claude Code").trim();
  }

  if (SYSTEM_PROMPT_MODE === "docs-heading") {
    return text.replace(/\b[Pp]i documentation\b/g, "Assistant documentation").trim();
  }

  if (SYSTEM_PROMPT_MODE === "docs-itself") {
    return text.replace(/\b[Pp]i itself\b/g, "the assistant itself").trim();
  }

  if (SYSTEM_PROMPT_MODE === "docs-packages") {
    return text.replace(/\b[Pp]i packages\b/g, "assistant packages").trim();
  }

  if (SYSTEM_PROMPT_MODE === "docs-topics") {
    return text.replace(/\b[Pp]i topics\b/g, "assistant topics").trim();
  }

  if (SYSTEM_PROMPT_MODE === "docs-md") {
    return text.replace(/\b[Pp]i \.md files\b/g, "assistant .md files").trim();
  }

  if (SYSTEM_PROMPT_MODE === "docs-itself-packages") {
    return text.replace(/\b[Pp]i itself\b/g, "the assistant itself").replace(/\b[Pp]i packages\b/g, "assistant packages").trim();
  }

  if (SYSTEM_PROMPT_MODE.startsWith("docs-pi-words")) {
    let result = text;
    if (!SYSTEM_PROMPT_MODE.includes("minus-heading")) {
      result = result.replace(/\b[Pp]i documentation\b/g, "Assistant documentation");
    }
    if (!SYSTEM_PROMPT_MODE.includes("minus-itself")) {
      result = result.replace(/\b[Pp]i itself\b/g, "the assistant itself");
    }
    if (!SYSTEM_PROMPT_MODE.includes("minus-packages")) {
      result = result.replace(/\b[Pp]i packages\b/g, "assistant packages");
    }
    if (!SYSTEM_PROMPT_MODE.includes("minus-topics")) {
      result = result.replace(/\b[Pp]i topics\b/g, "assistant topics");
    }
    if (!SYSTEM_PROMPT_MODE.includes("minus-md")) {
      result = result.replace(/\b[Pp]i \.md files\b/g, "assistant .md files");
    }
    return result.trim();
  }

  if (SYSTEM_PROMPT_MODE === "pi-word") {
    return text.replace(/\b[Pp]i\b/g, "assistant").trim();
  }

  if (SYSTEM_PROMPT_MODE === "package-name") {
    return text.replace(/@mariozechner\/pi-coding-agent/g, "Claude Code").replace(/pi-coding-agent/g, "claude-code").trim();
  }

  if (SYSTEM_PROMPT_MODE === "aggressive") {
    return rewritePiFingerprint(rewritePiDocsBlock(text)).trim();
  }

  return rewritePiDocsBlock(text).trim();
}

async function maybeDumpPayload(payload: unknown): Promise<void> {
  if (!DEBUG_PAYLOAD_PATH) return;
  try {
    await fs.writeFile(DEBUG_PAYLOAD_PATH, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  } catch {
    // Debug-only; never break provider requests.
  }
}

async function rewriteSystemInPayload(payload: unknown): Promise<unknown> {
  if (!payload || typeof payload !== "object") return payload;
  const body = payload as { system?: unknown };

  if (SYSTEM_PROMPT_MODE === "claude-code-only") {
    const next = {
      ...body,
      system: [
        {
          type: "text",
          text: "You are Claude Code, Anthropic's official CLI for Claude.",
          cache_control: { type: "ephemeral" },
        },
      ],
    };
    await maybeDumpPayload(next);
    return next;
  }

  let next: unknown = payload;
  if (typeof body.system === "string") {
    next = { ...body, system: scrubPiPrompt(body.system) };
  } else if (Array.isArray(body.system)) {
    next = {
      ...body,
      system: body.system.map((block) => {
        if (!block || typeof block !== "object") return block;
        const textBlock = block as { type?: unknown; text?: unknown };
        if (textBlock.type === "text" && typeof textBlock.text === "string") {
          return { ...textBlock, text: scrubPiPrompt(textBlock.text) };
        }
        return block;
      }),
    };
  }

  await maybeDumpPayload(next);
  return next;
}

async function readTokenFile(): Promise<OAuthToken | null> {
  try {
    const raw = await fs.readFile(CREDENTIALS_PATH, "utf8");
    const data = JSON.parse(raw) as ClaudeOAuthFile;
    const oauth = data.claudeAiOauth;
    if (!oauth?.accessToken || !oauth?.refreshToken || typeof oauth.expiresAt !== "number") {
      return null;
    }
    return {
      accessToken: oauth.accessToken,
      refreshToken: oauth.refreshToken,
      expiresAt: oauth.expiresAt,
      scopes: oauth.scopes,
      subscriptionType: oauth.subscriptionType,
      rateLimitTier: oauth.rateLimitTier,
    };
  } catch {
    return null;
  }
}

async function writeTokenFile(token: OAuthToken): Promise<void> {
  const raw = await fs.readFile(CREDENTIALS_PATH, "utf8");
  const data = JSON.parse(raw) as ClaudeOAuthFile;
  data.claudeAiOauth = {
    accessToken: token.accessToken,
    refreshToken: token.refreshToken,
    expiresAt: token.expiresAt,
    scopes: token.scopes,
    subscriptionType: token.subscriptionType,
    rateLimitTier: token.rateLimitTier,
  };
  await fs.writeFile(CREDENTIALS_PATH, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

async function refreshToken(current: OAuthToken): Promise<OAuthToken> {
  const response = await fetch(REFRESH_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: current.refreshToken,
      client_id: CLIENT_ID,
    }),
  });

  const bodyText = await response.text();
  if (!response.ok) {
    throw new Error(`Claude Code token refresh failed (${response.status}): ${bodyText}`);
  }

  const data = JSON.parse(bodyText) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };

  if (!data.access_token || typeof data.expires_in !== "number") {
    throw new Error("Claude Code token refresh returned an unexpected payload");
  }

  return {
    ...current,
    accessToken: data.access_token,
    refreshToken: data.refresh_token || current.refreshToken,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
}

async function getAccessToken(): Promise<string | null> {
  const token = await readTokenFile();
  if (!token) return null;

  if (Date.now() < token.expiresAt - REFRESH_SKEW_MS) {
    return token.accessToken;
  }

  if (!refreshPromise) {
    refreshPromise = (async () => {
      const refreshed = await refreshToken(token);
      await writeTokenFile(refreshed);
      return refreshed.accessToken;
    })().finally(() => {
      refreshPromise = null;
    });
  }

  return refreshPromise;
}

async function registerClaudeCodeProvider(pi: ExtensionAPI) {
  const accessToken = await getAccessToken();
  if (!accessToken) return false;

  pi.registerProvider(PROVIDER_NAME, {
    baseUrl: PROVIDER_BASE_URL,
    api: PROVIDER_API,
    apiKey: accessToken,
    models: MODELS,
  });

  return true;
}

async function refreshClaudeCodeProviderStatus(pi: ExtensionAPI, ctx: { ui: { setStatus: (key: string, text?: string) => void } }): Promise<boolean> {
  const ok = await registerClaudeCodeProvider(pi);
  ctx.ui.setStatus(PROVIDER_NAME, ok ? undefined : "Claude Code creds unavailable");
  return ok;
}

function isClaudeCodeProvider(ctx: unknown): boolean {
  return (ctx as { model?: { provider?: string } })?.model?.provider === PROVIDER_NAME;
}

export default async function (pi: ExtensionAPI) {
  await registerClaudeCodeProvider(pi);

  pi.registerCommand("claude-code-provider-status", {
    description: "Show Claude Code provider credential status",
    handler: async (_args, ctx) => {
      const token = await readTokenFile();
      if (!token) {
        ctx.ui.notify("Claude Code credentials not found", "warning");
        return;
      }

      const expiresInMs = token.expiresAt - Date.now();
      const expiresText = expiresInMs <= 0 ? "expired" : `${Math.floor(expiresInMs / 60000)}m remaining`;

      try {
        const ok = await refreshClaudeCodeProviderStatus(pi, ctx);
        const scopeText = token.scopes?.length ? token.scopes.join(", ") : "none";
        ctx.ui.notify(
          [
            "Claude Code creds: present",
            `Provider: ${ok ? "registered" : "not registered"}`,
            `API: ${PROVIDER_API}`,
            `Expiry: ${expiresText}`,
            `Subscription: ${token.subscriptionType || "unknown"}`,
            `Rate tier: ${token.rateLimitTier || "unknown"}`,
            `Scopes: ${scopeText}`,
            `Base URL: ${PROVIDER_BASE_URL}`,
            `Refresh URL: ${REFRESH_URL}`,
            `System prompt rewrite: ${DISABLE_PI_DOCS_REWRITE ? "disabled" : SYSTEM_PROMPT_MODE}`,
            `Source: ${CREDENTIALS_PATH}`,
          ].join("\n"),
          ok ? "info" : "warning",
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(
          [
            "Claude Code creds: present",
            "Provider: error",
            `API: ${PROVIDER_API}`,
            `Expiry: ${expiresText}`,
            `Base URL: ${PROVIDER_BASE_URL}`,
            `Refresh URL: ${REFRESH_URL}`,
            `Source: ${CREDENTIALS_PATH}`,
            `Error: ${message}`,
          ].join("\n"),
          "error",
        );
      }
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    try {
      await refreshClaudeCodeProviderStatus(pi, ctx);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.setStatus(PROVIDER_NAME, "Claude Code provider error");
      ctx.ui.notify(`Claude Code provider: ${message}`, "warning");
    }
  });

  pi.on("before_agent_start", async (event, ctx) => {
    try {
      await refreshClaudeCodeProviderStatus(pi, ctx);
    } catch {
      // Ignore here; session_start already surfaces errors.
    }

    if (!isClaudeCodeProvider(ctx)) return;
    if (SYSTEM_PROMPT_MODE === "claude-code-only") return;
    return { systemPrompt: scrubPiPrompt(event.systemPrompt) };
  });

  pi.on("before_provider_request", async (event, ctx) => {
    if (!isClaudeCodeProvider(ctx)) return;
    return rewriteSystemInPayload(event.payload);
  });
}
