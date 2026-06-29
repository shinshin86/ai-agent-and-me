import type { SessionModelInfo } from './types.js';

export function addUniqueString(values: string[], value: unknown): void {
  if (typeof value !== 'string') return;
  const trimmed = value.trim();
  if (!trimmed || values.includes(trimmed)) return;
  values.push(trimmed);
}

export function normalizeModelName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  // Claude logs may include synthetic bookkeeping markers in message.model.
  // These are not actual model names and should not appear in badges/filters.
  if (!trimmed || trimmed === '<synthetic>') return undefined;
  return trimmed;
}

export function addUniqueModelName(values: string[], value: unknown): void {
  const model = normalizeModelName(value);
  if (!model || values.includes(model)) return;
  values.push(model);
}

export function formatModelSummary(info?: SessionModelInfo): string {
  if (!info) return 'モデル不明';

  const parts = [info.toolName];
  if (info.toolVersion) parts[0] += ` v${info.toolVersion}`;

  parts.push(info.models.length > 0 ? info.models.join(', ') : 'モデル不明');
  if (info.provider) parts.push(info.provider);
  if (info.details?.length) parts.push(info.details.join(', '));

  return parts.join(' · ');
}
