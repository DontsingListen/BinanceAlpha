/**
 * Candle collection for one instrument: incremental fetch with overlap, bounded backfill toward the target history,
 * closed-bar filtering, versioned storage and a persisted cursor. Every response is stored raw and every request is recorded.
 */
import type { AlphaClient } from '../adapters/binance-alpha/client.ts';
import { KLINES_MAX_LIMIT, SourcePausedError } from '../adapters/binance-alpha/client.ts';
import type { RawKlineRow } from '../adapters/binance-alpha/dto.ts';
import type { Db } from '../storage/db.ts';
import { withTransaction } from '../storage/db.ts';
import { candleVersionsOfBar, getCursor, insertCandleVersion, insertRawResponse, upsertCursor, type CursorRow, type InstrumentRow } from '../storage/repos.ts';
import type { AppConfig } from './config.ts';

export type CollectOutcome = 'ok' | 'no_records' | 'paused' | 'failed' | 'clock_uncertain';

export type CollectSummary = {
  instrumentId: string;
  symbol: string;
  outcome: CollectOutcome;
  newClosedBars: number;
  revisedBars: number;
  rejectedRows: number;
  pagesFetched: number;
  latestClosedOpenAt: number | null;
  earliestOpenAt: number | null;
  backfillDone: boolean;
  notes: string[];
};

/** Largest openAt whose canonical close is at or before (now - margin). */
export function lastClosedOpenAt(now: number, intervalMs: number, marginMs: number): number {
  return Math.floor((now - marginMs - intervalMs) / intervalMs) * intervalMs;
}

export async function collectInstrument(db: Db, client: AlphaClient, cfg: AppConfig, instrument: InstrumentRow, now: number, budget: { backfillPages: number }): Promise<CollectSummary> {
  const intervalMs = cfg.intervalMs;
  const id = instrument.instrumentId;
  const cursor: CursorRow = getCursor(db, id, intervalMs) ?? {
    instrumentId: id, intervalMs, earliestOpenAt: null, latestClosedOpenAt: null, backfillTargetOpenAt: null, backfillDone: false, backfillReason: null,
    lastFetchAt: null, lastSuccessAt: null, consecutiveFailures: 0, pausedReason: null,
  };
  const summary: CollectSummary = {
    instrumentId: id, symbol: instrument.symbol, outcome: 'ok', newClosedBars: 0, revisedBars: 0, rejectedRows: 0, pagesFetched: 0,
    latestClosedOpenAt: cursor.latestClosedOpenAt, earliestOpenAt: cursor.earliestOpenAt, backfillDone: cursor.backfillDone, notes: [],
  };
  if (cursor.pausedReason) {
    summary.outcome = 'paused';
    summary.notes.push(`cursor paused: ${cursor.pausedReason}`);
    return summary;
  }
  const backfillTarget = Math.floor((now - cfg.collection.backfillDays * 86_400_000) / intervalMs) * intervalMs;
  cursor.backfillTargetOpenAt ??= backfillTarget;

  // 1. incremental (or first page)
  const closedLimit = lastClosedOpenAt(now, intervalMs, cfg.collection.closedMarginMs);
  const incremental = cursor.latestClosedOpenAt === null
    ? { limit: KLINES_MAX_LIMIT }
    : (() => {
      const startTime = cursor.latestClosedOpenAt - cfg.collection.overlapBars * intervalMs;
      const needed = Math.ceil((closedLimit - startTime) / intervalMs) + 2;
      return { startTime, limit: Math.min(KLINES_MAX_LIMIT, Math.max(needed, cfg.collection.overlapBars + 2)) };
    })();
  const page = await fetchPage(db, client, cfg, instrument, incremental, cursor, summary, closedLimit, now);
  if (page !== 'ok') {
    persistCursor(db, cursor, summary, now, page);
    return summary;
  }

  // 2. bounded backfill of older history
  while (!cursor.backfillDone && budget.backfillPages > 0) {
    if (cursor.earliestOpenAt === null) { cursor.backfillDone = true; cursor.backfillReason = 'no_data_at_all'; break; }
    if (cursor.earliestOpenAt <= (cursor.backfillTargetOpenAt as number)) { cursor.backfillDone = true; cursor.backfillReason = 'target_reached'; break; }
    const endTime = cursor.earliestOpenAt - 1;
    const startTime = Math.max(cursor.backfillTargetOpenAt as number, cursor.earliestOpenAt - KLINES_MAX_LIMIT * intervalMs);
    const before = cursor.earliestOpenAt;
    budget.backfillPages -= 1;
    const r = await fetchPage(db, client, cfg, instrument, { startTime, endTime, limit: KLINES_MAX_LIMIT }, cursor, summary, closedLimit, now);
    if (r === 'no_records') { cursor.backfillDone = true; cursor.backfillReason = `no_records_before_${before}`; break; }
    if (r !== 'ok') break;
    if (cursor.earliestOpenAt === before) { cursor.backfillDone = true; cursor.backfillReason = `history_starts_at_${before}`; break; }
    if (cursor.earliestOpenAt > startTime + intervalMs) { cursor.backfillDone = true; cursor.backfillReason = `history_starts_at_${cursor.earliestOpenAt}`; break; }
  }
  persistCursor(db, cursor, summary, now, 'ok');
  return summary;
}

type PageResult = 'ok' | 'no_records' | 'paused' | 'failed' | 'clock_uncertain';

async function fetchPage(db: Db, client: AlphaClient, cfg: AppConfig, instrument: InstrumentRow, args: { startTime?: number; endTime?: number; limit: number }, cursor: CursorRow, summary: CollectSummary, closedLimit: number, now: number): Promise<PageResult> {
  const intervalMs = cfg.intervalMs;
  let res;
  try {
    res = await client.getKlines({ symbol: instrument.symbol, interval: cfg.interval, intervalMs, ...args });
  } catch (error) {
    if (error instanceof SourcePausedError) {
      summary.outcome = 'paused';
      summary.notes.push(error.message);
      return 'paused';
    }
    throw error;
  }
  summary.pagesFetched += 1;
  cursor.lastFetchAt = now;
  const offset = res.attempt.clockOffsetMs;
  if (offset !== null && Math.abs(offset) > cfg.collection.maxClockOffsetMs) {
    summary.outcome = 'clock_uncertain';
    summary.notes.push(`CLOCK_UNCERTAIN: server-local offset ${offset}ms exceeds ${cfg.collection.maxClockOffsetMs}ms; page not consumed`);
    return 'clock_uncertain';
  }
  if (res.outcome === 'NO_RECORDS') {
    summary.notes.push(`no records for ${JSON.stringify(args)}`);
    if (summary.outcome === 'ok' && cursor.latestClosedOpenAt === null) summary.outcome = 'no_records';
    return 'no_records';
  }
  if (res.outcome === 'INVALID_SYMBOL') {
    cursor.pausedReason = `INVALID_SYMBOL at ${new Date(now).toISOString()}`;
    summary.outcome = 'failed';
    summary.notes.push('invalid symbol; cursor paused');
    return 'failed';
  }
  if (res.outcome !== 'OK' || !res.value) {
    cursor.consecutiveFailures += 1;
    summary.outcome = res.outcome === 'RATE_LIMITED' || res.outcome === 'SOURCE_PAUSED' ? 'paused' : 'failed';
    summary.notes.push(`${res.outcome}: ${res.message ?? ''}`);
    return summary.outcome === 'paused' ? 'paused' : 'failed';
  }
  summary.rejectedRows += res.rejected.length;
  for (const rj of res.rejected.slice(0, 3)) summary.notes.push(`rejected row ${rj.index}: ${rj.reason}`);
  const rows = res.value;
  const rawSha = res.attempt.rawSha256;
  storeRows(db, cfg, instrument, rows, rawSha, res.rawText, cursor, summary, closedLimit, now);
  cursor.consecutiveFailures = 0;
  cursor.lastSuccessAt = now;
  return 'ok';
}

function storeRows(db: Db, cfg: AppConfig, instrument: InstrumentRow, rows: RawKlineRow[], rawSha: string | null, rawText: string | null, cursor: CursorRow, summary: CollectSummary, closedLimit: number, now: number): void {
  withTransaction(db, () => {
    if (rawSha && rawText) insertRawResponse(db, rawSha, rawText, now);
    const prevLatest = cursor.latestClosedOpenAt;
    for (const row of rows) {
      if (row.openTime > closedLimit) continue; // still-open bar (or clock skew): never stored as closed
      const { inserted } = insertCandleVersion(db, instrument.instrumentId, cfg.intervalMs, row, now, rawSha);
      if (!inserted) continue;
      const versions = candleVersionsOfBar(db, instrument.instrumentId, cfg.intervalMs, row.openTime);
      if (versions.length > 1) {
        summary.revisedBars += 1;
        summary.notes.push(`REVISION at ${row.openTime}: ${versions.length} versions`);
      } else if (prevLatest === null || row.openTime > prevLatest) {
        summary.newClosedBars += 1;
      } else {
        summary.newClosedBars += 1; // backfilled older bar
      }
      cursor.earliestOpenAt = cursor.earliestOpenAt === null ? row.openTime : Math.min(cursor.earliestOpenAt, row.openTime);
      cursor.latestClosedOpenAt = cursor.latestClosedOpenAt === null ? row.openTime : Math.max(cursor.latestClosedOpenAt, row.openTime);
    }
    upsertCursor(db, cursor);
  });
  summary.latestClosedOpenAt = cursor.latestClosedOpenAt;
  summary.earliestOpenAt = cursor.earliestOpenAt;
}

function persistCursor(db: Db, cursor: CursorRow, summary: CollectSummary, now: number, result: PageResult): void {
  cursor.lastFetchAt = cursor.lastFetchAt ?? now;
  upsertCursor(db, cursor);
  summary.latestClosedOpenAt = cursor.latestClosedOpenAt;
  summary.earliestOpenAt = cursor.earliestOpenAt;
  summary.backfillDone = cursor.backfillDone;
  if (result === 'ok' && summary.outcome === 'ok' && summary.newClosedBars === 0 && cursor.latestClosedOpenAt === null) summary.outcome = 'no_records';
}
