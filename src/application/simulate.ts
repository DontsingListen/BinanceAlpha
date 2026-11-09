/**
 * historical-simulation: replays stored candles per instrument in close-time order under an explicit
 * availability assumption (closeAt + availabilityDelayMs). Results are research evidence about how the
 * rules trigger on recorded data; they never prove a signal was actually received at that time.
 */
import type { Policy } from '../domain/policy.ts';
import type { Db } from '../storage/db.ts';
import { endRun, eventCountsByCode, getInstruments, runStats, type InstrumentRow } from '../storage/repos.ts';
import type { AlertDispatcher } from './alerts.ts';
import type { AppConfig } from './config.ts';
import { InstrumentRunner, type AdvanceSummary } from './engine.ts';
import { newSimulationRun } from './runs.ts';

export type SimulationReport = {
  runId: string;
  availabilityDelayMs: number;
  instruments: number;
  perInstrument: AdvanceSummary[];
  eventCounts: Record<string, number>;
  diagnosticCounts: Record<string, number>;
  alertsByLevel: Record<string, number>;
  startedAt: number;
  endedAt: number;
};

export async function simulate(db: Db, cfg: AppConfig, policy: Policy, instrumentIds: readonly string[], dispatcher: AlertDispatcher | null, log: (line: string) => void): Promise<SimulationReport> {
  const startedAt = Date.now();
  const delay = cfg.simulation.availabilityDelayMs;
  const run = newSimulationRun(db, cfg, policy, startedAt, { availabilityDelayMs: delay, instruments: instrumentIds });
  const instruments: InstrumentRow[] = getInstruments(db, instrumentIds);
  const perInstrument: AdvanceSummary[] = [];
  const alertsByLevel: Record<string, number> = {};
  for (const instrument of instruments) {
    const runner = new InstrumentRunner({ db, policy, runId: run.runId, mode: 'historical-simulation', instrument, intervalMs: cfg.intervalMs, dispatcher, availableAt: (r) => r.closeAt + delay, clock: (c) => c.observedAt });
    const s = await runner.advance();
    perInstrument.push(s);
    for (const a of s.alerts) alertsByLevel[a.level] = (alertsByLevel[a.level] ?? 0) + 1;
    const codes = s.events.filter((e) => e.kind !== 'DATA_QUALITY' && e.code !== 'WARMUP_COMPLETE' && e.code !== 'COOLDOWN_COMPLETE').map((e) => e.code);
    log(`[sim] ${instrument.symbol.padEnd(16)} ${instrument.displaySymbol.padEnd(10)} bars=${String(s.processed).padStart(5)} gaps=${s.gaps} phase=${s.phase.padEnd(11)} events=${codes.length ? codes.join(',') : '-'}`);
  }
  const endedAt = Date.now();
  endRun(db, run.runId, 'completed', endedAt);
  return { runId: run.runId, availabilityDelayMs: delay, instruments: instruments.length, perInstrument, eventCounts: eventCountsByCode(db, run.runId), diagnosticCounts: runStats(db, run.runId), alertsByLevel, startedAt, endedAt };
}
