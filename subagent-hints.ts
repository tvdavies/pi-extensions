import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { getAgentDir, parseFrontmatter } from "@mariozechner/pi-coding-agent";

type AgentMeta = {
  name?: string;
  description?: string;
  model?: string;
  tools?: string;
};

function loadAgentSummaries(cwd: string): string[] {
  const dirs = [path.join(getAgentDir(), "agents"), path.join(cwd, ".pi", "agents")];
  const seen = new Set<string>();
  const summaries: string[] = [];

  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.name.endsWith(".md") || (!entry.isFile() && !entry.isSymbolicLink())) continue;
      const filePath = path.join(dir, entry.name);
      try {
        const content = fs.readFileSync(filePath, "utf8");
        const { frontmatter } = parseFrontmatter<AgentMeta>(content);
        if (!frontmatter.name || !frontmatter.description || seen.has(frontmatter.name)) continue;
        seen.add(frontmatter.name);
        const model = frontmatter.model ? ` model=${frontmatter.model}` : " model=current/default";
        const tools = frontmatter.tools ? ` tools=${frontmatter.tools}` : " tools=default";
        summaries.push(`- ${frontmatter.name}:${model};${tools}; ${frontmatter.description}`);
      } catch {
        // Ignore malformed/unreadable agent definitions.
      }
    }
  }

  return summaries;
}

export default function (pi: ExtensionAPI) {
  pi.on("before_agent_start", async (_event, ctx) => {
    const summaries = loadAgentSummaries(ctx.cwd);
    if (summaries.length === 0) return;

    return {
      systemPrompt:
        ctx.getSystemPrompt() +
        "\n\nSubagents are available via the `subagent` tool. When the user asks to use a subagent, choose one of these agents by name; if no role/model is specified, prefer `general-purpose`. Use `nano` for cheap/read-only lookup and `mini` for lightweight focused implementation. Available agents:\n" +
        summaries.join("\n"),
    };
  });
}
