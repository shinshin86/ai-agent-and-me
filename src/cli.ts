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
import { formatAgentJson, type ToolOutputMode } from './formatters/agentJson.js';
import { resolveDateRange } from './core/daterange.js';
import { buildApiResult, parseAgents, parseRoleList } from './core/sessionApi.js';
import type { CollectOptions, UnifiedSession } from './core/types.js';

const program = new Command();
const VALID_FORMATS = new Set(['timeline', 'json', 'markdown', 'api-json', 'agent-json']);
const VALID_TOOL_OUTPUT = new Set<ToolOutputMode>(['preview', 'full', 'none']);

function collectRepeated(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function splitRepeated(values: string[] | undefined): string[] {
  return [...new Set((values ?? []).flatMap((value) => value.split(',')).map((s) => s.trim()).filter(Boolean))];
}

function validateRoles(value: string): void {
  const validRoles = new Set(['user', 'assistant', 'tool', 'system']);
  for (const role of value.split(',').map((s) => s.trim()).filter(Boolean)) {
    if (!validRoles.has(role)) {
      console.error(`Invalid --role value: ${role}`);
      process.exit(2);
    }
  }
}

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
  .option('--format <fmt>', 'output format: timeline|json(legacy)|markdown|api-json|agent-json; prefer api-json/agent-json for machine-readable output', 'timeline')
  .option('--query <text>', 'full-text search query for api-json/agent-json')
  .option('--model <name>', 'model filter for api-json/agent-json (repeatable)', collectRepeated, [])
  .option('--tool-name <name>', 'tool call name filter for api-json/agent-json (repeatable)', collectRepeated, [])
  .option('--no-reasoning', 'exclude AI reasoning turns from api-json/agent-json')
  .option('--tool-output <mode>', 'tool output for agent-json: preview|full|none', 'preview')
  .option('--out <path>', 'write output to file instead of stdout')
  .option('--full', 'do not truncate message bodies in timeline output', false)
  .option('--width <n>', 'max characters per timeline line (ignored with --full)', '120')
  .option('--no-color', 'disable colored output')
  .option('-v, --verbose', 'verbose logging / include raw records', false)
  .action(async (projectDir: string, opts: any) => {
    const repoPath = resolveRepoPath(projectDir);
    const format = opts.format as string;
    if (!VALID_FORMATS.has(format)) {
      console.error(`Invalid --format value: ${format}`);
      process.exit(2);
    }
    if (!VALID_TOOL_OUTPUT.has(opts.toolOutput as ToolOutputMode)) {
      console.error(`Invalid --tool-output value: ${opts.toolOutput}`);
      process.exit(2);
    }

    const agents = parseAgents(opts.agent);

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

    const roles = opts.firstPromptOnly
      ? (['user'] as const)
      : opts.conversationOnly
      ? (['user', 'assistant'] as const)
      : parseRoleList(opts.role);
    validateRoles(opts.role);
    const models = splitRepeated(opts.model);
    const toolNames = splitRepeated(opts.toolName);
    const query = opts.query ?? '';

    if (format === 'api-json' || format === 'agent-json') {
      const result = await buildApiResult([repoPath], {
        agents,
        roles: [...roles],
        models,
        toolNames,
        includeReasoning: opts.reasoning,
        firstPromptOnly: opts.firstPromptOnly,
        query,
        since,
        until,
        verbose: opts.verbose,
        truncateToolPayloads: format === 'api-json',
      });
      const output = format === 'api-json'
        ? JSON.stringify(result, null, 2)
        : formatAgentJson(result, {
            toolNames,
            toolOutput: opts.toolOutput,
          });

      if (opts.out) {
        writeFileSync(opts.out, output);
        console.error(`[ai-agent-and-me] wrote ${opts.out}`);
      } else {
        process.stdout.write(output + '\n');
      }
      return;
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
      : parseRoleList(opts.role)
    );
    const roleSet = new Set(roleList);

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
    switch (format) {
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
