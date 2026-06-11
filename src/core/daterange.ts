// Date range helpers. All day boundaries are in the local timezone.

export interface DateRange {
  since?: Date;
  until?: Date;
}

function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function endOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(23, 59, 59, 999);
  return x;
}

function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

// Parse YYYY-MM-DD or YYYY/MM/DD as a local-timezone date.
function parseYMD(s: string): Date | null {
  const m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return isNaN(d.getTime()) ? null : d;
}

// Parse relative span like "7d", "24h", "2w", "30m".
function parseSpan(s: string): number | null {
  const m = s.trim().toLowerCase().match(/^(\d+)\s*(m|h|d|w)$/);
  if (!m) return null;
  const n = Number(m[1]);
  switch (m[2]) {
    case 'm': return n * 60 * 1000;
    case 'h': return n * 60 * 60 * 1000;
    case 'd': return n * 24 * 60 * 60 * 1000;
    case 'w': return n * 7 * 24 * 60 * 60 * 1000;
  }
  return null;
}

export interface DateRangeOptions {
  today?: boolean;
  yesterday?: boolean;
  date?: string;      // YYYY-MM-DD
  last?: string;      // 7d / 24h / 2w
  since?: string;     // ISO or YYYY-MM-DD
  until?: string;     // ISO or YYYY-MM-DD
}

export function resolveDateRange(opts: DateRangeOptions): DateRange {
  const now = new Date();
  const range: DateRange = {};

  if (opts.today) {
    range.since = startOfDay(now);
    range.until = endOfDay(now);
  } else if (opts.yesterday) {
    const y = addDays(now, -1);
    range.since = startOfDay(y);
    range.until = endOfDay(y);
  } else if (opts.date) {
    const d = parseYMD(opts.date);
    if (!d) throw new Error(`Invalid --date value: ${opts.date} (expected YYYY-MM-DD)`);
    range.since = startOfDay(d);
    range.until = endOfDay(d);
  } else if (opts.last) {
    const ms = parseSpan(opts.last);
    if (ms == null) throw new Error(`Invalid --last value: ${opts.last} (expected e.g. 7d, 24h, 2w)`);
    range.since = new Date(now.getTime() - ms);
    range.until = now;
  }

  // --since / --until override (fine-grained)
  if (opts.since) {
    const d = parseYMD(opts.since) ?? new Date(opts.since);
    if (isNaN(d.getTime())) throw new Error(`Invalid --since value: ${opts.since}`);
    range.since = parseYMD(opts.since) ? startOfDay(d) : d;
  }
  if (opts.until) {
    const d = parseYMD(opts.until) ?? new Date(opts.until);
    if (isNaN(d.getTime())) throw new Error(`Invalid --until value: ${opts.until}`);
    range.until = parseYMD(opts.until) ? endOfDay(d) : d;
  }

  return range;
}
