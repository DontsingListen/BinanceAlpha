import { randomUUID } from 'node:crypto';
import type { Policy } from '../domain/policy.ts';
import type { Db } from '../storage/db.ts';
import { createRun, endRun, latestRun, reopenRun, type RunRow } from '../storage/repos.ts';
import { SCHEMA_VERSION } from '../storage/schema.ts';
import type { AppConfig } from './config.ts';
import { computeCodeHash } from './manifest.ts';

export type EnsuredRun = {
  run: RunRow;
  resumed: boolean;
  /** When a cleanly stopped run was reopened: the time it had been paused at; null for a new or still-open run. */
  reopenedFrom: number | null;
};

/**
 * The online run is resumed across restarts while policy, schema and code are unchanged: a run still marked `running`
 * (crash) is continued from its heads, and one stopped cleanly (`paused`) is reopened. Any other terminal status, or a
 * change in policy/schema/code, starts a new run; a previous run that was still open is then marked `superseded`.
 */
export function ensureOnlineRun(db: Db, cfg: AppConfig, policy: Policy, now: number): EnsuredRun {
  const codeHash = computeCodeHash(cfg.rootDir);
  const latest = latestRun(db, 'online');
  const open = latest !== null && (latest.endedAt === null || latest.status === 'paused');
  const unchanged = latest !== null && latest.policyHash === policy.policyHash && latest.schemaVersion === SCHEMA_VERSION && latest.codeHash === codeHash;
  if (latest && open && unchanged) {
    if (latest.endedAt === null) return { run: latest, resumed: true, reopenedFrom: null };
    reopenRun(db, latest.runId);
    return { run: { ...latest, endedAt: null, status: 'running' }, resumed: true, reopenedFrom: latest.endedAt };
  }
  if (latest && open) endRun(db, latest.runId, 'superseded', now);
  const run: RunRow = {
    runId: `online-${new Date(now).toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`, mode: 'online', startedAt: now, endedAt: null, status: 'running',
    policyVersion: policy.policyVersion, policyHash: policy.policyHash, schemaVersion: SCHEMA_VERSION, codeHash,
    config: { quoteAsset: cfg.quoteAsset, intervalMs: cfg.intervalMs, selection: cfg.selection, collection: cfg.collection, previousRun: latest?.runId ?? null },
  };
  createRun(db, run);
  return { run, resumed: false, reopenedFrom: null };
}

export function newSimulationRun(db: Db, cfg: AppConfig, policy: Policy, now: number, extra: Record<string, unknown>): RunRow {
  const run: RunRow = {
    runId: `sim-${new Date(now).toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`, mode: 'historical-simulation', startedAt: now, endedAt: null, status: 'running',
    policyVersion: policy.policyVersion, policyHash: policy.policyHash, schemaVersion: SCHEMA_VERSION, codeHash: computeCodeHash(cfg.rootDir),
    config: { quoteAsset: cfg.quoteAsset, intervalMs: cfg.intervalMs, universe: 'CURRENT_UNIVERSE_RETROSPECTIVE', ...extra },
  };
  createRun(db, run);
  return run;
}
