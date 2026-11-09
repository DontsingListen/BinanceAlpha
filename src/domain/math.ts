/** Numeric helpers with explicit failure instead of silent zero substitution. */

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Sample median: sorted middle value; even length averages the two middle values. */
export function median(values: readonly number[]): number {
  if (values.length === 0) throw new RangeError('median of empty sample');
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >>> 1;
  if (sorted.length % 2 === 1) return sorted[mid] as number;
  return ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

export function mean(values: readonly number[]): number {
  if (values.length === 0) throw new RangeError('mean of empty sample');
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

export function sum(values: readonly number[]): number {
  let s = 0;
  for (const v of values) s += v;
  return s;
}

export function max(values: readonly number[]): number {
  if (values.length === 0) throw new RangeError('max of empty sample');
  let m = -Infinity;
  for (const v of values) if (v > m) m = v;
  return m;
}

export function min(values: readonly number[]): number {
  if (values.length === 0) throw new RangeError('min of empty sample');
  let m = Infinity;
  for (const v of values) if (v < m) m = v;
  return m;
}

/** Returns null when the division is undefined or non-finite. */
export function safeDiv(numerator: number, denominator: number): number | null {
  if (denominator === 0) return null;
  const r = numerator / denominator;
  return Number.isFinite(r) ? r : null;
}
