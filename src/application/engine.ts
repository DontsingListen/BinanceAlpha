/**
 * InstrumentRunner: feeds stored closed candles into the pure step() in journal order, persists
 * journal + events + head + stats + alerts atomically per input, then dispatches alerts to local sinks.
 * Resumable: the head row is the checkpoint; event ids are deterministic so retries never duplicate.
 */
import type { Policy } from '../domain/policy.ts';
import { step } from '../domain/step.ts';
import { INITIAL_STATE, type Candle, type DataQuality, type DecisionEvent, type EngineState } from '../domain/types.ts';
import { sha256Hex } from '../domain/hash.ts';
import { toCandle } from '../adapters/binance-alpha/dto.ts';
import type { Db } from '../storage/db.ts';
import { withTransaction } from '../storage/db.ts';
import {
  eventId as makeEventId, getHead, incrementStat, insertAlert, insertEvent, insertJournal, journaledVersionIds, latestCandles, updateAlertDelivery, upsertHead,
  type InstrumentRow, type StoredCandle, type StoredEvent,
} from '../storage/repos.ts';
import { buildAlert, type Alert, type AlertDispatcher } from './alerts.ts';

export type AdvanceSummary = { instrumentId: string; processed: number; gaps: number; revisions: number; events: StoredEvent[]; alerts: Alert[]; phase: string; lastOpenAt: number | null; historyLength: number };

export type RunnerOptions = {
  readonly db: Db;
  readonly policy: Policy;
  readonly runId: string;
  readonly mode: string;
  readonly instrument: InstrumentRow;
  readonly intervalMs: number;
  readonly dispatcher: AlertDispatcher | null;
  /** Explicit clock for each input: online = wall clock at processing; simulation = the candle's (simulated) availableAt. */
  readonly clock: (candle: Candle) => number;
  /**
   * When a stored candle becomes knowable. Online: its real first observation time (default).
   * historical-simulation: closeAt + an explicit availability delay (docs/03 "availableAt").
   */
  readonly availableAt?: (stored: StoredCandle) => number;
  /** Optional enrichment attached to every alert payload as `social` (ADR 0003); never influences the rules. */
  readonly socialContext?: (instrumentId: string, now: number) => Record<string, unknown> | null;
};

export class InstrumentRunner {
  readonly #o: RunnerOptions;
  #state: EngineState;
  #history: Candle[] = [];
  #historyLimit: number;

  readonly #socialContext: ((instrumentId: string, now: number) => Record<string, unknown> | null) | null;
  constructor(options: RunnerOptions) {
    this.#socialContext = options.socialContext ?? null;
    this.#o = options;
    this.#historyLimit = options.policy.parameters.warmupBars + 2;
    const head = getHead(options.db, options.runId, options.instrument.instrumentId);
    this.#state = head ? head.state : INITIAL_STATE;
    if (this.#state.lastOpenAt !== null) this.#history = this.#loadTrailingHistory(this.#state.lastOpenAt);
  }

  get state(): EngineState {
    return this.#state;
  }

  get historyLength(): number {
    return this.#history.length;
  }

  /** Latest-version candles up to and including `untilOpenAt`, cut to the trailing continuous run. */
  #loadTrailingHistory(untilOpenAt: number): Candle[] {
    const rows = latestCandles(this.#o.db, this.#o.instrument.instrumentId, this.#o.intervalMs, { untilOpenAt, limit: this.#historyLimit, newest: true });
    const candles = rows.map((r) => this.#toCandle(r));
    let start = 0;
    for (let i = candles.length - 1; i > 0; i--) {
      if ((candles[i] as Candle).openAt !== (candles[i - 1] as Candle).closeAt) { start = i; break; }
    }
    return candles.slice(start);
  }

  /** Processes every stored closed candle after the head (optionally bounded by untilOpenAt). */
  async advance(opts: { untilOpenAt?: number } = {}): Promise<AdvanceSummary> {
    const { db, instrument, intervalMs } = this.#o;
    const summary: AdvanceSummary = { instrumentId: instrument.instrumentId, processed: 0, gaps: 0, revisions: 0, events: [], alerts: [], phase: this.#state.phase, lastOpenAt: this.#state.lastOpenAt, historyLength: this.#history.length };

    // Revision check over the consumed window: the journal records which version each bar was judged on;
    // a newer stored version for any of those bars is a DATA_REVISED input (survives restarts).
    if (this.#history.length > 0 && this.#state.lastOpenAt !== null) {
      const first = this.#history[0] as Candle;
      const journaled = journaledVersionIds(db, this.#o.runId, instrument.instrumentId, first.openAt, this.#state.lastOpenAt);
      const current = latestCandles(db, instrument.instrumentId, intervalMs, { afterOpenAt: first.openAt - 1, untilOpenAt: this.#state.lastOpenAt });
      const revisedRow = current.find((r) => { const j = journaled.get(r.openAt); return j !== undefined && j !== r.versionId; });
      if (revisedRow) {
        const candle = this.#toCandle(revisedRow);
        await this.#consume(candle, [candle], 'REVISED', summary);
        summary.revisions += 1;
        this.#history = this.#loadTrailingHistory(this.#state.lastOpenAt as number);
      }
    }

    const after = this.#state.lastOpenAt ?? -1;
    const rows = latestCandles(db, instrument.instrumentId, intervalMs, { afterOpenAt: after, ...(opts.untilOpenAt !== undefined ? { untilOpenAt: opts.untilOpenAt } : {}) });
    for (const row of rows) {
      const candle = this.#toCandle(row);
      const last = this.#history[this.#history.length - 1];
      let quality: DataQuality = 'OK';
      if (last && candle.openAt !== last.closeAt) {
        quality = 'GAP';
        this.#history = [];
        summary.gaps += 1;
      }
      this.#history.push(candle);
      if (this.#history.length > this.#historyLimit) this.#history.splice(0, this.#history.length - this.#historyLimit);
      await this.#consume(candle, this.#history, quality, summary);
    }
    summary.phase = this.#state.phase;
    summary.lastOpenAt = this.#state.lastOpenAt;
    summary.historyLength = this.#history.length;
    return summary;
  }

  #toCandle(r: StoredCandle): Candle {
    const observedAt = this.#o.availableAt ? this.#o.availableAt(r) : r.firstObservedAt;
    return storedToCandle(r, this.#o.intervalMs, observedAt);
  }

  async #consume(candle: Candle, history: readonly Candle[], quality: DataQuality, summary: AdvanceSummary): Promise<void> {
    const { db, policy, runId, instrument, dispatcher, mode } = this.#o;
    const now = Math.max(this.#o.clock(candle), candle.observedAt);
    const seq = this.#state.seq + 1;
    const first = history[0] as Candle;
    const inputHash = sha256Hex('input', instrument.instrumentId, seq, candle.versionId, quality, history.length, first.versionId).slice(0, 40);
    const result = step(this.#state, { instrumentId: instrument.instrumentId, seq, candle, history, quality, now }, policy);
    const stored: StoredEvent[] = result.events.map((e: DecisionEvent) => ({
      ...e, eventId: makeEventId(runId, instrument.instrumentId, e, policy.policyHash), runId, instrumentId: instrument.instrumentId, inputHash, policyHash: policy.policyHash,
    }));
    const alerts: Alert[] = [];
    withTransaction(db, () => {
      insertJournal(db, { runId, instrumentId: instrument.instrumentId, seq, candleVersionId: candle.versionId, openAt: candle.openAt, closeAt: candle.closeAt, observedAt: candle.observedAt, quality, nowMs: now, historyLength: history.length, inputHash });
      for (const e of stored) {
        const inserted = insertEvent(db, e);
        if (!inserted) continue;
        const alert = buildAlert(e, instrument, result.state, policy, mode);
        if (alert && this.#socialContext) { const social = this.#socialContext(instrument.instrumentId, e.emittedAt); if (social) alert.payload['social'] = social; }
        if (alert && insertAlert(db, { ...alert, delivered: {} })) alerts.push(alert);
      }
      for (const d of result.diagnostics) incrementStat(db, runId, instrument.instrumentId, d.code);
      upsertHead(db, { runId, instrumentId: instrument.instrumentId, seq, phase: result.state.phase, lastOpenAt: result.state.lastOpenAt, state: result.state, updatedAt: now });
    });
    this.#state = result.state;
    summary.processed += 1;
    summary.events.push(...stored);
    for (const alert of alerts) {
      const delivered = dispatcher ? await dispatcher.dispatch(alert) : { none: 'no dispatcher' };
      updateAlertDelivery(db, alert.alertId, delivered);
      summary.alerts.push(alert);
    }
  }
}

export function storedToCandle(r: StoredCandle, intervalMs: number, observedAt: number = r.firstObservedAt): Candle {
  return toCandle(
    { openTime: r.openAt, open: r.open, high: r.high, low: r.low, close: r.close, volume: r.baseVolume, closeTime: r.sourceCloseAt, quoteVolume: r.quoteVolume, trades: r.tradeCount ?? '', contentHash: r.contentHash },
    r.versionId, intervalMs, observedAt,
  );
}
