/**
 * Repository functions over the SQLite schema. Each function is a thin, explicit query;
 * callers compose them inside withTransaction() when atomicity matters.
 */
import { gzipSync } from 'node:zlib';
import type { Db } from './db.ts';
import type { FetchAttemptRecord } from '../adapters/binance-alpha/client.ts';
import type { RawKlineRow } from '../adapters/binance-alpha/dto.ts';
import type { DecisionEvent, EngineState } from '../domain/types.ts';
import { sha256Hex } from '../domain/hash.ts';

// ---------------------------------------------------------------------------
// raw responses and fetch attempts

export function insertRawResponse(db: Db, sha256: string, text: string, observedAt: number): boolean {
  const r = db.prepare('INSERT OR IGNORE INTO raw_responses(sha256, first_observed_at, bytes, gzip) VALUES (?, ?, ?, ?)')
    .run(sha256, observedAt, Buffer.byteLength(text), gzipSync(Buffer.from(text, 'utf8')));
  return r.changes > 0;
}

export function insertFetchAttempt(db: Db, a: FetchAttemptRecord): void {
  db.prepare(`INSERT OR IGNORE INTO fetch_attempts(request_id, endpoint, params_json, started_at, finished_at, http_status, business_code, outcome,
      row_count, error_class, error_message, raw_sha256, raw_bytes, server_date_ms, clock_offset_ms, retry_index)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(a.requestId, a.endpoint, JSON.stringify(a.params), a.startedAt, a.finishedAt, a.httpStatus, a.businessCode, a.outcome,
      a.rowCount, a.errorClass, a.errorMessage, a.rawSha256, a.rawBytes, a.serverDateMs, a.clockOffsetMs, a.retryIndex);
}

export type FetchStats = { total: number; ok: number; byOutcome: Record<string, number>; p95LatencyMs: number | null };

export function fetchStatsSince(db: Db, sinceMs: number): FetchStats {
  const rows = db.prepare('SELECT outcome, (finished_at - started_at) AS latency FROM fetch_attempts WHERE started_at >= ?').all(sinceMs) as { outcome: string; latency: number }[];
  const byOutcome: Record<string, number> = {};
  const latencies: number[] = [];
  for (const r of rows) {
    byOutcome[r.outcome] = (byOutcome[r.outcome] ?? 0) + 1;
    latencies.push(r.latency);
  }
  latencies.sort((a, b) => a - b);
  const p95 = latencies.length ? latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * 0.95))] ?? null : null;
  return { total: rows.length, ok: byOutcome['OK'] ?? 0, byOutcome, p95LatencyMs: p95 };
}

// ---------------------------------------------------------------------------
// universe and instruments

export type UniverseSnapshotRow = {
  snapshotId: string; provider: string; observedAt: number; tokenListSha256: string; exchangeInfoSha256: string;
  selectionPolicyHash: string; tokenCount: number; symbolCount: number; eligibleCount: number; selectedCount: number; members: unknown;
};

export function insertUniverseSnapshot(db: Db, s: UniverseSnapshotRow): void {
  db.prepare(`INSERT INTO universe_snapshots(snapshot_id, provider, observed_at, token_list_sha256, exchange_info_sha256, selection_policy_hash,
      token_count, symbol_count, eligible_count, selected_count, members_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(s.snapshotId, s.provider, s.observedAt, s.tokenListSha256, s.exchangeInfoSha256, s.selectionPolicyHash,
      s.tokenCount, s.symbolCount, s.eligibleCount, s.selectedCount, JSON.stringify(s.members));
}

export function latestUniverseSnapshot(db: Db): (Omit<UniverseSnapshotRow, 'members'> & { members: { selected: string[]; excluded: { instrumentId: string; reason: string }[] } }) | null {
  const r = db.prepare('SELECT * FROM universe_snapshots ORDER BY observed_at DESC LIMIT 1').get() as Record<string, unknown> | undefined;
  if (!r) return null;
  return {
    snapshotId: r['snapshot_id'] as string, provider: r['provider'] as string, observedAt: r['observed_at'] as number,
    tokenListSha256: r['token_list_sha256'] as string, exchangeInfoSha256: r['exchange_info_sha256'] as string,
    selectionPolicyHash: r['selection_policy_hash'] as string, tokenCount: r['token_count'] as number, symbolCount: r['symbol_count'] as number,
    eligibleCount: r['eligible_count'] as number, selectedCount: r['selected_count'] as number,
    members: JSON.parse(r['members_json'] as string),
  };
}

export type InstrumentIdentity = {
  instrumentId: string; provider: string; marketType: string; symbol: string; alphaId: string; baseAsset: string; quoteAsset: string;
  displaySymbol: string; tokenName: string; chainId: string; chainName: string; contractAddress: string; status: string; tokenOffline: boolean;
};

export type InstrumentRow = InstrumentIdentity & { firstSeenAt: number; lastSeenAt: number; identityVersion: number };

/** Stable identity fields; a change in any of them creates a new identity version (never silently merged). */
function identityCore(i: InstrumentIdentity): Record<string, string> {
  return { alphaId: i.alphaId, baseAsset: i.baseAsset, quoteAsset: i.quoteAsset, symbol: i.symbol, chainId: i.chainId, contractAddress: i.contractAddress };
}

export function upsertInstrument(db: Db, i: InstrumentIdentity, observedAt: number): 'new' | 'identity_changed' | 'same' {
  const existing = db.prepare('SELECT identity_json, identity_version FROM instruments WHERE instrument_id = ?').get(i.instrumentId) as { identity_json: string; identity_version: number } | undefined;
  const identityJson = JSON.stringify(identityCore(i));
  if (!existing) {
    db.prepare(`INSERT INTO instruments(instrument_id, provider, market_type, symbol, alpha_id, base_asset, quote_asset, display_symbol, token_name, chain_id, chain_name,
        contract_address, status, token_offline, first_seen_at, last_seen_at, identity_version, identity_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`)
      .run(i.instrumentId, i.provider, i.marketType, i.symbol, i.alphaId, i.baseAsset, i.quoteAsset, i.displaySymbol, i.tokenName, i.chainId, i.chainName,
        i.contractAddress, i.status, i.tokenOffline ? 1 : 0, observedAt, observedAt, identityJson);
    db.prepare('INSERT INTO instrument_identity_versions(instrument_id, version, observed_at, identity_json) VALUES (?, 1, ?, ?)').run(i.instrumentId, observedAt, identityJson);
    return 'new';
  }
  const changed = existing.identity_json !== identityJson;
  const version = changed ? existing.identity_version + 1 : existing.identity_version;
  db.prepare(`UPDATE instruments SET display_symbol = ?, token_name = ?, chain_name = ?, status = ?, token_offline = ?, last_seen_at = ?, identity_version = ?, identity_json = ?,
      alpha_id = ?, base_asset = ?, quote_asset = ?, symbol = ?, chain_id = ?, contract_address = ? WHERE instrument_id = ?`)
    .run(i.displaySymbol, i.tokenName, i.chainName, i.status, i.tokenOffline ? 1 : 0, observedAt, version, identityJson,
      i.alphaId, i.baseAsset, i.quoteAsset, i.symbol, i.chainId, i.contractAddress, i.instrumentId);
  if (changed) {
    db.prepare('INSERT INTO instrument_identity_versions(instrument_id, version, observed_at, identity_json) VALUES (?, ?, ?, ?)').run(i.instrumentId, version, observedAt, identityJson);
    return 'identity_changed';
  }
  return 'same';
}

export function insertIdentityConflict(db: Db, observedAt: number, kind: string, detail: unknown): void {
  const detailJson = JSON.stringify(detail);
  db.prepare('INSERT OR IGNORE INTO identity_conflicts(conflict_id, observed_at, kind, detail_json) VALUES (?, ?, ?, ?)')
    .run(sha256Hex(kind, detailJson), observedAt, kind, detailJson);
}

function rowToInstrument(r: Record<string, unknown>): InstrumentRow {
  return {
    instrumentId: r['instrument_id'] as string, provider: r['provider'] as string, marketType: r['market_type'] as string, symbol: r['symbol'] as string,
    alphaId: r['alpha_id'] as string, baseAsset: r['base_asset'] as string, quoteAsset: r['quote_asset'] as string, displaySymbol: r['display_symbol'] as string,
    tokenName: r['token_name'] as string, chainId: r['chain_id'] as string, chainName: r['chain_name'] as string, contractAddress: r['contract_address'] as string,
    status: r['status'] as string, tokenOffline: (r['token_offline'] as number) === 1, firstSeenAt: r['first_seen_at'] as number, lastSeenAt: r['last_seen_at'] as number,
    identityVersion: r['identity_version'] as number,
  };
}

export function getInstrument(db: Db, instrumentId: string): InstrumentRow | null {
  const r = db.prepare('SELECT * FROM instruments WHERE instrument_id = ?').get(instrumentId) as Record<string, unknown> | undefined;
  return r ? rowToInstrument(r) : null;
}

export function listInstruments(db: Db): InstrumentRow[] {
  return (db.prepare('SELECT * FROM instruments ORDER BY instrument_id').all() as Record<string, unknown>[]).map(rowToInstrument);
}

export function getInstruments(db: Db, ids: readonly string[]): InstrumentRow[] {
  const out: InstrumentRow[] = [];
  for (const id of ids) {
    const i = getInstrument(db, id);
    if (i) out.push(i);
  }
  return out;
}

// ---------------------------------------------------------------------------
// candles and cursors

export type StoredCandle = {
  versionId: string; instrumentId: string; intervalMs: number; openAt: number; closeAt: number; sourceCloseAt: number;
  open: string; high: string; low: string; close: string; baseVolume: string; quoteVolume: string; tradeCount: string | null;
  contentHash: string; firstObservedAt: number; rawSha256: string | null;
};

export function candleVersionId(instrumentId: string, intervalMs: number, openAt: number, contentHash: string): string {
  return sha256Hex('candle', instrumentId, intervalMs, openAt, contentHash).slice(0, 40);
}

/** Idempotent: identical content for the same bar keeps its first observedAt. Returns whether a new version row was inserted. */
export function insertCandleVersion(db: Db, instrumentId: string, intervalMs: number, row: RawKlineRow, observedAt: number, rawSha256: string | null): { inserted: boolean; versionId: string } {
  const versionId = candleVersionId(instrumentId, intervalMs, row.openTime, row.contentHash);
  const r = db.prepare(`INSERT OR IGNORE INTO candle_versions(version_id, instrument_id, interval_ms, open_at, close_at, source_close_at, open, high, low, close,
      base_volume, quote_volume, trade_count, content_hash, first_observed_at, raw_sha256) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(versionId, instrumentId, intervalMs, row.openTime, row.openTime + intervalMs, row.closeTime, row.open, row.high, row.low, row.close,
      row.volume, row.quoteVolume, row.trades, row.contentHash, observedAt, rawSha256);
  return { inserted: r.changes > 0, versionId };
}

function rowToStoredCandle(r: Record<string, unknown>): StoredCandle {
  return {
    versionId: r['version_id'] as string, instrumentId: r['instrument_id'] as string, intervalMs: r['interval_ms'] as number,
    openAt: r['open_at'] as number, closeAt: r['close_at'] as number, sourceCloseAt: r['source_close_at'] as number,
    open: r['open'] as string, high: r['high'] as string, low: r['low'] as string, close: r['close'] as string,
    baseVolume: r['base_volume'] as string, quoteVolume: r['quote_volume'] as string, tradeCount: (r['trade_count'] as string | null) ?? null,
    contentHash: r['content_hash'] as string, firstObservedAt: r['first_observed_at'] as number, rawSha256: (r['raw_sha256'] as string | null) ?? null,
  };
}

const LATEST_VERSION_FILTER = `NOT EXISTS (
  SELECT 1 FROM candle_versions d WHERE d.instrument_id = c.instrument_id AND d.interval_ms = c.interval_ms AND d.open_at = c.open_at
    AND (d.first_observed_at > c.first_observed_at OR (d.first_observed_at = c.first_observed_at AND d.version_id > c.version_id)))`;

/** Latest version of each bar with open_at in (afterOpenAt, untilOpenAt], ascending; limit applies to the newest bars when `newestFirst`. */
export function latestCandles(db: Db, instrumentId: string, intervalMs: number, opts: { afterOpenAt?: number; untilOpenAt?: number; limit?: number; newest?: boolean } = {}): StoredCandle[] {
  const after = opts.afterOpenAt ?? -1;
  const until = opts.untilOpenAt ?? Number.MAX_SAFE_INTEGER;
  const limit = opts.limit ?? 1_000_000;
  const order = opts.newest ? 'DESC' : 'ASC';
  const rows = db.prepare(`SELECT * FROM candle_versions c WHERE c.instrument_id = ? AND c.interval_ms = ? AND c.open_at > ? AND c.open_at <= ? AND ${LATEST_VERSION_FILTER}
    ORDER BY c.open_at ${order} LIMIT ?`).all(instrumentId, intervalMs, after, until, limit) as Record<string, unknown>[];
  const out = rows.map(rowToStoredCandle);
  return opts.newest ? out.reverse() : out;
}

/** All versions of one bar (oldest first), for revision detection. */
export function candleVersionsOfBar(db: Db, instrumentId: string, intervalMs: number, openAt: number): StoredCandle[] {
  const rows = db.prepare('SELECT * FROM candle_versions WHERE instrument_id = ? AND interval_ms = ? AND open_at = ? ORDER BY first_observed_at, version_id')
    .all(instrumentId, intervalMs, openAt) as Record<string, unknown>[];
  return rows.map(rowToStoredCandle);
}

export function candleCoverage(db: Db, instrumentId: string, intervalMs: number): { bars: number; earliestOpenAt: number | null; latestOpenAt: number | null } {
  const r = db.prepare('SELECT COUNT(DISTINCT open_at) AS bars, MIN(open_at) AS e, MAX(open_at) AS l FROM candle_versions WHERE instrument_id = ? AND interval_ms = ?')
    .get(instrumentId, intervalMs) as { bars: number; e: number | null; l: number | null };
  return { bars: r.bars, earliestOpenAt: r.e, latestOpenAt: r.l };
}

export type CursorRow = {
  instrumentId: string; intervalMs: number; earliestOpenAt: number | null; latestClosedOpenAt: number | null; backfillTargetOpenAt: number | null;
  backfillDone: boolean; backfillReason: string | null; lastFetchAt: number | null; lastSuccessAt: number | null; consecutiveFailures: number; pausedReason: string | null;
};

export function getCursor(db: Db, instrumentId: string, intervalMs: number): CursorRow | null {
  const r = db.prepare('SELECT * FROM collection_cursors WHERE instrument_id = ? AND interval_ms = ?').get(instrumentId, intervalMs) as Record<string, unknown> | undefined;
  if (!r) return null;
  return {
    instrumentId, intervalMs, earliestOpenAt: (r['earliest_open_at'] as number | null) ?? null, latestClosedOpenAt: (r['latest_closed_open_at'] as number | null) ?? null,
    backfillTargetOpenAt: (r['backfill_target_open_at'] as number | null) ?? null, backfillDone: (r['backfill_done'] as number) === 1,
    backfillReason: (r['backfill_reason'] as string | null) ?? null, lastFetchAt: (r['last_fetch_at'] as number | null) ?? null,
    lastSuccessAt: (r['last_success_at'] as number | null) ?? null, consecutiveFailures: r['consecutive_failures'] as number, pausedReason: (r['paused_reason'] as string | null) ?? null,
  };
}

export function upsertCursor(db: Db, c: CursorRow): void {
  db.prepare(`INSERT INTO collection_cursors(instrument_id, interval_ms, earliest_open_at, latest_closed_open_at, backfill_target_open_at, backfill_done, backfill_reason,
      last_fetch_at, last_success_at, consecutive_failures, paused_reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(instrument_id, interval_ms) DO UPDATE SET earliest_open_at = excluded.earliest_open_at, latest_closed_open_at = excluded.latest_closed_open_at,
      backfill_target_open_at = excluded.backfill_target_open_at, backfill_done = excluded.backfill_done, backfill_reason = excluded.backfill_reason,
      last_fetch_at = excluded.last_fetch_at, last_success_at = excluded.last_success_at, consecutive_failures = excluded.consecutive_failures, paused_reason = excluded.paused_reason`)
    .run(c.instrumentId, c.intervalMs, c.earliestOpenAt, c.latestClosedOpenAt, c.backfillTargetOpenAt, c.backfillDone ? 1 : 0, c.backfillReason,
      c.lastFetchAt, c.lastSuccessAt, c.consecutiveFailures, c.pausedReason);
}

export function listCursors(db: Db): CursorRow[] {
  const rows = db.prepare('SELECT instrument_id, interval_ms FROM collection_cursors').all() as { instrument_id: string; interval_ms: number }[];
  return rows.map((r) => getCursor(db, r.instrument_id, r.interval_ms)).filter((c): c is CursorRow => c !== null);
}

// ---------------------------------------------------------------------------
// runs, journal, events, heads, stats

export type RunRow = { runId: string; mode: string; startedAt: number; endedAt: number | null; status: string; policyVersion: string; policyHash: string; schemaVersion: number; codeHash: string; config: unknown };

export function createRun(db: Db, r: RunRow): void {
  db.prepare('INSERT INTO runs(run_id, mode, started_at, ended_at, status, policy_version, policy_hash, schema_version, code_hash, config_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(r.runId, r.mode, r.startedAt, r.endedAt, r.status, r.policyVersion, r.policyHash, r.schemaVersion, r.codeHash, JSON.stringify(r.config));
}

export function getRun(db: Db, runId: string): RunRow | null {
  const r = db.prepare('SELECT * FROM runs WHERE run_id = ?').get(runId) as Record<string, unknown> | undefined;
  if (!r) return null;
  return {
    runId: r['run_id'] as string, mode: r['mode'] as string, startedAt: r['started_at'] as number, endedAt: (r['ended_at'] as number | null) ?? null, status: r['status'] as string,
    policyVersion: r['policy_version'] as string, policyHash: r['policy_hash'] as string, schemaVersion: r['schema_version'] as number, codeHash: r['code_hash'] as string,
    config: JSON.parse(r['config_json'] as string),
  };
}

export function latestRun(db: Db, mode: string): RunRow | null {
  const r = db.prepare('SELECT run_id FROM runs WHERE mode = ? ORDER BY started_at DESC LIMIT 1').get(mode) as { run_id: string } | undefined;
  return r ? getRun(db, r.run_id) : null;
}

export function endRun(db: Db, runId: string, status: string, endedAt: number): void {
  db.prepare('UPDATE runs SET status = ?, ended_at = ? WHERE run_id = ?').run(status, endedAt, runId);
}

/** Reopens a cleanly stopped (`paused`) run so the next process continues it instead of starting a new one. */
export function reopenRun(db: Db, runId: string): void {
  db.prepare("UPDATE runs SET status = 'running', ended_at = NULL WHERE run_id = ?").run(runId);
}

export type JournalRow = { runId: string; instrumentId: string; seq: number; candleVersionId: string; openAt: number; closeAt: number; observedAt: number; quality: string; nowMs: number; historyLength: number; inputHash: string };

export function insertJournal(db: Db, j: JournalRow): boolean {
  const r = db.prepare(`INSERT OR IGNORE INTO input_journal(run_id, instrument_id, seq, candle_version_id, open_at, close_at, observed_at, quality, now_ms, history_length, input_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(j.runId, j.instrumentId, j.seq, j.candleVersionId, j.openAt, j.closeAt, j.observedAt, j.quality, j.nowMs, j.historyLength, j.inputHash);
  return r.changes > 0;
}

/** Version id this run consumed for each bar in [fromOpenAt, toOpenAt] (last journal entry per bar wins). */
export function journaledVersionIds(db: Db, runId: string, instrumentId: string, fromOpenAt: number, toOpenAt: number): Map<number, string> {
  const rows = db.prepare('SELECT open_at, candle_version_id FROM input_journal WHERE run_id = ? AND instrument_id = ? AND open_at BETWEEN ? AND ? ORDER BY seq')
    .all(runId, instrumentId, fromOpenAt, toOpenAt) as { open_at: number; candle_version_id: string }[];
  const out = new Map<number, string>();
  for (const r of rows) out.set(r.open_at, r.candle_version_id);
  return out;
}

export function eventId(runId: string, instrumentId: string, e: DecisionEvent, policyHash: string): string {
  return sha256Hex('event', runId, instrumentId, e.seq, policyHash, e.kind, e.code, e.setupId, e.toPhase).slice(0, 40);
}

export type StoredEvent = DecisionEvent & { eventId: string; runId: string; instrumentId: string; inputHash: string; policyHash: string };

export function insertEvent(db: Db, e: StoredEvent): boolean {
  const r = db.prepare(`INSERT OR IGNORE INTO setup_events(event_id, run_id, instrument_id, seq, setup_id, kind, code, from_phase, to_phase, decision_bar_open_at, decision_bar_close_at,
      emitted_at, is_fresh, candle_version_id, input_hash, policy_hash, values_json, thresholds_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(e.eventId, e.runId, e.instrumentId, e.seq, e.setupId, e.kind, e.code, e.fromPhase, e.toPhase, e.decisionBarOpenAt, e.decisionBarCloseAt,
      e.emittedAt, e.isFresh ? 1 : 0, e.candleVersionId, e.inputHash, e.policyHash, JSON.stringify(e.values), JSON.stringify(e.thresholds));
  return r.changes > 0;
}

function rowToEvent(r: Record<string, unknown>): StoredEvent {
  return {
    eventId: r['event_id'] as string, runId: r['run_id'] as string, instrumentId: r['instrument_id'] as string, seq: r['seq'] as number,
    setupId: (r['setup_id'] as string | null) ?? null, kind: r['kind'] as StoredEvent['kind'], code: r['code'] as StoredEvent['code'],
    fromPhase: r['from_phase'] as StoredEvent['fromPhase'], toPhase: r['to_phase'] as StoredEvent['toPhase'],
    decisionBarOpenAt: r['decision_bar_open_at'] as number, decisionBarCloseAt: r['decision_bar_close_at'] as number, emittedAt: r['emitted_at'] as number,
    isFresh: (r['is_fresh'] as number) === 1, candleVersionId: r['candle_version_id'] as string, inputHash: r['input_hash'] as string, policyHash: r['policy_hash'] as string,
    values: JSON.parse(r['values_json'] as string), thresholds: JSON.parse(r['thresholds_json'] as string),
  };
}

export function listEvents(db: Db, opts: { runId?: string; instrumentId?: string; codes?: readonly string[]; limit?: number; newest?: boolean } = {}): StoredEvent[] {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (opts.runId) { where.push('run_id = ?'); params.push(opts.runId); }
  if (opts.instrumentId) { where.push('instrument_id = ?'); params.push(opts.instrumentId); }
  if (opts.codes && opts.codes.length) { where.push(`code IN (${opts.codes.map(() => '?').join(',')})`); params.push(...opts.codes); }
  const sql = `SELECT * FROM setup_events ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY decision_bar_close_at ${opts.newest ? 'DESC' : 'ASC'}, seq ${opts.newest ? 'DESC' : 'ASC'} LIMIT ?`;
  params.push(opts.limit ?? 1000);
  return (db.prepare(sql).all(...params) as Record<string, unknown>[]).map(rowToEvent);
}

export function eventCountsByCode(db: Db, runId: string): Record<string, number> {
  const rows = db.prepare('SELECT code, COUNT(*) AS n FROM setup_events WHERE run_id = ? GROUP BY code').all(runId) as { code: string; n: number }[];
  const out: Record<string, number> = {};
  for (const r of rows) out[r.code] = r.n;
  return out;
}

export type HeadRow = { runId: string; instrumentId: string; seq: number; phase: string; lastOpenAt: number | null; state: EngineState; updatedAt: number };

export function getHead(db: Db, runId: string, instrumentId: string): HeadRow | null {
  const r = db.prepare('SELECT * FROM setup_heads WHERE run_id = ? AND instrument_id = ?').get(runId, instrumentId) as Record<string, unknown> | undefined;
  if (!r) return null;
  return { runId, instrumentId, seq: r['seq'] as number, phase: r['phase'] as string, lastOpenAt: (r['last_open_at'] as number | null) ?? null, state: JSON.parse(r['state_json'] as string), updatedAt: r['updated_at'] as number };
}

export function upsertHead(db: Db, h: HeadRow): void {
  db.prepare(`INSERT INTO setup_heads(run_id, instrument_id, seq, phase, last_open_at, state_json, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(run_id, instrument_id) DO UPDATE SET seq = excluded.seq, phase = excluded.phase, last_open_at = excluded.last_open_at, state_json = excluded.state_json, updated_at = excluded.updated_at`)
    .run(h.runId, h.instrumentId, h.seq, h.phase, h.lastOpenAt, JSON.stringify(h.state), h.updatedAt);
}

export function listHeads(db: Db, runId: string): HeadRow[] {
  const rows = db.prepare('SELECT instrument_id FROM setup_heads WHERE run_id = ? ORDER BY instrument_id').all(runId) as { instrument_id: string }[];
  return rows.map((r) => getHead(db, runId, r.instrument_id)).filter((h): h is HeadRow => h !== null);
}

export function incrementStat(db: Db, runId: string, instrumentId: string, code: string, by = 1): void {
  db.prepare('INSERT INTO run_stats(run_id, instrument_id, code, count) VALUES (?, ?, ?, ?) ON CONFLICT(run_id, instrument_id, code) DO UPDATE SET count = count + excluded.count')
    .run(runId, instrumentId, code, by);
}

export function runStats(db: Db, runId: string): Record<string, number> {
  const rows = db.prepare('SELECT code, SUM(count) AS n FROM run_stats WHERE run_id = ? GROUP BY code').all(runId) as { code: string; n: number }[];
  const out: Record<string, number> = {};
  for (const r of rows) out[r.code] = r.n;
  return out;
}

// ---------------------------------------------------------------------------
// alerts and leases

export type AlertRow = { alertId: string; eventId: string; runId: string; instrumentId: string; level: string; code: string; createdAt: number; isFresh: boolean; payload: unknown; delivered: unknown };

export function insertAlert(db: Db, a: AlertRow): boolean {
  const r = db.prepare('INSERT OR IGNORE INTO alerts(alert_id, event_id, run_id, instrument_id, level, code, created_at, is_fresh, payload_json, delivered_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(a.alertId, a.eventId, a.runId, a.instrumentId, a.level, a.code, a.createdAt, a.isFresh ? 1 : 0, JSON.stringify(a.payload), JSON.stringify(a.delivered));
  return r.changes > 0;
}

export function updateAlertDelivery(db: Db, alertId: string, delivered: unknown): void {
  db.prepare('UPDATE alerts SET delivered_json = ? WHERE alert_id = ?').run(JSON.stringify(delivered), alertId);
}

export function listAlerts(db: Db, opts: { limit?: number; levels?: readonly string[]; runId?: string } = {}): AlertRow[] {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (opts.runId) { where.push('run_id = ?'); params.push(opts.runId); }
  if (opts.levels && opts.levels.length) { where.push(`level IN (${opts.levels.map(() => '?').join(',')})`); params.push(...opts.levels); }
  params.push(opts.limit ?? 50);
  const rows = db.prepare(`SELECT * FROM alerts ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC LIMIT ?`).all(...params) as Record<string, unknown>[];
  return rows.map((r) => ({
    alertId: r['alert_id'] as string, eventId: r['event_id'] as string, runId: r['run_id'] as string, instrumentId: r['instrument_id'] as string, level: r['level'] as string,
    code: r['code'] as string, createdAt: r['created_at'] as number, isFresh: (r['is_fresh'] as number) === 1, payload: JSON.parse(r['payload_json'] as string), delivered: JSON.parse(r['delivered_json'] as string),
  }));
}

/** Single-writer lease. Returns false when another live owner holds it. */
export function acquireLease(db: Db, name: string, owner: string, ttlMs: number, now: number): boolean {
  const existing = db.prepare('SELECT owner, expires_at FROM leases WHERE name = ?').get(name) as { owner: string; expires_at: number } | undefined;
  if (existing && existing.owner !== owner && existing.expires_at > now) return false;
  db.prepare('INSERT INTO leases(name, owner, acquired_at, expires_at) VALUES (?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET owner = excluded.owner, acquired_at = excluded.acquired_at, expires_at = excluded.expires_at')
    .run(name, owner, now, now + ttlMs);
  return true;
}

export function releaseLease(db: Db, name: string, owner: string): void {
  db.prepare('DELETE FROM leases WHERE name = ? AND owner = ?').run(name, owner);
}
