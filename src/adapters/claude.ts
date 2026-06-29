import { readdirSync, existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { encodeClaudeProjectDir } from '../core/path.js';
import type { CollectOptions, UnifiedSession, UnifiedTurn } from '../core/types.js';
import { addUniqueModelName } from '../core/modelInfo.js';
import { readJsonl } from '../utils/jsonl.js';

const CLAUDE_PROJECTS_DIR = join(homedir(), '.claude', 'projects');

// Harness-injected user records (slash command transcripts, shell passthrough,
// reminders) that are not part of the actual conversation.
const NOISE_PREFIXES = [
  '<command-name>',
  '<command-message>',
  '<local-command',
  '<bash-input>',
  '<bash-stdout>',
  '<bash-stderr>',
  '<system-reminder>',
  '<task-notification>',
  'Caveat: The messages below',
  '[Request interrupted',
];

function isNoiseText(text: string): boolean {
  const trimmed = text.trimStart();
  return NOISE_PREFIXES.some((p) => trimmed.startsWith(p));
}

function extractText(content: unknown): string | undefined {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const part of content) {
      if (typeof part === 'string') parts.push(part);
      else if (part && typeof part === 'object') {
        const p: any = part;
        if (typeof p.text === 'string') parts.push(p.text);
      }
    }
    return parts.join('\n') || undefined;
  }
  return undefined;
}

export async function collectClaude(opts: CollectOptions): Promise<UnifiedSession[]> {
  const encoded = encodeClaudeProjectDir(opts.repoPath);
  const dir = join(CLAUDE_PROJECTS_DIR, encoded);
  if (!existsSync(dir)) return [];

  const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  const sessions: UnifiedSession[] = [];

  for (const file of files) {
    const full = join(dir, file);
    try {
      if (!statSync(full).isFile()) continue;
    } catch {
      continue;
    }
    const sessionId = file.replace(/\.jsonl$/, '');
    const turns: UnifiedTurn[] = [];
    let sessionTitle: string | undefined;
    let toolVersion: string | undefined;
    const models: string[] = [];

    for await (const rec of readJsonl(full)) {
      const type = rec?.type;
      if (!type) continue;
      if (type === 'ai-title' && typeof rec.aiTitle === 'string') {
        sessionTitle = rec.aiTitle;
        continue;
      }
      // Skip non-conversational bookkeeping
      if (type !== 'user' && type !== 'assistant') continue;
      // Skip harness-generated records and subagent (sidechain) traffic
      if (rec.isMeta || rec.isSidechain) continue;
      const ts: string | undefined = rec.timestamp;
      if (!ts) continue;
      const t = new Date(ts);
      if (opts.since && t < opts.since) continue;
      if (opts.until && t > opts.until) continue;

      const msg = rec.message;
      const role = (msg?.role ?? type) as 'user' | 'assistant';
      const content = msg?.content;
      if (role === 'assistant') {
        addUniqueModelName(models, msg?.model);
        if (typeof rec.version === 'string') toolVersion = rec.version;
      }

      if (Array.isArray(content)) {
        for (const part of content) {
          if (!part || typeof part !== 'object') continue;
          if (part.type === 'tool_use') {
            turns.push({
              agent: 'claude',
              sessionId,
              repoPath: opts.repoPath,
              timestamp: ts,
              role: 'tool',
              toolCall: { name: part.name, input: part.input },
              raw: opts.verbose ? rec : undefined,
            });
            continue;
          }
          if (part.type === 'tool_result') {
            turns.push({
              agent: 'claude',
              sessionId,
              repoPath: opts.repoPath,
              timestamp: ts,
              role: 'tool',
              toolCall: { name: 'tool_result', output: part.content },
              raw: opts.verbose ? rec : undefined,
            });
            continue;
          }
          if (part.type === 'thinking' && typeof part.thinking === 'string' && part.thinking.trim()) {
            turns.push({
              agent: 'claude',
              sessionId,
              repoPath: opts.repoPath,
              timestamp: ts,
              role: 'assistant',
              kind: 'reasoning',
              text: part.thinking,
              raw: opts.verbose ? rec : undefined,
            });
            continue;
          }
          if (part.type === 'text' && typeof part.text === 'string') {
            if (isNoiseText(part.text)) continue;
            turns.push({
              agent: 'claude',
              sessionId,
              repoPath: opts.repoPath,
              timestamp: ts,
              role,
              text: part.text,
              raw: opts.verbose ? rec : undefined,
            });
            continue;
          }
        }
      } else {
        const text = extractText(content);
        if (text !== undefined && !isNoiseText(text)) {
          turns.push({
            agent: 'claude',
            sessionId,
            repoPath: opts.repoPath,
            timestamp: ts,
            role,
            text,
            raw: opts.verbose ? rec : undefined,
          });
        }
      }
    }

    if (turns.length === 0) continue;
    turns.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    sessions.push({
      agent: 'claude',
      sessionId,
      sessionTitle,
      repoPath: opts.repoPath,
      startedAt: turns[0].timestamp,
      endedAt: turns[turns.length - 1].timestamp,
      modelInfo: {
        toolName: 'Claude Code',
        toolVersion,
        models,
      },
      turns,
    });
  }

  return sessions;
}
