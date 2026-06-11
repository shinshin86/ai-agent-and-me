export type AgentId = 'claude' | 'codex' | 'copilot';

export type Role = 'user' | 'assistant' | 'system' | 'tool';

export interface UnifiedTurn {
  agent: AgentId;
  sessionId: string;
  sessionTitle?: string;
  repoPath: string;
  timestamp: string; // ISO8601
  role: Role;
  // 'reasoning' marks assistant thinking/reasoning text (Claude thinking blocks,
  // Codex reasoning summaries). Absent for plain messages and tool turns.
  kind?: 'reasoning';
  text?: string;
  toolCall?: { name: string; input?: unknown; output?: unknown };
  raw?: unknown;
}

export interface UnifiedSession {
  agent: AgentId;
  sessionId: string;
  sessionTitle?: string;
  repoPath: string;
  startedAt: string;
  endedAt?: string;
  turns: UnifiedTurn[];
}

export interface CollectOptions {
  repoPath: string; // absolute, realpath-resolved
  since?: Date;
  until?: Date;
  verbose?: boolean;
}
