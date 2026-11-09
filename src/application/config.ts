import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parsePolicy, type Policy } from '../domain/policy.ts';

export type AppConfig = {
  readonly rootDir: string;
  readonly dbPath: string;
  readonly policyPath: string;
  readonly alertsJsonlPath: string;
  readonly provider: string;
  readonly marketType: string;
  readonly baseUrl: string;
  readonly quoteAsset: string;
  readonly interval: string;
  readonly intervalMs: number;
  readonly selection: { readonly maxInstruments: number; readonly orderBy: 'token_volume24h_desc' | 'instrument_id_asc'; readonly pinned: readonly string[]; readonly only: readonly string[]; readonly socialPinHours: number; readonly socialMaxPinned: number };
  readonly collection: { readonly backfillDays: number; readonly closedMarginMs: number; readonly fetchDelayAfterCloseMs: number; readonly overlapBars: number; readonly backfillPagesPerCycle: number; readonly maxClockOffsetMs: number };
  readonly http: { readonly ratePerSec: number; readonly maxConcurrent: number; readonly timeoutMs: number; readonly maxRetries: number };
  readonly watch: { readonly universeRefreshMs: number; readonly leaseTtlMs: number };
  readonly simulation: { readonly availabilityDelayMs: number };
};

const DEFAULTS = {
  dbPath: 'data/alpha.sqlite',
  policyPath: 'spec/policy-v0.proposed.json',
  alertsJsonlPath: 'data/alerts.jsonl',
  provider: 'binance-alpha',
  marketType: 'alpha',
  baseUrl: 'https://www.binance.com',
  quoteAsset: 'USDT',
  interval: '5m',
  intervalMs: 300_000,
  selection: { maxInstruments: 50, orderBy: 'token_volume24h_desc', pinned: [], only: [], socialPinHours: 24, socialMaxPinned: 20 },
  collection: { backfillDays: 7, closedMarginMs: 3000, fetchDelayAfterCloseMs: 8000, overlapBars: 2, backfillPagesPerCycle: 60, maxClockOffsetMs: 10_000 },
  http: { ratePerSec: 1, maxConcurrent: 2, timeoutMs: 10_000, maxRetries: 2 },
  watch: { universeRefreshMs: 30 * 60_000, leaseTtlMs: 120_000 },
  simulation: { availabilityDelayMs: 8000 },
} as const;

type Overrides = Partial<Record<string, string>>;

/** Loads config/app.json (if present) merged over defaults, then applies CLI overrides. Paths resolve from rootDir. */
export function loadConfig(rootDir: string, overrides: Overrides = {}): AppConfig {
  let fileDoc: Record<string, unknown> = {};
  try {
    fileDoc = JSON.parse(readFileSync(resolve(rootDir, 'config/app.json'), 'utf8')) as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const merged = deepMerge(DEFAULTS as unknown as Record<string, unknown>, fileDoc) as unknown as AppConfig;
  const selection = { ...merged.selection };
  const collection = { ...merged.collection };
  if (overrides['maxInstruments']) selection.maxInstruments = Number(overrides['maxInstruments']);
  if (overrides['instruments']) selection.only = overrides['instruments'].split(',').map((s) => s.trim()).filter(Boolean);
  if (overrides['backfillDays']) collection.backfillDays = Number(overrides['backfillDays']);
  const cfg: AppConfig = {
    ...merged,
    rootDir,
    dbPath: resolve(rootDir, overrides['db'] ?? merged.dbPath),
    policyPath: resolve(rootDir, overrides['policy'] ?? merged.policyPath),
    alertsJsonlPath: resolve(rootDir, merged.alertsJsonlPath),
    selection,
    collection,
  };
  if (!(cfg.selection.maxInstruments > 0)) throw new Error('selection.maxInstruments must be > 0');
  if (!(cfg.intervalMs > 0)) throw new Error('intervalMs must be > 0');
  return cfg;
}

export function loadPolicy(cfg: AppConfig): Policy {
  const doc = JSON.parse(readFileSync(cfg.policyPath, 'utf8')) as unknown;
  const policy = parsePolicy(doc);
  if (policy.timeframeMs !== cfg.intervalMs) throw new Error(`policy timeframeMs ${policy.timeframeMs} != config intervalMs ${cfg.intervalMs}`);
  if (policy.quoteAsset !== cfg.quoteAsset) throw new Error(`policy quoteAsset ${policy.quoteAsset} != config quoteAsset ${cfg.quoteAsset}`);
  return policy;
}

function deepMerge(base: Record<string, unknown>, over: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) {
    const b = base[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && b && typeof b === 'object' && !Array.isArray(b)) {
      out[k] = deepMerge(b as Record<string, unknown>, v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out;
}
