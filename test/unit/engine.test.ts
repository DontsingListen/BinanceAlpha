import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../src/storage/db.ts';
import { getHead, getInstrument, insertCandleVersion, listAlerts, listEvents, upsertInstrument, type InstrumentRow } from '../../src/storage/repos.ts';
import { parseKlineRows } from '../../src/adapters/binance-alpha/dto.ts';
import { AlertDispatcher, type Alert, type AlertSink } from '../../src/application/alerts.ts';
import { InstrumentRunner } from '../../src/application/engine.ts';
import { INTERVAL, loadPolicy, mk, scenarioToBase } from './helpers.ts';
import type { Candle } from '../../src/domain/types.ts';

const policy = loadPolicy();
const ID = 'binance-alpha:alpha:ALPHA_1USDT';

function setup(): { db: ReturnType<typeof openDatabase>; instrument: InstrumentRow; delivered: Alert[]; dispatcher: AlertDispatcher } {
  const db = openDatabase(':memory:');
  upsertInstrument(db, { instrumentId: ID, provider: 'binance-alpha', marketType: 'alpha', symbol: 'ALPHA_1USDT', alphaId: 'ALPHA_1', baseAsset: 'ALPHA_1', quoteAsset: 'USDT', displaySymbol: 'TST', tokenName: 'Test', chainId: '56', chainName: 'BSC', contractAddress: '0x1', status: 'TRADING', tokenOffline: false }, 1);
  const delivered: Alert[] = [];
  const sink: AlertSink = { name: 'capture', deliver: (a) => { delivered.push(a); } };
  return { db, instrument: getInstrument(db, ID) as InstrumentRow, delivered, dispatcher: new AlertDispatcher([sink]) };
}

function insert(db: ReturnType<typeof openDatabase>, candles: readonly Candle[], observedAt = 0): void {
  for (const c of candles) {
    const row = parseKlineRows([[String(c.openAt), String(c.open), String(c.high), String(c.low), String(c.close), String(c.baseVolume), String(c.openAt + INTERVAL - 1), String(c.quoteVolume), '1', '0', '0', '0']], INTERVAL).rows[0]!;
    insertCandleVersion(db, ID, INTERVAL, row, observedAt || c.observedAt, null);
  }
}

const runner = (s: ReturnType<typeof setup>, runId = 'run-1') => new InstrumentRunner({ db: s.db, policy, runId, mode: 'test', instrument: s.instrument, intervalMs: INTERVAL, dispatcher: s.dispatcher, clock: (c) => c.closeAt + 8000 });

test('runner persists journal, events, head and alerts; restart resumes without duplicates', async () => {
  const s = setup();
  const bars = scenarioToBase();
  bars.push(mk(319, { o: 1.16, c: 1.19, h: 1.2, l: 1.16, v: 400 }));
  bars.push(mk(320, { c: 1.18 }));
  bars.push(mk(321, { c: 1.18 }));
  insert(s.db, bars);
  const r1 = await runner(s).advance();
  assert.equal(r1.processed, 322);
  assert.equal(r1.phase, 'CONFIRMED');
  const codes = listEvents(s.db, { runId: 'run-1' }).map((e) => e.code);
  assert.deepEqual(codes, ['WARMUP_COMPLETE', 'IMPULSE_DETECTED', 'PULLBACK_CONFIRMED', 'BASE_FORMED', 'SECOND_LEG_BREAKOUT', 'SECOND_LEG_CONFIRMED']);
  assert.deepEqual(s.delivered.map((a) => a.level), ['DISCOVERY', 'TRACKING', 'SETUP', 'ORDER', 'CONFIRM']);
  const order = s.delivered.find((a) => a.level === 'ORDER')!;
  const action = order.payload['suggestedAction'] as Record<string, unknown>;
  assert.equal(action['pivot'], 1.17);
  assert.ok(Math.abs((action['invalidationPrice'] as number) - 1.1074) < 1e-12);
  assert.equal(listAlerts(s.db, { runId: 'run-1' }).length, 5);
  assert.deepEqual(listAlerts(s.db, { runId: 'run-1' })[0]!.delivered, { capture: 'ok' });
  const head = getHead(s.db, 'run-1', ID)!;
  assert.equal(head.seq, 322);
  assert.equal(head.phase, 'CONFIRMED');
  // restart from the head: nothing new to process, no duplicate events or alerts
  const r2 = await runner(s).advance();
  assert.equal(r2.processed, 0);
  assert.equal(listEvents(s.db, { runId: 'run-1' }).length, 6);
  assert.equal(s.delivered.length, 5);
  // more data arrives: only the new bars are processed and seq continues
  insert(s.db, [mk(322, { c: 1.18 }), mk(323, { c: 1.18 })]);
  const r3 = await runner(s).advance();
  assert.equal(r3.processed, 2);
  assert.equal(getHead(s.db, 'run-1', ID)!.seq, 324);
  assert.equal(r3.historyLength, 302); // trailing window capped at warmupBars + 2
});

test('runner detects a missing bar as GAP and restarts the continuous history', async () => {
  const s = setup();
  const bars = scenarioToBase().filter((c) => c.openAt !== mk(315, { c: 1 }).openAt); // drop bar 315
  insert(s.db, bars);
  const r = await runner(s).advance();
  assert.equal(r.gaps, 1);
  assert.ok(r.events.some((e) => e.code === 'CANDLE_GAP'));
  assert.equal(r.phase, 'PULLBACK'); // base window restarted after the gap: only 3 continuous bars after it
  assert.equal(r.historyLength, 3);
});

test('a revised consumed candle emits DATA_REVISED, terminates the setup, and the window is rebuilt', async () => {
  const s = setup();
  const bars = scenarioToBase().slice(0, 315); // through bar 314 (PULLBACK)
  insert(s.db, bars);
  const first = await runner(s).advance();
  assert.equal(first.phase, 'PULLBACK');
  // a later fetch returns a different close for bar 313
  const revised = mk(313, { o: 1.15, c: 1.151, h: 1.17, l: 1.13, v: 150 });
  insert(s.db, [revised], revised.observedAt + 60_000);
  insert(s.db, [mk(315, { c: 1.15, h: 1.17, l: 1.13, v: 150 })]);
  const second = await runner(s).advance();
  assert.equal(second.revisions, 1);
  const codes = second.events.map((e) => `${e.code}:${e.fromPhase}->${e.toPhase}`);
  assert.equal(codes[0], 'DATA_REVISED:PULLBACK->INVALIDATED');
  assert.equal(second.processed, 2); // the revision input + bar 315
  assert.equal(second.phase, 'INVALIDATED');
  assert.equal(getHead(s.db, 'run-1', ID)!.lastOpenAt, mk(315, { c: 1 }).openAt);
});
