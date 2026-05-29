import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@mariozechner/pi-coding-agent";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

const LINEAR_FLAGS = ["--output", "json", "--compact", "--no-pager", "--quiet"];
const CWD_CHANGE_TYPE = "workflow-cwd-change";
const WORKTREE_CHANGE_TYPE = "workflow-worktree-change";
const MAIN_REPO_CHANGE_TYPE = "workflow-main-repo-change";

let effectiveCwd = process.cwd();
let effectiveBranch: string | undefined;
let activePrCache:
  | { key: string; pr: ActivePr | null; loading: boolean }
  | undefined;

type ExecResult = Awaited<ReturnType<ExtensionAPI["exec"]>>;

type ActivePr = {
  number: number;
  url: string;
};

type LinearIssue = {
  id?: string;
  identifier?: string;
  title?: string;
  description?: string;
  url?: string;
  branchName?: string;
  gitBranchName?: string;
  state?: { name?: string } | string;
  assignee?: { name?: string; email?: string } | string | null;
  priorityLabel?: string;
};

type WorktreeConfig = {
  baseDir: string;
  branchPrefix: string;
  defaultBaseBranch: string;
  defaultIntegrateMode: "squash" | "cherry-pick" | "merge";
  cleanupAfterIntegrate: "ask" | "none" | "worktree" | "branch";
  copyFiles: string[];
  symlinkDirs: string[];
  postCreateHooks: string[];
  postSwitchHooks: string[];
  preYeetChecks: string[];
};

type WorktreeInfo = {
  path: string;
  branch?: string;
  head?: string;
  detached: boolean;
};

const DEFAULT_CONFIG: WorktreeConfig = {
  baseDir: "~/.pi-worktrees",
  branchPrefix: "tvdavies/",
  defaultBaseBranch: "main",
  defaultIntegrateMode: "squash",
  cleanupAfterIntegrate: "ask",
  copyFiles: [".env", ".env.local"],
  symlinkDirs: [],
  postCreateHooks: [],
  postSwitchHooks: [],
  preYeetChecks: [],
};

function output(result: ExecResult) {
  return [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
}

function stripAnsi(input: string) {
  return input
    .replace(/\x1b\[[0-9;]*m/g, "")
    // Preserve OSC 8 hyperlink labels while removing opener/closer escapes.
    .replace(/\x1b\]8;;[^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "");
}

function sanitizeFooterText(text: string) {
  return stripAnsi(text)
    .replace(/[\r\n\t]/g, " ")
    .replace(/ +/g, " ")
    .trim();
}

function visibleWidth(input: string) {
  return stripAnsi(input).length;
}

function truncateToWidth(input: string, width: number, ellipsis = "...") {
  if (visibleWidth(input) <= width) return input;
  const plain = stripAnsi(input);
  if (width <= visibleWidth(ellipsis)) return ellipsis.slice(0, width);
  return `${plain.slice(0, width - visibleWidth(ellipsis))}${ellipsis}`;
}

function terminalLink(label: string, url: string) {
  return `\x1b]8;;${url}\x1b\\${label}\x1b]8;;\x1b\\`;
}

function formatTokens(count: number) {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
  return `${Math.round(count / 1000000)}M`;
}

function assertOk(result: ExecResult, message: string) {
  if (result.code !== 0)
    throw new Error(`${message}\n${output(result)}`.trim());
}

function expandHome(path: string) {
  return path === "~"
    ? homedir()
    : path.startsWith("~/")
      ? join(homedir(), path.slice(2))
      : path;
}

function slug(input: string) {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 90);
}

function shellQuote(input: string) {
  return `'${input.replace(/'/g, `'\\''`)}'`;
}

function parseFlags(args: string) {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  const flags = new Set(parts.filter((part) => part.startsWith("--")));
  const positional = parts.filter((part) => !part.startsWith("--"));
  return { flags, positional };
}

function getConfig(): WorktreeConfig {
  const settingsPath = join(homedir(), ".pi", "agent", "settings.json");
  try {
    const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as {
      worktrees?: Partial<WorktreeConfig>;
    };
    return { ...DEFAULT_CONFIG, ...(settings.worktrees ?? {}) };
  } catch {
    return DEFAULT_CONFIG;
  }
}

async function execOk(
  pi: ExtensionAPI,
  command: string,
  args: string[],
  cwd: string,
  message: string,
) {
  const result = await pi.exec(command, args, { cwd });
  assertOk(result, message);
  return result.stdout.trim();
}

function applyEffectiveStateEntry(entry: unknown) {
  const candidate = entry as
    | {
        type?: unknown;
        customType?: unknown;
        data?: { cwd?: unknown; branch?: unknown };
      }
    | undefined;
  if (candidate?.type !== "custom") return;

  if (candidate.customType === CWD_CHANGE_TYPE) {
    const cwd = candidate.data?.cwd;
    if (typeof cwd === "string" && existsSync(cwd)) effectiveCwd = cwd;
  }

  if (candidate.customType === WORKTREE_CHANGE_TYPE) {
    const cwd = candidate.data?.cwd;
    if (typeof cwd === "string" && existsSync(cwd)) effectiveCwd = cwd;
    effectiveBranch =
      typeof candidate.data?.branch === "string"
        ? candidate.data.branch
        : undefined;
  }
}

function restoreEffectiveState(ctx: {
  sessionManager: ExtensionCommandContext["sessionManager"];
  cwd: string;
}) {
  effectiveCwd = ctx.cwd;
  effectiveBranch = undefined;
  for (const entry of ctx.sessionManager.getBranch()) {
    applyEffectiveStateEntry(entry);
  }
}

function restoreEffectiveStateFromSessionFile(sessionFile: string) {
  if (!existsSync(sessionFile)) return false;

  for (const line of readFileSync(sessionFile, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      applyEffectiveStateEntry(JSON.parse(line));
    } catch {
      // Ignore malformed historical entries.
    }
  }

  return existsSync(effectiveCwd);
}

function getEffectiveCwd(ctx: ExtensionCommandContext) {
  restoreEffectiveState(ctx);
  return effectiveCwd;
}

function bashSingleQuote(str: string) {
  return `'${str.replace(/'/g, `'\\''`)}'`;
}

function launchGhostty(cwd: string) {
  const command = ["ghostty", "ghosty"].find(
    (candidate) => spawnSync("sh", ["-lc", `command -v ${candidate}`]).status === 0,
  );
  if (!command) throw new Error("Could not find ghostty on PATH.");

  const env = {
    ...process.env,
    DISPLAY: process.env.DISPLAY || ":0",
    XAUTHORITY: process.env.XAUTHORITY || join(homedir(), ".Xauthority"),
    XDG_RUNTIME_DIR:
      process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.() ?? 1000}`,
    DBUS_SESSION_BUS_ADDRESS:
      process.env.DBUS_SESSION_BUS_ADDRESS ||
      `unix:path=/run/user/${process.getuid?.() ?? 1000}/bus`,
  };
  const child = spawn(command, [], {
    cwd,
    env,
    detached: true,
    stdio: "ignore",
  });
  child.on("error", () => undefined);
  child.unref();
  return command;
}

function resolveToolPath(path: string | undefined) {
  if (!path || isAbsolute(path)) return path;
  return resolve(effectiveCwd, path);
}

async function getGitRoot(pi: ExtensionAPI, cwd: string) {
  return execOk(
    pi,
    "git",
    ["rev-parse", "--show-toplevel"],
    cwd,
    "Could not find git root.",
  );
}

async function getMainWorktreePath(pi: ExtensionAPI, cwd: string) {
  const gitRoot = await getGitRoot(pi, cwd);
  const worktrees = await listWorktrees(pi, gitRoot);
  const main = worktrees.find((wt) => !wt.path.includes("/.pi-worktrees/"));
  return main?.path ?? gitRoot;
}

async function getCurrentBranch(pi: ExtensionAPI, cwd = process.cwd()) {
  const result = await pi.exec("git", ["branch", "--show-current"], { cwd });
  assertOk(result, "Could not determine current branch.");
  return result.stdout.trim();
}

async function getDefaultBranch(
  pi: ExtensionAPI,
  repoRoot: string,
  config: WorktreeConfig,
) {
  const result = await pi.exec(
    "git",
    ["symbolic-ref", "refs/remotes/origin/HEAD", "--short"],
    { cwd: repoRoot },
  );
  if (result.code === 0 && result.stdout.trim().startsWith("origin/"))
    return result.stdout.trim().replace(/^origin\//, "");
  return config.defaultBaseBranch;
}

async function repoSlug(pi: ExtensionAPI, repoRoot: string) {
  const result = await pi.exec(
    "git",
    ["config", "--get", "remote.origin.url"],
    { cwd: repoRoot },
  );
  const remote = result.code === 0 ? result.stdout.trim() : "";
  const name = remote
    ? remote
        .replace(/\.git$/, "")
        .split(/[/:]/)
        .filter(Boolean)
        .pop()
    : undefined;
  return slug(name || basename(repoRoot));
}

async function getIssue(pi: ExtensionAPI, issueId: string) {
  const result = await pi.exec("linear-cli", [
    "issues",
    "get",
    issueId,
    "--comments",
    ...LINEAR_FLAGS,
  ]);
  assertOk(result, `Could not fetch Linear issue ${issueId}.`);
  const parsed = JSON.parse(result.stdout) as LinearIssue | LinearIssue[];
  return Array.isArray(parsed) ? parsed[0] : parsed;
}

function branchForIssue(
  issue: LinearIssue,
  fallbackIssueId: string,
  config: WorktreeConfig,
) {
  const raw =
    issue.branchName ??
    issue.gitBranchName ??
    `${issue.identifier ?? fallbackIssueId}-${slug(issue.title ?? "work")}`;
  return raw.startsWith(config.branchPrefix)
    ? raw
    : `${config.branchPrefix}${slug(raw)}`;
}

function worktreeNameFromBranch(branch: string, config: WorktreeConfig) {
  return slug(
    branch.startsWith(config.branchPrefix)
      ? branch.slice(config.branchPrefix.length)
      : branch,
  );
}

function shortWorktreeId(branch: string) {
  return createHash("sha1")
    .update(`${branch}:${Date.now()}:${randomBytes(4).toString("hex")}`)
    .digest("hex")
    .slice(0, 8);
}

function worktreeLabel(wt: WorktreeInfo, config: WorktreeConfig) {
  const name = basename(wt.path);
  const branch = wt.branch ?? "detached";
  const suffix = isManagedWorktree(wt.path, config) ? name : wt.path;
  return `${branch} — ${suffix}`;
}

function pathFromWorktreeLabel(label: string) {
  return label.split(" — ").at(-1);
}

async function listWorktrees(
  pi: ExtensionAPI,
  repoRoot: string,
): Promise<WorktreeInfo[]> {
  const result = await pi.exec("git", ["worktree", "list", "--porcelain"], {
    cwd: repoRoot,
  });
  assertOk(result, "Could not list git worktrees.");
  return result.stdout
    .trim()
    .split("\n\n")
    .filter(Boolean)
    .map((block) => {
      const lines = block.split("\n");
      const path =
        lines
          .find((line) => line.startsWith("worktree "))
          ?.replace(/^worktree /, "") ?? "";
      const branch = lines
        .find((line) => line.startsWith("branch "))
        ?.replace(/^branch refs\/heads\//, "");
      const head = lines
        .find((line) => line.startsWith("HEAD "))
        ?.replace(/^HEAD /, "");
      return { path, branch, head, detached: !branch };
    })
    .filter((item) => item.path);
}

async function findWorktree(
  pi: ExtensionAPI,
  repoRoot: string,
  branchOrName: string,
  config: WorktreeConfig,
) {
  const target = branchOrName.startsWith(config.branchPrefix)
    ? branchOrName
    : `${config.branchPrefix}${branchOrName}`;
  const targetName = worktreeNameFromBranch(target, config);
  const worktrees = await listWorktrees(pi, repoRoot);
  return worktrees.find(
    (item) =>
      item.branch === target ||
      item.branch === branchOrName ||
      worktreeNameFromBranch(item.branch ?? basename(item.path), config) ===
        targetName ||
      basename(item.path) === branchOrName,
  );
}

function isManagedWorktree(path: string, config: WorktreeConfig) {
  const managedRoot = resolve(expandHome(config.baseDir));
  return resolve(path).startsWith(`${managedRoot}/`);
}

async function copyConfiguredFiles(
  pi: ExtensionAPI,
  sourceRoot: string,
  worktreePath: string,
  config: WorktreeConfig,
) {
  for (const file of config.copyFiles) {
    if (!existsSync(join(sourceRoot, file))) continue;
    await pi.exec(
      "cp",
      ["-R", join(sourceRoot, file), join(worktreePath, file)],
      { cwd: sourceRoot },
    );
  }
  for (const dir of config.symlinkDirs) {
    const source = join(sourceRoot, dir);
    const target = join(worktreePath, dir);
    if (!existsSync(source) || existsSync(target)) continue;
    await pi.exec("ln", ["-s", source, target], { cwd: sourceRoot });
  }
}

async function runWorktreeHooks(
  pi: ExtensionAPI,
  hooks: string[],
  sourceRoot: string,
  worktreePath: string,
  label: string,
) {
  for (const hook of hooks) {
    const command = `export PI_WORKTREE_SOURCE_ROOT=${shellQuote(sourceRoot)} PI_WORKTREE_PATH=${shellQuote(worktreePath)}; ${hook}`;
    const result = await pi.exec("bash", ["-lc", command], {
      cwd: worktreePath,
    });
    assertOk(result, `Worktree ${label} hook failed: ${hook}`);
  }
}

async function chooseBaseRef(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  repoRoot: string,
  explicitBase: string | undefined,
  config: WorktreeConfig,
) {
  if (explicitBase) return explicitBase;
  const defaultBranch = await getDefaultBranch(pi, repoRoot, config);
  const currentBranch = await getCurrentBranch(pi, repoRoot).catch(
    () => "HEAD",
  );
  const choice = await ctx.ui.select("Create worktree from", [
    `Latest origin/${defaultBranch}`,
    `Current branch (${currentBranch})`,
    "Specific branch/ref…",
  ]);
  if (choice === `Current branch (${currentBranch})`) return currentBranch;
  if (choice === "Specific branch/ref…") {
    const ref = await ctx.ui.input(
      "Base ref",
      "Branch, tag, or commit to branch from",
    );
    if (!ref) return undefined;
    return ref.trim();
  }
  return `origin/${defaultBranch}`;
}

async function fetchBaseRef(
  pi: ExtensionAPI,
  repoRoot: string,
  baseRef: string,
) {
  if (baseRef.startsWith("origin/")) {
    const branch = baseRef.replace(/^origin\//, "");
    await execOk(
      pi,
      "git",
      ["fetch", "origin", branch],
      repoRoot,
      `Could not fetch latest ${baseRef}.`,
    );
    return;
  }
  await pi.exec("git", ["fetch", "origin"], { cwd: repoRoot });
}

async function ensureWorktree(
  pi: ExtensionAPI,
  repoRoot: string,
  branchName: string,
  baseRef: string,
  config: WorktreeConfig,
) {
  const existing = await findWorktree(pi, repoRoot, branchName, config);
  if (existing && existsSync(existing.path)) return existing.path;

  const root = join(
    resolve(expandHome(config.baseDir)),
    await repoSlug(pi, repoRoot),
  );
  await mkdir(root, { recursive: true });
  let worktreePath = join(root, shortWorktreeId(branchName));
  while (existsSync(worktreePath))
    worktreePath = join(root, shortWorktreeId(branchName));

  await fetchBaseRef(pi, repoRoot, baseRef);
  let result = await pi.exec(
    "git",
    ["worktree", "add", worktreePath, branchName],
    { cwd: repoRoot },
  );
  if (result.code !== 0) {
    result = await pi.exec(
      "git",
      ["worktree", "add", "-b", branchName, worktreePath, baseRef],
      { cwd: repoRoot },
    );
  }
  assertOk(result, `Could not create worktree for ${branchName}.`);
  await copyConfiguredFiles(pi, repoRoot, worktreePath, config);
  await runWorktreeHooks(
    pi,
    config.postCreateHooks,
    repoRoot,
    worktreePath,
    "post-create",
  );
  return worktreePath;
}

async function switchCwd(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  worktreePath: string,
  branch?: string,
  kickoff?: string,
) {
  const resolvedWorktreePath = resolve(worktreePath);
  const config = getConfig();
  const repoRoot = await getGitRoot(pi, resolvedWorktreePath).catch(
    () => resolvedWorktreePath,
  );
  await runWorktreeHooks(
    pi,
    config.postSwitchHooks,
    repoRoot,
    resolvedWorktreePath,
    "post-switch",
  );
  effectiveCwd = resolvedWorktreePath;
  effectiveBranch = branch;
  pi.appendEntry(CWD_CHANGE_TYPE, { cwd: resolvedWorktreePath });
  pi.appendEntry(WORKTREE_CHANGE_TYPE, { cwd: resolvedWorktreePath, branch });
  if (branch)
    ctx.ui.setStatus("worktree", ctx.ui.theme.fg("accent", `wt ${branch}`));
  else ctx.ui.setStatus("worktree", undefined);
  ctx.ui.notify(`Working in ${resolvedWorktreePath}`, "info");
  if (kickoff) pi.sendUserMessage(kickoff, { deliverAs: "followUp" });
}

function issueContext(
  issue: LinearIssue,
  branchName: string,
  worktreePath: string,
) {
  const state =
    typeof issue.state === "string" ? issue.state : issue.state?.name;
  const assignee =
    typeof issue.assignee === "string"
      ? issue.assignee
      : (issue.assignee?.name ?? issue.assignee?.email);
  return [
    `We are starting work in git worktree: ${worktreePath}`,
    `Branch: ${branchName}`,
    issue.identifier ? `Issue: ${issue.identifier}` : undefined,
    issue.title ? `Title: ${issue.title}` : undefined,
    state ? `State: ${state}` : undefined,
    assignee ? `Assignee: ${assignee}` : undefined,
    issue.priorityLabel ? `Priority: ${issue.priorityLabel}` : undefined,
    issue.url ? `URL: ${issue.url}` : undefined,
    issue.description ? `\nDescription:\n${issue.description}` : undefined,
  ]
    .filter(Boolean)
    .join("\n");
}

async function statusLine(pi: ExtensionAPI, cwd: string) {
  const branch = await getCurrentBranch(pi, cwd).catch(() => "detached");
  const short = await pi.exec("git", ["status", "--short"], { cwd });
  const files = short.stdout.trim()
    ? short.stdout.trim().split("\n").length
    : 0;
  return `${branch} · ${files} changed file${files === 1 ? "" : "s"}`;
}

function getActivePr(
  pi: ExtensionAPI,
  cwd: string,
  branch: string | null,
  onChange: () => void,
) {
  if (!branch || branch === "detached") return null;
  const key = `${cwd}:${branch}`;
  if (activePrCache?.key === key) return activePrCache.pr;

  activePrCache = { key, pr: null, loading: true };
  void pi
    .exec(
      "gh",
      ["pr", "view", branch, "--json", "number,url"],
      { cwd },
    )
    .then((result) => {
      if (activePrCache?.key !== key) return;
      if (result.code !== 0 || !result.stdout.trim()) {
        activePrCache = { key, pr: null, loading: false };
        onChange();
        return;
      }
      const parsed = JSON.parse(result.stdout) as ActivePr;
      activePrCache = {
        key,
        pr: parsed.url && parsed.number ? parsed : null,
        loading: false,
      };
      onChange();
    })
    .catch(() => {
      if (activePrCache?.key === key) {
        activePrCache = { key, pr: null, loading: false };
        onChange();
      }
    });
  return null;
}

async function runYeet(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  args: string,
) {
  const { flags } = parseFlags(args);
  const cwd = getEffectiveCwd(ctx);
  const branch = await getCurrentBranch(pi, cwd);
  if (!branch) throw new Error("Cannot yeet from detached HEAD.");
  const defaultBranch = await getDefaultBranch(
    pi,
    await getGitRoot(pi, cwd),
    getConfig(),
  );
  if (branch === defaultBranch)
    throw new Error(`Refusing to yeet default branch ${defaultBranch}.`);

  const summary = await statusLine(pi, cwd);
  const choice = await ctx.ui.select("Yeet branch?", [
    `Run checks, commit, push, create/update draft PR (${summary})`,
    "Commit + push only",
    "Create/update draft PR only",
    "Cancel",
  ]);
  if (!choice || choice === "Cancel") return;

  const config = getConfig();
  if (!flags.has("--no-checks") && choice.startsWith("Run checks")) {
    for (const check of config.preYeetChecks)
      assertOk(
        await pi.exec("bash", ["-lc", check], { cwd }),
        `Check failed: ${check}`,
      );
  }

  const hasChanges =
    (await pi.exec("git", ["status", "--porcelain"], { cwd })).stdout.trim()
      .length > 0;
  if (hasChanges && !choice.startsWith("Create/update")) {
    await execOk(pi, "git", ["add", "-A"], cwd, "Could not stage changes.");
    const message = `chore: update ${branch.replace(/^.*\//, "")}`;
    await execOk(
      pi,
      "git",
      ["commit", "-m", message],
      cwd,
      "Could not commit changes.",
    );
  }

  if (!choice.startsWith("Create/update")) {
    await execOk(
      pi,
      "git",
      ["push", "-u", "origin", branch],
      cwd,
      "Could not push branch.",
    );
  }
  if (choice === "Commit + push only") return;

  const existingPr = await pi.exec(
    "gh",
    ["pr", "view", branch, "--json", "url", "--jq", ".url"],
    { cwd },
  );
  if (existingPr.code === 0 && existingPr.stdout.trim()) {
    ctx.ui.notify(`PR already exists: ${existingPr.stdout.trim()}`, "info");
    return;
  }

  const title = branch
    .replace(/^.*\//, "")
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
  const log = await pi.exec(
    "git",
    ["log", `origin/${defaultBranch}..HEAD`, "--oneline"],
    { cwd },
  );
  const body = [
    `## Summary`,
    log.stdout.trim() || "Changes from this branch.",
    "",
    "## Validation",
    flags.has("--no-checks")
      ? "Not run."
      : config.preYeetChecks.length
        ? config.preYeetChecks.map((x) => `- ${x}`).join("\n")
        : "Not run.",
  ].join("\n");
  await execOk(
    pi,
    "gh",
    [
      "pr",
      "create",
      "--draft",
      "--base",
      defaultBranch,
      "--head",
      branch,
      "--title",
      title,
      "--body",
      body,
    ],
    cwd,
    "Could not create draft PR.",
  );
}

async function withLoading<T>(
  ctx: ExtensionCommandContext,
  message: string,
  fn: () => Promise<T>,
) {
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let frame = 0;
  let currentMessage = message;
  let timer: ReturnType<typeof setInterval> | undefined;
  let requestRender: (() => void) | undefined;
  const setMessage = ctx.ui.setWorkingMessage.bind(ctx.ui);
  ctx.ui.setWorkingVisible(false);
  ctx.ui.setWorkingMessage = (next?: string) => {
    currentMessage = next || message;
    requestRender?.();
  };
  ctx.ui.setStatus("workflow", ctx.ui.theme.fg("accent", message));
  ctx.ui.setWidget(
    "workflow-loading",
    (tui, theme) => {
      requestRender = () => tui.requestRender();
      timer ??= setInterval(() => {
        frame = (frame + 1) % frames.length;
        tui.requestRender();
      }, 80);
      return {
        render: () => [
          "",
          ` ${theme.fg("accent", frames[frame])} ${theme.fg("muted", currentMessage)}`,
          "",
        ],
        invalidate() {},
      };
    },
    { placement: "aboveEditor" },
  );
  try {
    return await fn();
  } finally {
    if (timer) clearInterval(timer);
    ctx.ui.setWorkingMessage = setMessage;
    ctx.ui.setWorkingMessage();
    ctx.ui.setWorkingVisible(true);
    ctx.ui.setWidget("workflow-loading", undefined);
    ctx.ui.setStatus("workflow", undefined);
  }
}

async function cleanupIntegrated(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  repoRoot: string,
  worktreePath: string,
  branch: string,
  config: WorktreeConfig,
) {
  let action = config.cleanupAfterIntegrate;
  if (action === "ask") {
    const choice = await ctx.ui.select("Clean up integrated worktree?", [
      "Remove worktree + local branch",
      "Remove worktree only",
      "Keep everything",
    ]);
    action =
      choice === "Remove worktree + local branch"
        ? "branch"
        : choice === "Remove worktree only"
          ? "worktree"
          : "none";
  }
  if (action === "none") return;
  await pi.exec("git", ["worktree", "remove", worktreePath], { cwd: repoRoot });
  if (action === "branch")
    await pi.exec("git", ["branch", "-d", branch], { cwd: repoRoot });
}

function installFooter(pi: ExtensionAPI, ctx: ExtensionCommandContext) {
  restoreEffectiveState(ctx);
  ctx.ui.setFooter((tui, theme, footerData) => {
    const unsub = footerData.onBranchChange(() => tui.requestRender());
    return {
      dispose: unsub,
      invalidate() {},
      render(width: number): string[] {
        restoreEffectiveState(ctx);
        let totalInput = 0;
        let totalOutput = 0;
        let totalCacheRead = 0;
        let totalCacheWrite = 0;
        let totalCost = 0;
        for (const entry of ctx.sessionManager.getEntries()) {
          if (entry.type === "message" && entry.message.role === "assistant") {
            totalInput += entry.message.usage.input;
            totalOutput += entry.message.usage.output;
            totalCacheRead += entry.message.usage.cacheRead;
            totalCacheWrite += entry.message.usage.cacheWrite;
            totalCost += entry.message.usage.cost.total;
          }
        }

        const statuses = footerData.getExtensionStatuses();

        let pwd = effectiveCwd;
        const home = process.env.HOME || process.env.USERPROFILE;
        if (home && pwd.startsWith(home)) pwd = `~${pwd.slice(home.length)}`;

        const branch = effectiveBranch ?? footerData.getGitBranch() ?? null;
        const activePr = getActivePr(pi, effectiveCwd, branch, () =>
          tui.requestRender(),
        );
        if (branch) pwd = `${pwd} (${branch})`;
        if (activePr)
          pwd = `${pwd} • ${terminalLink(`PR #${activePr.number}`, activePr.url)}`;

        const sessionName = ctx.sessionManager.getSessionName();
        if (sessionName) pwd = `${pwd} • ${sessionName}`;

        const statsParts: string[] = [];
        if (totalInput) statsParts.push(`↑${formatTokens(totalInput)}`);
        if (totalOutput) statsParts.push(`↓${formatTokens(totalOutput)}`);
        if (totalCacheRead) statsParts.push(`R${formatTokens(totalCacheRead)}`);
        if (totalCacheWrite)
          statsParts.push(`W${formatTokens(totalCacheWrite)}`);
        const usingSubscription = ctx.model
          ? ctx.modelRegistry.isUsingOAuth(ctx.model)
          : false;
        if (totalCost || usingSubscription)
          statsParts.push(
            `$${totalCost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`,
          );

        const contextUsage = ctx.getContextUsage();
        const contextWindow =
          contextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
        const contextPercentValue = contextUsage?.percent ?? 0;
        const contextPercent =
          contextUsage?.percent !== null ? contextPercentValue.toFixed(1) : "?";
        const contextDisplay =
          contextPercent === "?"
            ? `?/${formatTokens(contextWindow)} (auto)`
            : `${contextPercent}%/${formatTokens(contextWindow)} (auto)`;
        statsParts.push(
          contextPercentValue > 90
            ? theme.fg("error", contextDisplay)
            : contextPercentValue > 70
              ? theme.fg("warning", contextDisplay)
              : contextDisplay,
        );

        let statsLeft = statsParts.join(" ");
        let statsLeftWidth = visibleWidth(statsLeft);
        if (statsLeftWidth > width) {
          statsLeft = truncateToWidth(statsLeft, width, "...");
          statsLeftWidth = visibleWidth(statsLeft);
        }

        const modelName = ctx.model?.id || "no-model";
        let rightSide = modelName;
        if (ctx.model?.reasoning) {
          const thinking = ctx.model.reasoning ? "thinking" : "";
          rightSide = thinking ? `${modelName} • ${thinking}` : modelName;
        }
        if (footerData.getAvailableProviderCount() > 1 && ctx.model) {
          const withProvider = `(${ctx.model.provider}) ${rightSide}`;
          if (statsLeftWidth + 2 + visibleWidth(withProvider) <= width)
            rightSide = withProvider;
        }

        const rightWidth = visibleWidth(rightSide);
        let statsLine: string;
        if (statsLeftWidth + 2 + rightWidth <= width) {
          statsLine =
            statsLeft +
            " ".repeat(width - statsLeftWidth - rightWidth) +
            rightSide;
        } else {
          const available = width - statsLeftWidth - 2;
          if (available > 0) {
            const truncatedRight = truncateToWidth(rightSide, available, "");
            statsLine =
              statsLeft +
              " ".repeat(
                Math.max(
                  0,
                  width - statsLeftWidth - visibleWidth(truncatedRight),
                ),
              ) +
              truncatedRight;
          } else {
            statsLine = statsLeft;
          }
        }

        const lines = [
          theme.fg("dim", truncateToWidth(pwd, width, "...")),
          theme.fg("dim", statsLeft) +
            theme.fg("dim", statsLine.slice(statsLeft.length)),
        ];

        const extraStatuses = Array.from(statuses.entries())
          .filter(([key]) => key !== "cwd" && key !== "worktree")
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([, text]) => sanitizeFooterText(text));
        if (extraStatuses.length)
          lines.push(
            truncateToWidth(
              extraStatuses.join(" "),
              width,
              theme.fg("dim", "..."),
            ),
          );
        return lines;
      },
    };
  });
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (event, ctx) => {
    restoreEffectiveState(ctx);

    if (
      event.reason === "new" &&
      event.previousSessionFile &&
      restoreEffectiveStateFromSessionFile(event.previousSessionFile)
    ) {
      pi.appendEntry(CWD_CHANGE_TYPE, { cwd: effectiveCwd });
      pi.appendEntry(WORKTREE_CHANGE_TYPE, {
        cwd: effectiveCwd,
        branch: effectiveBranch,
      });
    }

    installFooter(pi, ctx as ExtensionCommandContext);
  });
  pi.on("session_tree", (_event, ctx) => {
    restoreEffectiveState(ctx);
    installFooter(pi, ctx as ExtensionCommandContext);
  });

  pi.on("before_agent_start", (event) => {
    return {
      systemPrompt: event.systemPrompt.replace(
        /Current working directory: .+/,
        `Current working directory: ${effectiveCwd}`,
      ),
    };
  });

  pi.on("tool_call", (event) => {
    const input = event.input as Record<string, unknown>;
    if (event.toolName === "bash" && typeof input.command === "string") {
      input.command = `cd ${bashSingleQuote(effectiveCwd)} && ${input.command}`;
      return;
    }
    if (["read", "write", "edit"].includes(event.toolName)) {
      const path = input.path ?? input.file_path;
      if (typeof path === "string") {
        const resolved = resolveToolPath(path);
        if ("path" in input) input.path = resolved;
        if ("file_path" in input) input.file_path = resolved;
      }
      return;
    }
    if (["ls", "find", "grep"].includes(event.toolName)) {
      input.path = resolveToolPath(
        typeof input.path === "string" ? input.path : ".",
      );
    }
  });

  pi.registerCommand("t", {
    description: "Open a new Ghostty terminal in Pi's current worktree directory",
    handler: async (_args, ctx) => {
      const cwd = getEffectiveCwd(ctx);
      const command = launchGhostty(cwd);
      ctx.ui.notify(`Launched ${command} in ${cwd}`, "info");
    },
  });

  pi.registerCommand("wt-new", {
    description:
      "Create a git worktree under ~/.worktrees and switch Pi into it",
    handler: async (args, ctx) => {
      await ctx.waitForIdle();
      const config = getConfig();
      const { positional } = parseFlags(args);
      const repoRoot = await getGitRoot(pi, getEffectiveCwd(ctx));
      const name =
        positional[0] ??
        (await ctx.ui.input(
          "Worktree name",
          "Name for the new worktree/branch",
        ));
      if (!name) return;
      const base = await chooseBaseRef(
        pi,
        ctx,
        repoRoot,
        positional[1],
        config,
      );
      if (!base) return;
      const branch = name.startsWith(config.branchPrefix)
        ? name
        : `${config.branchPrefix}${slug(name)}`;
      await withLoading(ctx, `Creating worktree ${branch}…`, async () => {
        const worktreePath = await ensureWorktree(
          pi,
          repoRoot,
          branch,
          base,
          config,
        );
        await switchCwd(pi, ctx, worktreePath, branch);
      });
    },
  });

  pi.registerCommand("wt-fork", {
    description:
      "Create a pi-managed worktree and copy current uncommitted changes into it",
    handler: async (args, ctx) => {
      await ctx.waitForIdle();
      const config = getConfig();
      const { positional } = parseFlags(args);
      const repoRoot = await getGitRoot(pi, getEffectiveCwd(ctx));
      const name =
        positional[0] ??
        (await ctx.ui.input(
          "Worktree name",
          "Name for the new worktree/branch",
        ));
      if (!name) return;

      const status = (
        await pi.exec("git", ["status", "--porcelain"], { cwd: repoRoot })
      ).stdout.trim();
      if (!status) {
        ctx.ui.notify(
          "No local changes to copy. Use /wt-new instead.",
          "warning",
        );
        return;
      }

      const base = await chooseBaseRef(
        pi,
        ctx,
        repoRoot,
        positional[1],
        config,
      );
      if (!base) return;
      const branch = name.startsWith(config.branchPrefix)
        ? name
        : `${config.branchPrefix}${slug(name)}`;
      const patchPath = join(
        tmpdir(),
        `pi-wt-fork-${randomBytes(6).toString("hex")}.patch`,
      );

      await withLoading(
        ctx,
        `Creating worktree ${branch} with local changes…`,
        async () => {
          const diff = await pi.exec("git", ["diff", "--binary", "HEAD"], {
            cwd: repoRoot,
          });
          assertOk(diff, "Could not capture tracked changes.");
          writeFileSync(patchPath, diff.stdout);

          const untrackedResult = await pi.exec(
            "git",
            ["ls-files", "--others", "--exclude-standard", "-z"],
            { cwd: repoRoot },
          );
          assertOk(untrackedResult, "Could not list untracked files.");
          const untracked = untrackedResult.stdout.split("\0").filter(Boolean);

          const worktreePath = await ensureWorktree(
            pi,
            repoRoot,
            branch,
            base,
            config,
          );

          if (diff.stdout.trim()) {
            const apply = await pi.exec(
              "git",
              ["apply", "--binary", patchPath],
              { cwd: worktreePath },
            );
            assertOk(
              apply,
              `Could not apply local changes patch ${patchPath}.`,
            );
          }

          for (const file of untracked) {
            await mkdir(join(worktreePath, dirname(file)), { recursive: true });
            const copy = await pi.exec(
              "cp",
              ["-R", join(repoRoot, file), join(worktreePath, file)],
              { cwd: repoRoot },
            );
            assertOk(copy, `Could not copy untracked file ${file}.`);
          }

          await switchCwd(pi, ctx, worktreePath, branch);
          ctx.ui.notify(
            `Copied local changes into ${worktreePath}. Recovery patch: ${patchPath}`,
            "info",
          );
        },
      );
    },
  });

  pi.registerCommand("wt-ticket", {
    description:
      "Create a pi-managed worktree for a Linear ticket and switch into it",
    handler: async (args, ctx) => {
      await ctx.waitForIdle();
      const issueId =
        args.trim() ||
        (await ctx.ui.input("Linear ticket", "Ticket ID, e.g. LLE-1234"));
      if (!issueId) return;
      const config = getConfig();
      const repoRoot = await getGitRoot(pi, getEffectiveCwd(ctx));
      const issue = await withLoading(ctx, `Loading ${issueId}…`, () =>
        getIssue(pi, issueId),
      );
      const base = await chooseBaseRef(pi, ctx, repoRoot, undefined, config);
      if (!base) return;
      const branch = branchForIssue(issue, issueId, config);
      await withLoading(ctx, `Creating worktree ${branch}…`, async () => {
        const worktreePath = await ensureWorktree(
          pi,
          repoRoot,
          branch,
          base,
          config,
        );
        await switchCwd(
          pi,
          ctx,
          worktreePath,
          branch,
          issueContext(issue, branch, worktreePath),
        );
      });
    },
  });

  pi.registerCommand("wt-list", {
    description: "List pi-managed git worktrees",
    handler: async (_args, ctx) => {
      await withLoading(ctx, "Loading worktrees…", async () => {
        const config = getConfig();
        const managedRoot = resolve(expandHome(config.baseDir));
        const repoRoot = await getGitRoot(pi, getEffectiveCwd(ctx));
        const managed = (await listWorktrees(pi, repoRoot)).filter((wt) =>
          resolve(wt.path).startsWith(`${managedRoot}/`),
        );
        const rows = await Promise.all(
          managed.map(async (wt) => {
            const status = await statusLine(pi, wt.path).catch(() => "unknown");
            const changed = status.match(/· (.+)$/)?.[1] ?? status;
            return `${wt.branch ?? "detached"} (${changed}) — ${basename(wt.path)}`;
          }),
        );
        ctx.ui.notify(
          rows.join("\n") || "No pi-managed worktrees found.",
          "info",
        );
      });
    },
  });

  pi.registerCommand("wt-prune", {
    description:
      "Interactively remove clean pi-managed worktrees under worktrees.baseDir",
    handler: async (args, ctx) => {
      await ctx.waitForIdle();
      const config = getConfig();
      const managedRoot = resolve(expandHome(config.baseDir));
      const repoRoot = await getGitRoot(pi, getEffectiveCwd(ctx));
      const { flags } = parseFlags(args);
      const current = resolve(getEffectiveCwd(ctx));
      const managed = (await listWorktrees(pi, repoRoot)).filter(
        (wt) =>
          resolve(wt.path).startsWith(`${managedRoot}/`) &&
          resolve(wt.path) !== current,
      );
      const clean: WorktreeInfo[] = [];
      const dirty: WorktreeInfo[] = [];
      for (const wt of managed) {
        const status = existsSync(wt.path)
          ? (
              await pi.exec("git", ["status", "--porcelain"], { cwd: wt.path })
            ).stdout.trim()
          : "missing";
        (status ? dirty : clean).push(wt);
      }
      if (clean.length === 0) {
        ctx.ui.notify(
          `No clean pi-managed worktrees to prune. Dirty/skipped: ${dirty.length}`,
          "info",
        );
        return;
      }
      const preview = clean
        .map((wt) => `- ${wt.branch ?? "detached"} — ${wt.path}`)
        .join("\n");
      const ok =
        flags.has("--yes") ||
        (await ctx.ui.confirm(
          "Prune clean pi-managed worktrees?",
          `${preview}\n\nDirty/skipped: ${dirty.length}`,
        ));
      if (!ok) return;
      for (const wt of clean) {
        await pi.exec("git", ["worktree", "remove", wt.path], {
          cwd: repoRoot,
        });
        if (wt.branch?.startsWith(config.branchPrefix))
          await pi.exec("git", ["branch", "-d", wt.branch], { cwd: repoRoot });
      }
      ctx.ui.notify(
        `Pruned ${clean.length} worktree${clean.length === 1 ? "" : "s"}. Dirty/skipped: ${dirty.length}`,
        "info",
      );
    },
  });

  pi.registerCommand("wt-switch", {
    description: "Switch Pi to an existing worktree",
    handler: async (args, ctx) => {
      await ctx.waitForIdle();
      const config = getConfig();
      const repoRoot = await getGitRoot(pi, getEffectiveCwd(ctx));
      const worktrees = await listWorktrees(pi, repoRoot);
      let selected: WorktreeInfo | undefined;
      if (args.trim()) {
        selected = await findWorktree(pi, repoRoot, args.trim(), config);
      } else {
        const labels = worktrees.map((wt) => worktreeLabel(wt, config));
        const selectedLabel = await ctx.ui.select("Switch to worktree", labels);
        const selectedSuffix = selectedLabel
          ? pathFromWorktreeLabel(selectedLabel)
          : undefined;
        selected = worktrees.find(
          (wt) =>
            wt.path === selectedSuffix || basename(wt.path) === selectedSuffix,
        );
      }
      if (selected) await switchCwd(pi, ctx, selected.path, selected.branch);
    },
  });

  pi.registerCommand("wt-main", {
    description: "Switch Pi to the main repository checkout",
    handler: async (_args, ctx) => {
      await ctx.waitForIdle();
      ctx.ui.setStatus("worktree", undefined);
      await switchCwd(
        pi,
        ctx,
        await getMainWorktreePath(pi, getEffectiveCwd(ctx)),
      );
    },
  });

  pi.registerCommand("wt-status", {
    description: "Show current worktree status",
    handler: async (_args, ctx) => {
      const cwd = getEffectiveCwd(ctx);
      ctx.ui.notify(`${cwd}\n${await statusLine(pi, cwd)}`, "info");
    },
  });

  pi.registerCommand("wt-pull-main", {
    description:
      "Switch to the main checkout, checkout main, and pull latest changes",
    handler: async (_args, ctx) => {
      await ctx.waitForIdle();
      await withLoading(ctx, "Updating main…", async () => {
        const config = getConfig();
        const currentCwd = getEffectiveCwd(ctx);
        const mainPath = await getMainWorktreePath(pi, currentCwd);
        const defaultBranch = await getDefaultBranch(pi, mainPath, config);
        const status = (
          await pi.exec("git", ["status", "--porcelain"], { cwd: mainPath })
        ).stdout.trim();
        let stashed = false;
        if (status) {
          ctx.ui.setWorkingMessage("Stashing main changes…");
          await execOk(
            pi,
            "git",
            [
              "stash",
              "push",
              "-u",
              "-m",
              `pi wt-pull-main ${new Date().toISOString()}`,
            ],
            mainPath,
            "Could not stash uncommitted changes in the main checkout.",
          );
          stashed = true;
        }
        ctx.ui.setWorkingMessage(`Fetching origin/${defaultBranch}…`);
        await execOk(
          pi,
          "git",
          ["fetch", "origin", defaultBranch],
          mainPath,
          `Could not fetch origin/${defaultBranch}.`,
        );
        ctx.ui.setWorkingMessage(`Checking out ${defaultBranch}…`);
        await execOk(
          pi,
          "git",
          ["checkout", defaultBranch],
          mainPath,
          `Could not checkout ${defaultBranch}.`,
        );
        ctx.ui.setWorkingMessage(`Pulling origin/${defaultBranch}…`);
        await execOk(
          pi,
          "git",
          ["pull", "--ff-only", "origin", defaultBranch],
          mainPath,
          `Could not pull origin/${defaultBranch}.`,
        );
        if (stashed) {
          ctx.ui.setWorkingMessage("Restoring stashed changes…");
          await execOk(
            pi,
            "git",
            ["stash", "pop"],
            mainPath,
            "Pulled main, but could not re-apply stashed changes. Resolve the stash manually with `git stash list`.",
          );
        }
        await switchCwd(pi, ctx, mainPath);
        ctx.ui.notify(
          `Updated ${defaultBranch} in ${mainPath}${stashed ? " and restored stashed changes" : ""}`,
          "info",
        );
      });
    },
  });

  pi.registerCommand("wt-merge", {
    description: "Integrate current worktree into a target branch",
    handler: async (args, ctx) => {
      await ctx.waitForIdle();
      const config = getConfig();
      const { flags, positional } = parseFlags(args);
      const mode = flags.has("--cherry-pick")
        ? "cherry-pick"
        : flags.has("--merge")
          ? "merge"
          : flags.has("--squash")
            ? "squash"
            : config.defaultIntegrateMode;
      const worktreePath = getEffectiveCwd(ctx);
      const branch = await getCurrentBranch(pi, worktreePath);
      const gitRoot = await getGitRoot(pi, worktreePath);
      const target =
        positional[0] ??
        (await ctx.ui.input("Target branch", "Branch to integrate into"));
      if (!target) return;
      await withLoading(ctx, `Integrating ${branch}…`, async () => {
        const dirty = (
          await pi.exec("git", ["status", "--porcelain"], { cwd: worktreePath })
        ).stdout.trim();
        if (dirty)
          throw new Error("Commit or stash worktree changes before /wt-merge.");
        const worktrees = await listWorktrees(pi, gitRoot);
        const targetCheckout =
          worktrees.find((wt) => wt.branch === target)?.path ??
          worktrees.find(
            (wt) =>
              wt.path !== worktreePath &&
              !(wt.branch ?? "").startsWith(config.branchPrefix),
          )?.path ??
          gitRoot;
        await execOk(
          pi,
          "git",
          ["checkout", target],
          targetCheckout,
          `Could not checkout ${target}.`,
        );
        if (mode === "squash")
          await execOk(
            pi,
            "git",
            ["merge", "--squash", branch],
            targetCheckout,
            `Could not squash ${branch}.`,
          );
        else if (mode === "merge")
          await execOk(
            pi,
            "git",
            ["merge", "--no-ff", branch],
            targetCheckout,
            `Could not merge ${branch}.`,
          );
        else
          await execOk(
            pi,
            "git",
            ["cherry-pick", `${target}..${branch}`],
            targetCheckout,
            `Could not cherry-pick ${branch}.`,
          );
        ctx.ui.notify(
          `Integrated ${branch} into ${target} using ${mode}.`,
          "info",
        );
        await cleanupIntegrated(
          pi,
          ctx,
          targetCheckout,
          worktreePath,
          branch,
          config,
        );
        if (flags.has("--yeet")) await runYeet(pi, ctx, "");
        await switchCwd(pi, ctx, targetCheckout, target);
      });
    },
  });

  pi.registerCommand("wt-done", {
    description:
      "Return to the main checkout and remove the current pi-managed worktree",
    handler: async (args, ctx) => {
      await ctx.waitForIdle();
      const config = getConfig();
      const { flags } = parseFlags(args);
      const worktreePath = resolve(getEffectiveCwd(ctx));
      if (!isManagedWorktree(worktreePath, config)) {
        return ctx.ui.notify(
          "Current checkout is not a pi-managed worktree.",
          "warning",
        );
      }
      const branch = await getCurrentBranch(pi, worktreePath);
      const mainPath = await getMainWorktreePath(pi, worktreePath);
      const dirty = (
        await pi.exec("git", ["status", "--porcelain"], { cwd: worktreePath })
      ).stdout.trim();
      if (dirty && !flags.has("--force")) {
        throw new Error(
          "Commit, stash, or pass --force before removing a dirty worktree.",
        );
      }
      const ok =
        flags.has("--yes") ||
        (await ctx.ui.confirm(
          "Finish worktree?",
          `${dirty ? "This worktree has uncommitted changes and will be force removed.\n\n" : ""}Switch back to ${mainPath} and remove ${worktreePath}?`,
        ));
      if (!ok) return;
      await withLoading(
        ctx,
        `Removing ${branch || basename(worktreePath)}…`,
        async () => {
          await switchCwd(pi, ctx, mainPath);
          const removeArgs = ["worktree", "remove"];
          if (dirty) removeArgs.push("--force");
          removeArgs.push(worktreePath);
          assertOk(
            await pi.exec("git", removeArgs, { cwd: mainPath }),
            `Could not remove worktree ${worktreePath}.`,
          );
          if (branch?.startsWith(config.branchPrefix)) {
            const deleteArgs = [
              "branch",
              flags.has("--force") ? "-D" : "-d",
              branch,
            ];
            assertOk(
              await pi.exec("git", deleteArgs, { cwd: mainPath }),
              `Removed worktree, but could not delete local branch ${branch}. It may not be merged; use /wt-abandon ${branch} to force delete it.`,
            );
          }
        },
      );
      ctx.ui.notify(`Finished ${branch || worktreePath}`, "info");
    },
  });

  pi.registerCommand("wt-abandon", {
    description: "Remove a pi-managed worktree without integrating it",
    handler: async (args, ctx) => {
      await ctx.waitForIdle();
      const config = getConfig();
      const repoRoot = await getGitRoot(pi, getEffectiveCwd(ctx));
      const managed = (await listWorktrees(pi, repoRoot)).filter((wt) =>
        isManagedWorktree(wt.path, config),
      );
      let target = args.trim()
        ? await findWorktree(pi, repoRoot, args.trim(), config)
        : undefined;
      if (!target) {
        const selected = await ctx.ui.select(
          "Abandon pi-managed worktree",
          managed.map((wt) => worktreeLabel(wt, config)),
        );
        const selectedSuffix = selected
          ? pathFromWorktreeLabel(selected)
          : undefined;
        target = managed.find(
          (wt) =>
            wt.path === selectedSuffix || basename(wt.path) === selectedSuffix,
        );
      }
      if (!target || !isManagedWorktree(target.path, config))
        return ctx.ui.notify("No pi-managed worktree selected.", "warning");
      const dirty = existsSync(target.path)
        ? (
            await pi.exec("git", ["status", "--porcelain"], {
              cwd: target.path,
            })
          ).stdout.trim()
        : "";
      const ok = await ctx.ui.confirm(
        "Abandon worktree?",
        `${dirty ? "This worktree has uncommitted changes.\n\n" : ""}Remove ${target.path} without integrating ${target.branch ?? "detached"}?`,
      );
      if (!ok) return;
      if (resolve(getEffectiveCwd(ctx)) === resolve(target.path)) {
        ctx.ui.setStatus("worktree", undefined);
        await switchCwd(pi, ctx, repoRoot);
      }
      const remove = await pi.exec(
        "git",
        [
          "worktree",
          "remove",
          dirty ? "--force" : target.path,
          ...(dirty ? [target.path] : []),
        ],
        { cwd: repoRoot },
      );
      assertOk(remove, `Could not remove worktree ${target.path}.`);
      if (target.branch?.startsWith(config.branchPrefix))
        await pi.exec("git", ["branch", "-D", target.branch], {
          cwd: repoRoot,
        });
      ctx.ui.notify(`Abandoned ${target.branch ?? target.path}`, "info");
    },
  });

  pi.registerCommand("yeet", {
    description:
      "Scripted commit, push, and draft PR flow for the current branch",
    handler: async (args, ctx) => {
      await ctx.waitForIdle();
      await withLoading(ctx, "Yeeting current branch…", () =>
        runYeet(pi, ctx, args),
      );
    },
  });
}
