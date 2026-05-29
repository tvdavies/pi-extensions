# Pi Extensions

Personal extensions for [Pi](https://github.com/earendil-works/pi-coding-agent), a coding agent harness.

## Extensions

- `anthropic-claude-code.ts` — registers an Anthropic provider using local Claude Code OAuth credentials.
- `goal.ts` — adds `/goal` plus goal continuation tools for long-running objectives.
- `scheduler.ts` — adds `/schedule` plus tools for delayed prompts.
- `send-user-message.ts` — adds a lightweight progress-note tool.
- `subagent/` — adds the `subagent` delegation tool.
- `subagent-hints.ts` — injects available subagent summaries into the system prompt.
- `web-tools/` — adds local web search/fetch tools.
- `workflow-commands.ts` — adds personal workflow/worktree commands.
- `openai-fast.json` — provider/model configuration.

## Usage

Clone or copy these files into your Pi extension directory:

```bash
git clone git@github.com:tvdavies/pi-extensions.git ~/.pi/agent/extensions
```

If you already have extensions in that directory, clone elsewhere and copy the files you want.

After adding or changing extensions, run `/reload` inside Pi.

## Notes

These extensions are personal tooling and may assume local commands or config such as `gh`, `linear`, Claude Code credentials, or local Pi agent settings.
