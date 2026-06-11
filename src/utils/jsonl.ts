import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

export async function* readJsonl(
  path: string,
  onError?: (err: unknown, line: string) => void
): AsyncGenerator<any> {
  const stream = createReadStream(path, { encoding: 'utf8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  for await (const raw of rl) {
    const line = raw.trim();
    if (!line) continue;
    try {
      yield JSON.parse(line);
    } catch (err) {
      onError?.(err, line);
    }
  }
}
