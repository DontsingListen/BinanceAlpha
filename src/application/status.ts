import type { Db } from '../storage/db.ts';
import { candleCoverage, eventCountsByCode, fetchStatsSince, getInstruments, latestRun, latestUniverseSnapshot, listAlerts, listCursors, listEvents, listHeads, runStats } from '../storage/repos.ts';
import type { AppConfig } from './config.ts';
import { printSocialStatus } from './social-status.ts';

const iso = (ms: number | null | undefined): string => (ms === null || ms === undefined ? '-' : new Date(ms).toISOString().slice(0, 16).replace('T', ' '));

export function printStatus(db: Db, cfg: AppConfig, log: (line: string) => void, now: number = Date.now(), social: { spoolDirectory: string } | null = null): void {
  const snap = latestUniverseSnapshot(db);
  log('== universe ==');
  if (!snap) log('no snapshot yet (run discover)');
  else {
    const reasons: Record<string, number> = {};
    for (const e of snap.members.excluded) reasons[e.reason] = (reasons[e.reason] ?? 0) + 1;
    log(`snapshot ${snap.snapshotId} at ${iso(snap.observedAt)} tokens=${snap.tokenCount} symbols=${snap.symbolCount} eligible=${snap.eligibleCount} selected=${snap.selectedCount} policy=${snap.selectionPolicyHash.slice(0, 12)}`);
    log(`excluded: ${JSON.stringify(reasons)}`);
  }
  const run = latestRun(db, 'online');
  log('== online run ==');
  if (!run) log('no online run yet');
  else {
    log(`run ${run.runId} status=${run.status} started=${iso(run.startedAt)} policy=${run.policyVersion} code=${run.codeHash.slice(0, 12)}`);
    log(`events by code: ${JSON.stringify(eventCountsByCode(db, run.runId))}`);
    log(`exclusion diagnostics: ${JSON.stringify(runStats(db, run.runId))}`);
  }
  const fetch = fetchStatsSince(db, now - 3_600_000);
  log(`== fetch (last 1h) == total=${fetch.total} ok=${fetch.ok} p95=${fetch.p95LatencyMs ?? '-'}ms outcomes=${JSON.stringify(fetch.byOutcome)}`);
  log('== instruments ==');
  const cursors = listCursors(db);
  const heads = run ? new Map(listHeads(db, run.runId).map((h) => [h.instrumentId, h])) : new Map();
  const ids = snap ? snap.members.selected : cursors.map((c) => c.instrumentId);
  const instruments = getInstruments(db, ids);
  log('symbol           name       bars  earliest          latest            stale  backfill  phase        lastEvent');
  for (const inst of instruments) {
    const cov = candleCoverage(db, inst.instrumentId, cfg.intervalMs);
    const cur = cursors.find((c) => c.instrumentId === inst.instrumentId);
    const head = heads.get(inst.instrumentId);
    const stale = cov.latestOpenAt !== null && now - (cov.latestOpenAt + cfg.intervalMs) > 3 * cfg.intervalMs ? 'STALE' : '';
    const last = listEvents(db, { ...(run ? { runId: run.runId } : {}), instrumentId: inst.instrumentId, limit: 1, newest: true })[0];
    const lastEv = last ? `${last.code}@${iso(last.decisionBarCloseAt)}` : '-';
    log(`${inst.symbol.padEnd(16)} ${inst.displaySymbol.slice(0, 10).padEnd(10)} ${String(cov.bars).padStart(5)} ${iso(cov.earliestOpenAt).padEnd(17)} ${iso(cov.latestOpenAt).padEnd(17)} ${stale.padEnd(6)} ${(cur ? (cur.backfillDone ? 'done' : cur.pausedReason ? 'paused' : 'pending') : '-').padEnd(9)} ${(head?.phase ?? '-').padEnd(12)} ${lastEv}`);
  }
  const alerts = listAlerts(db, { limit: 10 });
  printSocialStatus(db, log, now, social?.spoolDirectory ?? null);
  log(`== last ${alerts.length} alerts ==`);
  for (const a of alerts) {
    const p = a.payload as { displaySymbol?: string; symbol?: string; mode?: string };
    log(`${iso(a.createdAt)} [${a.level}${a.isFresh ? '' : ' LATE'}] ${p.displaySymbol ?? ''} ${p.symbol ?? a.instrumentId} ${a.code} (${p.mode ?? ''})`);
  }
}
