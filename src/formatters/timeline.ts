import chalk from 'chalk';
import type { UnifiedSession, AgentId } from '../core/types.js';
import { mergeTurns } from '../core/merge.js';
import { formatModelSummary } from '../core/modelInfo.js';

const agentColor: Record<AgentId, (s: string) => string> = {
  claude: (s) => chalk.magenta(s),
  codex: (s) => chalk.cyan(s),
  copilot: (s) => chalk.yellow(s),
};

const roleColor: Record<string, (s: string) => string> = {
  user: (s) => chalk.green(s),
  assistant: (s) => chalk.white(s),
  tool: (s) => chalk.gray(s),
  system: (s) => chalk.dim(s),
};

function truncate(s: string, n: number, full: boolean): string {
  if (full) return s;
  const oneLine = s.replace(/\s+/g, ' ').trim();
  return oneLine.length > n ? oneLine.slice(0, n) + '…' : oneLine;
}

export function formatTimeline(
  sessions: UnifiedSession[],
  opts: { noColor?: boolean; width?: number; full?: boolean } = {}
): string {
  const useColor = !opts.noColor;
  const width = opts.width ?? 120;
  const full = opts.full ?? false;
  const turns = mergeTurns(sessions);
  const sessionByTurn = new Map<string, UnifiedSession>();
  for (const s of sessions) sessionByTurn.set(`${s.agent}\0${s.sessionId}`, s);

  const paint = (fn: (s: string) => string, s: string) => (useColor ? fn(s) : s);

  const lines: string[] = [];
  lines.push(
    `${sessions.length} sessions, ${turns.length} turns` +
      (sessions.length > 0 ? ` (${sessions[0].repoPath})` : '')
  );
  lines.push('');

  let currentSessionKey = '';
  for (const t of turns) {
    const sessionKey = `${t.agent}\0${t.sessionId}`;
    if (sessionKey !== currentSessionKey) {
      currentSessionKey = sessionKey;
      const session = sessionByTurn.get(sessionKey);
      if (session) {
        lines.push(
          paint(chalk.dim, `# ${session.agent} ${session.sessionId} — ${formatModelSummary(session.modelInfo)}`)
        );
      }
    }
    const ts = t.timestamp.slice(0, 19).replace('T', ' ');
    const agent = paint(agentColor[t.agent], t.agent.padEnd(7));
    const role = paint(roleColor[t.role] ?? ((s) => s), t.role.padEnd(9));
    let body: string;
    if (t.toolCall) {
      const name = t.toolCall.name;
      const detail = t.toolCall.input
        ? truncate(JSON.stringify(t.toolCall.input, null, full ? 2 : 0), width, full)
        : t.toolCall.output
        ? truncate(typeof t.toolCall.output === 'string' ? t.toolCall.output : JSON.stringify(t.toolCall.output, null, full ? 2 : 0), width, full)
        : '';
      body = paint(chalk.gray, `[${name}]${full ? '\n' : ' '}${detail}`);
    } else {
      body = truncate(t.text ?? '', width, full);
    }
    if (full) {
      lines.push(`${chalk.dim(ts)} ${agent} ${role}`);
      lines.push(body);
      lines.push('');
    } else {
      lines.push(`${chalk.dim(ts)} ${agent} ${role} ${body}`);
    }
  }

  return lines.join('\n');
}
