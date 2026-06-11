import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';

export function resolveRepoPath(input: string): string {
  const abs = resolve(input);
  try {
    return realpathSync(abs);
  } catch {
    return abs;
  }
}

// Claude Code encodes cwd by replacing `/` with `-`.
// e.g. /Users/a/b => -Users-a-b
export function encodeClaudeProjectDir(absPath: string): string {
  return absPath.replace(/\//g, '-');
}
