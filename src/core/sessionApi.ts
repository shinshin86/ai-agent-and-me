import { collectClaude } from '../adapters/claude.js';
import { collectCodex } from '../adapters/codex.js';
import { collectCopilot } from '../adapters/copilot.js';
import { normalizeModelName } from './modelInfo.js';
import { resolveRepoPath } from './path.js';
import type { AgentId, CollectOptions, Role, UnifiedSession, UnifiedTurn } from './types.js';

const MAX_TOOL_PAYLOAD_CHARS = 20_000;
const UNKNOWN_MODEL_LABEL = 'モデル不明';

export interface ModelFacet {
  name: string;
  count: number;
}

export interface SessionView extends Omit<UnifiedSession, 'turns'> {
  turns: UnifiedTurn[];
  matchedTurns: number;
}

export interface FilterResult {
  sessions: SessionView[];
  totalTurns: number;
  matchedTurns: number;
}

export interface ApiProject {
  project: {
    name: string;
    path: string;
  };
  summary: {
    sessions: number;
    turns: number;
    matchedTurns: number;
  };
  sessions: SessionView[];
}

export interface ApiResult {
  filters: {
    agents: AgentId[];
    roles: Role[];
    models: string[];
    toolNames?: string[];
    reasoning: boolean;
    firstPromptOnly: boolean;
    q: string;
    since?: string;
    until?: string;
  };
  summary: {
    projects: number;
    sessions: number;
    turns: number;
    matchedTurns: number;
  };
  availableModels: ModelFacet[];
  projects: ApiProject[];
}

export interface BuildApiFilters {
  agents: AgentId[];
  roles: Role[];
  models?: string[];
  toolNames?: string[];
  includeReasoning?: boolean;
  firstPromptOnly?: boolean;
  query?: string;
  since?: Date;
  until?: Date;
  verbose?: boolean;
  truncateToolPayloads?: boolean;
}

export function parseAgents(value: string | null | undefined): AgentId[] {
  const allowed = new Set<AgentId>(['claude', 'codex', 'copilot']);
  const agents = (value ?? 'claude,codex,copilot')
    .split(',')
    .map((s) => s.trim())
    .filter((s): s is AgentId => allowed.has(s as AgentId));
  return agents.length > 0 ? agents : ['claude', 'codex', 'copilot'];
}

export function parseRoles(params: URLSearchParams): Role[] {
  if (params.get('conversationOnly') === '1') return ['user', 'assistant'];
  return parseRoleList(params.get('role') ?? 'user,assistant,tool,system');
}

export function parseRoleList(value: string | null | undefined): Role[] {
  const allowed = new Set<Role>(['user', 'assistant', 'tool', 'system']);
  const roles = (value ?? 'user,assistant,tool,system')
    .split(',')
    .map((s) => s.trim())
    .filter((s): s is Role => allowed.has(s as Role));
  return roles.length > 0 ? roles : ['user', 'assistant', 'tool', 'system'];
}

export function parseBooleanFlag(value: string | null, defaultValue: boolean): boolean {
  if (value === null) return defaultValue;
  const normalized = value.trim().toLowerCase();
  if (['0', 'false', 'off', 'no'].includes(normalized)) return false;
  if (['1', 'true', 'on', 'yes'].includes(normalized)) return true;
  return defaultValue;
}

export function parseModels(params: URLSearchParams): string[] {
  const values = [
    ...params.getAll('model'),
    ...(params.get('models') ?? '').split(','),
  ];
  return [...new Set(values.map((s) => s.trim()).filter(Boolean))];
}

export function turnText(turn: UnifiedTurn): string {
  const chunks = [turn.text ?? ''];
  if (turn.toolCall) {
    chunks.push(turn.toolCall.name);
    if (turn.toolCall.input !== undefined) chunks.push(JSON.stringify(turn.toolCall.input));
    if (turn.toolCall.output !== undefined) chunks.push(JSON.stringify(turn.toolCall.output));
  }
  return chunks.join('\n');
}

export function sessionModelNames(session: UnifiedSession | SessionView): string[] {
  const models = session.modelInfo?.models
    ?.map((m) => normalizeModelName(m))
    .filter((m): m is string => typeof m === 'string' && m.length > 0) ?? [];
  return models.length > 0 ? models : [UNKNOWN_MODEL_LABEL];
}

export function sessionMatchesModels(session: UnifiedSession | SessionView, models: string[]): boolean {
  if (models.length === 0) return true;
  const wanted = new Set(models.map((m) => m.toLowerCase()));
  return sessionModelNames(session).some((m) => wanted.has(m.toLowerCase()));
}

export function collectModelFacets(projects: { sessions: SessionView[] }[]): ModelFacet[] {
  const counts = new Map<string, number>();
  for (const project of projects) {
    for (const session of project.sessions) {
      for (const model of sessionModelNames(session)) {
        counts.set(model, (counts.get(model) ?? 0) + 1);
      }
    }
  }

  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => {
      if (a.name === UNKNOWN_MODEL_LABEL) return 1;
      if (b.name === UNKNOWN_MODEL_LABEL) return -1;
      if (b.count !== a.count) return b.count - a.count;
      return a.name.localeCompare(b.name);
    });
}

export function truncatePayload(value: unknown): unknown {
  if (value === undefined) return undefined;
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (typeof text !== 'string') return value;
  if (text.length <= MAX_TOOL_PAYLOAD_CHARS) return value;
  return text.slice(0, MAX_TOOL_PAYLOAD_CHARS) + `\n…(truncated, ${text.length} chars total)`;
}

// Keep whole sessions that contain a match so query results preserve the
// surrounding conversation flow, matching the Web UI behavior.
export function filterSessions(
  sessions: UnifiedSession[],
  roles: Role[],
  includeReasoning: boolean,
  firstPromptOnly: boolean,
  query: string,
  truncateToolPayloads = true,
  toolNames: string[] = []
): FilterResult {
  const roleSet = new Set<Role>(roles);
  const toolNameSet = new Set(toolNames);
  const q = query.trim().toLowerCase();
  let totalTurns = 0;
  let matchedTurns = 0;

  const filtered: SessionView[] = [];
  for (const session of sessions) {
    let turns = session.turns.filter(
      (turn) => roleSet.has(turn.role) && (includeReasoning || turn.kind !== 'reasoning')
    );
    if (toolNameSet.size > 0) {
      turns = turns.filter((turn) => !turn.toolCall || toolNameSet.has(turn.toolCall.name));
    }
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
      turn.toolCall && truncateToolPayloads
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

export async function buildApiResult(repoPaths: string[], filters: BuildApiFilters): Promise<ApiResult> {
  const agents = filters.agents;
  const roles = filters.roles;
  const selectedModels = filters.models ?? [];
  const toolNames = filters.toolNames ?? [];
  const includeReasoning = filters.includeReasoning ?? true;
  const firstPromptOnly = filters.firstPromptOnly ?? false;
  const q = filters.query ?? '';
  const seen = new Set<string>();

  const projectResults = await Promise.all(
    repoPaths.map(async (dir) => {
      const repoPath = resolveRepoPath(dir);
      if (seen.has(repoPath)) return null;
      seen.add(repoPath);

      const opts: CollectOptions = { repoPath, since: filters.since, until: filters.until, verbose: filters.verbose };
      const tasks: Promise<UnifiedSession[]>[] = [];
      if (agents.includes('claude')) tasks.push(collectClaude(opts));
      if (agents.includes('codex')) tasks.push(collectCodex(opts));
      if (agents.includes('copilot')) tasks.push(collectCopilot(opts));

      const collected = (await Promise.all(tasks)).flat();
      const { sessions, totalTurns, matchedTurns } = filterSessions(
        collected,
        roles,
        includeReasoning,
        firstPromptOnly,
        q,
        filters.truncateToolPayloads ?? true,
        toolNames
      );

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

  const baseProjects = projectResults
    .filter((p): p is NonNullable<typeof p> => p !== null)
    .sort((a, b) => {
      const aLatest = a.sessions[0]?.startedAt ?? '';
      const bLatest = b.sessions[0]?.startedAt ?? '';
      return bLatest.localeCompare(aLatest);
    });
  const availableModels = collectModelFacets(baseProjects);

  const projects = baseProjects
    .map((project) => {
      if (selectedModels.length === 0) return project;
      const sessions = project.sessions.filter((session) => sessionMatchesModels(session, selectedModels));
      return {
        ...project,
        summary: {
          sessions: sessions.length,
          turns: sessions.reduce((n, s) => n + s.turns.length, 0),
          matchedTurns: sessions.reduce((n, s) => n + s.matchedTurns, 0),
        },
        sessions,
      };
    })
    .filter((p) => p.sessions.length > 0);

  return {
    filters: {
      agents,
      roles,
      models: selectedModels,
      ...(toolNames.length > 0 ? { toolNames } : {}),
      reasoning: includeReasoning,
      firstPromptOnly,
      q,
      since: filters.since?.toISOString(),
      until: filters.until?.toISOString(),
    },
    summary: {
      projects: projects.length,
      sessions: projects.reduce((n, p) => n + p.summary.sessions, 0),
      turns: projects.reduce((n, p) => n + p.summary.turns, 0),
      matchedTurns: projects.reduce((n, p) => n + p.summary.matchedTurns, 0),
    },
    availableModels,
    projects,
  };
}
