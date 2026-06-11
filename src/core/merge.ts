import type { UnifiedSession, UnifiedTurn } from './types.js';

export function mergeTurns(sessions: UnifiedSession[]): UnifiedTurn[] {
  const all: UnifiedTurn[] = [];
  for (const s of sessions) all.push(...s.turns);
  all.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  return all;
}
