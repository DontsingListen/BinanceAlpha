/**
 * Local alerts ("下单提醒"). Alerts are derived from persisted decision events and delivered to local sinks only:
 * console, a JSONL file and the SQLite `alerts` table. No external push and no order execution exist here.
 * A future order-execution integration plugs in as another AlertSink consuming level === 'ORDER'
 * and needs its own ADR/scope update per docs/adr/0001-project-foundation.md.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Policy } from '../domain/policy.ts';
import type { EngineState, Setup } from '../domain/types.ts';
import { sha256Hex } from '../domain/hash.ts';
import type { InstrumentRow, StoredEvent } from '../storage/repos.ts';

export type AlertLevel = 'DISCOVERY' | 'TRACKING' | 'SETUP' | 'ORDER' | 'CONFIRM' | 'EXIT' | 'REJECTED' | 'INFO' | 'MENTION' | 'MENTION_SETUP';

export type Alert = {
  readonly alertId: string;
  readonly eventId: string;
  readonly runId: string;
  readonly instrumentId: string;
  readonly level: AlertLevel;
  readonly code: string;
  readonly createdAt: number;
  readonly isFresh: boolean;
  readonly payload: Record<string, unknown>;
};

export interface AlertSink {
  readonly name: string;
  deliver(alert: Alert): void | Promise<void>;
}

const LEVEL_BY_CODE: Record<string, AlertLevel> = {
  IMPULSE_DETECTED: 'DISCOVERY',
  PULLBACK_CONFIRMED: 'TRACKING',
  BASE_FORMED: 'SETUP',
  SECOND_LEG_BREAKOUT: 'ORDER',
  SECOND_LEG_CONFIRMED: 'CONFIRM',
};

/** Maps a persisted event to an alert, or null when the event is not alert-worthy. */
export function buildAlert(event: StoredEvent, instrument: InstrumentRow, state: EngineState, policy: Policy, mode: string): Alert | null {
  let level: AlertLevel | null = LEVEL_BY_CODE[event.code] ?? null;
  if (event.kind === 'BREAKOUT_REJECTED') level = 'REJECTED';
  if (event.kind === 'TRANSITION' && (event.toPhase === 'INVALIDATED' || event.toPhase === 'EXPIRED')) {
    level = event.fromPhase === 'BREAKOUT' ? 'EXIT' : 'INFO';
  }
  if (level === null) return null;
  const setup: Setup | null = state.setup;
  const payload: Record<string, unknown> = {
    mode,
    symbol: instrument.symbol,
    displaySymbol: instrument.displaySymbol,
    tokenName: instrument.tokenName,
    alphaId: instrument.alphaId,
    chain: instrument.chainName,
    contractAddress: instrument.contractAddress,
    phase: { from: event.fromPhase, to: event.toPhase },
    timing: {
      decisionBarCloseAt: iso(event.decisionBarCloseAt),
      emittedAt: iso(event.emittedAt),
      latencyMs: event.emittedAt - event.decisionBarCloseAt,
      isFresh: event.isFresh,
      note: event.isFresh ? 'timely' : 'historical backfill (late); not a timely signal',
    },
    measured: event.values,
    thresholds: event.thresholds,
    setup: setup ? summarizeSetup(setup) : null,
    policy: { version: policy.policyVersion, hash: policy.policyHash },
    disclaimer: 'research event from second-leg-v0-proposed; not an order instruction and not validated for profitability',
  };
  if (level === 'ORDER' && setup) {
    payload['suggestedAction'] = {
      action: 'CONSIDER_ENTRY',
      entryReference: 'open of the first candle with openAt >= emittedAt (never the trigger close)',
      triggerClose: setup.breakoutClose,
      pivot: setup.pivot,
      invalidationPrice: setup.invalidationPrice,
      invalidationRule: 'close strictly below invalidationPrice (close-only, wicks ignored)',
      confirmationRule: `${policy.parameters.confirmationBars} consecutive closes >= pivot within ${policy.parameters.confirmationWindowBars} bars`,
    };
  }
  if (level === 'EXIT' && setup) {
    payload['suggestedAction'] = { action: 'REVIEW_OPEN_POSITION', reason: event.code, invalidationPrice: setup.invalidationPrice };
  }
  return {
    alertId: sha256Hex('alert', event.eventId).slice(0, 32),
    eventId: event.eventId,
    runId: event.runId,
    instrumentId: event.instrumentId,
    level,
    code: event.code,
    createdAt: event.emittedAt,
    isFresh: event.isFresh,
    payload,
  };
}

function summarizeSetup(s: Setup): Record<string, unknown> {
  return {
    setupId: s.setupId, activationCloseAt: iso(s.activationCloseAt), B: s.B, P: s.P, impulseReturn: s.impulseReturn, impulseVolumeRatio: s.impulseVolumeRatio,
    supportPrice: s.supportPrice, pullbackDepth: s.pullbackDepth, pivot: s.pivot, baseLow: s.baseLow, baseMedianVolume: s.baseMedianVolume,
    invalidationPrice: s.invalidationPrice, breakoutClose: s.breakoutClose, terminalReason: s.terminalReason,
  };
}

function iso(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}

export class ConsoleSink implements AlertSink {
  readonly name = 'console';
  readonly #write: (line: string) => void;
  constructor(write: (line: string) => void = (l) => process.stdout.write(l + '\n')) {
    this.#write = write;
  }
  deliver(a: Alert): void {
    const p = a.payload as { displaySymbol?: string; symbol?: string; setup?: Record<string, unknown> | null; timing?: { decisionBarCloseAt?: string; latencyMs?: number } };
    const tag = a.isFresh ? '' : ' [LATE]';
    if (a.level === 'MENTION' || a.level === 'MENTION_SETUP') {
      const m = (a.payload['mention'] ?? {}) as Record<string, unknown>;
      const src = (a.payload['source'] ?? {}) as Record<string, unknown>;
      const post = (a.payload['post'] ?? {}) as Record<string, unknown>;
      const market = (a.payload['market'] ?? null) as Record<string, unknown> | null;
      this.#write(`[ALERT ${a.level}${tag}] ${String(m['tokenText'])} ${String(m['resolution'])} (${a.instrumentId}) by ${String(src['kind'])}:${String(src['handle'] ?? src['sourceId'])} stance=${String(m['stance'])} conf=${String(m['confidence'])} phase=${String(market?.['phase'] ?? '-')} ${String(post['url'] ?? post['id'])}`);
      return;
    }
    const s = p.setup ?? {};
    const detail = a.level === 'ORDER'
      ? ` close=${fmt(s['breakoutClose'])} pivot=${fmt(s['pivot'])} stop=${fmt(s['invalidationPrice'])}`
      : a.level === 'SETUP'
        ? ` pivot=${fmt(s['pivot'])} stop=${fmt(s['invalidationPrice'])}`
        : a.level === 'DISCOVERY'
          ? ` ret=${pct(s['impulseReturn'])} volx=${fmt(s['impulseVolumeRatio'])} P=${fmt(s['P'])}`
          : '';
    this.#write(`[ALERT ${a.level}${tag}] ${p.displaySymbol ?? ''} (${p.symbol ?? a.instrumentId}) ${a.code} bar=${p.timing?.decisionBarCloseAt ?? ''} lag=${p.timing?.latencyMs ?? ''}ms${detail}`);
  }
}

function fmt(v: unknown): string {
  return typeof v === 'number' ? v.toPrecision(6) : String(v ?? '-');
}

function pct(v: unknown): string {
  return typeof v === 'number' ? (v * 100).toFixed(1) + '%' : '-';
}

export class JsonlSink implements AlertSink {
  readonly name = 'jsonl';
  readonly #path: string;
  constructor(path: string) {
    this.#path = path;
    mkdirSync(dirname(path), { recursive: true });
  }
  deliver(a: Alert): void {
    appendFileSync(this.#path, JSON.stringify(a) + '\n');
  }
}

export class AlertDispatcher {
  readonly #sinks: readonly AlertSink[];
  constructor(sinks: readonly AlertSink[]) {
    this.#sinks = sinks;
  }
  /** Delivers to every sink; a failing sink is recorded, never thrown, so one sink cannot block the others. */
  async dispatch(alert: Alert): Promise<Record<string, string>> {
    const result: Record<string, string> = {};
    for (const sink of this.#sinks) {
      try {
        await sink.deliver(alert);
        result[sink.name] = 'ok';
      } catch (error) {
        result[sink.name] = `error: ${(error as Error).message}`;
      }
    }
    return result;
  }
}
