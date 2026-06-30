import type { ApiResult } from '../core/sessionApi.js';
import { truncatePayload } from '../core/sessionApi.js';

export type ToolOutputMode = 'preview' | 'full' | 'none';

interface AgentJsonTurn {
  timestamp: string;
  role: 'user' | 'assistant';
  text: string;
}

interface AgentJsonToolCall {
  timestamp: string;
  name: string;
  input?: unknown;
  outputPreview?: unknown;
  exitCode: number | null;
}

function firstPrompt(turns: AgentJsonTurn[]): string | null {
  return turns.find((turn) => turn.role === 'user' && turn.text.trim())?.text ?? null;
}

function exitCodeFromOutput(output: unknown): number | null {
  const text = typeof output === 'string' ? output : output === undefined ? '' : JSON.stringify(output);
  const match = text.match(/Process exited with code (\d+)/);
  return match ? Number(match[1]) : null;
}

function toolOutputValue(output: unknown, mode: ToolOutputMode): unknown {
  if (mode === 'none') return undefined;
  if (mode === 'full') return output;
  return truncatePayload(output);
}

export function formatAgentJson(
  result: ApiResult,
  opts: { toolNames?: string[]; toolOutput?: ToolOutputMode } = {}
): string {
  const toolNames = new Set(opts.toolNames ?? []);
  const toolOutput = opts.toolOutput ?? 'preview';

  const projects = result.projects.map((project) => ({
    name: project.project.name,
    path: project.project.path,
    sessions: project.sessions.map((session) => {
      const conversation: AgentJsonTurn[] = session.turns
        .filter((turn) => (turn.role === 'user' || turn.role === 'assistant') && typeof turn.text === 'string')
        .map((turn) => ({
          timestamp: turn.timestamp,
          role: turn.role as 'user' | 'assistant',
          text: turn.text ?? '',
        }));

      const toolCalls: AgentJsonToolCall[] = session.turns
        .filter((turn) => turn.toolCall && (toolNames.size === 0 || toolNames.has(turn.toolCall.name)))
        .map((turn) => {
          const output = turn.toolCall?.output;
          const formatted: AgentJsonToolCall = {
            timestamp: turn.timestamp,
            name: turn.toolCall?.name ?? 'tool',
            input: turn.toolCall?.input,
            exitCode: exitCodeFromOutput(output),
          };
          const outputPreview = toolOutputValue(output, toolOutput);
          if (outputPreview !== undefined) formatted.outputPreview = outputPreview;
          return formatted;
        });

      return {
        agent: session.agent,
        sessionId: session.sessionId,
        startedAt: session.startedAt,
        endedAt: session.endedAt ?? null,
        modelInfo: {
          toolName: session.modelInfo?.toolName ?? session.agent,
          models: session.modelInfo?.models ?? [],
        },
        firstPrompt: firstPrompt(conversation),
        conversation,
        toolCalls,
      };
    }),
  }));

  return JSON.stringify(
    {
      filters: result.filters,
      summary: {
        projects: projects.length,
        sessions: projects.reduce((n, project) => n + project.sessions.length, 0),
        turns: projects.reduce((n, project) => n + project.sessions.reduce((m, session) => m + session.conversation.length, 0), 0),
        toolCalls: projects.reduce((n, project) => n + project.sessions.reduce((m, session) => m + session.toolCalls.length, 0), 0),
      },
      projects,
    },
    null,
    2
  );
}
