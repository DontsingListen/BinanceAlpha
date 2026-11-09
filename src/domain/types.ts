/**
 * Domain types for the second-leg state machine.
 * Pure data: no I/O, no clocks. Numbers here are already validated finite values
 * (see adapters/binance-alpha/dto.ts for the string -> number boundary).
 */

export type Candle = {
  readonly versionId: string;
  readonly openAt: number;
  /** Canonical close: openAt + intervalMs (left-closed, right-open). */
  readonly closeAt: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly baseVolume: number;
  readonly quoteVolume: number;
  readonly tradeCount: number | null;
  /** When this candle version actually entered the system. */
  readonly observedAt: number;
};

export const PHASES = [
  'WARMUP',
  'IDLE',
  'IMPULSE',
  'PULLBACK',
  'BASE',
  'BREAKOUT',
  'CONFIRMED',
  'INVALIDATED',
  'EXPIRED',
] as const;
export type Phase = (typeof PHASES)[number];

export const ACTIVE_PHASES: readonly Phase[] = ['IMPULSE', 'PULLBACK', 'BASE', 'BREAKOUT'];
export const TERMINAL_PHASES: readonly Phase[] = ['CONFIRMED', 'INVALIDATED', 'EXPIRED'];

export type DataQuality = 'OK' | 'GAP' | 'REVISED';

export const REASON_CODES = [
  // data / gating
  'WARMUP_INCOMPLETE',
  'WARMUP_COMPLETE',
  'COOLDOWN_ACTIVE',
  'COOLDOWN_COMPLETE',
  'CANDLE_GAP',
  'STALE_INPUT',
  'IDENTITY_CONFLICT',
  'CLOCK_UNCERTAIN',
  'LOW_ACTIVITY',
  'ACTIVITY_WINDOW_INCOMPLETE',
  'ZERO_VOLUME_BASELINE',
  'DATA_REVISED',
  // G1 diagnostics (non-events)
  'IMPULSE_RETURN_BELOW_MIN',
  'IMPULSE_VOLUME_BELOW_MIN',
  'IMPULSE_NO_WINDOW_HIGH',
  'BASE_NOT_FORMED',
  'PIVOT_NOT_CROSSED',
  // transitions
  'IMPULSE_DETECTED',
  'PULLBACK_CONFIRMED',
  'BASE_FORMED',
  'SECOND_LEG_BREAKOUT',
  'SECOND_LEG_CONFIRMED',
  // rejections (phase unchanged)
  'BREAKOUT_LOW_VOLUME',
  'BREAKOUT_OVEREXTENDED',
  // invalidation / expiry
  'IMPULSE_RETRACEMENT_TOO_DEEP',
  'NEW_IMPULSE_WITHOUT_BASE',
  'SUPPORT_BROKEN',
  'CONFIRMATION_TIMEOUT',
  'SETUP_EXPIRED',
  'DEGENERATE_RANGE',
] as const;
export type ReasonCode = (typeof REASON_CODES)[number];

export type EventKind = 'TRANSITION' | 'BREAKOUT_REJECTED' | 'DATA_QUALITY';

export type Setup = {
  readonly setupId: string;
  readonly activationOpenAt: number;
  readonly activationCloseAt: number;
  /** B = C[t-impulseBars] at activation. Never changes. */
  readonly B: number;
  readonly impulseReturn: number;
  readonly impulseMeanVolume: number;
  readonly impulseVolumeRatio: number;
  readonly baselineVolume: number;
  /** Running high while IMPULSE; frozen at PULLBACK. */
  readonly P: number;
  readonly pOpenAt: number;
  // frozen at PULLBACK
  readonly pullbackCloseAt: number | null;
  readonly pullbackDepth: number | null;
  readonly supportPrice: number | null;
  // frozen at BASE
  readonly baseFormedCloseAt: number | null;
  readonly pivot: number | null;
  readonly baseLow: number | null;
  readonly baseRange: number | null;
  readonly baseMedianVolume: number | null;
  readonly invalidationPrice: number | null;
  // breakout / confirmation
  readonly breakoutCloseAt: number | null;
  readonly breakoutClose: number | null;
  readonly confirmationBarsSeen: number;
  readonly confirmationConsecutive: number;
  readonly terminalReason: ReasonCode | null;
  readonly terminalCloseAt: number | null;
};

export type EngineState = {
  readonly phase: Phase;
  /** Last consumed journal sequence number (0 before any input). */
  readonly seq: number;
  readonly lastOpenAt: number | null;
  readonly setup: Setup | null;
  /** Valid bars still to wait after a terminal phase before returning to IDLE. */
  readonly cooldownRemaining: number;
};

export type DecisionInput = {
  readonly instrumentId: string;
  readonly seq: number;
  readonly candle: Candle;
  /**
   * Continuous run of closed candles ending with `candle` (inclusive), oldest first.
   * The application resets this run at every gap; the domain never looks past it.
   */
  readonly history: readonly Candle[];
  readonly quality: DataQuality;
  /** Explicit clock supplied by the caller (emittedAt). Never read from the system here. */
  readonly now: number;
};

export type MeasuredValues = Readonly<Record<string, number | string | boolean | null>>;

export type DecisionEvent = {
  readonly kind: EventKind;
  readonly code: ReasonCode;
  readonly fromPhase: Phase;
  readonly toPhase: Phase;
  readonly setupId: string | null;
  readonly seq: number;
  readonly decisionBarOpenAt: number;
  readonly decisionBarCloseAt: number;
  readonly emittedAt: number;
  readonly isFresh: boolean;
  readonly candleVersionId: string;
  readonly values: MeasuredValues;
  readonly thresholds: MeasuredValues;
};

export type Diagnostic = {
  readonly code: ReasonCode;
  readonly values: MeasuredValues;
};

export type StepResult = {
  readonly state: EngineState;
  readonly events: readonly DecisionEvent[];
  readonly diagnostics: readonly Diagnostic[];
};

export const INITIAL_STATE: EngineState = {
  phase: 'WARMUP',
  seq: 0,
  lastOpenAt: null,
  setup: null,
  cooldownRemaining: 0,
};
