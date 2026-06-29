# AI Agent and Me

A CLI tool that aggregates local session logs from **Claude Code**, **Codex**, and **GitHub Copilot CLI** for a given repository (CWD), and renders them as a unified timeline.

> 日本語版: [README.ja.md](./README.ja.md)

## Install / Run

```sh
npx ai-agent-and-me <project-dir>
```

Web UI:

```sh
npm run web
# open http://127.0.0.1:4732
```

## Usage

```sh
ai-agent-and-me /path/to/your/repo
ai-agent-and-me . --agent claude,codex
ai-agent-and-me . --conversation-only                 # show only user/assistant turns
ai-agent-and-me . --first-prompt-only                 # show only the first user prompt per session
ai-agent-and-me . --role user,assistant,tool          # custom role filter
ai-agent-and-me . --today
mkdir -p tmp
ai-agent-and-me . --yesterday --format markdown --out tmp/yesterday.md
ai-agent-and-me . --date 2026-04-10
ai-agent-and-me . --last 24h
ai-agent-and-me . --last 7d --conversation-only
ai-agent-and-me . --since 2026-04-01 --until 2026-04-10
ai-agent-and-me . --format json > tmp/sessions.json
```

### Options

| Option | Description | Default |
|---|---|---|
| `--agent <list>` | Comma-separated agents: `claude,codex,copilot` | all |
| `--role <list>` | Comma-separated roles: `user,assistant,tool,system` | all |
| `--conversation-only` | Shortcut for `--role user,assistant` | false |
| `--first-prompt-only` | Show only the first user prompt in each session | false |
| `--today` | Filter to today (local timezone) | false |
| `--yesterday` | Filter to yesterday (local timezone) | false |
| `--date <ymd>` | Filter to a single day (`YYYY-MM-DD`, local TZ) | — |
| `--last <span>` | Relative window: `24h`, `7d`, `2w`, `30m` | — |
| `--since <value>` | Earliest timestamp (ISO8601 or `YYYY-MM-DD`) | — |
| `--until <value>` | Latest timestamp (ISO8601 or `YYYY-MM-DD`) | — |
| `--format <fmt>` | Output format: `timeline` / `json` / `markdown` | `timeline` |
| `--out <path>` | Write output to file instead of stdout | stdout |
| `--full` | Do not truncate message bodies (timeline format) | false |
| `--width <n>` | Max chars per timeline line (ignored with `--full`) | 120 |
| `--no-color` | Disable colored output | false |
| `-v, --verbose` | Verbose logs / include `raw` records | false |

## How repository matching works

- The argument is resolved with `realpath` and matched **exactly** against each session's CWD (MVP).
- **Claude Code**: `~/.claude/projects/<encoded-cwd>/*.jsonl` (directory name encodes the CWD by replacing `/` with `-`).
- **Codex**: `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` — matched via the `cwd` field in the leading `session_meta` record.
- **GitHub Copilot CLI**: `~/.copilot/session-state/<id>/events.jsonl` — matched via `session.start.context.cwd`.

## Web UI

Run `npm run web` to start a local-only Web UI. By default, it listens only on `127.0.0.1:4732`.

- Lists projects discovered from Claude Code / Codex / Copilot CLI logs; filter by name and **select multiple projects**.
- Add a project by absolute path when it is not in the list.
- Full-text search conversations across all selected projects (matching sessions keep their full conversation flow, with hits highlighted).
- Sessions are collapsed by default — title, date, turn count and hit count first; click to expand the whole conversation.
- AI reasoning logs (Claude thinking / Codex reasoning summaries) and tool logs are rendered as collapsible blocks and can be toggled on/off.
- Non-conversational noise records (slash-command transcripts, injected environment context, Codex-internal subagent sessions) are filtered out automatically.
- Filter by agent and time window.

## Notes

- The JSONL schemas of each agent are **unofficial and may break across versions**.
- Logs can contain **sensitive information**. Keep exported files out of git-tracked paths; the examples above use `tmp/`, which is gitignored.
- This tool is intended for personal, local use. If a Web UI is added, it should bind to `127.0.0.1` / `localhost` by default and should not be exposed to a LAN or the internet.
- This tool is **read-only**; it never writes to agent log files.

## License

MIT
