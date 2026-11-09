/**
 * Online loop: discover (every universeRefreshMs) -> collect each selected instrument -> advance its runner -> alerts.
 * Single writer via a database lease; one cycle per 5m close (+ fetchDelayAfterCloseMs). `once` runs a single cycle.
 */
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { AlphaClient } from '../adapters/binance-alpha/client.ts';
import { sleep } from '../adapters/binance-alpha/http.ts';
import type { Policy } from '../domain/policy.ts';
import type { Db } from '../storage/db.ts';
import { acquireLease, endRun, fetchStatsSince, getInstruments, latestUniverseSnapshot, releaseLease, type InstrumentRow, type RunRow } from '../storage/repos.ts';
import type { AlertDispatcher } from './alerts.ts';
import { collectInstrument, type CollectSummary } from './collect.ts';
import type { AppConfig } from './config.ts';
import { InstrumentRunner, type AdvanceSummary } from './engine.ts';
import { ensureOnlineRun } from './runs.ts';
import { socialContextFor } from './social.ts';
import { discoverUniverse } from './universe.ts';

export class WriterBusyError extends Error {}

export type CycleReport = {
  startedAt: number;
  durationMs: number;
  instruments: number;
  collected: CollectSummary[];
  advanced: AdvanceSummary[];
  newBars: number;
  events: number;
  alerts: number;
  fetch: ReturnType<typeof fetchStatsSince>;
  pause: { until: number; reason: string | null };
};

export type WatchOptions = { once: boolean; skipDiscovery?: boolean; log: (line: string) => void };

export async function watch(db: Db, cfg: AppConfig, policy: Policy, client: AlphaClient, dispatcher: AlertDispatcher, opts: WatchOptions): Promise<void> {
  const owner = `${hostname()}#${process.pid}#${randomUUID().slice(0, 8)}`;
  const now0 = Date.now();
  if (!acquireLease(db, 'writer', owner, cfg.watch.leaseTtlMs, now0)) throw new WriterBusyError('another writer holds the lease; refusing to start a second scanner');
  const { run, resumed, reopenedFrom } = ensureOnlineRun(db, cfg, policy, now0);
  const how = !resumed ? 'new' : reopenedFrom === null ? 'resumed' : `resumed after ${Math.round((now0 - reopenedFrom) / 60_000)} min pause`;
  opts.log(`[watch] run ${run.runId} (${how}) policy=${policy.policyVersion} hash=${policy.policyHash.slice(0, 12)} writer=${owner}`);
  const runners = new Map<string, InstrumentRunner>();
  let stopping = false;
  const onSignal = () => { stopping = true; opts.log('[watch] stop requested; finishing current cycle'); };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  try {
    while (!stopping) {
      const now = Date.now();
      acquireLease(db, 'writer', owner, cfg.watch.leaseTtlMs, now);
      const selected = await ensureUniverse(db, client, cfg, now, opts);
      const report = await runCycle(db, cfg, policy, client, dispatcher, run, selected, runners, now);
      logCycle(report, opts.log);
      if (opts.once) break;
      const nextClose = Math.ceil(Date.now() / cfg.intervalMs) * cfg.intervalMs;
      const wakeAt = nextClose + cfg.collection.fetchDelayAfterCloseMs;
      opts.log(`[watch] next cycle at ${new Date(wakeAt).toISOString()}`);
      while (!stopping && Date.now() < wakeAt) {
        await sleep(Math.min(5000, Math.max(0, wakeAt - Date.now())));
        acquireLease(db, 'writer', owner, cfg.watch.leaseTtlMs, Date.now());
      }
    }
  } finally {
    if (!opts.once) endRun(db, run.runId, 'paused', Date.now());
    releaseLease(db, 'writer', owner);
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
}

async function ensureUniverse(db: Db, client: AlphaClient, cfg: AppConfig, now: number, opts: WatchOptions): Promise<InstrumentRow[]> {
  const snap = latestUniverseSnapshot(db);
  const fresh = snap !== null && now - snap.observedAt < cfg.watch.universeRefreshMs;
  if ((fresh || opts.skipDiscovery) && snap) return getInstruments(db, snap.members.selected);
  const d = await discoverUniverse(db, client, cfg, now);
  opts.log(`[discover] snapshot ${d.snapshotId} tokens=${d.counts.tokens} symbols=${d.counts.symbols} ${cfg.quoteAsset}=${d.counts.quoteSymbols} eligible=${d.counts.eligible} selected=${d.counts.selected} new=${d.counts.newInstruments} identityChanges=${d.counts.identityChanges} conflicts=${d.counts.conflicts} socialPinned=${d.counts.socialPinned}`);
  return d.selected;
}

export async function runCycle(db: Db, cfg: AppConfig, policy: Policy, client: AlphaClient, dispatcher: AlertDispatcher, run: RunRow, selected: InstrumentRow[], runners: Map<string, InstrumentRunner>, now: number): Promise<CycleReport> {
  const startedAt = Date.now();
  const budget = { backfillPages: cfg.collection.backfillPagesPerCycle };
  const collected: CollectSummary[] = [];
  const advanced: AdvanceSummary[] = [];
  // Collection is I/O bound: run with the client's concurrency; engine steps are serialized by the single writer.
  const queue = [...selected];
  const workers = Array.from({ length: cfg.http.maxConcurrent }, async () => {
    for (let inst = queue.shift(); inst; inst = queue.shift()) {
      try {
        collected.push(await collectInstrument(db, client, cfg, inst, Date.now(), budget));
      } catch (error) {
        collected.push({ instrumentId: inst.instrumentId, symbol: inst.symbol, outcome: 'failed', newClosedBars: 0, revisedBars: 0, rejectedRows: 0, pagesFetched: 0, latestClosedOpenAt: null, earliestOpenAt: null, backfillDone: false, notes: [`exception: ${(error as Error).message}`] });
      }
    }
  });
  await Promise.all(workers);
  for (const inst of selected) {
    let runner = runners.get(inst.instrumentId);
    if (!runner) {
      runner = new InstrumentRunner({ db, policy, runId: run.runId, mode: 'online', instrument: inst, intervalMs: cfg.intervalMs, dispatcher, clock: () => Date.now(), socialContext: socialContextFor(db) });
      runners.set(inst.instrumentId, runner);
    }
    advanced.push(await runner.advance());
  }
  return {
    startedAt, durationMs: Date.now() - startedAt, instruments: selected.length, collected, advanced,
    newBars: collected.reduce((n, c) => n + c.newClosedBars, 0), events: advanced.reduce((n, a) => n + a.events.length, 0), alerts: advanced.reduce((n, a) => n + a.alerts.length, 0),
    fetch: fetchStatsSince(db, now), pause: client.pauseState,
  };
}

function logCycle(r: CycleReport, log: (line: string) => void): void {
  const outcomes: Record<string, number> = {};
  for (const c of r.collected) outcomes[c.outcome] = (outcomes[c.outcome] ?? 0) + 1;
  const phases: Record<string, number> = {};
  for (const a of r.advanced) phases[a.phase] = (phases[a.phase] ?? 0) + 1;
  log(`[cycle] ${new Date(r.startedAt).toISOString()} ${r.durationMs}ms instruments=${r.instruments} newBars=${r.newBars} events=${r.events} alerts=${r.alerts} collect=${JSON.stringify(outcomes)} phases=${JSON.stringify(phases)} fetch=${r.fetch.total}req ok=${r.fetch.ok} p95=${r.fetch.p95LatencyMs ?? '-'}ms${r.pause.reason ? ` PAUSED(${r.pause.reason})` : ''}`);
  for (const c of r.collected) {
    if (c.outcome !== 'ok' || c.revisedBars > 0 || c.rejectedRows > 0) log(`[collect] ${c.symbol} ${c.outcome} new=${c.newClosedBars} revised=${c.revisedBars} rejected=${c.rejectedRows} ${c.notes.slice(0, 2).join('; ')}`);
  }
  for (const a of r.advanced) {
    const codes = a.events.filter((e) => e.kind !== 'DATA_QUALITY' && e.code !== 'WARMUP_COMPLETE').map((e) => e.code);
    if (codes.length || a.gaps || a.revisions) log(`[engine] ${a.instrumentId} processed=${a.processed} gaps=${a.gaps} revisions=${a.revisions} phase=${a.phase} events=${codes.join(',') || '-'}`);
  }
}
