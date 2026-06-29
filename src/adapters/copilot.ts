import { readdirSync, existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { CollectOptions, UnifiedSession, UnifiedTurn } from '../core/types.js';
import { addUniqueModelName } from '../core/modelInfo.js';
import { readJsonl } from '../utils/jsonl.js';

const COPILOT_SESSIONS_DIR = join(homedir(), '.copilot', 'session-state');

export async function collectCopilot(opts: CollectOptions): Promise<UnifiedSession[]> {
  if (!existsSync(COPILOT_SESSIONS_DIR)) return [];
  const sessionDirs = readdirSync(COPILOT_SESSIONS_DIR);
  const sessions: UnifiedSession[] = [];

  for (const sid of sessionDirs) {
    const eventsPath = join(COPILOT_SESSIONS_DIR, sid, 'events.jsonl');
    if (!existsSync(eventsPath)) continue;
    try {
      if (!statSync(eventsPath).isFile()) continue;
    } catch {
      continue;
    }

    let matched = false;
    let startedAt: string | undefined;
    let endedAt: string | undefined;
    let sessionTitle: string | undefined;
    let toolVersion: string | undefined;
    const models: string[] = [];
    const turns: UnifiedTurn[] = [];

    for await (const rec of readJsonl(eventsPath)) {
      const type = rec?.type;
      if (!type) continue;

      if (type === 'session.start') {
        const ctx = rec?.data?.context;
        const cwd: string | undefined = ctx?.cwd;
        if (cwd !== opts.repoPath) {
          break; // not our repo; skip rest of file
        }
        matched = true;
        startedAt = rec?.data?.startTime;
        sessionTitle = ctx?.repository ? `${ctx.repository}${ctx.branch ? '@' + ctx.branch : ''}` : undefined;
        if (typeof rec?.data?.copilotVersion === 'string') toolVersion = rec.data.copilotVersion;
        addUniqueModelName(models, rec?.data?.selectedModel);
        continue;
      }

      if (!matched) continue;

      const ts: string | undefined = rec.timestamp;
      if (ts) {
        endedAt = ts;
        const t = new Date(ts);
        if (opts.since && t < opts.since) continue;
        if (opts.until && t > opts.until) continue;
      }

      if (type === 'user.message') {
        const text = rec?.data?.content;
        if (typeof text === 'string') {
          turns.push({
            agent: 'copilot',
            sessionId: sid,
            sessionTitle,
            repoPath: opts.repoPath,
            timestamp: ts ?? startedAt ?? new Date().toISOString(),
            role: 'user',
            text,
            raw: opts.verbose ? rec : undefined,
          });
        }
      } else if (type === 'assistant.message') {
        const text = rec?.data?.content;
        if (typeof text === 'string') {
          turns.push({
            agent: 'copilot',
            sessionId: sid,
            sessionTitle,
            repoPath: opts.repoPath,
            timestamp: ts ?? startedAt ?? new Date().toISOString(),
            role: 'assistant',
            text,
            raw: opts.verbose ? rec : undefined,
          });
        }
        const toolReqs = rec?.data?.toolRequests;
        if (Array.isArray(toolReqs)) {
          for (const tr of toolReqs) {
            turns.push({
              agent: 'copilot',
              sessionId: sid,
              sessionTitle,
              repoPath: opts.repoPath,
              timestamp: ts ?? startedAt ?? new Date().toISOString(),
              role: 'tool',
              toolCall: { name: tr?.name ?? 'tool', input: tr?.arguments ?? tr?.input },
              raw: opts.verbose ? rec : undefined,
            });
          }
        }
      }
    }

    if (!matched || turns.length === 0) continue;
    turns.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    sessions.push({
      agent: 'copilot',
      sessionId: sid,
      sessionTitle,
      repoPath: opts.repoPath,
      startedAt: startedAt ?? turns[0].timestamp,
      endedAt: endedAt ?? turns[turns.length - 1].timestamp,
      modelInfo: {
        toolName: 'GitHub Copilot CLI',
        toolVersion,
        models,
      },
      turns,
    });
  }

  return sessions;
}
