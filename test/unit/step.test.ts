import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eventsOf, flat, loadPolicy, mk, run, scenarioToBase } from './helpers.ts';
import { step } from '../../src/domain/step.ts';
import { INITIAL_STATE } from '../../src/domain/types.ts';

const policy = loadPolicy();

test('normal path: warmup -> impulse -> pullback -> base -> breakout -> confirmed -> cooldown', () => {
  const bars = scenarioToBase();
  // breakout bar 319: close 1.19 > pivot 1.17 * 1.003 = 1.17351; prev close 1.16; v=400 -> ratio 2.67; extension 1.7%
  bars.push(mk(319, { o: 1.16, c: 1.19, h: 1.2, l: 1.16, v: 400, q: 500 }));
  bars.push(mk(320, { c: 1.18, v: 200 })); // >= pivot (1.17): consecutive 1
  bars.push(mk(321, { c: 1.18, v: 200 })); // consecutive 2 -> CONFIRMED
  // cooldown 24 valid bars: 322..345 ; bar 345 -> COOLDOWN_COMPLETE
  for (let i = 322; i <= 346; i++) bars.push(mk(i, { c: 1.18 }));
  const traces = run(bars, policy);
  const ev = eventsOf(traces).filter((e) => e.code !== 'WARMUP_COMPLETE');
  assert.deepEqual(ev, [
    { index: 311, code: 'IMPULSE_DETECTED', from: 'IDLE', to: 'IMPULSE' },
    { index: 312, code: 'PULLBACK_CONFIRMED', from: 'IMPULSE', to: 'PULLBACK' },
    { index: 318, code: 'BASE_FORMED', from: 'PULLBACK', to: 'BASE' },
    { index: 319, code: 'SECOND_LEG_BREAKOUT', from: 'BASE', to: 'BREAKOUT' },
    { index: 321, code: 'SECOND_LEG_CONFIRMED', from: 'BREAKOUT', to: 'CONFIRMED' },
    { index: 345, code: 'COOLDOWN_COMPLETE', from: 'CONFIRMED', to: 'IDLE' },
  ]);
  assert.equal(eventsOf(traces)[0]?.code, 'WARMUP_COMPLETE');
  assert.equal(eventsOf(traces)[0]?.index, 299);
  // frozen values
  const impulse = traces[311]!.events[0]!;
  assert.equal(impulse.values['B'], 1.0);
  assert.equal(impulse.values['P'], 1.26);
  assert.ok(Math.abs((impulse.values['volumeRatio'] as number) - 4.25) < 1e-12);
  const pull = traces[312]!.events[0]!;
  assert.ok(Math.abs((pull.values['depth'] as number) - 0.11 / 0.26) < 1e-12);
  assert.ok(Math.abs((pull.values['supportPrice'] as number) - 1.091) < 1e-12);
  const base = traces[318]!.events[0]!;
  assert.equal(base.values['pivot'], 1.17);
  assert.equal(base.values['baseLow'], 1.13);
  assert.ok(Math.abs((base.values['invalidationPrice'] as number) - 1.1074) < 1e-12);
  const brk = traces[319]!.events[0]!;
  assert.ok(Math.abs((brk.values['volumeRatio'] as number) - 400 / 150) < 1e-12);
  assert.equal(brk.isFresh, true);
  // the setup stays frozen after breakout
  assert.equal(traces[321]!.state.setup?.pivot, 1.17);
  assert.equal(traces[346]!.state.phase, 'IDLE');
});

test('impulse not detected before 300 continuous bars (WARMUP) and detected exactly at >= 20% (ratio form)', () => {
  const bars = flat(311, 0, { c: 1.0, h: 1.01, l: 0.99 });
  bars.push(mk(311, { o: 1.0, c: 1.2, h: 1.21, l: 1.0, v: 4000 })); // exactly +20%
  const traces = run(bars, policy);
  assert.equal(traces[310]!.state.phase, 'IDLE');
  assert.equal(traces[311]!.state.phase, 'IMPULSE');
  // 300 bars in total: the impulse bar itself completes warmup (-> IDLE); G1 is evaluated from the next bar
  const exact = run(bars.slice(12), policy);
  assert.equal(exact[exact.length - 1]!.state.phase, 'IDLE');
  assert.equal(exact[exact.length - 1]!.events[0]?.code, 'WARMUP_COMPLETE');
  const short = run(bars.slice(13), policy); // 299 bars: still WARMUP
  assert.equal(short[short.length - 1]!.state.phase, 'WARMUP');
});

test('impulse rejected: volume ratio just below 3 and close not above 12-bar window high', () => {
  const bars = flat(311, 0, { c: 1.0, h: 1.01, l: 0.99, v: 100 });
  // mean(V[300..311]) = (11*100 + v)/12 ; ratio < 3 when v < 2500
  bars.push(mk(311, { o: 1.0, c: 1.25, h: 1.26, l: 1.0, v: 2499 }));
  let traces = run(bars, policy);
  assert.equal(traces[311]!.state.phase, 'IDLE');
  assert.equal(traces[311]!.diagnostics[0]?.code, 'IMPULSE_VOLUME_BELOW_MIN');
  bars[311] = mk(311, { o: 1.0, c: 1.25, h: 1.26, l: 1.0, v: 2500 }); // ratio exactly 3 -> ok
  traces = run(bars, policy);
  assert.equal(traces[311]!.state.phase, 'IMPULSE');
  // window high above close -> no impulse
  bars[310] = mk(310, { c: 1.0, h: 1.3, l: 0.99 });
  traces = run(bars, policy);
  assert.equal(traces[311]!.state.phase, 'IDLE');
  assert.equal(traces[311]!.diagnostics[0]?.code, 'IMPULSE_NO_WINDOW_HIGH');
});

test('G0 low activity blocks impulse; zero-volume baseline is reported when activity passes', () => {
  const bars = flat(311, 0, { c: 1.0, h: 1.01, l: 0.99, v: 100, q: 300 }); // 288*300 = 86400 < 100000
  bars.push(mk(311, { o: 1.0, c: 1.25, h: 1.26, l: 1.0, v: 4000, q: 5000 }));
  const traces = run(bars, policy);
  assert.equal(traces[311]!.state.phase, 'IDLE');
  assert.equal(traces[311]!.diagnostics[0]?.code, 'LOW_ACTIVITY');
  // zero baseline: all warmup bars zero volume; relax positive fraction so the activity gate passes
  const relaxed = loadPolicy({ minPositiveVolumeFraction: 0.001 }); // 1/288 positive bars must pass the gate
  const zero = flat(311, 0, { c: 1.0, h: 1.01, l: 0.99, v: 0, q: 500 });
  zero.push(mk(311, { o: 1.0, c: 1.25, h: 1.26, l: 1.0, v: 4000, q: 5000 }));
  const t2 = run(zero, relaxed);
  assert.equal(t2[311]!.diagnostics[0]?.code, 'ZERO_VOLUME_BASELINE');
  assert.equal(t2[311]!.state.phase, 'IDLE');
});

test('retracement deeper than 65% invalidates the impulse', () => {
  const bars = scenarioToBase().slice(0, 312);
  bars.push(mk(312, { o: 1.25, c: 1.05, h: 1.25, l: 1.04, v: 300 })); // d = 0.21/0.26 = 0.81
  const traces = run(bars, policy);
  assert.deepEqual(eventsOf(traces).at(-1), { index: 312, code: 'IMPULSE_RETRACEMENT_TOO_DEEP', from: 'IMPULSE', to: 'INVALIDATED' });
  assert.equal(traces[312]!.state.cooldownRemaining, 24);
});

test('V-shape: close above frozen high during pullback ends the setup without a base', () => {
  const bars = scenarioToBase().slice(0, 313);
  bars.push(mk(313, { o: 1.15, c: 1.27, h: 1.28, l: 1.15, v: 300 }));
  const traces = run(bars, policy);
  assert.deepEqual(eventsOf(traces).at(-1), { index: 313, code: 'NEW_IMPULSE_WITHOUT_BASE', from: 'PULLBACK', to: 'INVALIDATED' });
});

test('pullback: close strictly below support line invalidates; equal does not', () => {
  const bars = scenarioToBase().slice(0, 313);
  bars.push(mk(313, { o: 1.15, c: 1.091, h: 1.15, l: 1.09, v: 150 })); // support = 1.0 + 0.35*0.26 = 1.091 (equal)
  let traces = run(bars, policy);
  assert.equal(traces[313]!.state.phase, 'PULLBACK');
  bars[313] = mk(313, { o: 1.15, c: 1.0909, h: 1.15, l: 1.09, v: 150 });
  traces = run(bars, policy);
  assert.deepEqual(eventsOf(traces).at(-1), { index: 313, code: 'SUPPORT_BROKEN', from: 'PULLBACK', to: 'INVALIDATED' });
});

test('base not formed when median volume has not contracted or range too wide', () => {
  const bars = scenarioToBase();
  for (let k = 0; k < 6; k++) bars[313 + k] = mk(313 + k, { c: 1.15, h: 1.17, l: 1.13, v: 300 }); // 300/425 = 0.706 > 0.5
  let traces = run(bars, policy);
  assert.equal(traces[318]!.state.phase, 'PULLBACK');
  assert.equal(traces[318]!.diagnostics[0]?.code, 'BASE_NOT_FORMED');
  const wide = scenarioToBase();
  wide[315] = mk(315, { c: 1.15, h: 1.23, l: 1.13, v: 150 }); // (1.23-1.13)/1.13 = 0.088 > 0.08
  traces = run(wide, policy);
  assert.equal(traces[318]!.state.phase, 'PULLBACK');
  // base forms once the wide bar leaves the 6-bar window (bars 316..321)
  for (let k = 319; k <= 321; k++) wide.push(mk(k, { c: 1.15, h: 1.17, l: 1.13, v: 150 }));
  traces = run(wide, policy);
  assert.deepEqual(eventsOf(traces).at(-1), { index: 321, code: 'BASE_FORMED', from: 'PULLBACK', to: 'BASE' });
});

test('low-volume cross is rejected once; no re-signal while above threshold; re-cross after dipping back signals', () => {
  const bars = scenarioToBase();
  bars.push(mk(319, { o: 1.16, c: 1.19, h: 1.2, l: 1.16, v: 200 })); // ratio 1.33 < 2 -> rejected
  bars.push(mk(320, { o: 1.19, c: 1.2, h: 1.21, l: 1.19, v: 500 })); // still above threshold -> nothing
  bars.push(mk(321, { o: 1.2, c: 1.17, h: 1.2, l: 1.16, v: 150 })); // back inside (<= 1.17351)
  bars.push(mk(322, { o: 1.17, c: 1.19, h: 1.2, l: 1.17, v: 500 })); // re-cross with volume -> BREAKOUT
  const traces = run(bars, policy);
  const ev = eventsOf(traces).filter((e) => e.index >= 319);
  assert.deepEqual(ev, [
    { index: 319, code: 'BREAKOUT_LOW_VOLUME', from: 'BASE', to: 'BASE' },
    { index: 322, code: 'SECOND_LEG_BREAKOUT', from: 'BASE', to: 'BREAKOUT' },
  ]);
  assert.equal(traces[319]!.events[0]!.kind, 'BREAKOUT_REJECTED');
  assert.equal(traces[320]!.diagnostics[0]?.code, 'PIVOT_NOT_CROSSED');
});

test('overextended breakout is rejected; exactly 8% is accepted', () => {
  const bars = scenarioToBase();
  bars.push(mk(319, { o: 1.16, c: 1.17 * 1.08 + 1e-9, h: 1.3, l: 1.16, v: 500 }));
  let traces = run(bars, policy);
  assert.deepEqual(eventsOf(traces).at(-1), { index: 319, code: 'BREAKOUT_OVEREXTENDED', from: 'BASE', to: 'BASE' });
  bars[319] = mk(319, { o: 1.16, c: 1.17 * 1.08, h: 1.3, l: 1.16, v: 500 });
  traces = run(bars, policy);
  assert.deepEqual(eventsOf(traces).at(-1), { index: 319, code: 'SECOND_LEG_BREAKOUT', from: 'BASE', to: 'BREAKOUT' });
});

test('breakout then close below invalidation line -> INVALIDATED (structural beats confirmation)', () => {
  const bars = scenarioToBase();
  bars.push(mk(319, { o: 1.16, c: 1.19, h: 1.2, l: 1.16, v: 400 }));
  bars.push(mk(320, { o: 1.19, c: 1.10, h: 1.19, l: 1.09, v: 400 })); // < 1.1074
  const traces = run(bars, policy);
  assert.deepEqual(eventsOf(traces).at(-1), { index: 320, code: 'SUPPORT_BROKEN', from: 'BREAKOUT', to: 'INVALIDATED' });
});

test('confirmation on the 6th bar wins over timeout; otherwise CONFIRMATION_TIMEOUT on bar 6', () => {
  const base = scenarioToBase();
  base.push(mk(319, { o: 1.16, c: 1.19, h: 1.2, l: 1.16, v: 400 }));
  const confirm = [...base];
  for (let i = 320; i <= 323; i++) confirm.push(mk(i, { c: 1.16 }));
  confirm.push(mk(324, { c: 1.18 }));
  confirm.push(mk(325, { c: 1.18 }));
  let traces = run(confirm, policy);
  assert.deepEqual(eventsOf(traces).at(-1), { index: 325, code: 'SECOND_LEG_CONFIRMED', from: 'BREAKOUT', to: 'CONFIRMED' });
  const timeout = [...base];
  for (let i = 320; i <= 325; i++) timeout.push(mk(i, { c: 1.16 }));
  traces = run(timeout, policy);
  assert.deepEqual(eventsOf(traces).at(-1), { index: 325, code: 'CONFIRMATION_TIMEOUT', from: 'BREAKOUT', to: 'EXPIRED' });
  assert.equal(traces[324]!.state.phase, 'BREAKOUT');
});

test('72h lifetime expires an impulse that never pulls back', () => {
  const bars = scenarioToBase().slice(0, 312);
  for (let i = 312; i <= 1175; i++) bars.push(mk(i, { c: 1.25, h: 1.255, l: 1.245 })); // d = 0.01/0.26 < 0.25
  const traces = run(bars, policy);
  assert.equal(traces[1174]!.state.phase, 'IMPULSE');
  assert.deepEqual(eventsOf(traces).at(-1), { index: 1175, code: 'SETUP_EXPIRED', from: 'IMPULSE', to: 'EXPIRED' });
});

test('gap during pullback pauses, keeps state, and restarts the base window', () => {
  const bars = scenarioToBase();
  const traces = run(bars, policy, { gaps: [315] });
  assert.equal(traces[315]!.events[0]?.code, 'CANDLE_GAP');
  assert.equal(traces[315]!.state.phase, 'PULLBACK');
  assert.equal(traces[318]!.state.phase, 'PULLBACK'); // only 4 continuous bars after the gap
  for (let k = 319; k <= 320; k++) bars.push(mk(k, { c: 1.15, h: 1.17, l: 1.13, v: 150 }));
  const t2 = run(bars, policy, { gaps: [315] });
  assert.deepEqual(eventsOf(t2).at(-1), { index: 320, code: 'BASE_FORMED', from: 'PULLBACK', to: 'BASE' });
  // gap while IDLE returns to WARMUP
  const idle = flat(305, 0, { c: 1.0 });
  const t3 = run(idle, policy, { gaps: [302] });
  assert.equal(t3[301]!.state.phase, 'IDLE');
  assert.equal(t3[302]!.state.phase, 'WARMUP');
});

test('revision of a consumed candle terminates the active setup with DATA_REVISED', () => {
  const bars = scenarioToBase();
  const traces = run(bars, policy, { revised: [314] });
  assert.deepEqual(eventsOf(traces).at(-1), { index: 314, code: 'DATA_REVISED', from: 'PULLBACK', to: 'INVALIDATED' });
});

test('late inputs keep events but mark isFresh=false', () => {
  const bars = scenarioToBase();
  const traces = run(bars, policy, { lateMs: 11 * 60_000 });
  assert.equal(traces[311]!.events[0]!.code, 'IMPULSE_DETECTED');
  assert.equal(traces[311]!.events[0]!.isFresh, false);
});

test('future data never changes past events (prefix stability)', () => {
  const bars = scenarioToBase();
  bars.push(mk(319, { o: 1.16, c: 1.19, h: 1.2, l: 1.16, v: 400 }));
  const prefix = run(bars.slice(0, 313), policy);
  const full = run([...bars, mk(320, { c: 3.0, h: 3.5, l: 1.0, v: 99999 }), mk(321, { c: 0.5, h: 3.0, l: 0.4, v: 99999 })], policy);
  assert.deepEqual(eventsOf(full).filter((e) => e.index <= 312), eventsOf(prefix));
  assert.deepEqual(full[312]!.state, prefix[312]!.state);
});

test('step contract: rejects non-monotonic seq, discontinuous history and clock before observedAt', () => {
  const c = mk(0, { c: 1 });
  assert.throws(() => step(INITIAL_STATE, { instrumentId: 'x', seq: 2, candle: c, history: [c], quality: 'OK', now: c.observedAt }, policy), /seq must be 1/);
  const c1 = mk(2, { c: 1 });
  assert.throws(() => step(INITIAL_STATE, { instrumentId: 'x', seq: 1, candle: c1, history: [c, c1], quality: 'OK', now: c1.observedAt }, policy), /not continuous/);
  assert.throws(() => step(INITIAL_STATE, { instrumentId: 'x', seq: 1, candle: c, history: [c], quality: 'OK', now: c.observedAt - 1 }, policy), /now must not precede/);
});
