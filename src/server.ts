#!/usr/bin/env node
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { resolveRepoPath } from './core/path.js';
import { resolveDateRange } from './core/daterange.js';
import { discoverProjects } from './core/projects.js';
import { collectClaude } from './adapters/claude.js';
import { collectCodex } from './adapters/codex.js';
import { collectCopilot } from './adapters/copilot.js';
import type { AgentId, CollectOptions, Role, UnifiedSession, UnifiedTurn } from './core/types.js';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 4732;
const MAX_PROJECTS_PER_REQUEST = 20;
const MAX_TOOL_PAYLOAD_CHARS = 20_000;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

function sendHtml(res: ServerResponse): void {
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(INDEX_HTML);
}

function parseAgents(value: string | null): AgentId[] {
  const allowed = new Set<AgentId>(['claude', 'codex', 'copilot']);
  const agents = (value ?? 'claude,codex,copilot')
    .split(',')
    .map((s) => s.trim())
    .filter((s): s is AgentId => allowed.has(s as AgentId));
  return agents.length > 0 ? agents : ['claude', 'codex', 'copilot'];
}

function parseRoles(params: URLSearchParams): Role[] {
  if (params.get('conversationOnly') === '1') return ['user', 'assistant'];
  const allowed = new Set<Role>(['user', 'assistant', 'tool', 'system']);
  const roles = (params.get('role') ?? 'user,assistant,tool,system')
    .split(',')
    .map((s) => s.trim())
    .filter((s): s is Role => allowed.has(s as Role));
  return roles.length > 0 ? roles : ['user', 'assistant', 'tool', 'system'];
}

function parseBooleanFlag(value: string | null, defaultValue: boolean): boolean {
  if (value === null) return defaultValue;
  const normalized = value.trim().toLowerCase();
  if (['0', 'false', 'off', 'no'].includes(normalized)) return false;
  if (['1', 'true', 'on', 'yes'].includes(normalized)) return true;
  return defaultValue;
}

function turnText(turn: UnifiedTurn): string {
  const chunks = [turn.text ?? ''];
  if (turn.toolCall) {
    chunks.push(turn.toolCall.name);
    if (turn.toolCall.input !== undefined) chunks.push(JSON.stringify(turn.toolCall.input));
    if (turn.toolCall.output !== undefined) chunks.push(JSON.stringify(turn.toolCall.output));
  }
  return chunks.join('\n');
}

function truncatePayload(value: unknown): unknown {
  if (value === undefined) return undefined;
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (typeof text !== 'string') return value;
  if (text.length <= MAX_TOOL_PAYLOAD_CHARS) return value;
  return text.slice(0, MAX_TOOL_PAYLOAD_CHARS) + `\n…(truncated, ${text.length} chars total)`;
}

interface SessionView extends Omit<UnifiedSession, 'turns'> {
  turns: UnifiedTurn[];
  matchedTurns: number;
}

interface FilterResult {
  sessions: SessionView[];
  totalTurns: number;
  matchedTurns: number;
}

// Keep whole sessions that contain a match (instead of dropping non-matching
// turns) so the conversation flow stays readable around each hit.
function filterSessions(
  sessions: UnifiedSession[],
  roles: Role[],
  includeReasoning: boolean,
  firstPromptOnly: boolean,
  query: string
): FilterResult {
  const roleSet = new Set<Role>(roles);
  const q = query.trim().toLowerCase();
  let totalTurns = 0;
  let matchedTurns = 0;

  const filtered: SessionView[] = [];
  for (const session of sessions) {
    let turns = session.turns.filter(
      (turn) => roleSet.has(turn.role) && (includeReasoning || turn.kind !== 'reasoning')
    );
    if (firstPromptOnly) {
      const firstUserTurn = turns.find((turn) => turn.role === 'user' && typeof turn.text === 'string' && turn.text.trim());
      turns = firstUserTurn ? [firstUserTurn] : [];
    }
    if (turns.length === 0) continue;
    totalTurns += turns.length;

    let matches = turns.length;
    if (q) {
      matches = turns.reduce((n, turn) => (turnText(turn).toLowerCase().includes(q) ? n + 1 : n), 0);
      if (matches === 0) continue;
    }
    matchedTurns += matches;

    turns.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    const slimTurns = turns.map((turn) =>
      turn.toolCall
        ? {
            ...turn,
            toolCall: {
              name: turn.toolCall.name,
              input: truncatePayload(turn.toolCall.input),
              output: truncatePayload(turn.toolCall.output),
            },
          }
        : turn
    );
    filtered.push({ ...session, turns: slimTurns, matchedTurns: matches });
  }

  filtered.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  return { sessions: filtered, totalTurns, matchedTurns };
}

async function collectForRequest(params: URLSearchParams): Promise<{ status: number; body: unknown }> {
  const projectDirs = params.getAll('projectDir').filter((p) => p.trim());
  if (projectDirs.length === 0) {
    return { status: 400, body: { error: 'projectDir is required' } };
  }
  if (projectDirs.length > MAX_PROJECTS_PER_REQUEST) {
    return { status: 400, body: { error: `too many projects (max ${MAX_PROJECTS_PER_REQUEST})` } };
  }

  const agents = parseAgents(params.get('agent'));
  const roles = parseRoles(params);
  const includeReasoning = parseBooleanFlag(params.get('reasoning'), true);
  const firstPromptOnly = parseBooleanFlag(params.get('firstPromptOnly'), false);
  const q = params.get('q') ?? '';

  const range = resolveDateRange({
    today: params.get('today') === '1',
    yesterday: params.get('yesterday') === '1',
    date: params.get('date') ?? undefined,
    last: params.get('last') ?? undefined,
    since: params.get('since') ?? undefined,
    until: params.get('until') ?? undefined,
  });

  const seen = new Set<string>();
  const projectResults = await Promise.all(
    projectDirs.map(async (dir) => {
      const repoPath = resolveRepoPath(dir);
      if (seen.has(repoPath)) return null;
      seen.add(repoPath);

      const opts: CollectOptions = { repoPath, since: range.since, until: range.until };
      const tasks: Promise<UnifiedSession[]>[] = [];
      if (agents.includes('claude')) tasks.push(collectClaude(opts));
      if (agents.includes('codex')) tasks.push(collectCodex(opts));
      if (agents.includes('copilot')) tasks.push(collectCopilot(opts));

      const collected = (await Promise.all(tasks)).flat();
      const { sessions, totalTurns, matchedTurns } = filterSessions(collected, roles, includeReasoning, firstPromptOnly, q);

      return {
        project: {
          name: repoPath.split('/').filter(Boolean).at(-1) ?? repoPath,
          path: repoPath,
        },
        summary: { sessions: sessions.length, turns: totalTurns, matchedTurns },
        sessions,
      };
    })
  );

  const projects = projectResults
    .filter((p): p is NonNullable<typeof p> => p !== null)
    .sort((a, b) => {
      const aLatest = a.sessions[0]?.startedAt ?? '';
      const bLatest = b.sessions[0]?.startedAt ?? '';
      return bLatest.localeCompare(aLatest);
    });

  return {
    status: 200,
    body: {
      filters: {
        agents,
        roles,
        reasoning: includeReasoning,
        firstPromptOnly,
        q,
        since: range.since?.toISOString(),
        until: range.until?.toISOString(),
      },
      summary: {
        projects: projects.length,
        sessions: projects.reduce((n, p) => n + p.summary.sessions, 0),
        turns: projects.reduce((n, p) => n + p.summary.turns, 0),
        matchedTurns: projects.reduce((n, p) => n + p.summary.matchedTurns, 0),
      },
      projects,
    },
  };
}

async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  try {
    if (url.pathname === '/api/projects') {
      sendJson(res, 200, { projects: await discoverProjects() });
      return;
    }

    if (url.pathname === '/api/sessions') {
      const { status, body } = await collectForRequest(url.searchParams);
      sendJson(res, status, body);
      return;
    }

    sendJson(res, 404, { error: 'not found' });
  } catch (err) {
    sendJson(res, 500, { error: (err as Error).message });
  }
}

function parseServerArgs(argv: string[]): { host: string; port: number } {
  let host = process.env.AIAM_HOST || DEFAULT_HOST;
  let port = Number(process.env.PORT || process.env.AIAM_PORT || DEFAULT_PORT);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--host' && argv[i + 1]) host = argv[++i];
    else if (arg === '--port' && argv[i + 1]) port = Number(argv[++i]);
  }
  if (!Number.isFinite(port) || port <= 0) port = DEFAULT_PORT;
  return { host, port };
}

const server = createServer((req, res) => {
  const hostHeader = req.headers.host ?? `${DEFAULT_HOST}:${DEFAULT_PORT}`;
  const url = new URL(req.url ?? '/', `http://${hostHeader}`);

  if (url.pathname.startsWith('/api/')) {
    void handleApi(req, res, url);
    return;
  }

  if (url.pathname === '/' || url.pathname === '/index.html') {
    sendHtml(res);
    return;
  }

  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('not found');
});

const { host, port } = parseServerArgs(process.argv.slice(2));
server.listen(port, host, () => {
  const url = `http://${host}:${port}`;
  console.error(`[ai-agent-and-me] Web UI: ${url}`);
  console.error('[ai-agent-and-me] Listening on localhost only by default. Logs may contain sensitive data.');
});

const INDEX_HTML = String.raw`<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>AI Agent and Me</title>
  <style>
    :root {
      color-scheme: light dark;
      --bg: #f5f6f8;
      --panel: #ffffff;
      --line: #dde2ea;
      --text: #1c2430;
      --muted: #69748a;
      --accent: #0f766e;
      --accent-soft: #e6f5f2;
      --user: #1d4ed8;
      --user-soft: #eef3fe;
      --warn: #9a3412;
      --code: #f1f3f6;
      --shadow: 0 1px 2px rgba(15, 23, 42, .06), 0 4px 12px rgba(15, 23, 42, .04);
      --hover: #f3f5f8;
      --muted-strong: #475569;
      --bubble: #ffffff;
      --session-hover-border: #c7d0dc;
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #0f1419;
        --panel: #171c24;
        --line: #2a323d;
        --text: #e6edf3;
        --muted: #8b97a8;
        --accent: #2dd4bf;
        --accent-soft: #133b37;
        --user: #7aa2f7;
        --user-soft: #1b2740;
        --warn: #fca873;
        --code: #1f2630;
        --shadow: 0 1px 2px rgba(0, 0, 0, .4), 0 4px 14px rgba(0, 0, 0, .3);
        --hover: #1d2530;
        --muted-strong: #aeb9c7;
        --bubble: #1b212b;
        --session-hover-border: #3a4654;
      }
    }
    * { box-sizing: border-box; }
    body { margin: 0; background: var(--bg); color: var(--text); font-size: 14px; }
    button, input, select { font: inherit; }
    .shell { display: grid; grid-template-columns: 320px minmax(0, 1fr); min-height: 100vh; }

    /* ---- sidebar ---- */
    aside {
      background: var(--panel);
      border-right: 1px solid var(--line);
      padding: 18px;
      position: sticky;
      top: 0;
      height: 100vh;
      overflow: auto;
      display: flex;
      flex-direction: column;
      gap: 14px;
    }
    h1 { margin: 0; font-size: 18px; }
    .side-label { font-size: 12px; color: var(--muted); font-weight: 700; margin-bottom: 5px; display: flex; justify-content: space-between; align-items: baseline; }
    .side-label a { color: var(--accent); font-weight: 600; text-decoration: none; cursor: pointer; font-size: 12px; }
    input[type="text"], input[type="search"], select {
      width: 100%;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 8px 10px;
      background: #fff;
      color: var(--text);
    }
    input[type="text"], input[type="search"], select { background: var(--panel); }
    input:focus-visible, select:focus-visible, button:focus-visible, .check:focus-within, .project-item:focus-within {
      outline: 2px solid var(--accent);
      outline-offset: 1px;
    }
    .project-list {
      border: 1px solid var(--line);
      border-radius: 8px;
      min-height: 132px;
      max-height: 320px;
      overflow: auto;
      background: var(--panel);
    }
    .project-item {
      display: flex;
      gap: 8px;
      align-items: flex-start;
      padding: 8px 10px;
      border-bottom: 1px solid var(--line);
      cursor: pointer;
    }
    .project-item:last-child { border-bottom: 0; }
    .project-item:hover { background: var(--hover); }
    .project-item.active { background: var(--accent-soft); }
    .project-item input { margin-top: 3px; }
    .project-name { font-weight: 650; overflow-wrap: anywhere; }
    .project-path { color: var(--muted); font-size: 11px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; overflow-wrap: anywhere; }
    .project-empty { padding: 12px; color: var(--muted); font-size: 13px; }
    .agent-badges { display: inline-flex; gap: 4px; margin-left: 4px; }
    .badge {
      display: inline-block;
      padding: 1px 6px;
      border-radius: 999px;
      font-size: 10.5px;
      font-weight: 700;
      vertical-align: 1px;
    }
    .badge.claude { background: #fcefe3; color: #b4540a; }
    .badge.codex { background: #e3f0fc; color: #1d62b4; }
    .badge.copilot { background: #efe7fb; color: #6d3bbf; }
    .badge.model { background: #dcfce7; color: #166534; }
    .badge.model::before { content: "◆"; font-size: 8px; margin-right: 3px; vertical-align: 1px; opacity: .7; }
    .badge.model.unknown { background: #f1f5f9; color: #64748b; }
    @media (prefers-color-scheme: dark) {
      .badge.claude { background: #3a2616; color: #f0b384; }
      .badge.codex { background: #16273e; color: #8fbcf0; }
      .badge.copilot { background: #2a1f3e; color: #c2a3f0; }
      .badge.model { background: #14361f; color: #86d9a3; }
      .badge.model.unknown { background: #22282f; color: #8b97a8; }
    }
    .checks { display: flex; flex-wrap: wrap; gap: 6px; }
    .check {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 5px 10px;
      background: #fff;
      font-size: 13px;
      cursor: pointer;
      user-select: none;
      transition: background .12s, border-color .12s, color .12s;
    }
    .check { background: var(--panel); }
    .check:hover { border-color: var(--accent); }
    .check:has(input:checked) { background: var(--accent-soft); border-color: var(--accent); color: var(--accent); font-weight: 650; }
    .check:has(input:disabled) { opacity: .45; cursor: not-allowed; }
    .hint { font-size: 11.5px; color: var(--muted); line-height: 1.5; margin-top: 8px; padding-left: 2px; }
    .row { display: flex; gap: 6px; }
    .row > input { flex: 1; }
    button {
      border: 1px solid var(--accent);
      background: var(--accent);
      color: #fff;
      border-radius: 8px;
      padding: 8px 12px;
      cursor: pointer;
      transition: filter .12s, background .12s, color .12s;
    }
    button:hover { filter: brightness(1.06); }
    button.secondary { background: var(--panel); color: var(--accent); }
    button.secondary:hover { background: var(--accent-soft); }
    button:disabled { opacity: .5; cursor: default; }
    button:disabled:hover { filter: none; background: var(--accent); }
    button.secondary:disabled:hover { background: var(--panel); }

    /* ---- main ---- */
    main { padding: 0 26px 48px; min-width: 0; }
    .searchbar {
      position: sticky;
      top: 0;
      z-index: 5;
      background: var(--bg);
      padding: 18px 0 12px;
      display: flex;
      gap: 8px;
      align-items: center;
      border-bottom: 1px solid var(--line);
      margin-bottom: 14px;
    }
    .searchbar input { flex: 1; padding: 10px 12px; border-radius: 8px; border: 1px solid var(--line); }
    .summary { display: flex; flex-wrap: wrap; gap: 8px; margin: 0 0 14px; color: var(--muted); font-size: 13px; align-items: center; }
    .pill { display: inline-flex; padding: 4px 10px; border-radius: 999px; border: 1px solid var(--line); background: var(--panel); color: var(--text); font-size: 12.5px; }
    .status { color: var(--muted); margin: 10px 0; }
    .copy-fallback {
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--panel);
      padding: 10px;
      margin: 0 0 14px;
    }
    .copy-fallback-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      margin-bottom: 8px;
      font-size: 12.5px;
      font-weight: 700;
      color: var(--muted);
    }
    .copy-fallback textarea {
      width: 100%;
      min-height: 180px;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 8px;
      background: var(--panel);
      color: var(--text);
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 12px;
      line-height: 1.45;
    }

    .project-group { margin-bottom: 22px; }
    .project-group > .group-head {
      display: flex;
      flex-wrap: wrap;
      align-items: baseline;
      gap: 10px;
      padding: 6px 2px;
      margin-bottom: 8px;
      border-bottom: 2px solid var(--line);
    }
    .group-head .gname { font-size: 16px; font-weight: 750; }
    .group-head .gpath { color: var(--muted); font-size: 11.5px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
    .group-head .gcount { margin-left: auto; color: var(--muted); font-size: 12.5px; }

    .session { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; margin-bottom: 10px; overflow: hidden; }
    .session { transition: box-shadow .12s, border-color .12s; }
    .session:hover { box-shadow: var(--shadow); border-color: var(--session-hover-border); }
    .session[open] { box-shadow: var(--shadow); }
    .session > summary { list-style: none; cursor: pointer; padding: 11px 14px; display: grid; gap: 4px; }
    .session > summary::-webkit-details-marker { display: none; }
    .session > summary:hover { background: var(--hover); }
    .s-head { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
    .s-title { font-weight: 700; overflow-wrap: anywhere; }
    .copy-log {
      margin-left: auto;
      padding: 4px 8px;
      font-size: 12px;
      line-height: 1.2;
      white-space: nowrap;
    }
    .s-meta { color: var(--muted); font-size: 12px; display: flex; flex-wrap: wrap; gap: 10px; }
    .s-meta .model-meta { color: var(--muted); font-size: 11.5px; }
    .s-preview { color: var(--muted-strong); font-size: 12.5px; line-height: 1.5; overflow-wrap: anywhere; }
    .first-prompt-card { padding: 12px 14px 14px; border-top: 1px solid var(--line); }
    .first-prompt-head { display: flex; gap: 8px; align-items: center; justify-content: space-between; margin-bottom: 5px; }
    .first-prompt-label { color: var(--user); font-size: 12px; font-weight: 700; margin-bottom: 5px; }
    .first-prompt-head .first-prompt-label { margin-bottom: 0; }
    .clamp { position: relative; max-height: 220px; overflow: hidden; }
    .clamp::after {
      content: "";
      position: absolute;
      left: 0; right: 0; bottom: 0;
      height: 56px;
      background: linear-gradient(to bottom, transparent, var(--bubble));
      pointer-events: none;
    }
    .clamp.expanded { max-height: none; }
    .clamp.expanded::after { display: none; }
    .show-more {
      margin: 6px 0 0;
      padding: 4px 10px;
      font-size: 12px;
      background: var(--panel);
      color: var(--accent);
    }
    .show-more.top { margin: 0; }
    .session.flat .summary-like { padding: 11px 14px; display: grid; gap: 4px; }
    .session.flat:hover { box-shadow: var(--shadow); }
    .hit { background: #fef3c7; color: #92400e; border-color: #fde68a; }
    .turns { border-top: 1px solid var(--line); padding: 6px 14px 12px; }

    .turn { margin: 10px 0; }
    .turn-label { font-size: 11.5px; font-weight: 700; color: var(--muted); margin-bottom: 3px; display: flex; gap: 8px; align-items: baseline; }
    .turn-time { font-weight: 400; }
    .bubble {
      border: 1px solid var(--line);
      border-radius: 10px;
      padding: 10px 12px;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      line-height: 1.6;
      background: var(--bubble);
    }
    .turn.user .bubble { background: var(--user-soft); border-color: #d4e0fb; }
    .turn.user .turn-label { color: var(--user); }
    .turn.assistant .bubble { background: var(--accent-soft); border-color: #cfe9e3; }
    .turn.assistant .turn-label { color: var(--accent); }
    details.sub { border: 1px dashed var(--line); border-radius: 10px; background: var(--hover); }
    details.sub > summary {
      cursor: pointer;
      list-style: none;
      padding: 7px 12px;
      color: var(--muted);
      font-size: 12.5px;
      overflow-wrap: anywhere;
    }
    details.sub > summary::-webkit-details-marker { display: none; }
    details.sub > .sub-body {
      padding: 0 12px 10px;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      line-height: 1.55;
      color: var(--muted-strong);
      font-size: 12.5px;
      max-height: 420px;
      overflow: auto;
    }
    details.sub.tool > .sub-body { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px; }

    mark { background: #fde68a; color: inherit; padding: 0 2px; border-radius: 3px; }
    .more { width: 100%; margin: 4px 0 10px; background: #fff; color: var(--accent); }
    .empty, .error { padding: 20px; border: 1px solid var(--line); border-radius: 10px; background: #fff; color: var(--muted); }
    .error { color: var(--warn); border-color: #fed7aa; background: #fff7ed; }
    .more { background: var(--panel); }
    .empty, .error { background: var(--panel); }
    .empty { text-align: center; line-height: 1.7; }
    .empty .empty-icon { font-size: 30px; display: block; margin-bottom: 8px; }
    .empty .empty-title { color: var(--text); font-weight: 700; font-size: 15px; margin-bottom: 4px; }
    @media (prefers-color-scheme: dark) {
      mark { background: #5a4a12; color: #fde68a; }
      .turn.user .bubble { border-color: #2f3f63; }
      .turn.assistant .bubble { border-color: #245049; }
      .hit { background: #4a3a12; color: #fde9a8; border-color: #6b5316; }
      .error { background: #3a1f12; border-color: #6b3a1f; }
    }

    /* ---- toast ---- */
    .toast {
      position: fixed;
      bottom: 22px;
      left: 50%;
      transform: translateX(-50%) translateY(12px);
      background: var(--text);
      color: var(--bg);
      padding: 10px 16px;
      border-radius: 999px;
      font-size: 13px;
      font-weight: 650;
      box-shadow: var(--shadow);
      opacity: 0;
      pointer-events: none;
      transition: opacity .18s, transform .18s;
      z-index: 50;
    }
    .toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }

    /* ---- common loading component ---- */
    .loading { display: block; }
    .loading-status { display: flex; align-items: center; gap: 8px; color: var(--muted); font-size: 12.5px; margin-bottom: 10px; }
    .spinner {
      width: 14px; height: 14px; flex: none;
      border: 2px solid var(--line);
      border-top-color: var(--accent);
      border-radius: 50%;
      animation: spin .7s linear infinite;
    }
    .skeleton { border: 1px solid var(--line); border-radius: 10px; background: var(--panel); padding: 14px; margin-bottom: 10px; }
    .skeleton .bar { height: 12px; border-radius: 6px; background: linear-gradient(90deg, var(--line) 25%, var(--hover) 37%, var(--line) 63%); background-size: 400% 100%; animation: shimmer 1.3s ease infinite; }
    .skeleton .bar + .bar { margin-top: 8px; }
    .skeleton .bar.short { width: 40%; }
    .skeleton .bar.medium { width: 70%; }
    /* compact variant for the sidebar project list */
    .loading.compact { padding: 8px; }
    .loading.compact .loading-status { padding: 0 2px; margin-bottom: 8px; }
    .skeleton.row { padding: 8px 10px; margin-bottom: 6px; }
    .skeleton.row:last-child { margin-bottom: 0; }
    @keyframes shimmer { 0% { background-position: 100% 0; } 100% { background-position: 0 0; } }
    @keyframes spin { to { transform: rotate(360deg); } }
    @media (prefers-reduced-motion: reduce) {
      .skeleton .bar { animation: none; }
      .spinner { animation-duration: 1.6s; }
      .toast, .session, button { transition: none; }
    }

    @media (max-width: 920px) {
      .shell { grid-template-columns: 1fr; }
      aside { position: static; height: auto; border-right: 0; border-bottom: 1px solid var(--line); }
      main { padding: 0 16px 40px; }
      .searchbar { flex-wrap: wrap; }
      .searchbar input { flex: 1 1 100%; }
      .searchbar button { flex: 1 1 auto; }
    }
  </style>
</head>
<body>
  <div class="shell">
    <aside>
      <h1>AI Agent and Me</h1>

      <div>
        <div class="side-label">
          <span>プロジェクト</span>
          <a id="clearProjects">全解除</a>
        </div>
        <input id="projectFilter" type="search" placeholder="プロジェクト名で絞り込み" autocomplete="off">
        <div class="project-list" id="projectList"></div>
      </div>

      <div>
        <div class="side-label"><span>絶対パスを追加</span></div>
        <div class="row">
          <input id="manualPath" type="text" placeholder="/Users/me/repo/project">
          <button id="addPath" class="secondary">追加</button>
        </div>
      </div>

      <div>
        <div class="side-label"><span>エージェント</span></div>
        <div class="checks">
          <label class="check"><input type="checkbox" name="agent" value="claude" checked> Claude</label>
          <label class="check"><input type="checkbox" name="agent" value="codex" checked> Codex</label>
          <label class="check"><input type="checkbox" name="agent" value="copilot" checked> Copilot</label>
        </div>
      </div>

      <div>
        <div class="side-label"><span>表示モード</span></div>
        <div class="checks">
          <label class="check"><input id="firstPromptOnly" type="checkbox"> 最初の依頼のみ</label>
        </div>
        <div class="side-label" style="margin-top:10px"><span>追加で表示する詳細</span></div>
        <div class="checks">
          <label class="check"><input id="showReasoning" type="checkbox"> 💭 AI推論サマリー</label>
          <label class="check"><input id="showTools" type="checkbox"> 🔧 ツール実行詳細</label>
        </div>
        <div class="hint">通常の会話本文は常に表示されます。ここでは補助情報だけを追加表示します。</div>
        <div id="logModeHint" class="hint" hidden>「最初の依頼のみ」では各セッション冒頭の依頼だけを表示します。</div>
      </div>

      <div>
        <div class="side-label"><span>期間</span></div>
        <select id="last">
          <option value="">すべて</option>
          <option value="24h">直近24時間</option>
          <option value="7d">直近7日</option>
          <option value="30d">直近30日</option>
        </select>
      </div>

      <div class="row">
        <button id="searchButton" style="flex:1">表示する</button>
        <button id="reloadProjects" class="secondary">再読込</button>
      </div>
    </aside>

    <main>
      <div class="searchbar">
        <input id="query" type="search" placeholder="選択したプロジェクトの会話を文字列で検索 (Enter)" autocomplete="off">
        <button id="queryButton">検索</button>
        <button id="copyResults" class="secondary" disabled>結果をコピー</button>
      </div>
      <div class="summary" id="summary"></div>
      <div id="status" class="status"></div>
      <div id="results">
        <div class="empty">
          <span class="empty-icon">🗂️</span>
          <div class="empty-title">プロジェクトを選んで表示しましょう</div>
          左のリストからプロジェクトを選び、「表示する」を押すと会話ログが表示されます。<br>複数選択や絞り込み、期間フィルタも利用できます。
        </div>
      </div>
    </main>
  </div>
  <div id="toast" class="toast" role="status" aria-live="polite"></div>

  <script>
    var els = {
      projectFilter: document.getElementById('projectFilter'),
      projectList: document.getElementById('projectList'),
      clearProjects: document.getElementById('clearProjects'),
      manualPath: document.getElementById('manualPath'),
      addPath: document.getElementById('addPath'),
      last: document.getElementById('last'),
      showReasoning: document.getElementById('showReasoning'),
      showTools: document.getElementById('showTools'),
      firstPromptOnly: document.getElementById('firstPromptOnly'),
      searchButton: document.getElementById('searchButton'),
      reloadProjects: document.getElementById('reloadProjects'),
      query: document.getElementById('query'),
      queryButton: document.getElementById('queryButton'),
      copyResults: document.getElementById('copyResults'),
      summary: document.getElementById('summary'),
      status: document.getElementById('status'),
      results: document.getElementById('results'),
      logModeHint: document.getElementById('logModeHint'),
      toast: document.getElementById('toast'),
    };

    var projects = [];          // discovered projects
    var selected = new Set();   // selected project paths
    var lastQuery = '';
    var PAGE = 30;              // sessions rendered per project before "もっと見る"
    var toastTimer = null;

    function showToast(message) {
      if (!els.toast) return;
      els.toast.textContent = message;
      els.toast.classList.add('show');
      if (toastTimer) window.clearTimeout(toastTimer);
      toastTimer = window.setTimeout(function () { els.toast.classList.remove('show'); }, 1800);
    }

    // 共通ローディングコンポーネント。
    // variant: 'panel'(メインパネル) / 'compact'(サイドバーのプロジェクト一覧)
    function loadingMarkup(options) {
      var opts = options || {};
      var variant = opts.variant === 'compact' ? 'compact' : 'panel';
      var rows = typeof opts.rows === 'number' ? opts.rows : (variant === 'compact' ? 4 : 3);
      var label = opts.label || '読み込んでいます...';

      var status = '<div class="loading-status"><span class="spinner" aria-hidden="true"></span>'
        + '<span>' + escapeHtml(label) + '</span></div>';

      var cards = '';
      for (var i = 0; i < rows; i++) {
        cards += variant === 'compact'
          ? '<div class="skeleton row"><div class="bar medium"></div><div class="bar short"></div></div>'
          : '<div class="skeleton"><div class="bar short"></div><div class="bar medium"></div><div class="bar"></div></div>';
      }

      return '<div class="loading ' + variant + '" role="status" aria-live="polite">' + status + cards + '</div>';
    }

    function escapeHtml(value) {
      return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
      });
    }

    function highlight(value, needle) {
      var text = escapeHtml(value);
      if (!needle) return text;
      var safe = escapeHtml(needle).replace(/[.*+?^\${}()|[\]\\]/g, '\\$&');
      return text.replace(new RegExp(safe, 'gi'), function (m) { return '<mark>' + m + '</mark>'; });
    }

    function oneLine(value, maxLength) {
      var text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
      return text.length > maxLength ? text.slice(0, maxLength - 1) + '…' : text;
    }

    function fmtDate(iso) {
      if (!iso) return '';
      var d = new Date(iso);
      if (isNaN(d)) return iso;
      var p = function (n) { return String(n).padStart(2, '0'); };
      return d.getFullYear() + '/' + p(d.getMonth() + 1) + '/' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
    }

    function agentBadge(agent) {
      return '<span class="badge ' + escapeHtml(agent) + '">' + escapeHtml(agent) + '</span>';
    }

    function formatModelSummary(modelInfo) {
      if (!modelInfo) return 'モデル不明';
      var pieces = [];
      var tool = modelInfo.toolName || 'ツール不明';
      if (modelInfo.toolVersion) tool += ' v' + modelInfo.toolVersion;
      pieces.push(tool);
      pieces.push(modelInfo.models && modelInfo.models.length ? modelInfo.models.join(', ') : 'モデル不明');
      if (modelInfo.provider) pieces.push(modelInfo.provider);
      if (modelInfo.details && modelInfo.details.length) pieces.push(modelInfo.details.join(', '));
      return pieces.join(' · ');
    }

    function modelBadge(modelInfo) {
      var models = modelInfo && modelInfo.models && modelInfo.models.length ? modelInfo.models.join(', ') : '';
      var label = models || 'モデル不明';
      var cls = models ? 'badge model' : 'badge model unknown';
      return '<span class="' + cls + '" title="' + escapeHtml(formatModelSummary(modelInfo)) + '">' + escapeHtml(label) + '</span>';
    }

    // バッジ本文はモデル名のみ。ツール名/バージョン/provider は
    // 補助テキストとして常時表示し、title 依存をなくす。
    function modelMeta(modelInfo) {
      if (!modelInfo) return '';
      var bits = [];
      var tool = modelInfo.toolName || '';
      if (modelInfo.toolVersion) tool += ' v' + modelInfo.toolVersion;
      if (tool) bits.push(tool);
      if (modelInfo.provider) bits.push(modelInfo.provider);
      if (bits.length === 0) return '';
      return '<span class="model-meta">' + escapeHtml(bits.join(' · ')) + '</span>';
    }

    /* ---------- project list ---------- */

    function renderProjectList() {
      var filter = els.projectFilter.value.trim().toLowerCase();
      var visible = projects.filter(function (p) {
        if (!filter) return true;
        return p.name.toLowerCase().indexOf(filter) !== -1 || p.path.toLowerCase().indexOf(filter) !== -1;
      });
      if (visible.length === 0) {
        els.projectList.innerHTML = '<div class="project-empty">' +
          (projects.length === 0 ? 'プロジェクトが見つかりません。下の入力欄で絶対パスを追加できます。' : '絞り込みに一致するプロジェクトがありません。') +
          '</div>';
        return;
      }
      els.projectList.innerHTML = visible.map(function (p) {
        var badges = (p.agents || []).map(agentBadge).join('');
        return '<label class="project-item' + (selected.has(p.path) ? ' active' : '') + '">'
          + '<input type="checkbox" data-path="' + escapeHtml(p.path) + '"' + (selected.has(p.path) ? ' checked' : '') + '>'
          + '<span><span class="project-name">' + escapeHtml(p.name) + '</span>'
          + '<span class="agent-badges">' + badges + '</span>'
          + '<div class="project-path">' + escapeHtml(p.path) + '</div></span>'
          + '</label>';
      }).join('');
    }

    function updateSearchButton() {
      els.searchButton.textContent = selected.size > 0 ? '表示する (' + selected.size + ')' : '表示する';
      els.searchButton.disabled = selected.size === 0;
    }

    function updateLogModeControls() {
      var firstOnly = els.firstPromptOnly.checked;
      els.showReasoning.disabled = firstOnly;
      els.showTools.disabled = firstOnly;
      if (els.logModeHint) els.logModeHint.hidden = !firstOnly;
    }

    async function loadProjects() {
      els.status.textContent = '';
      els.projectList.innerHTML = loadingMarkup({ variant: 'compact', label: 'プロジェクト一覧を読み込み中...' });
      try {
        var res = await fetch('/api/projects');
        var data = await res.json();
        projects = data.projects || [];
        // keep manually added paths visible even if not discovered
        selected.forEach(function (path) {
          if (!projects.some(function (p) { return p.path === path; })) {
            projects.push({ name: path.split('/').filter(Boolean).pop() || path, path: path, agents: [] });
          }
        });
        renderProjectList();
        els.status.textContent = projects.length + ' 件のプロジェクトを検出しました。表示したいプロジェクトを選択してください(複数可)。';
      } catch (err) {
        els.status.textContent = '';
        els.projectList.innerHTML = '<div class="project-empty">プロジェクト一覧の読み込みに失敗しました。「再読込」を試してください。</div>';
        els.results.innerHTML = '<div class="error">' + escapeHtml(err.message) + '</div>';
      }
      updateSearchButton();
    }

    /* ---------- results rendering ---------- */

    function turnMatches(turn, q) {
      if (!q) return false;
      var hay = (turn.text || '');
      if (turn.toolCall) {
        hay += '\n' + (turn.toolCall.name || '');
        if (turn.toolCall.input !== undefined) hay += '\n' + JSON.stringify(turn.toolCall.input);
        if (turn.toolCall.output !== undefined) hay += '\n' + JSON.stringify(turn.toolCall.output);
      }
      return hay.toLowerCase().indexOf(q.toLowerCase()) !== -1;
    }

    function matchSnippet(text, q, width) {
      var idx = text.toLowerCase().indexOf(q.toLowerCase());
      if (idx === -1) return oneLine(text, width);
      var start = Math.max(0, idx - Math.floor(width / 3));
      var snippet = (start > 0 ? '…' : '') + text.slice(start, start + width) + (start + width < text.length ? '…' : '');
      return oneLine(snippet, width + 4);
    }

    function sessionTitle(session) {
      if (session.sessionTitle) return session.sessionTitle;
      var first = firstUserTurn(session);
      if (first && first.text) return oneLine(first.text, 70);
      return session.sessionId;
    }

    function firstUserTurn(session) {
      for (var i = 0; i < session.turns.length; i++) {
        var t = session.turns[i];
        if (t.role === 'user' && t.text) return t;
      }
      return null;
    }

    function sessionPreview(session, q) {
      if (q) {
        for (var i = 0; i < session.turns.length; i++) {
          var t = session.turns[i];
          if (turnMatches(t, q)) {
            var text = t.text || (t.toolCall ? t.toolCall.name + ' ' + JSON.stringify(t.toolCall.input || '') : '');
            return matchSnippet(String(text), q, 150);
          }
        }
      }
      for (var j = 0; j < session.turns.length; j++) {
        var u = session.turns[j];
        if (u.role === 'user' && u.text) return oneLine(u.text, 150);
      }
      var first = session.turns[0];
      return first ? oneLine(first.text || '', 150) : '';
    }

    function renderTurn(turn, q) {
      var time = '<span class="turn-time">' + escapeHtml(fmtDate(turn.timestamp)) + '</span>';
      var hit = turnMatches(turn, q);

      if (turn.kind === 'reasoning') {
        return '<div class="turn reasoning"><details class="sub"' + (hit ? ' open' : '') + '>'
          + '<summary>💭 AI推論サマリー ' + time + ' — ' + highlight(oneLine(turn.text || '', 90), q) + '</summary>'
          + '<div class="sub-body">' + highlight(turn.text || '', q) + '</div>'
          + '</details></div>';
      }

      if (turn.role === 'tool' || turn.toolCall) {
        var tc = turn.toolCall || {};
        var body = '';
        if (tc.input !== undefined) body += 'input:\n' + (typeof tc.input === 'string' ? tc.input : JSON.stringify(tc.input, null, 2)) + '\n';
        if (tc.output !== undefined) body += 'output:\n' + (typeof tc.output === 'string' ? tc.output : JSON.stringify(tc.output, null, 2));
        return '<div class="turn tool"><details class="sub tool"' + (hit ? ' open' : '') + '>'
          + '<summary>🔧 ' + escapeHtml(tc.name || 'tool') + ' ' + time + '</summary>'
          + '<div class="sub-body">' + highlight(body, q) + '</div>'
          + '</details></div>';
      }

      var who = turn.role === 'user' ? 'あなた' : 'AI (' + turn.agent + ')';
      return '<div class="turn ' + escapeHtml(turn.role) + '">'
        + '<div class="turn-label">' + escapeHtml(who) + ' ' + time + '</div>'
        + '<div class="bubble">' + highlight(turn.text || '', q) + '</div>'
        + '</div>';
    }

    var sessionStore = [];  // flat session data for lazy rendering

    function formatToolPayload(value) {
      if (value === undefined) return '';
      return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    }

    function formatSessionLog(session) {
      var lines = [
        '# AI Agent and Me log',
        '',
        'Project: ' + session.repoPath,
        'Agent: ' + session.agent,
        'Tool / model: ' + formatModelSummary(session.modelInfo),
        'Session: ' + session.sessionId,
        'Title: ' + sessionTitle(session),
        'Started: ' + fmtDate(session.startedAt),
        'Ended: ' + fmtDate(session.endedAt),
        '',
        '---',
        '',
      ];

      session.turns.forEach(function (turn) {
        var time = fmtDate(turn.timestamp);
        if (turn.kind === 'reasoning') {
          lines.push('[' + time + '] AI reasoning summary (' + turn.agent + ')');
          lines.push(turn.text || '');
        } else if (turn.role === 'tool' || turn.toolCall) {
          var tc = turn.toolCall || {};
          lines.push('[' + time + '] Tool: ' + (tc.name || 'tool'));
          if (tc.input !== undefined) {
            lines.push('input:');
            lines.push(formatToolPayload(tc.input));
          }
          if (tc.output !== undefined) {
            lines.push('output:');
            lines.push(formatToolPayload(tc.output));
          }
        } else {
          var label = turn.role === 'user' ? 'User' : 'Assistant (' + turn.agent + ')';
          lines.push('[' + time + '] ' + label);
          lines.push(turn.text || '');
        }
        lines.push('');
      });

      return lines.join('\n').trim() + '\n';
    }

    function formatFirstPromptLog(session) {
      var first = firstUserTurn(session);
      var lines = [
        '# AI Agent and Me first prompt',
        '',
        'Project: ' + session.repoPath,
        'Agent: ' + session.agent,
        'Tool / model: ' + formatModelSummary(session.modelInfo),
        'Session: ' + session.sessionId,
        'Title: ' + sessionTitle(session),
        'Started: ' + fmtDate(session.startedAt),
        '',
        '---',
        '',
      ];
      if (first) {
        lines.push('[' + fmtDate(first.timestamp) + '] User');
        lines.push(first.text || '');
      } else {
        lines.push('（ユーザープロンプトなし）');
      }
      return lines.join('\n').trim() + '\n';
    }

    function formatSearchResultsLog(data) {
      var filters = data.filters || {};
      var lines = [
        '# AI Agent and Me search results log',
        '',
        'Projects: ' + data.summary.projects,
        'Sessions: ' + data.summary.sessions,
        'Turns: ' + data.summary.turns,
      ];
      if (filters.q) lines.push('Query: ' + filters.q);
      if (filters.agents) lines.push('Agents: ' + filters.agents.join(', '));
      if (filters.roles) lines.push('Roles: ' + filters.roles.join(', '));
      if (filters.firstPromptOnly) lines.push('Mode: first prompt only');
      if (filters.since) lines.push('Since: ' + fmtDate(filters.since));
      if (filters.until) lines.push('Until: ' + fmtDate(filters.until));
      lines.push('', '---', '');

      data.projects.forEach(function (group) {
        if (!group.sessions.length) return;
        lines.push('## ' + group.project.name);
        lines.push(group.project.path);
        lines.push('');
        group.sessions.forEach(function (session) {
          lines.push((filters.firstPromptOnly ? formatFirstPromptLog(session) : formatSessionLog(session)).trim());
          lines.push('');
        });
      });

      return lines.join('\n').trim() + '\n';
    }

    function copyText(text) {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      ta.setSelectionRange(0, ta.value.length);
      var ok = false;
      try {
        ok = document.execCommand('copy');
      } catch {
        ok = false;
      }
      document.body.removeChild(ta);
      if (ok) return Promise.resolve();
      if (navigator.clipboard && window.isSecureContext) {
        return navigator.clipboard.writeText(text);
      }
      return Promise.reject(new Error('copy failed'));
    }

    function showCopyFallback(text) {
      var existing = document.getElementById('copyFallback');
      if (existing) existing.remove();

      var box = document.createElement('div');
      box.id = 'copyFallback';
      box.className = 'copy-fallback';

      var head = document.createElement('div');
      head.className = 'copy-fallback-head';
      var title = document.createElement('span');
      title.textContent = 'コピー用テキスト';
      var close = document.createElement('button');
      close.type = 'button';
      close.className = 'secondary';
      close.textContent = '閉じる';
      close.addEventListener('click', function () { box.remove(); });
      head.appendChild(title);
      head.appendChild(close);

      var ta = document.createElement('textarea');
      ta.readOnly = true;
      ta.value = text;

      box.appendChild(head);
      box.appendChild(ta);
      els.results.parentNode.insertBefore(box, els.results);
      ta.focus();
      ta.select();
      ta.setSelectionRange(0, ta.value.length);
    }

    function renderFirstPromptCard(session, q) {
      var first = firstUserTurn(session);
      var body = first ? highlight(first.text || '', q) : '（ユーザープロンプトなし）';
      var time = first ? ' ' + escapeHtml(fmtDate(first.timestamp)) : '';
      // 長文の最初の依頼は一覧性を保つためクランプし、必要なら全文展開できる。
      var longText = !!(first && first.text && first.text.length > 600);
      var bubbleCls = longText ? 'bubble clamp' : 'bubble';
      var topBtn = longText
        ? '<button type="button" class="secondary show-more top" hidden>折りたたむ</button>'
        : '';
      var moreBtn = longText
        ? '<button type="button" class="secondary show-more">全文を表示</button>'
        : '';
      return '<div class="first-prompt-card">'
        + '<div class="first-prompt-head"><div class="first-prompt-label">最初の依頼' + time + '</div>' + topBtn + '</div>'
        + '<div class="' + bubbleCls + '">' + body + '</div>'
        + moreBtn
        + '</div>';
    }

    function renderSessionCard(session, q, firstPromptOnly) {
      var idx = sessionStore.length;
      sessionStore.push(session);
      var meta = [
        agentBadge(session.agent),
        modelBadge(session.modelInfo),
        modelMeta(session.modelInfo),
        '<span>' + escapeHtml(fmtDate(session.startedAt)) + '</span>',
        '<span>' + session.turns.length + ' turns</span>',
      ];
      if (q && session.matchedTurns) {
        meta.push('<span class="pill hit">' + session.matchedTurns + ' 件ヒット</span>');
      }
      meta = meta.filter(Boolean);
      // 最初の依頼のみモードは展開不要。プレビューと本文の重複を避けて
      // 1 枚のフラットカードで「タイトル＋メタ＋依頼全文」を見せる。
      if (firstPromptOnly) {
        return '<div class="session flat" data-idx="' + idx + '">'
          + '<div class="summary-like">'
          + '<div class="s-head"><span class="s-title">' + highlight(sessionTitle(session), q) + '</span>'
          + '<button type="button" class="copy-log secondary" data-idx="' + idx + '">最初の依頼をコピー</button></div>'
          + '<div class="s-meta">' + meta.join('') + '</div>'
          + '</div>'
          + renderFirstPromptCard(session, q)
          + '</div>';
      }
      return '<details class="session" data-idx="' + idx + '">'
        + '<summary>'
        + '<div class="s-head"><span class="s-title">' + highlight(sessionTitle(session), q) + '</span>'
        + '<button type="button" class="copy-log secondary" data-idx="' + idx + '">ログをコピー</button></div>'
        + '<div class="s-meta">' + meta.join('') + '</div>'
        + '<div class="s-preview">' + highlight(sessionPreview(session, q), q) + '</div>'
        + '</summary>'
        + '<div class="turns"></div>'
        + '</details>';
    }

    // サーバ側でもフィルタしているが、古いレスポンスや想定外の
    // reasoning パラメータ表現に備え、クライアント側でも最終防衛する。
    function normalizeResultData(data) {
      if (!data || !data.filters || data.filters.reasoning !== false) return data;

      var q = data.filters.q || '';
      var totalTurns = 0;
      var matchedTurns = 0;
      data.projects = (data.projects || []).map(function (group) {
        var sessions = (group.sessions || []).map(function (session) {
          var turns = (session.turns || []).filter(function (turn) { return turn.kind !== 'reasoning'; });
          var sessionMatched = q
            ? turns.reduce(function (n, turn) { return turnMatches(turn, q) ? n + 1 : n; }, 0)
            : turns.length;
          return Object.assign({}, session, { turns: turns, matchedTurns: sessionMatched });
        }).filter(function (session) { return session.turns.length > 0; });

        var groupTurns = sessions.reduce(function (n, session) { return n + session.turns.length; }, 0);
        var groupMatched = sessions.reduce(function (n, session) { return n + session.matchedTurns; }, 0);
        totalTurns += groupTurns;
        matchedTurns += groupMatched;

        return Object.assign({}, group, {
          sessions: sessions,
          summary: Object.assign({}, group.summary || {}, {
            sessions: sessions.length,
            turns: groupTurns,
            matchedTurns: groupMatched,
          }),
        });
      }).filter(function (group) { return group.sessions.length > 0; });

      data.summary = Object.assign({}, data.summary || {}, {
        projects: data.projects.length,
        sessions: data.projects.reduce(function (n, group) { return n + group.sessions.length; }, 0),
        turns: totalTurns,
        matchedTurns: matchedTurns,
      });

      return data;
    }

    function renderResults(data) {
      sessionStore = [];
      lastQuery = (data.filters && data.filters.q) || '';
      var q = lastQuery;
      var firstPromptOnly = !!(data.filters && data.filters.firstPromptOnly);
      els.copyResults.disabled = data.summary.sessions === 0;

      els.summary.innerHTML = [
        '<span class="pill">プロジェクト: ' + data.summary.projects + '</span>',
        '<span class="pill">セッション: ' + data.summary.sessions + '</span>',
        firstPromptOnly ? '<span class="pill">最初の依頼のみ</span>' : '',
        q
          ? '<span class="pill hit">ヒット: ' + data.summary.matchedTurns + ' / ' + data.summary.turns + ' turns</span>'
          : '<span class="pill">' + data.summary.turns + ' turns</span>',
      ].filter(Boolean).join('');

      if (!data.projects.length || data.summary.sessions === 0) {
        els.results.innerHTML = '<div class="empty">'
          + '<span class="empty-icon">' + (q ? '🔍' : '📭') + '</span>'
          + '<div class="empty-title">' + (q ? '一致する会話が見つかりません' : '表示できるログがありません') + '</div>'
          + (q
              ? '「' + escapeHtml(q) + '」を含む会話はありませんでした。<br>キーワードを変えるか、エージェント・期間の条件を緩めてみてください。'
              : '選択したプロジェクト・条件にはログがありません。<br>エージェントや期間の条件を見直してください。')
          + '</div>';
        return;
      }

      els.results.innerHTML = data.projects.map(function (group) {
        if (!group.sessions.length) return '';
        var head = '<div class="group-head">'
          + '<span class="gname">' + escapeHtml(group.project.name) + '</span>'
          + '<span class="gpath">' + escapeHtml(group.project.path) + '</span>'
          + '<span class="gcount">' + group.summary.sessions + ' sessions</span>'
          + '</div>';
        var cards = group.sessions.slice(0, PAGE).map(function (s) { return renderSessionCard(s, q, firstPromptOnly); }).join('');
        var rest = group.sessions.length - PAGE;
        var more = rest > 0
          ? '<button class="more secondary" data-shown="' + PAGE + '" data-project="' + escapeHtml(group.project.path) + '">残り ' + rest + ' セッションを表示</button>'
          : '';
        return '<section class="project-group" data-path="' + escapeHtml(group.project.path) + '">' + head + cards + more + '</section>';
      }).join('');

      // 検索時はセッションが少なければ自動展開して会話をすぐ見られるように
      // 検索時はヒットしたセッションへ素早く到達できるよう自動展開する
      // (件数が多すぎると描画が重いので上限を設ける)。
      if (!firstPromptOnly && q && data.summary.sessions <= 8) {
        els.results.querySelectorAll('details.session').forEach(function (d) { d.open = true; });
      }
    }

    var lastData = null;
    var searchController = null;   // 進行中リクエストの AbortController
    var researchTimer = null;      // 自動再検索の debounce タイマー

    // 即時 return / エラー時に画面状態を一括リセットして、
    // 古い結果やコピー可能状態が残らないようにする。
    function resetResultState(html) {
      lastData = null;
      els.results.innerHTML = html;
      els.summary.innerHTML = '';
      els.status.textContent = '';
      els.copyResults.disabled = true;
    }

    // lazy-render turns on first expand (large sessions stay cheap)
    els.results.addEventListener('toggle', function (ev) {
      var details = ev.target;
      if (!details.classList || !details.classList.contains('session') || !details.open) return;
      var turnsEl = details.querySelector('.turns');
      if (!turnsEl) return;
      if (turnsEl.dataset.rendered) return;
      var session = sessionStore[Number(details.dataset.idx)];
      turnsEl.innerHTML = session.turns.map(function (t) { return renderTurn(t, lastQuery); }).join('');
      turnsEl.dataset.rendered = '1';
    }, true);

    els.results.addEventListener('click', function (ev) {
      var moreText = ev.target.closest('button.show-more');
      if (moreText) {
        ev.preventDefault();
        ev.stopPropagation();
        var promptCard = moreText.closest('.first-prompt-card');
        var clamp = promptCard ? promptCard.querySelector('.clamp') : null;
        if (clamp) {
          var expanded = clamp.classList.toggle('expanded');
          if (promptCard) {
            promptCard.querySelectorAll('button.show-more').forEach(function (btn) {
              if (btn.classList.contains('top')) {
                btn.hidden = !expanded;
              } else {
                btn.textContent = expanded ? '折りたたむ' : '全文を表示';
              }
            });
          } else {
            moreText.textContent = expanded ? '折りたたむ' : '全文を表示';
          }
          // 折りたたんだ際は、長くスクロールした位置から
          // カード先頭へ戻して読み戻しやすくする。
          if (!expanded) {
            var card = moreText.closest('.session');
            if (card && typeof card.scrollIntoView === 'function') {
              card.scrollIntoView({ block: 'nearest' });
            }
          }
        }
        return;
      }
      var copyBtn = ev.target.closest('button.copy-log');
      if (copyBtn) {
        ev.preventDefault();
        ev.stopPropagation();
        var session = sessionStore[Number(copyBtn.dataset.idx)];
        if (!session) return;
        var oldText = copyBtn.textContent;
        var text = lastData && lastData.filters && lastData.filters.firstPromptOnly
          ? formatFirstPromptLog(session)
          : formatSessionLog(session);
        copyBtn.disabled = true;
        copyText(text).then(function () {
          copyBtn.textContent = 'コピーしました';
          showToast('クリップボードにコピーしました');
        }).catch(function () {
          showCopyFallback(text);
          copyBtn.textContent = 'コピー用に選択';
        }).finally(function () {
          window.setTimeout(function () {
            copyBtn.textContent = oldText;
            copyBtn.disabled = false;
          }, 1400);
        });
        return;
      }

      var btn = ev.target.closest('button.more');
      if (!btn || !lastData) return;
      var path = btn.dataset.project;
      var group = lastData.projects.find(function (g) { return g.project.path === path; });
      if (!group) return;
      var firstPromptOnly = !!(lastData.filters && lastData.filters.firstPromptOnly);
      var shown = Number(btn.dataset.shown);
      var next = group.sessions.slice(shown, shown + PAGE)
        .map(function (s) { return renderSessionCard(s, lastQuery, firstPromptOnly); }).join('');
      btn.insertAdjacentHTML('beforebegin', next);
      var newShown = shown + PAGE;
      if (newShown >= group.sessions.length) btn.remove();
      else {
        btn.dataset.shown = newShown;
        btn.textContent = '残り ' + (group.sessions.length - newShown) + ' セッションを表示';
      }
    });

    /* ---------- search ---------- */

    function selectedAgents() {
      return Array.prototype.map.call(document.querySelectorAll('input[name="agent"]:checked'), function (el) { return el.value; });
    }

    // 一度結果を表示した後にフィルタを変えたら自動で再取得する。
    // 連続変更時は debounce で最後の 1 回だけ実行する。
    function researchIfShown() {
      if (!lastData || selected.size === 0) return;
      if (researchTimer) window.clearTimeout(researchTimer);
      researchTimer = window.setTimeout(function () {
        researchTimer = null;
        if (selected.size > 0) search();
      }, 250);
    }

    async function search() {
      // 自動再検索が pending なら取り消す(手動検索が優先)。
      if (researchTimer) { window.clearTimeout(researchTimer); researchTimer = null; }

      if (selected.size === 0) {
        resetResultState('<div class="empty">'
          + '<span class="empty-icon">👈</span>'
          + '<div class="empty-title">プロジェクトが選択されていません</div>'
          + '左のリストからプロジェクトを選択してください（複数選択できます）。</div>');
        showToast('プロジェクトを選択してください');
        return;
      }

      var agents = selectedAgents();
      if (agents.length === 0) {
        resetResultState('<div class="empty">'
          + '<span class="empty-icon">🤖</span>'
          + '<div class="empty-title">エージェントが選択されていません</div>'
          + '少なくとも 1 つのエージェント（Claude / Codex / Copilot）を選択してください。</div>');
        showToast('エージェントを選択してください');
        return;
      }

      var params = new URLSearchParams();
      selected.forEach(function (path) { params.append('projectDir', path); });
      params.set('agent', agents.join(','));
      params.set('q', els.query.value.trim());
      params.set('reasoning', els.firstPromptOnly.checked ? '0' : (els.showReasoning.checked ? '1' : '0'));
      params.set('role', els.firstPromptOnly.checked ? 'user' : (els.showTools.checked ? 'user,assistant,tool' : 'user,assistant'));
      params.set('firstPromptOnly', els.firstPromptOnly.checked ? '1' : '0');
      if (els.last.value) params.set('last', els.last.value);

      // 進行中の古いリクエストを中断し、最新条件だけを反映する。
      if (searchController) searchController.abort();
      var controller = new AbortController();
      searchController = controller;

      els.status.textContent = '';
      els.results.innerHTML = loadingMarkup({ variant: 'panel', label: 'ログを読み込み中...' });
      els.summary.innerHTML = '';
      els.copyResults.disabled = true;
      lastData = null;

      try {
        var res = await fetch('/api/sessions?' + params.toString(), { signal: controller.signal });
        var data = await res.json();
        if (!res.ok) throw new Error(data.error || 'request failed');
        // 応答が返る間に新しい検索が始まっていたら、この結果は破棄する。
        if (controller !== searchController) return;
        data = normalizeResultData(data);
        els.status.textContent = '';
        lastData = data;
        renderResults(data);
      } catch (err) {
        // 中断(新しい検索に置き換え)時は画面を触らない。
        if (err && err.name === 'AbortError') return;
        if (controller !== searchController) return;
        els.status.textContent = '';
        els.results.innerHTML = '<div class="error">' + escapeHtml(err.message) + '</div>';
        els.summary.innerHTML = '';
        lastData = null;
        els.copyResults.disabled = true;
      } finally {
        if (controller === searchController) searchController = null;
      }
    }

    /* ---------- events ---------- */

    els.projectFilter.addEventListener('input', renderProjectList);
    els.projectList.addEventListener('change', function (ev) {
      var cb = ev.target;
      if (!cb.dataset || !cb.dataset.path) return;
      if (cb.checked) selected.add(cb.dataset.path);
      else selected.delete(cb.dataset.path);
      var item = cb.closest('.project-item');
      if (item) item.classList.toggle('active', cb.checked);
      updateSearchButton();
    });
    els.clearProjects.addEventListener('click', function () {
      selected.clear();
      renderProjectList();
      updateSearchButton();
    });
    els.addPath.addEventListener('click', function () {
      var path = els.manualPath.value.trim();
      if (!path) return;
      if (!projects.some(function (p) { return p.path === path; })) {
        projects.unshift({ name: path.split('/').filter(Boolean).pop() || path, path: path, agents: [] });
      }
      selected.add(path);
      els.manualPath.value = '';
      els.projectFilter.value = '';
      renderProjectList();
      updateSearchButton();
    });
    els.manualPath.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') els.addPath.click(); });
    els.searchButton.addEventListener('click', search);
    els.queryButton.addEventListener('click', search);
    els.firstPromptOnly.addEventListener('change', function () {
      updateLogModeControls();
      researchIfShown();
    });
    // 既に結果が表示されている場合、フィルタ変更を即時反映する
    // (「変更後に再度『表示する』が必要」という分かりにくさを解消)。
    els.showReasoning.addEventListener('change', researchIfShown);
    els.showTools.addEventListener('change', researchIfShown);
    els.last.addEventListener('change', researchIfShown);
    Array.prototype.forEach.call(document.querySelectorAll('input[name="agent"]'), function (el) {
      el.addEventListener('change', researchIfShown);
    });
    els.copyResults.addEventListener('click', function () {
      if (!lastData || !lastData.summary || lastData.summary.sessions === 0) return;
      var oldText = els.copyResults.textContent;
      var text = formatSearchResultsLog(lastData);
      els.copyResults.disabled = true;
      copyText(text).then(function () {
        els.copyResults.textContent = 'コピーしました';
        showToast('検索結果をコピーしました');
      }).catch(function () {
        showCopyFallback(text);
        els.copyResults.textContent = 'コピー用に選択';
      }).finally(function () {
        window.setTimeout(function () {
          els.copyResults.textContent = oldText;
          els.copyResults.disabled = false;
        }, 1400);
      });
    });
    els.reloadProjects.addEventListener('click', loadProjects);
    els.query.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') search(); });

    updateLogModeControls();
    loadProjects();
  </script>
</body>
</html>`;
