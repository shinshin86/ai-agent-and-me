#!/usr/bin/env node
import { Command } from 'commander';
import { writeFileSync } from 'node:fs';
import { resolveRepoPath } from './core/path.js';
import { collectClaude } from './adapters/claude.js';
import { collectCodex } from './adapters/codex.js';
import { collectCopilot } from './adapters/copilot.js';
import { formatTimeline } from './formatters/timeline.js';
import { formatJson } from './formatters/json.js';
import { formatMarkdown } from './formatters/markdown.js';
import { resolveDateRange } from './core/daterange.js';
import type { AgentId, CollectOptions, UnifiedSession } from './core/types.js';

const program = new Command();

program
  .name('ai-agent-and-me')
  .description('Aggregate Claude Code / Codex / GitHub Copilot CLI session logs per repository')
  .argument('<project-dir>', 'target repository directory (absolute or relative)')
  .option('--agent <list>', 'comma-separated agents: claude,codex,copilot', 'claude,codex,copilot')
  .option('--role <list>', 'comma-separated roles: user,assistant,tool,system', 'user,assistant,tool,system')
  .option('--conversation-only', 'shortcut for --role user,assistant (hide tool/system turns)', false)
  .option('--first-prompt-only', 'show only the first user prompt in each session', false)
  .option('--since <value>', 'earliest timestamp (ISO8601 or YYYY-MM-DD, local TZ)')
  .option('--until <value>', 'latest timestamp (ISO8601 or YYYY-MM-DD, local TZ)')
  .option('--today', 'filter to today (local timezone)', false)
  .option('--yesterday', 'filter to yesterday (local timezone)', false)
  .option('--date <ymd>', 'filter to a single day (YYYY-MM-DD, local TZ)')
  .option('--last <span>', 'relative window, e.g. 24h, 7d, 2w')
  .option('--format <fmt>', 'output format: timeline|json|markdown', 'timeline')
  .option('--out <path>', 'write output to file instead of stdout')
  .option('--full', 'do not truncate message bodies in timeline output', false)
  .option('--width <n>', 'max characters per timeline line (ignored with --full)', '120')
  .option('--no-color', 'disable colored output')
  .option('-v, --verbose', 'verbose logging / include raw records', false)
  .action(async (projectDir: string, opts: any) => {
    const repoPath = resolveRepoPath(projectDir);
    const agents = (opts.agent as string).split(',').map((s) => s.trim()).filter(Boolean) as AgentId[];

    let since: Date | undefined;
    let until: Date | undefined;
    try {
      const r = resolveDateRange({
        today: opts.today,
        yesterday: opts.yesterday,
        date: opts.date,
        last: opts.last,
        since: opts.since,
        until: opts.until,
      });
      since = r.since;
      until = r.until;
    } catch (e) {
      console.error((e as Error).message);
      process.exit(2);
    }

    const collectOpts: CollectOptions = { repoPath, since, until, verbose: opts.verbose };

    if (opts.verbose) {
      console.error(`[ai-agent-and-me] repo: ${repoPath}`);
      console.error(`[ai-agent-and-me] agents: ${agents.join(',')}`);
      if (since || until) {
        console.error(`[ai-agent-and-me] range: ${since?.toISOString() ?? '-'} .. ${until?.toISOString() ?? '-'}`);
      }
    }

    const tasks: Promise<UnifiedSession[]>[] = [];
    if (agents.includes('claude')) tasks.push(collectClaude(collectOpts));
    if (agents.includes('codex')) tasks.push(collectCodex(collectOpts));
    if (agents.includes('copilot')) tasks.push(collectCopilot(collectOpts));

    const results = await Promise.all(tasks);
    let sessions = results.flat();

    const roleList = (opts.firstPromptOnly
      ? ['user']
      : opts.conversationOnly
      ? ['user', 'assistant']
      : (opts.role as string).split(',').map((s) => s.trim()).filter(Boolean)
    );
    const roleSet = new Set(roleList);
    const validRoles = new Set(['user', 'assistant', 'tool', 'system']);
    for (const r of roleSet) {
      if (!validRoles.has(r)) {
        console.error(`Invalid --role value: ${r}`);
        process.exit(2);
      }
    }

    sessions = sessions
      .map((s) => ({ ...s, turns: s.turns.filter((t) => roleSet.has(t.role)) }))
      .map((s) => {
        if (!opts.firstPromptOnly) return s;
        const firstUserTurn = s.turns.find((t) => t.role === 'user' && typeof t.text === 'string' && t.text.trim());
        return { ...s, turns: firstUserTurn ? [firstUserTurn] : [] };
      })
      .filter((s) => s.turns.length > 0);

    sessions.sort((a, b) => a.startedAt.localeCompare(b.startedAt));

    let output: string;
    switch (opts.format) {
      case 'json':
        output = formatJson(sessions);
        break;
      case 'markdown':
        output = formatMarkdown(sessions);
        break;
      case 'timeline':
      default:
        output = formatTimeline(sessions, {
          noColor: opts.color === false,
          full: opts.full,
          width: Number(opts.width) || 120,
        });
        break;
    }

    if (opts.out) {
      writeFileSync(opts.out, output);
      console.error(`[ai-agent-and-me] wrote ${opts.out}`);
    } else {
      process.stdout.write(output + '\n');
    }
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(err);
  process.exit(1);
});
