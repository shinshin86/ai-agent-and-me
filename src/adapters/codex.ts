import { readdirSync, existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { CollectOptions, UnifiedSession, UnifiedTurn, Role } from '../core/types.js';
import { readJsonl } from '../utils/jsonl.js';

const CODEX_SESSIONS_DIR = join(homedir(), '.codex', 'sessions');

// Codex injects environment/instruction preambles as user messages; they are
// not something the user actually typed.
const NOISE_PREFIXES = [
  '<user_instructions>',
  '<environment_context>',
  '<ENVIRONMENT_CONTEXT>',
  '<permissions',
  '<turn_aborted',
  '# AGENTS.md instructions',
];

function isNoiseText(text: string): boolean {
  const trimmed = text.trimStart();
  return NOISE_PREFIXES.some((p) => trimmed.startsWith(p));
}

function extractResponseItemText(payload: any): { role: Role; kind?: 'reasoning'; text?: string; tool?: { name: string; input?: unknown; output?: unknown } } | null {
  if (!payload || typeof payload !== 'object') return null;

  // message with role + content[]
  if (payload.type === 'message') {
    const role: Role = payload.role === 'assistant' ? 'assistant' : payload.role === 'user' ? 'user' : 'system';
    if (role === 'system') {
      // Skip system/developer preambles to reduce noise
      if (payload.role === 'developer' || payload.role === 'system') return null;
    }
    const content = payload.content;
    if (Array.isArray(content)) {
      const parts: string[] = [];
      for (const p of content) {
        if (p && typeof p === 'object' && typeof p.text === 'string') parts.push(p.text);
      }
      const text = parts.join('\n') || undefined;
      if (text !== undefined && role === 'user' && isNoiseText(text)) return null;
      return { role, text };
    }
    return { role };
  }

  if (payload.type === 'function_call' || payload.type === 'tool_call') {
    return {
      role: 'tool',
      tool: { name: payload.name ?? 'function_call', input: payload.arguments ?? payload.input },
    };
  }

  if (payload.type === 'function_call_output' || payload.type === 'tool_result') {
    return {
      role: 'tool',
      tool: { name: 'function_call_output', output: payload.output ?? payload.result },
    };
  }

  if (payload.type === 'reasoning') {
    // Reasoning content itself is encrypted; the readable part is summary[].text.
    const summary = payload.summary;
    if (Array.isArray(summary)) {
      const parts: string[] = [];
      for (const s of summary) {
        if (s && typeof s === 'object' && typeof s.text === 'string' && s.text.trim()) parts.push(s.text);
      }
      if (parts.length > 0) {
        return { role: 'assistant', kind: 'reasoning', text: parts.join('\n\n') };
      }
    }
    return null;
  }

  return null;
}

async function readRolloutIfMatching(
  path: string,
  opts: CollectOptions
): Promise<UnifiedSession | null> {
  let sessionId = '';
  let startedAt: string | undefined;
  let matched = false;
  const turns: UnifiedTurn[] = [];
  let endedAt: string | undefined;

  for await (const rec of readJsonl(path)) {
    const type = rec?.type;
    const ts: string | undefined = rec?.timestamp;

    if (type === 'session_meta') {
      const payload = rec.payload ?? {};
      if (payload.cwd !== opts.repoPath) return null;
      // Skip Codex-internal subagent sessions (guardian permission checks,
      // thread_spawn workers); user-driven sessions have a string source.
      if (payload.source && typeof payload.source === 'object') return null;
      matched = true;
      sessionId = payload.id ?? '';
      startedAt = payload.timestamp ?? ts;
      continue;
    }

    if (!matched) continue;
    if (!ts) continue;
    const t = new Date(ts);
    if (opts.since && t < opts.since) continue;
    if (opts.until && t > opts.until) continue;
    endedAt = ts;

    if (type === 'response_item') {
      const parsed = extractResponseItemText(rec.payload);
      if (!parsed) continue;
      if (parsed.tool) {
        turns.push({
          agent: 'codex',
          sessionId,
          repoPath: opts.repoPath,
          timestamp: ts,
          role: 'tool',
          toolCall: parsed.tool,
          raw: opts.verbose ? rec : undefined,
        });
      } else if (parsed.text !== undefined) {
        turns.push({
          agent: 'codex',
          sessionId,
          repoPath: opts.repoPath,
          timestamp: ts,
          role: parsed.role,
          kind: parsed.kind,
          text: parsed.text,
          raw: opts.verbose ? rec : undefined,
        });
      }
    }
  }

  if (!matched || turns.length === 0) return null;
  turns.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  return {
    agent: 'codex',
    sessionId,
    repoPath: opts.repoPath,
    startedAt: startedAt ?? turns[0].timestamp,
    endedAt: endedAt ?? turns[turns.length - 1].timestamp,
    turns,
  };
}

function walkRollouts(root: string, since?: Date, until?: Date): string[] {
  if (!existsSync(root)) return [];
  const results: string[] = [];
  // Structure: root/YYYY/MM/DD/rollout-*.jsonl
  const years = safeReaddir(root);
  for (const y of years) {
    if (!/^\d{4}$/.test(y)) continue;
    const yp = join(root, y);
    for (const m of safeReaddir(yp)) {
      if (!/^\d{2}$/.test(m)) continue;
      const mp = join(yp, m);
      for (const d of safeReaddir(mp)) {
        if (!/^\d{2}$/.test(d)) continue;
        const dateStr = `${y}-${m}-${d}`;
        if (since) {
          const dayEnd = new Date(`${dateStr}T23:59:59Z`);
          if (dayEnd < since) continue;
        }
        if (until) {
          const dayStart = new Date(`${dateStr}T00:00:00Z`);
          if (dayStart > until) continue;
        }
        const dp = join(mp, d);
        for (const f of safeReaddir(dp)) {
          if (f.startsWith('rollout-') && f.endsWith('.jsonl')) {
            results.push(join(dp, f));
          }
        }
      }
    }
  }
  return results;
}

function safeReaddir(p: string): string[] {
  try {
    return readdirSync(p);
  } catch {
    return [];
  }
}

export async function collectCodex(opts: CollectOptions): Promise<UnifiedSession[]> {
  const files = walkRollouts(CODEX_SESSIONS_DIR, opts.since, opts.until);
  const sessions: UnifiedSession[] = [];
  for (const f of files) {
    try {
      if (!statSync(f).isFile()) continue;
    } catch {
      continue;
    }
    const s = await readRolloutIfMatching(f, opts);
    if (s) sessions.push(s);
  }
  return sessions;
}
