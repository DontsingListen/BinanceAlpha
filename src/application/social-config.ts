import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DEFAULT_STOPLIST, normalizeXHandle } from '../domain/mentions.ts';
import { maxGapMs, parseSchedule, type PollCadence } from './social-schedule.ts';

export type SocialConfig = {
  readonly rootDir: string;
  readonly alertsJsonlPath: string;
  readonly x: {
    readonly enabled: boolean; readonly handles: readonly string[]; readonly labels: Readonly<Record<string, string>>;
    /** `schedule` (wall-clock times in a zone) when configured, else the `pollIntervalMs` interval. */
    readonly cadence: PollCadence; readonly retryDelayMs: number; readonly maxAttemptsPerSlot: number;
    /** Handles per x_search request and the pause between requests of one poll (bursts of searches fail on the live API). */
    readonly batchSize: number; readonly batchDelayMs: number;
    readonly model: string; readonly maxTurns: number; readonly maxOutputTokens: number;
    readonly dailyBudgetUsd: number; readonly perRequestBudgetUsd: number; readonly timeoutMs: number; readonly lookbackMs: number;
  };
  readonly telegram: { readonly enabled: boolean; readonly spoolDirectory: string; readonly pollIntervalMs: number };
  readonly mentions: { readonly stoplist: readonly string[] };
  readonly lease: { readonly ttlMs: number };
};

const DEFAULTS = {
  alertsJsonlPath: 'data/alerts.social.jsonl',
  x: { enabled: false, handles: [] as string[], labels: {} as Record<string, string>, schedule: null as unknown, pollIntervalMs: 60 * 60_000, retryDelayMs: 30 * 60_000, maxAttemptsPerSlot: 3, batchSize: 5, batchDelayMs: 120_000, model: 'grok-4.3', maxTurns: 2, maxOutputTokens: 6000, dailyBudgetUsd: 5, perRequestBudgetUsd: 1, timeoutMs: 120_000, lookbackMs: 3 * 60 * 60_000 },
  telegram: { enabled: false, spoolDirectory: '/var/lib/binance-alpha/telegram-inbox', pollIntervalMs: 5000 },
  mentions: { stoplist: [...DEFAULT_STOPLIST] },
  lease: { ttlMs: 120_000 },
};

export const XAI_HANDLE_LIMIT = 20;

/** Loads config/social.json over defaults. Handles are validated and normalized (no `@`); at most 20 per request (xAI limit). */
export function loadSocialConfig(rootDir: string, overrides: Partial<Record<string, string>> = {}): SocialConfig {
  let doc: Record<string, unknown> = {};
  try {
    doc = JSON.parse(readFileSync(resolve(rootDir, overrides['socialConfig'] ?? 'config/social.json'), 'utf8')) as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const x = { ...DEFAULTS.x, ...((doc['x'] as Record<string, unknown> | undefined) ?? {}) } as typeof DEFAULTS.x;
  const telegram = { ...DEFAULTS.telegram, ...((doc['telegram'] as Record<string, unknown> | undefined) ?? {}) } as typeof DEFAULTS.telegram;
  const mentions = { stoplist: (((doc['mentions'] as Record<string, unknown> | undefined)?.['stoplist'] as unknown[] | undefined) ?? []).filter((x): x is string => typeof x === 'string') };
  const lease = { ...DEFAULTS.lease, ...((doc['lease'] as Record<string, unknown> | undefined) ?? {}) } as typeof DEFAULTS.lease;
  const handles: string[] = [];
  const labels: Record<string, string> = {};
  for (const raw of x.handles) {
    const entry = typeof raw === 'string' ? { handle: raw, label: '' } : (raw as { handle: string; label?: string });
    const h = normalizeXHandle(entry.handle);
    if (!h) throw new Error(`social.x.handles: invalid X handle ${JSON.stringify(entry.handle)}`);
    if (!handles.some((k) => k.toLowerCase() === h.toLowerCase())) handles.push(h);
    if (entry.label) labels[h.toLowerCase()] = entry.label;
  }
  if (handles.length > XAI_HANDLE_LIMIT) throw new Error(`social.x.handles: ${handles.length} handles exceed the x_search limit of ${XAI_HANDLE_LIMIT} per request`);
  for (const [k, v] of Object.entries({ pollIntervalMs: x.pollIntervalMs, retryDelayMs: x.retryDelayMs, maxAttemptsPerSlot: x.maxAttemptsPerSlot, maxTurns: x.maxTurns, maxOutputTokens: x.maxOutputTokens, dailyBudgetUsd: x.dailyBudgetUsd, perRequestBudgetUsd: x.perRequestBudgetUsd, timeoutMs: x.timeoutMs, lookbackMs: x.lookbackMs })) {
    if (!(typeof v === 'number' && Number.isFinite(v) && v > 0)) throw new Error(`social.x.${k} must be a positive number`);
  }
  if (!Number.isInteger(x.maxAttemptsPerSlot) || x.maxAttemptsPerSlot > 10) throw new Error('social.x.maxAttemptsPerSlot must be an integer 1..10');
  if (!Number.isInteger(x.batchSize) || x.batchSize < 1 || x.batchSize > XAI_HANDLE_LIMIT) throw new Error(`social.x.batchSize must be an integer 1..${XAI_HANDLE_LIMIT}`);
  if (!(typeof x.batchDelayMs === 'number' && Number.isFinite(x.batchDelayMs) && x.batchDelayMs >= 0)) throw new Error('social.x.batchDelayMs must be a non-negative number');
  const cadence: PollCadence = x.schedule ? { kind: 'schedule', schedule: parseSchedule(x.schedule) } : { kind: 'interval', intervalMs: x.pollIntervalMs };
  if (cadence.kind === 'schedule' && x.lookbackMs < maxGapMs(cadence.schedule) + 5 * 60_000) {
    throw new Error(`social.x.lookbackMs (${x.lookbackMs}) must cover the longest gap between scheduled polls plus 5 min (${maxGapMs(cadence.schedule) + 5 * 60_000})`);
  }
  if (x.perRequestBudgetUsd > 10) throw new Error('social.x.perRequestBudgetUsd must be <= 10 USD (review threshold)');
  if (!/^[a-z0-9.-]{3,40}$/.test(x.model)) throw new Error('social.x.model is not a valid model id');
  if (x.enabled && handles.length === 0) throw new Error('social.x.enabled requires at least one handle');
  if (!(telegram.pollIntervalMs >= 1000)) throw new Error('social.telegram.pollIntervalMs must be >= 1000');
  return {
    rootDir,
    alertsJsonlPath: resolve(rootDir, String((doc['alertsJsonlPath'] as string | undefined) ?? DEFAULTS.alertsJsonlPath)),
    x: {
      enabled: x.enabled, handles, labels, cadence, retryDelayMs: x.retryDelayMs, maxAttemptsPerSlot: x.maxAttemptsPerSlot, batchSize: x.batchSize, batchDelayMs: x.batchDelayMs, model: x.model, maxTurns: x.maxTurns, maxOutputTokens: x.maxOutputTokens,
      dailyBudgetUsd: x.dailyBudgetUsd, perRequestBudgetUsd: x.perRequestBudgetUsd, timeoutMs: x.timeoutMs, lookbackMs: x.lookbackMs,
    },
    telegram: { ...telegram, spoolDirectory: resolve(rootDir, telegram.spoolDirectory) },
    mentions: { stoplist: [...new Set([...DEFAULT_STOPLIST, ...mentions.stoplist].map((s) => s.toUpperCase()))] },
    lease,
  };
}

const KEY_PATTERN = /^xai-[A-Za-z0-9]{40,200}$/;

/** The xAI key comes only from the environment (systemd EnvironmentFile in production); it is never stored or logged. */
export function xaiApiKeyFromEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  const key = env['XAI_API_KEY'];
  return typeof key === 'string' && KEY_PATTERN.test(key) ? key : null;
}
