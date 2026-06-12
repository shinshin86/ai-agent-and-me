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
  query: string
): FilterResult {
  const roleSet = new Set<Role>(roles);
  const q = query.trim().toLowerCase();
  let totalTurns = 0;
  let matchedTurns = 0;

  const filtered: SessionView[] = [];
  for (const session of sessions) {
    const turns = session.turns.filter(
      (turn) => roleSet.has(turn.role) && (includeReasoning || turn.kind !== 'reasoning')
    );
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
  const includeReasoning = params.get('reasoning') !== '0';
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
      const { sessions, totalTurns, matchedTurns } = filterSessions(collected, roles, includeReasoning, q);

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
      color-scheme: light;
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
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
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
    .project-list {
      border: 1px solid var(--line);
      border-radius: 8px;
      max-height: 320px;
      overflow: auto;
      background: #fff;
    }
    .project-item {
      display: flex;
      gap: 8px;
      align-items: flex-start;
      padding: 8px 10px;
      border-bottom: 1px solid #eef1f5;
      cursor: pointer;
    }
    .project-item:last-child { border-bottom: 0; }
    .project-item:hover { background: #f8fafb; }
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
    }
    .row { display: flex; gap: 6px; }
    .row > input { flex: 1; }
    button {
      border: 1px solid var(--accent);
      background: var(--accent);
      color: #fff;
      border-radius: 8px;
      padding: 8px 12px;
      cursor: pointer;
    }
    button.secondary { background: #fff; color: var(--accent); }
    button:disabled { opacity: .5; cursor: default; }

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
    .pill { display: inline-flex; padding: 4px 10px; border-radius: 999px; border: 1px solid var(--line); background: #fff; color: #334155; font-size: 12.5px; }
    .status { color: var(--muted); margin: 10px 0; }

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
    .session > summary { list-style: none; cursor: pointer; padding: 11px 14px; display: grid; gap: 4px; }
    .session > summary::-webkit-details-marker { display: none; }
    .session > summary:hover { background: #fafbfc; }
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
    .s-preview { color: #475569; font-size: 12.5px; line-height: 1.5; overflow-wrap: anywhere; }
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
      background: #fff;
    }
    .turn.user .bubble { background: var(--user-soft); border-color: #d4e0fb; }
    .turn.user .turn-label { color: var(--user); }
    .turn.assistant .bubble { background: var(--accent-soft); border-color: #cfe9e3; }
    .turn.assistant .turn-label { color: var(--accent); }
    details.sub { border: 1px dashed var(--line); border-radius: 10px; background: #fafbfc; }
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
      color: #475569;
      font-size: 12.5px;
      max-height: 420px;
      overflow: auto;
    }
    details.sub.tool > .sub-body { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px; }

    mark { background: #fde68a; color: inherit; padding: 0 2px; border-radius: 3px; }
    .more { width: 100%; margin: 4px 0 10px; background: #fff; color: var(--accent); }
    .empty, .error { padding: 20px; border: 1px solid var(--line); border-radius: 10px; background: #fff; color: var(--muted); }
    .error { color: var(--warn); border-color: #fed7aa; background: #fff7ed; }

    @media (max-width: 920px) {
      .shell { grid-template-columns: 1fr; }
      aside { position: static; height: auto; border-right: 0; border-bottom: 1px solid var(--line); }
      main { padding: 0 16px 40px; }
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
        <div class="side-label"><span>表示するログ</span></div>
        <div class="checks">
          <label class="check"><input id="showReasoning" type="checkbox" checked> 思考ログ</label>
          <label class="check"><input id="showTools" type="checkbox"> ツールログ</label>
        </div>
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
      </div>
      <div class="summary" id="summary"></div>
      <div id="status" class="status"></div>
      <div id="results"></div>
    </main>
  </div>

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
      searchButton: document.getElementById('searchButton'),
      reloadProjects: document.getElementById('reloadProjects'),
      query: document.getElementById('query'),
      queryButton: document.getElementById('queryButton'),
      summary: document.getElementById('summary'),
      status: document.getElementById('status'),
      results: document.getElementById('results'),
    };

    var projects = [];          // discovered projects
    var selected = new Set();   // selected project paths
    var lastQuery = '';
    var PAGE = 30;              // sessions rendered per project before "もっと見る"

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
        return '<label class="project-item">'
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

    async function loadProjects() {
      els.status.textContent = 'プロジェクト一覧を読み込んでいます...';
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
      for (var i = 0; i < session.turns.length; i++) {
        var t = session.turns[i];
        if (t.role === 'user' && t.text) return oneLine(t.text, 70);
      }
      return session.sessionId;
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
          + '<summary>💭 思考ログ ' + time + ' — ' + highlight(oneLine(turn.text || '', 90), q) + '</summary>'
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
          lines.push('[' + time + '] AI reasoning (' + turn.agent + ')');
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

    async function copyText(text) {
      if (navigator.clipboard && window.isSecureContext) {
        try {
          await navigator.clipboard.writeText(text);
          return;
        } catch {
          // Fall back for browsers that expose Clipboard API but deny writes.
        }
      }
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      var ok = document.execCommand('copy');
      document.body.removeChild(ta);
      if (!ok) throw new Error('copy failed');
    }

    function renderSessionCard(session, q) {
      var idx = sessionStore.length;
      sessionStore.push(session);
      var meta = [
        agentBadge(session.agent),
        '<span>' + escapeHtml(fmtDate(session.startedAt)) + '</span>',
        '<span>' + session.turns.length + ' turns</span>',
      ];
      if (q && session.matchedTurns) {
        meta.push('<span class="pill hit">' + session.matchedTurns + ' 件ヒット</span>');
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

    function renderResults(data) {
      sessionStore = [];
      lastQuery = (data.filters && data.filters.q) || '';
      var q = lastQuery;

      els.summary.innerHTML = [
        '<span class="pill">プロジェクト: ' + data.summary.projects + '</span>',
        '<span class="pill">セッション: ' + data.summary.sessions + '</span>',
        q
          ? '<span class="pill hit">ヒット: ' + data.summary.matchedTurns + ' / ' + data.summary.turns + ' turns</span>'
          : '<span class="pill">' + data.summary.turns + ' turns</span>',
      ].join('');

      if (!data.projects.length || data.summary.sessions === 0) {
        els.results.innerHTML = '<div class="empty">' + (q ? '「' + escapeHtml(q) + '」に一致する会話はありません。' : '表示できるログがありません。') + '</div>';
        return;
      }

      els.results.innerHTML = data.projects.map(function (group) {
        if (!group.sessions.length) return '';
        var head = '<div class="group-head">'
          + '<span class="gname">' + escapeHtml(group.project.name) + '</span>'
          + '<span class="gpath">' + escapeHtml(group.project.path) + '</span>'
          + '<span class="gcount">' + group.summary.sessions + ' sessions</span>'
          + '</div>';
        var cards = group.sessions.slice(0, PAGE).map(function (s) { return renderSessionCard(s, q); }).join('');
        var rest = group.sessions.length - PAGE;
        var more = rest > 0
          ? '<button class="more secondary" data-shown="' + PAGE + '" data-project="' + escapeHtml(group.project.path) + '">残り ' + rest + ' セッションを表示</button>'
          : '';
        return '<section class="project-group" data-path="' + escapeHtml(group.project.path) + '">' + head + cards + more + '</section>';
      }).join('');

      // 検索時はセッションが少なければ自動展開して会話をすぐ見られるように
      if (q && data.summary.sessions <= 3) {
        els.results.querySelectorAll('details.session').forEach(function (d) { d.open = true; });
      }
    }

    var lastData = null;

    // lazy-render turns on first expand (large sessions stay cheap)
    els.results.addEventListener('toggle', function (ev) {
      var details = ev.target;
      if (!details.classList || !details.classList.contains('session') || !details.open) return;
      var turnsEl = details.querySelector('.turns');
      if (turnsEl.dataset.rendered) return;
      var session = sessionStore[Number(details.dataset.idx)];
      turnsEl.innerHTML = session.turns.map(function (t) { return renderTurn(t, lastQuery); }).join('');
      turnsEl.dataset.rendered = '1';
    }, true);

    els.results.addEventListener('click', function (ev) {
      var copyBtn = ev.target.closest('button.copy-log');
      if (copyBtn) {
        ev.preventDefault();
        ev.stopPropagation();
        var session = sessionStore[Number(copyBtn.dataset.idx)];
        if (!session) return;
        var oldText = copyBtn.textContent;
        copyBtn.disabled = true;
        copyText(formatSessionLog(session)).then(function () {
          copyBtn.textContent = 'コピーしました';
        }).catch(function () {
          copyBtn.textContent = 'コピー失敗';
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
      var shown = Number(btn.dataset.shown);
      var next = group.sessions.slice(shown, shown + PAGE)
        .map(function (s) { return renderSessionCard(s, lastQuery); }).join('');
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

    async function search() {
      if (selected.size === 0) {
        els.results.innerHTML = '<div class="error">左のリストからプロジェクトを選択してください(複数選択できます)。</div>';
        return;
      }

      var params = new URLSearchParams();
      selected.forEach(function (path) { params.append('projectDir', path); });
      params.set('agent', selectedAgents().join(','));
      params.set('q', els.query.value.trim());
      params.set('reasoning', els.showReasoning.checked ? '1' : '0');
      params.set('role', els.showTools.checked ? 'user,assistant,tool' : 'user,assistant');
      if (els.last.value) params.set('last', els.last.value);

      els.status.textContent = 'ログを読み込んでいます...';
      els.results.innerHTML = '';
      els.summary.innerHTML = '';

      try {
        var res = await fetch('/api/sessions?' + params.toString());
        var data = await res.json();
        if (!res.ok) throw new Error(data.error || 'request failed');
        els.status.textContent = '';
        lastData = data;
        renderResults(data);
      } catch (err) {
        els.status.textContent = '';
        els.results.innerHTML = '<div class="error">' + escapeHtml(err.message) + '</div>';
      }
    }

    /* ---------- events ---------- */

    els.projectFilter.addEventListener('input', renderProjectList);
    els.projectList.addEventListener('change', function (ev) {
      var cb = ev.target;
      if (!cb.dataset || !cb.dataset.path) return;
      if (cb.checked) selected.add(cb.dataset.path);
      else selected.delete(cb.dataset.path);
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
    els.reloadProjects.addEventListener('click', loadProjects);
    els.query.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') search(); });

    loadProjects();
  </script>
</body>
</html>`;
