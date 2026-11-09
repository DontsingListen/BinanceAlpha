import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parsePolicy, type Policy } from '../../src/domain/policy.ts';
import { step } from '../../src/domain/step.ts';
import { INITIAL_STATE } from '../../src/domain/types.ts';
import type { Candle, DecisionEvent, Diagnostic, EngineState } from '../../src/domain/types.ts';

export const ROOT = resolve(import.meta.dirname, '../..');
export const INTERVAL = 300_000;
export const T0 = 1_790_000_100_000; // aligned base: 300000 * 5966667

export function loadPolicy(overrides: Record<string, number> = {}): Policy {
  const doc = JSON.parse(readFileSync(resolve(ROOT, 'spec/policy-v0.proposed.json'), 'utf8')) as { parameters: Record<string, number> };
  doc.parameters = { ...doc.parameters, ...overrides };
  return parsePolicy(doc);
}

export type Bar = { o?: number; h?: number; l?: number; c: number; v?: number; q?: number };

/** Builds a candle at bar index i. Defaults: o=c, h=c*1.01, l=c*0.99, v=100, q=500. */
export function mk(i: number, b: Bar): Candle {
  const c = b.c;
  const o = b.o ?? c;
  const h = b.h ?? Math.max(o, c) * 1.01;
  const l = b.l ?? Math.min(o, c) * 0.99;
  const openAt = T0 + i * INTERVAL;
  return {
    versionId: `v${i}`,
    openAt, closeAt: openAt + INTERVAL,
    open: o, high: h, low: l, close: c,
    baseVolume: b.v ?? 100, quoteVolume: b.q ?? 500, tradeCount: null,
    observedAt: openAt + INTERVAL + 1000,
  };
}

export function flat(count: number, startIndex: number, bar: Bar): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < count; i++) out.push(mk(startIndex + i, bar));
  return out;
}

export type Trace = { index: number; events: DecisionEvent[]; diagnostics: Diagnostic[]; state: EngineState };

/**
 * Feeds candles sequentially through step(), maintaining the continuous history the way the application does.
 * `gaps` lists candle indices (position in the array) that should be presented as GAP inputs (history reset).
 * `revised` lists positions presented as REVISED inputs. `lateMs` adds latency to `now`.
 */
export function run(candles: readonly Candle[], policy: Policy, opts: { gaps?: number[]; revised?: number[]; lateMs?: number; startState?: EngineState } = {}): Trace[] {
  let state = opts.startState ?? INITIAL_STATE;
  let history: Candle[] = [];
  const traces: Trace[] = [];
  candles.forEach((candle, pos) => {
    const isGap = opts.gaps?.includes(pos) ?? false;
    const isRevised = opts.revised?.includes(pos) ?? false;
    if (isGap || isRevised) history = [];
    history.push(candle);
    if (history.length > policy.parameters.warmupBars + 10) history = history.slice(-policy.parameters.warmupBars - 10);
    const result = step(state, {
      instrumentId: 'test:alpha:TESTUSDT', seq: state.seq + 1, candle, history, quality: isRevised ? 'REVISED' : isGap ? 'GAP' : 'OK',
      now: candle.observedAt + (opts.lateMs ?? 0),
    }, policy);
    state = result.state;
    traces.push({ index: pos, events: [...result.events], diagnostics: [...result.diagnostics], state });
  });
  return traces;
}

export function eventsOf(traces: Trace[]): { index: number; code: string; from: string; to: string }[] {
  return traces.flatMap((t) => t.events.map((e) => ({ index: t.index, code: e.code, from: e.fromPhase, to: e.toPhase })));
}

/**
 * Canonical synthetic scenario (hand-derived expectations, see test comments):
 * bars 0..310 flat at 1.0 (v=100,q=500), bar 311 impulse close 1.25 high 1.26 v=4000,
 * bar 312 pullback open 1.2 close 1.15 (high 1.2, low 1.14, v=150), bars 313..318 base (closes 1.15,1.16,1.15,1.14,1.15,1.16; h=1.17; l=1.13; v=150).
 */
export function scenarioToBase(): Candle[] {
  const bars = flat(311, 0, { c: 1.0, h: 1.01, l: 0.99, v: 100, q: 500 });
  bars.push(mk(311, { o: 1.0, c: 1.25, h: 1.26, l: 1.0, v: 4000, q: 5000 }));
  bars.push(mk(312, { o: 1.2, c: 1.15, h: 1.2, l: 1.14, v: 150, q: 500 }));
  const baseCloses = [1.15, 1.16, 1.15, 1.14, 1.15, 1.16];
  baseCloses.forEach((c, k) => bars.push(mk(313 + k, { o: c, c, h: 1.17, l: 1.13, v: 150, q: 500 })));
  return bars;
}
