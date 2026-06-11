import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import type { AgentId } from './types.js';
import { readJsonl } from '../utils/jsonl.js';

export interface ProjectInfo {
  name: string;
  path: string;
  agents: AgentId[];
  lastSeen?: string;
  exists: boolean;
}

const CLAUDE_PROJECTS_DIR = join(homedir(), '.claude', 'projects');
const CODEX_SESSIONS_DIR = join(homedir(), '.codex', 'sessions');
const COPILOT_SESSIONS_DIR = join(homedir(), '.copilot', 'session-state');

function safeReaddir(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

function addProject(
  projects: Map<string, ProjectInfo>,
  path: string | undefined,
  agent: AgentId,
  lastSeen?: string
): void {
  if (!path) return;
  const existing = projects.get(path);
  if (existing) {
    if (!existing.agents.includes(agent)) existing.agents.push(agent);
    if (lastSeen && (!existing.lastSeen || lastSeen > existing.lastSeen)) {
      existing.lastSeen = lastSeen;
    }
    return;
  }

  projects.set(path, {
    name: basename(path) || path,
    path,
    agents: [agent],
    lastSeen,
    exists: existsSync(path),
  });
}

function walkCodexRollouts(root: string): string[] {
  if (!existsSync(root)) return [];
  const results: string[] = [];
  for (const y of safeReaddir(root)) {
    if (!/^\d{4}$/.test(y)) continue;
    for (const m of safeReaddir(join(root, y))) {
      if (!/^\d{2}$/.test(m)) continue;
      for (const d of safeReaddir(join(root, y, m))) {
        if (!/^\d{2}$/.test(d)) continue;
        const dayDir = join(root, y, m, d);
        for (const f of safeReaddir(dayDir)) {
          if (f.startsWith('rollout-') && f.endsWith('.jsonl')) {
            results.push(join(dayDir, f));
          }
        }
      }
    }
  }
  return results;
}

async function discoverCodexProjects(projects: Map<string, ProjectInfo>): Promise<void> {
  for (const file of walkCodexRollouts(CODEX_SESSIONS_DIR)) {
    try {
      if (!statSync(file).isFile()) continue;
    } catch {
      continue;
    }

    for await (const rec of readJsonl(file)) {
      if (rec?.type !== 'session_meta') continue;
      const payload = rec.payload ?? {};
      // Skip Codex-internal subagent sessions (see adapters/codex.ts)
      if (!(payload.source && typeof payload.source === 'object')) {
        addProject(projects, payload.cwd, 'codex', payload.timestamp ?? rec.timestamp);
      }
      break;
    }
  }
}

async function discoverCopilotProjects(projects: Map<string, ProjectInfo>): Promise<void> {
  if (!existsSync(COPILOT_SESSIONS_DIR)) return;

  for (const sid of safeReaddir(COPILOT_SESSIONS_DIR)) {
    const eventsPath = join(COPILOT_SESSIONS_DIR, sid, 'events.jsonl');
    if (!existsSync(eventsPath)) continue;
    try {
      if (!statSync(eventsPath).isFile()) continue;
    } catch {
      continue;
    }

    for await (const rec of readJsonl(eventsPath)) {
      if (rec?.type !== 'session.start') continue;
      const ctx = rec?.data?.context;
      addProject(projects, ctx?.cwd, 'copilot', rec?.data?.startTime ?? rec.timestamp);
      break;
    }
  }
}

async function discoverClaudeProjects(projects: Map<string, ProjectInfo>): Promise<void> {
  if (!existsSync(CLAUDE_PROJECTS_DIR)) return;

  for (const dirName of safeReaddir(CLAUDE_PROJECTS_DIR)) {
    const dir = join(CLAUDE_PROJECTS_DIR, dirName);
    let files: { path: string; mtime: number }[] = [];
    for (const f of safeReaddir(dir)) {
      if (!f.endsWith('.jsonl')) continue;
      const full = join(dir, f);
      try {
        const st = statSync(full);
        if (st.isFile()) files.push({ path: full, mtime: st.mtimeMs });
      } catch {
        // ignore
      }
    }
    if (files.length === 0) continue;
    files.sort((a, b) => b.mtime - a.mtime);

    // The directory name encodes the cwd lossily ("/" -> "-"), so read the
    // actual cwd from the newest session's records instead.
    const newest = files[0];
    let cwd: string | undefined;
    let scanned = 0;
    for await (const rec of readJsonl(newest.path)) {
      if (typeof rec?.cwd === 'string') {
        cwd = rec.cwd;
        break;
      }
      if (++scanned >= 50) break;
    }
    addProject(projects, cwd, 'claude', new Date(newest.mtime).toISOString());
  }
}

export async function discoverProjects(): Promise<ProjectInfo[]> {
  const projects = new Map<string, ProjectInfo>();
  await Promise.all([
    discoverClaudeProjects(projects),
    discoverCodexProjects(projects),
    discoverCopilotProjects(projects),
  ]);

  return [...projects.values()].sort((a, b) => {
    if (a.lastSeen && b.lastSeen && a.lastSeen !== b.lastSeen) {
      return b.lastSeen.localeCompare(a.lastSeen);
    }
    return a.name.localeCompare(b.name);
  });
}
