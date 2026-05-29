import { spawn } from "node:child_process";

/** Minimal Pi API surface used by this extension. */
export interface PiExtensionAPI {
  on(
    event: "input",
    handler: (
      event: InputEvent,
      ctx: PiContext,
    ) => Promise<InputResult | undefined> | InputResult | undefined,
  ): void;
  on(
    event: "before_agent_start",
    handler: (
      event: BeforeAgentStartEvent,
      ctx: PiContext,
    ) => Promise<BeforeAgentStartResult | undefined> | BeforeAgentStartResult | undefined,
  ): void;
  registerCommand(
    name: string,
    command: { description?: string; handler(args: string, ctx: PiContext): Promise<void> | void },
  ): void;
  registerTool(tool: PiTool): void;
}

export interface PiContext {
  ui?: {
    notify(message: string, level?: "info" | "success" | "warning" | "error"): void;
    setStatus?(key: string, message?: string): void;
  };
}

export interface InputEvent {
  text: string;
  source?: "interactive" | "rpc" | "extension";
}

export type InputResult = { action: "continue" | "handled" | "transform"; text?: string };

export interface BeforeAgentStartEvent {
  prompt: string;
  systemPrompt: string;
}

export interface BeforeAgentStartResult {
  systemPrompt?: string;
  message?: { customType?: string; content: string; display?: boolean };
}

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  details?: Record<string, unknown>;
};
type PiTool = {
  name: string;
  label?: string;
  description: string;
  parameters: unknown;
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
    onUpdate: unknown,
    ctx: PiContext,
  ): Promise<ToolResult> | ToolResult;
};

type Turn = { role: "user" | "assistant"; text: string; recordedAt: string };
type PendingRecall = { prompt: string; promise: Promise<string>; startedAt: number };

const DEFAULT_LIMIT = "5";
const DEFAULT_RECALL_TIMEOUT_MS = 75;
const MEMORY_TOOL_PROMPT = `

# Persistent Memory

You have access to persistent memory through tools:
- Use brain_query when the user asks about prior context, preferences, identity, decisions, or anything that may have been remembered.
- Use brain_remember only when the user explicitly asks to remember/save something, or when a durable preference/correction is clearly worth saving.
- Treat automatically injected memory context as potentially stale; verify load-bearing details when possible.`;

export default function brainExtension(pi: PiExtensionAPI): void {
  let enabled = process.env.BRAIN_PI_ENABLED !== "0" && process.env.BRAIN_PI_ENABLED !== "false";
  let pendingRecall: PendingRecall | undefined;
  let rememberQueue: Promise<void> = Promise.resolve();

  pi.on("input", (event) => {
    if (!enabled || event.source === "extension") return { action: "continue" };
    if (recallMode() === "off") return { action: "continue" };
    pendingRecall = {
      prompt: event.text,
      promise: brainQueryContext(event.text).catch(() => ""),
      startedAt: Date.now(),
    };
    return { action: "continue" };
  });

  pi.on("before_agent_start", async (event, ctx) => {
    if (!enabled) return;
    const systemPrompt = event.systemPrompt.includes("# Persistent Memory")
      ? event.systemPrompt
      : `${event.systemPrompt}${MEMORY_TOOL_PROMPT}`;

    if (recallMode() === "off") return { systemPrompt };

    const recall =
      pendingRecall?.prompt === event.prompt
        ? pendingRecall.promise
        : brainQueryContext(event.prompt).catch(() => "");

    try {
      const context =
        recallMode() === "blocking"
          ? await recall
          : await withTimeout(recall, recallTimeoutMs(), "");
      if (context.trim() === "") return { systemPrompt };
      return { systemPrompt: `${systemPrompt}\n\n${context}` };
    } catch (error) {
      ctx.ui?.notify(`Brain query failed: ${errorMessage(error)}`, "warning");
      return { systemPrompt };
    }
  });

  pi.registerTool({
    name: "brain_query",
    label: "Brain Query",
    description:
      "Search persistent memory for relevant prior context. Use when the user asks about remembered facts, preferences, prior decisions, or history.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query for persistent memory" },
        limit: { type: "number", description: "Maximum memories to return" },
      },
      required: ["query"],
    },
    async execute(_toolCallId, params) {
      const query = stringParam(params.query);
      if (query === "") return textResult("query is required");
      const limit =
        typeof params.limit === "number" && Number.isFinite(params.limit)
          ? String(Math.max(1, Math.min(20, Math.floor(params.limit))))
          : undefined;
      const context = await brainQueryContext(query, limit);
      return textResult(context.trim() || "No relevant memories found.");
    },
  });

  pi.registerTool({
    name: "brain_remember",
    label: "Brain Remember",
    description:
      "Persist a durable memory when the user explicitly asks to remember something or provides a clear durable preference/correction.",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "Durable information to remember" },
      },
      required: ["text"],
    },
    async execute(_toolCallId, params) {
      const text = stringParam(params.text);
      if (text === "") return textResult("text is required");
      await enqueueBrainRemember([{ role: "user", text, recordedAt: new Date().toISOString() }]);
      return textResult("Remembered.");
    },
  });

  pi.registerCommand("brain", {
    description: "Control brain integration: /brain on | off | status | remember <text>",
    async handler(args, ctx) {
      const [command = "status", ...rest] = args.trim().split(/\s+/).filter(Boolean);
      switch (command) {
        case "on":
        case "enable":
          enabled = true;
          ctx.ui?.notify("Brain extension enabled", "success");
          return;
        case "off":
        case "disable":
          enabled = false;
          pendingRecall = undefined;
          ctx.ui?.notify("Brain extension disabled", "warning");
          return;
        case "status": {
          const status = await runBrain(["daemon", "status"]);
          const state = enabled ? "enabled" : "disabled";
          const message = [
            `brain extension: ${state}`,
            `pre-turn recall: ${recallMode()} (${recallTimeoutMs()}ms opportunistic timeout)`,
            "passive capture: connector-owned",
            status.stdout.trim() || status.stderr.trim(),
          ]
            .filter(Boolean)
            .join("\n");
          ctx.ui?.notify(
            message || "brain status unavailable",
            status.code === 0 ? "info" : "error",
          );
          return;
        }
        case "remember": {
          const text = rest.join(" ").trim();
          if (text === "") {
            ctx.ui?.notify("Usage: /brain remember <text>", "warning");
            return;
          }
          try {
            await enqueueBrainRemember([
              { role: "user", text, recordedAt: new Date().toISOString() },
            ]);
            ctx.ui?.notify("Brain remembered it", "success");
          } catch (error) {
            ctx.ui?.notify(`Brain remember failed: ${errorMessage(error)}`, "error");
          }
          return;
        }
        default:
          ctx.ui?.notify("Usage: /brain on | off | status | remember <text>", "warning");
      }
    },
  });

  function enqueueBrainRemember(turns: readonly Turn[]): Promise<void> {
    const run = rememberQueue.then(() => brainRememberWithRetry(turns));
    rememberQueue = run.catch(() => undefined);
    return run;
  }
}

function recallMode(): "opportunistic" | "blocking" | "off" {
  const raw = process.env.BRAIN_PI_PRETURN_RECALL;
  if (raw === "blocking" || raw === "off") return raw;
  return "opportunistic";
}

function recallTimeoutMs(): number {
  const parsed = Number(process.env.BRAIN_PI_RECALL_TIMEOUT_MS ?? DEFAULT_RECALL_TIMEOUT_MS);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_RECALL_TIMEOUT_MS;
}

async function brainQueryContext(
  query: string,
  limit = process.env.BRAIN_PI_LIMIT ?? DEFAULT_LIMIT,
): Promise<string> {
  const result = await runBrain(["query", query, "--format", "context", "--limit", limit]);
  if (result.code !== 0) throw new Error(result.stderr || "brain query failed");
  return result.stdout;
}

async function brainRemember(turns: readonly Turn[]): Promise<void> {
  const args = ["remember", "--json"];
  args.push("--sync");
  const input = `${turns.map((turn) => JSON.stringify(turn)).join("\n")}\n`;
  const result = await runBrain(args, input);
  if (result.code !== 0) throw new Error(result.stderr || "brain remember failed");
}

async function brainRememberWithRetry(turns: readonly Turn[]): Promise<void> {
  const attempts = Math.max(1, Number(process.env.BRAIN_PI_REMEMBER_RETRIES ?? 3));
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await brainRemember(turns);
      return;
    } catch (error) {
      lastError = error;
      if (!isSqliteLockedError(error) || attempt === attempts) break;
      await sleep(250 * attempt);
    }
  }
  throw lastError;
}

function isSqliteLockedError(error: unknown): boolean {
  return errorMessage(error).toLowerCase().includes("database is locked");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  if (ms <= 0) return Promise.resolve(fallback);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function textResult(text: string): ToolResult {
  return { content: [{ type: "text", text }], details: {} };
}

function stringParam(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function runBrain(
  args: readonly string[],
  stdin?: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.BRAIN_BIN ?? "brain", [...args], {
      stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    if (child.stdout === null || child.stderr === null) {
      reject(new Error("failed to capture brain subprocess output"));
      return;
    }
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    if (stdin !== undefined) {
      if (child.stdin === null) {
        reject(new Error("failed to write to brain subprocess stdin"));
        return;
      }
      child.stdin.end(stdin, "utf8");
    }
  });
}
