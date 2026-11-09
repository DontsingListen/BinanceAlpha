import { createHash } from 'node:crypto';

/** Deterministic SHA-256 hex of the given parts joined with a separator. */
export function sha256Hex(...parts: readonly (string | number | null | undefined)[]): string {
  const h = createHash('sha256');
  for (const p of parts) {
    h.update(p === null || p === undefined ? '\u0000' : String(p));
    h.update('|');
  }
  return h.digest('hex');
}

export function sha256OfText(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Stable JSON with sorted object keys, for hashing policies/configs. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}
