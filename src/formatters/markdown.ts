import type { UnifiedSession } from '../core/types.js';

export function formatMarkdown(sessions: UnifiedSession[]): string {
  const lines: string[] = [];
  const sorted = [...sessions].sort((a, b) => a.startedAt.localeCompare(b.startedAt));

  for (const s of sorted) {
    lines.push(`## [${s.agent}] ${s.sessionTitle ?? s.sessionId}`);
    lines.push(`- session: \`${s.sessionId}\``);
    lines.push(`- repo: \`${s.repoPath}\``);
    lines.push(`- started: ${s.startedAt}`);
    if (s.endedAt) lines.push(`- ended: ${s.endedAt}`);
    lines.push('');

    for (const t of s.turns) {
      const ts = t.timestamp.slice(0, 19).replace('T', ' ');
      if (t.toolCall) {
        const detail = t.toolCall.input
          ? '```json\n' + JSON.stringify(t.toolCall.input, null, 2) + '\n```'
          : t.toolCall.output
          ? '```\n' + (typeof t.toolCall.output === 'string' ? t.toolCall.output : JSON.stringify(t.toolCall.output, null, 2)) + '\n```'
          : '';
        lines.push(`### [${ts}] tool: ${t.toolCall.name}`);
        if (detail) lines.push(detail);
      } else {
        lines.push(`### [${ts}] ${t.role}`);
        lines.push('');
        lines.push(t.text ?? '');
      }
      lines.push('');
    }
    lines.push('---');
    lines.push('');
  }
  return lines.join('\n');
}
