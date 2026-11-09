/**
 * Pure second-leg state machine: step(previousState, input, policy) -> { state, events, diagnostics }.
 * Implements docs/04-strategy-spec.md (rule version second-leg-v0-proposed).
 * No network, file, database, system clock or randomness is read here.
 *
 * Invariant kept stricter than the spec's minimum: at most ONE phase change per input.
 * The bar that completes WARMUP or cooldown becomes IDLE and G1 is evaluated from the next bar.
 */
import type {
  Candle, DecisionEvent, DecisionInput, Diagnostic, EngineState, EventKind, MeasuredValues,
  Phase, ReasonCode, Setup, StepResult,
} from './types.ts';
import { ACTIVE_PHASES, TERMINAL_PHASES } from './types.ts';
import type { Policy } from './policy.ts';
import { setupTtlMs } from './policy.ts';
import { max, mean, median, min, safeDiv, sum } from './math.ts';
import { sha256Hex } from './hash.ts';

type Ctx = {
  readonly input: DecisionInput;
  readonly policy: Policy;
  readonly events: DecisionEvent[];
  readonly diagnostics: Diagnostic[];
};

export class StepContractError extends Error {}

export function step(prev: EngineState, input: DecisionInput, policy: Policy): StepResult {
  validateInput(prev, input);
  const ctx: Ctx = { input, policy, events: [], diagnostics: [] };
  const lastOpenAt = input.quality === 'REVISED' ? Math.max(prev.lastOpenAt ?? input.candle.openAt, input.candle.openAt) : input.candle.openAt;
  let state: EngineState = { ...prev, seq: input.seq, lastOpenAt };
  const setup = state.setup;
  const active = isActive(state.phase);

  // Priority 1: identity / data revision.
  if (input.quality === 'REVISED') {
    if (active && setup) {
      state = terminate(ctx, state, setup, 'INVALIDATED', 'DATA_REVISED', { reason: 'consumed candle revised' });
    } else {
      emit(ctx, 'DATA_QUALITY', 'DATA_REVISED', state.phase, state.phase, setup?.setupId ?? null, {}, {});
      if (!isTerminal(state.phase)) state = { ...state, phase: warmupOrIdle(ctx) };
    }
    return finish(ctx, state);
  }

  // Priority 2: total setup lifetime.
  if (active && setup) {
    const age = input.candle.closeAt - setup.activationCloseAt;
    const ttl = setupTtlMs(policy);
    if (age >= ttl) {
      state = terminate(ctx, state, setup, 'EXPIRED', 'SETUP_EXPIRED', { ageMs: age }, { setupTtlMs: ttl });
      return finish(ctx, state);
    }
  }

  // Priority 3: valid data check. A gap pauses structural evaluation; TTL above still applied.
  if (input.quality === 'GAP') {
    const prevOpen = prev.lastOpenAt;
    const missing = prevOpen === null ? null : (input.candle.openAt - prevOpen) / policy.timeframeMs - 1;
    emit(ctx, 'DATA_QUALITY', 'CANDLE_GAP', state.phase, state.phase, setup?.setupId ?? null,
      { previousOpenAt: prevOpen, openAt: input.candle.openAt, missingBars: missing }, {});
    if (active && setup) {
      // Continuity broken: confirmation streak cannot be "consecutive" across a gap.
      state = { ...state, setup: { ...setup, confirmationConsecutive: 0 } };
    } else if (state.phase === 'IDLE') {
      state = { ...state, phase: 'WARMUP' };
      emit(ctx, 'TRANSITION', 'WARMUP_INCOMPLETE', 'IDLE', 'WARMUP', null, { historyLength: input.history.length }, { warmupBars: policy.parameters.warmupBars });
    }
    return finish(ctx, state);
  }

  // Priority 4/5: structural checks and normal transitions per phase.
  switch (state.phase) {
    case 'CONFIRMED':
    case 'INVALIDATED':
    case 'EXPIRED':
      state = stepTerminal(ctx, state);
      break;
    case 'WARMUP':
      state = stepWarmup(ctx, state);
      break;
    case 'IDLE':
      state = stepIdle(ctx, state);
      break;
    case 'IMPULSE':
      state = stepImpulse(ctx, state, setup as Setup);
      break;
    case 'PULLBACK':
      state = stepPullback(ctx, state, setup as Setup);
      break;
    case 'BASE':
      state = stepBase(ctx, state, setup as Setup);
      break;
    case 'BREAKOUT':
      state = stepBreakout(ctx, state, setup as Setup);
      break;
  }
  return finish(ctx, state);
}

// ---------------------------------------------------------------------------
// phase handlers

function stepTerminal(ctx: Ctx, state: EngineState): EngineState {
  const remaining = state.cooldownRemaining - 1;
  if (remaining > 0) {
    ctx.diagnostics.push({ code: 'COOLDOWN_ACTIVE', values: { remaining } });
    return { ...state, cooldownRemaining: remaining };
  }
  const next = warmupOrIdle(ctx);
  emit(ctx, 'TRANSITION', 'COOLDOWN_COMPLETE', state.phase, next, state.setup?.setupId ?? null,
    { historyLength: ctx.input.history.length }, { cooldownBars: ctx.policy.parameters.cooldownBars });
  return { ...state, phase: next, setup: null, cooldownRemaining: 0 };
}

function stepWarmup(ctx: Ctx, state: EngineState): EngineState {
  const { warmupBars } = ctx.policy.parameters;
  const n = ctx.input.history.length;
  if (n < warmupBars) {
    ctx.diagnostics.push({ code: 'WARMUP_INCOMPLETE', values: { historyLength: n, warmupBars } });
    return state;
  }
  emit(ctx, 'TRANSITION', 'WARMUP_COMPLETE', 'WARMUP', 'IDLE', null, { historyLength: n }, { warmupBars });
  return { ...state, phase: 'IDLE' };
}

/** G0 + G1: identify the first impulse. */
function stepIdle(ctx: Ctx, state: EngineState): EngineState {
  const p = ctx.policy.parameters;
  const h = ctx.input.history;
  const n = h.length;
  if (n < p.warmupBars) {
    // Only reachable if history shrank without a GAP input; treat as warmup to be safe.
    ctx.diagnostics.push({ code: 'WARMUP_INCOMPLETE', values: { historyLength: n, warmupBars: p.warmupBars } });
    emit(ctx, 'TRANSITION', 'WARMUP_INCOMPLETE', 'IDLE', 'WARMUP', null, { historyLength: n }, { warmupBars: p.warmupBars });
    return { ...state, phase: 'WARMUP' };
  }
  const t = n - 1;
  const cur = h[t] as Candle;
  const baseBar = h[t - p.impulseBars] as Candle;
  const B = baseBar.close;
  const r = safeDiv(cur.close, B);
  if (r === null) {
    ctx.diagnostics.push({ code: 'DEGENERATE_RANGE', values: { B } });
    return state;
  }
  // Compared in ratio form (C/B >= 1 + min) to avoid subtractive cancellation at the exact boundary.
  const impulseReturn = r - 1;
  const thresholds: MeasuredValues = {
    impulseReturnMin: p.impulseReturnMin, impulseVolumeRatioMin: p.impulseVolumeRatioMin,
    minQuoteVolume24h: p.minQuoteVolume24h, minPositiveVolumeFraction: p.minPositiveVolumeFraction,
  };
  if (!(r >= 1 + p.impulseReturnMin)) {
    ctx.diagnostics.push({ code: 'IMPULSE_RETURN_BELOW_MIN', values: { impulseReturn } });
    return state;
  }
  const activity = measureActivity(ctx);
  if (!activity.ok) {
    ctx.diagnostics.push({ code: activity.code, values: activity.values });
    return state;
  }
  const baselineSlice = h.slice(t - p.warmupBars + 1, t - p.impulseBars + 1); // t-299 .. t-12
  const impulseSlice = h.slice(t - p.impulseBars + 1, t + 1); // t-11 .. t
  const baselineVolume = median(baselineSlice.map((c) => c.baseVolume));
  const impulseMeanVolume = mean(impulseSlice.map((c) => c.baseVolume));
  const volumeRatio = safeDiv(impulseMeanVolume, baselineVolume);
  if (volumeRatio === null) {
    ctx.diagnostics.push({ code: 'ZERO_VOLUME_BASELINE', values: { baselineVolume, impulseMeanVolume, impulseReturn } });
    return state;
  }
  if (volumeRatio < p.impulseVolumeRatioMin) {
    ctx.diagnostics.push({ code: 'IMPULSE_VOLUME_BELOW_MIN', values: { volumeRatio, impulseReturn } });
    return state;
  }
  const windowHigh = max(h.slice(t - p.impulseBars, t).map((c) => c.high)); // t-12 .. t-1
  if (!(cur.close > windowHigh)) {
    ctx.diagnostics.push({ code: 'IMPULSE_NO_WINDOW_HIGH', values: { close: cur.close, windowHigh, impulseReturn, volumeRatio } });
    return state;
  }
  // P = max(H[t-11..t]); ties keep the earlier bar.
  let P = -Infinity;
  let pOpenAt = cur.openAt;
  for (const c of impulseSlice) {
    if (c.high > P) { P = c.high; pOpenAt = c.openAt; }
  }
  const setupId = sha256Hex('setup', ctx.input.instrumentId, cur.openAt, ctx.policy.policyHash).slice(0, 32);
  const setup: Setup = {
    setupId,
    activationOpenAt: cur.openAt,
    activationCloseAt: cur.closeAt,
    B, impulseReturn, impulseMeanVolume, impulseVolumeRatio: volumeRatio, baselineVolume,
    P, pOpenAt,
    pullbackCloseAt: null, pullbackDepth: null, supportPrice: null,
    baseFormedCloseAt: null, pivot: null, baseLow: null, baseRange: null, baseMedianVolume: null, invalidationPrice: null,
    breakoutCloseAt: null, breakoutClose: null,
    confirmationBarsSeen: 0, confirmationConsecutive: 0,
    terminalReason: null, terminalCloseAt: null,
  };
  emit(ctx, 'TRANSITION', 'IMPULSE_DETECTED', 'IDLE', 'IMPULSE', setupId, {
    B, close: cur.close, impulseReturn, baselineVolume, impulseMeanVolume, volumeRatio, windowHigh, P,
    sumQuoteVolume24h: activity.values['sumQuoteVolume'] ?? null,
    positiveVolumeFraction: activity.values['positiveVolumeFraction'] ?? null,
  }, thresholds);
  return { ...state, phase: 'IMPULSE', setup };
}

/** G2: track the high, freeze the pullback. */
function stepImpulse(ctx: Ctx, state: EngineState, setup: Setup): EngineState {
  const p = ctx.policy.parameters;
  const cur = ctx.input.candle;
  let P = setup.P;
  let pOpenAt = setup.pOpenAt;
  if (cur.high > P) { P = cur.high; pOpenAt = cur.openAt; }
  const range = P - setup.B;
  const d = safeDiv(P - cur.close, range);
  if (d === null || range <= 0) {
    return terminate(ctx, state, { ...setup, P, pOpenAt }, 'INVALIDATED', 'DEGENERATE_RANGE', { P, B: setup.B });
  }
  const thresholds: MeasuredValues = { pullbackMin: p.pullbackMin, pullbackMax: p.pullbackMax };
  if (d > p.pullbackMax) {
    return terminate(ctx, state, { ...setup, P, pOpenAt }, 'INVALIDATED', 'IMPULSE_RETRACEMENT_TOO_DEEP', { P, B: setup.B, close: cur.close, depth: d }, thresholds);
  }
  if (d >= p.pullbackMin) {
    const supportPrice = setup.B + (1 - p.pullbackMax) * (P - setup.B);
    const next: Setup = { ...setup, P, pOpenAt, pullbackCloseAt: cur.closeAt, pullbackDepth: d, supportPrice };
    emit(ctx, 'TRANSITION', 'PULLBACK_CONFIRMED', 'IMPULSE', 'PULLBACK', setup.setupId,
      { P, pOpenAt, B: setup.B, close: cur.close, depth: d, supportPrice }, { ...thresholds, supportFraction: 1 - p.pullbackMax });
    return { ...state, phase: 'PULLBACK', setup: next };
  }
  ctx.diagnostics.push({ code: 'PULLBACK_CONFIRMED', values: { depth: d, tracking: true } });
  return { ...state, setup: { ...setup, P, pOpenAt } };
}

/** G3: structural checks in PULLBACK, then base formation. */
function stepPullback(ctx: Ctx, state: EngineState, setup: Setup): EngineState {
  const p = ctx.policy.parameters;
  const cur = ctx.input.candle;
  const support = setup.supportPrice as number;
  const pullbackCloseAt = setup.pullbackCloseAt as number;
  if (cur.close < support) {
    return terminate(ctx, state, setup, 'INVALIDATED', 'SUPPORT_BROKEN', { close: cur.close, supportPrice: support, phase: 'PULLBACK' });
  }
  if (cur.close > setup.P) {
    return terminate(ctx, state, setup, 'INVALIDATED', 'NEW_IMPULSE_WITHOUT_BASE', { close: cur.close, P: setup.P });
  }
  const h = ctx.input.history;
  const window = h.slice(-p.baseBars);
  const thresholds: MeasuredValues = { baseBars: p.baseBars, baseRangeMax: p.baseRangeMax, baseVolumeRatioMax: p.baseVolumeRatioMax, baseStopBuffer: p.baseStopBuffer };
  if (window.length < p.baseBars || (window[0] as Candle).openAt < pullbackCloseAt) {
    ctx.diagnostics.push({ code: 'BASE_NOT_FORMED', values: { why: 'insufficient_post_pullback_bars', available: window.length } });
    return { ...state, setup };
  }
  const allWithin = window.every((c) => c.close >= support && c.close <= setup.P);
  const hi = max(window.map((c) => c.high));
  const lo = min(window.map((c) => c.low));
  const rangeFrac = safeDiv(hi - lo, lo);
  const medV = median(window.map((c) => c.baseVolume));
  const volRatio = safeDiv(medV, setup.impulseMeanVolume);
  const values: MeasuredValues = { allWithin, high: hi, low: lo, rangeFraction: rangeFrac, medianVolume: medV, volumeRatio: volRatio, supportPrice: support, P: setup.P };
  const ok = allWithin && rangeFrac !== null && rangeFrac <= p.baseRangeMax && medV > 0 && volRatio !== null && volRatio <= p.baseVolumeRatioMax;
  if (!ok) {
    ctx.diagnostics.push({ code: 'BASE_NOT_FORMED', values });
    return { ...state, setup };
  }
  const invalidationPrice = Math.max(support, lo * (1 - p.baseStopBuffer));
  const next: Setup = { ...setup, baseFormedCloseAt: cur.closeAt, pivot: hi, baseLow: lo, baseRange: rangeFrac, baseMedianVolume: medV, invalidationPrice };
  emit(ctx, 'TRANSITION', 'BASE_FORMED', 'PULLBACK', 'BASE', setup.setupId, { ...values, pivot: hi, baseLow: lo, invalidationPrice }, thresholds);
  return { ...state, phase: 'BASE', setup: next };
}

/** G4: second-leg breakout event. */
function stepBase(ctx: Ctx, state: EngineState, setup: Setup): EngineState {
  const p = ctx.policy.parameters;
  const cur = ctx.input.candle;
  const pivot = setup.pivot as number;
  const invalidationPrice = setup.invalidationPrice as number;
  if (cur.close < invalidationPrice) {
    return terminate(ctx, state, setup, 'INVALIDATED', 'SUPPORT_BROKEN', { close: cur.close, invalidationPrice, phase: 'BASE' });
  }
  const threshold = pivot * (1 + p.breakoutBuffer);
  const h = ctx.input.history;
  const prevBar = h.length >= 2 ? (h[h.length - 2] as Candle) : null;
  if (prevBar === null) {
    ctx.diagnostics.push({ code: 'PIVOT_NOT_CROSSED', values: { why: 'no_previous_bar_in_continuous_history' } });
    return state;
  }
  const crossed = prevBar.close <= threshold && cur.close > threshold;
  if (!crossed) {
    ctx.diagnostics.push({ code: 'PIVOT_NOT_CROSSED', values: { previousClose: prevBar.close, close: cur.close, threshold } });
    return state;
  }
  const activity = measureActivity(ctx);
  const volRatio = safeDiv(cur.baseVolume, setup.baseMedianVolume as number);
  const extension = cur.close / pivot - 1;
  const values: MeasuredValues = {
    pivot, threshold, previousClose: prevBar.close, close: cur.close, volume: cur.baseVolume,
    baseMedianVolume: setup.baseMedianVolume, volumeRatio: volRatio, extension, invalidationPrice,
    sumQuoteVolume24h: activity.values['sumQuoteVolume'] ?? null,
    positiveVolumeFraction: activity.values['positiveVolumeFraction'] ?? null,
  };
  const thresholds: MeasuredValues = {
    breakoutBuffer: p.breakoutBuffer, breakoutVolumeRatioMin: p.breakoutVolumeRatioMin, breakoutExtensionMax: p.breakoutExtensionMax,
    minQuoteVolume24h: p.minQuoteVolume24h, minPositiveVolumeFraction: p.minPositiveVolumeFraction,
  };
  let rejection: ReasonCode | null = null;
  if (!activity.ok) rejection = activity.code;
  else if (volRatio === null || volRatio < p.breakoutVolumeRatioMin) rejection = 'BREAKOUT_LOW_VOLUME';
  else if (cur.close / pivot > 1 + p.breakoutExtensionMax) rejection = 'BREAKOUT_OVEREXTENDED';
  if (rejection) {
    emit(ctx, 'BREAKOUT_REJECTED', rejection, 'BASE', 'BASE', setup.setupId, values, thresholds);
    return state;
  }
  const next: Setup = { ...setup, breakoutCloseAt: cur.closeAt, breakoutClose: cur.close, confirmationBarsSeen: 0, confirmationConsecutive: 0 };
  emit(ctx, 'TRANSITION', 'SECOND_LEG_BREAKOUT', 'BASE', 'BREAKOUT', setup.setupId, values, thresholds);
  return { ...state, phase: 'BREAKOUT', setup: next };
}

/** G5: confirmation window after the breakout. */
function stepBreakout(ctx: Ctx, state: EngineState, setup: Setup): EngineState {
  const p = ctx.policy.parameters;
  const cur = ctx.input.candle;
  const pivot = setup.pivot as number;
  const invalidationPrice = setup.invalidationPrice as number;
  if (cur.close < invalidationPrice) {
    return terminate(ctx, state, setup, 'INVALIDATED', 'SUPPORT_BROKEN', { close: cur.close, invalidationPrice, phase: 'BREAKOUT' });
  }
  const seen = setup.confirmationBarsSeen + 1;
  const consecutive = cur.close >= pivot ? setup.confirmationConsecutive + 1 : 0;
  const thresholds: MeasuredValues = { confirmationBars: p.confirmationBars, confirmationWindowBars: p.confirmationWindowBars };
  const values: MeasuredValues = { close: cur.close, pivot, barsSeen: seen, consecutive };
  const updated: Setup = { ...setup, confirmationBarsSeen: seen, confirmationConsecutive: consecutive };
  if (consecutive >= p.confirmationBars) {
    emit(ctx, 'TRANSITION', 'SECOND_LEG_CONFIRMED', 'BREAKOUT', 'CONFIRMED', setup.setupId, values, thresholds);
    return { ...state, phase: 'CONFIRMED', setup: { ...updated, terminalReason: 'SECOND_LEG_CONFIRMED', terminalCloseAt: cur.closeAt }, cooldownRemaining: p.cooldownBars };
  }
  if (seen >= p.confirmationWindowBars) {
    return terminate(ctx, state, updated, 'EXPIRED', 'CONFIRMATION_TIMEOUT', values, thresholds);
  }
  return { ...state, setup: updated };
}

// ---------------------------------------------------------------------------
// helpers

type ActivityResult = { ok: true; code: 'LOW_ACTIVITY'; values: MeasuredValues } | { ok: false; code: 'LOW_ACTIVITY' | 'ACTIVITY_WINDOW_INCOMPLETE'; values: MeasuredValues };

/** G0 activity gate over the last 24h of continuous bars. */
function measureActivity(ctx: Ctx): ActivityResult {
  const p = ctx.policy.parameters;
  const bars = Math.round(86_400_000 / ctx.policy.timeframeMs);
  const h = ctx.input.history;
  if (h.length < bars) {
    return { ok: false, code: 'ACTIVITY_WINDOW_INCOMPLETE', values: { historyLength: h.length, requiredBars: bars } };
  }
  const window = h.slice(-bars);
  const sumQuoteVolume = sum(window.map((c) => c.quoteVolume));
  const positive = window.filter((c) => c.baseVolume > 0).length;
  const positiveVolumeFraction = positive / bars;
  const values: MeasuredValues = { sumQuoteVolume, positiveVolumeFraction, positiveBars: positive, windowBars: bars };
  const ok = sumQuoteVolume >= p.minQuoteVolume24h && positiveVolumeFraction >= p.minPositiveVolumeFraction;
  return ok ? { ok: true, code: 'LOW_ACTIVITY', values } : { ok: false, code: 'LOW_ACTIVITY', values };
}

function terminate(ctx: Ctx, state: EngineState, setup: Setup, toPhase: 'INVALIDATED' | 'EXPIRED', code: ReasonCode, values: MeasuredValues, thresholds: MeasuredValues = {}): EngineState {
  const cur = ctx.input.candle;
  emit(ctx, 'TRANSITION', code, state.phase, toPhase, setup.setupId, values, thresholds);
  return {
    ...state,
    phase: toPhase,
    setup: { ...setup, terminalReason: code, terminalCloseAt: cur.closeAt },
    cooldownRemaining: ctx.policy.parameters.cooldownBars,
  };
}

function warmupOrIdle(ctx: Ctx): Phase {
  return ctx.input.history.length >= ctx.policy.parameters.warmupBars ? 'IDLE' : 'WARMUP';
}

function emit(ctx: Ctx, kind: EventKind, code: ReasonCode, fromPhase: Phase, toPhase: Phase, setupId: string | null, values: MeasuredValues, thresholds: MeasuredValues): void {
  const { candle, now, seq } = ctx.input;
  ctx.events.push({
    kind, code, fromPhase, toPhase, setupId, seq,
    decisionBarOpenAt: candle.openAt,
    decisionBarCloseAt: candle.closeAt,
    emittedAt: now,
    isFresh: now - candle.closeAt <= ctx.policy.parameters.freshnessMaxMs,
    candleVersionId: candle.versionId,
    values, thresholds,
  });
}

function finish(ctx: Ctx, state: EngineState): StepResult {
  return { state, events: ctx.events, diagnostics: ctx.diagnostics };
}

function isActive(phase: Phase): boolean {
  return ACTIVE_PHASES.includes(phase);
}

function isTerminal(phase: Phase): boolean {
  return TERMINAL_PHASES.includes(phase);
}

function validateInput(prev: EngineState, input: DecisionInput): void {
  if (input.seq !== prev.seq + 1) throw new StepContractError(`seq must be ${prev.seq + 1}, got ${input.seq}`);
  const last = input.history[input.history.length - 1];
  if (!last || last.versionId !== input.candle.versionId) throw new StepContractError('history must end with the input candle');
  if (input.quality !== 'REVISED' && prev.lastOpenAt !== null && input.candle.openAt <= prev.lastOpenAt) {
    throw new StepContractError(`candle openAt ${input.candle.openAt} must be after ${prev.lastOpenAt}`);
  }
  if (input.now < input.candle.observedAt) throw new StepContractError('now must not precede the candle observedAt');
  for (let i = 1; i < input.history.length; i++) {
    const a = input.history[i - 1] as Candle;
    const b = input.history[i] as Candle;
    if (b.openAt !== a.closeAt) throw new StepContractError(`history not continuous at index ${i}`);
  }
}
