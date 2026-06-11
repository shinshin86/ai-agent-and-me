import type { UnifiedSession } from '../core/types.js';

export function formatJson(sessions: UnifiedSession[]): string {
  return JSON.stringify(sessions, null, 2);
}
