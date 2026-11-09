/** CLI entry: probe | discover | collect [--once] | scan | watch [--once] | simulate | status | alerts | events */
import { resolve } from 'node:path';
import { AlphaClient } from '../adapters/binance-alpha/client.ts';
import { openDatabase } from '../storage/db.ts';
import { getInstruments, insertFetchAttempt, latestRun, latestUniverseSnapshot, listAlerts, listEvents } from '../storage/repos.ts';
import { AlertDispatcher, ConsoleSink, JsonlSink } from '../application/alerts.ts';
import { loadConfig, loadPolicy } from '../application/config.ts';
import { InstrumentRunner } from '../application/engine.ts';
import { probe } from '../application/probe.ts';
import { ensureOnlineRun } from '../application/runs.ts';
import { simulate } from '../application/simulate.ts';
import { printStatus } from '../application/status.ts';
import { discoverUniverse } from '../application/universe.ts';
import { runCycle, watch } from '../application/watch.ts';
import { SocialMonitor, SocialWriterBusyError, socialContextFor } from '../application/social.ts';
import { loadSocialConfig, xaiApiKeyFromEnv } from '../application/social-config.ts';
import { XaiClient, keyPreflight } from '../adapters/xai/client.ts';
import { listMentions } from '../storage/social-repos.ts';

const USAGE = `usage: node src/cli/main.ts <command> [--db path] [--policy path] [--max-instruments n] [--instruments SYM,SYM] [--backfill-days n]
  probe                     M0 contract probe (no persistence)
  discover                  snapshot universe, map identities, select collection scope
  collect [--once]          backfill/incremental candles for the selected scope (no engine)
  scan                      advance the engine over stored candles (no network) and emit alerts
  watch [--once]            discover + collect + scan; loops every 5m close unless --once
  simulate [--delay-ms n]   historical-simulation over stored candles (new run, explicit availability delay)
  status                    coverage, phases, recent events and alerts
  alerts [--level L] [--limit n] [--fresh] [--all]
  events [--code C] [--limit n]
  social [--once] [--force-x [--lookback-hours h]]  X handle polling on the configured schedule (xAI x_search, needs XAI_API_KEY) + Telegram spool ingest -> MENTION alerts; --force-x polls once regardless of schedule (billed), optionally over the last h hours
  social-plan               dry run: planned x_search request, budget state, key status; sends no /responses request
  mentions [--hours n] [--limit n] [--instrument id]`;

function parseArgs(argv: string[]): { command: string; flags: Record<string, string> } {
  const [command = 'help', ...rest] = argv;
  const flags: Record<string, string> = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i] as string;
    if (!a.startsWith('--')) continue;
    const key = a.slice(2).replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
    const next = rest[i + 1];
    if (next !== undefined && !next.startsWith('--')) { flags[key] = next; i++; } else flags[key] = 'true';
  }
  return { command, flags };
}

const log = (line: string) => process.stdout.write(line + '\n');

async function main(): Promise<number> {
  const { command, flags } = parseArgs(process.argv.slice(2));
  if (command === 'help' || command === '--help') { log(USAGE); return 0; }
  const rootDir = resolve(import.meta.dirname, '../..');
  const cfg = loadConfig(rootDir, flags);
  const policy = loadPolicy(cfg);
  const db = openDatabase(cfg.dbPath);
  const client = new AlphaClient({ baseUrl: cfg.baseUrl, ...cfg.http, onAttempt: (a) => { try { insertFetchAttempt(db, a); } catch { /* recording must never break a fetch */ } } });
  const dispatcherFor = (mode: string) => new AlertDispatcher([new ConsoleSink(log), new JsonlSink(mode === 'online' ? cfg.alertsJsonlPath : cfg.alertsJsonlPath.replace(/\.jsonl$/, `.${mode}.jsonl`))]);

  switch (command) {
    case 'probe': {
      const path = await probe(client, cfg, log);
      log(`probe report: ${path}`);
      return 0;
    }
    case 'discover': {
      const d = await discoverUniverse(db, client, cfg);
      log(`snapshot ${d.snapshotId} counts=${JSON.stringify(d.counts)} selectionPolicy=${d.selectionPolicyHash.slice(0, 12)}`);
      const reasons: Record<string, number> = {};
      for (const e of d.excluded) reasons[e.reason] = (reasons[e.reason] ?? 0) + 1;
      log(`excluded by reason: ${JSON.stringify(reasons)}`);
      for (const i of d.selected) log(`  ${i.symbol.padEnd(16)} ${i.displaySymbol.padEnd(12)} ${i.chainName.padEnd(8)} ${i.contractAddress}`);
      return 0;
    }
    case 'collect':
    case 'scan':
    case 'watch': {
      const once = command !== 'watch' || flags['once'] === 'true';
      if (command === 'watch') { await watch(db, cfg, policy, client, dispatcherFor('online'), { once, log }); return 0; }
      const snap = latestUniverseSnapshot(db);
      if (!snap) { log('no universe snapshot; run discover first'); return 2; }
      const selected = getInstruments(db, snap.members.selected);
      const { run } = ensureOnlineRun(db, cfg, policy, Date.now());
      if (command === 'collect') {
        const report = await runCycle(db, cfg, policy, client, dispatcherFor('online'), run, selected, new Map(), Date.now());
        // runCycle also advances the engine; for `collect` we report collection only
        for (const c of report.collected) log(`[collect] ${c.symbol.padEnd(16)} ${c.outcome.padEnd(8)} new=${String(c.newClosedBars).padStart(5)} revised=${c.revisedBars} pages=${c.pagesFetched} earliest=${c.earliestOpenAt ? new Date(c.earliestOpenAt).toISOString() : '-'} latest=${c.latestClosedOpenAt ? new Date(c.latestClosedOpenAt).toISOString() : '-'} backfill=${c.backfillDone ? 'done' : 'pending'} ${c.notes.slice(0, 2).join('; ')}`);
        log(`[collect] cycle ${report.durationMs}ms fetch=${report.fetch.total} ok=${report.fetch.ok} p95=${report.fetch.p95LatencyMs}ms events=${report.events} alerts=${report.alerts}`);
        return 0;
      }
      const dispatcher = dispatcherFor('online');
      let events = 0;
      for (const inst of selected) {
        const runner = new InstrumentRunner({ db, policy, runId: run.runId, mode: 'online', instrument: inst, intervalMs: cfg.intervalMs, dispatcher, clock: () => Date.now(), socialContext: socialContextFor(db) });
        const s = await runner.advance();
        events += s.events.length;
        if (s.processed) log(`[scan] ${inst.symbol.padEnd(16)} processed=${s.processed} gaps=${s.gaps} phase=${s.phase} events=${s.events.map((e) => e.code).join(',') || '-'}`);
      }
      log(`[scan] run ${run.runId} events=${events}`);
      return 0;
    }
    case 'simulate': {
      const snap = latestUniverseSnapshot(db);
      const ids = cfg.selection.only.length ? cfg.selection.only.map((s) => (s.includes(':') ? s : `${cfg.provider}:${cfg.marketType}:${s}`)) : snap?.members.selected ?? [];
      if (!ids.length) { log('nothing to simulate: no snapshot and no --instruments'); return 2; }
      const delayCfg = flags['delayMs'] ? { ...cfg, simulation: { availabilityDelayMs: Number(flags['delayMs']) } } : cfg;
      const r = await simulate(db, delayCfg, policy, ids, dispatcherFor('historical-simulation'), log);
      log(`[sim] run ${r.runId} instruments=${r.instruments} delay=${r.availabilityDelayMs}ms ${r.endedAt - r.startedAt}ms`);
      log(`[sim] events: ${JSON.stringify(r.eventCounts)}`);
      log(`[sim] exclusions: ${JSON.stringify(r.diagnosticCounts)}`);
      log(`[sim] alerts by level: ${JSON.stringify(r.alertsByLevel)}`);
      log('[sim] universe = CURRENT_UNIVERSE_RETROSPECTIVE (survivorship risk; see docs/03). Results describe rule triggers under the stated availability assumption, not received signals.');
      return 0;
    }
    case 'status': {
      printStatus(db, cfg, log, Date.now(), { spoolDirectory: loadSocialConfig(rootDir, flags).telegram.spoolDirectory });
      return 0;
    }
    case 'alerts': {
      const levels = flags['level'] ? flags['level'].split(',') : undefined;
      const run = flags['run'] ?? (flags['all'] ? undefined : latestRun(db, 'online')?.runId);
      const all = listAlerts(db, { limit: Number(flags['limit'] ?? 20), ...(levels ? { levels } : {}), ...(run ? { runId: run } : {}) });
      const rows = flags['fresh'] ? all.filter((a) => a.isFresh) : all;
      for (const a of rows.reverse()) log(JSON.stringify(a));
      log(`${rows.length} alerts${run ? ` (run ${run})` : ''}`);
      return 0;
    }
    case 'events': {
      const codes = flags['code'] ? flags['code'].split(',') : undefined;
      const run = flags['run'] ?? latestRun(db, 'online')?.runId;
      const rows = listEvents(db, { ...(run ? { runId: run } : {}), ...(codes ? { codes } : {}), limit: Number(flags['limit'] ?? 50), newest: true });
      for (const e of rows.reverse()) log(`${new Date(e.decisionBarCloseAt).toISOString()} ${e.instrumentId} ${e.code} ${e.fromPhase}->${e.toPhase} fresh=${e.isFresh} ${JSON.stringify(e.values)}`);
      return 0;
    }
    case 'social': {
      const social = loadSocialConfig(rootDir, flags);
      const key = xaiApiKeyFromEnv();
      const xai = key ? new XaiClient({ apiKey: key, timeoutMs: social.x.timeoutMs }) : null;
      const monitor = new SocialMonitor({ db, cfg: social, xai, dispatcher: new AlertDispatcher([new ConsoleSink(log), new JsonlSink(social.alertsJsonlPath)]), log });
      const lookbackHours = flags['lookbackHours'] !== undefined ? Number(flags['lookbackHours']) : null;
      if (lookbackHours !== null && !(lookbackHours > 0 && lookbackHours <= 72)) { log('--lookback-hours must be in (0, 72]'); return 2; }
      try {
        await monitor.run({ once: flags['once'] === 'true', forceX: flags['forceX'] === 'true', ...(lookbackHours !== null ? { forceSinceMs: Date.now() - lookbackHours * 3_600_000 } : {}) });
      } catch (error) { if (error instanceof SocialWriterBusyError) { log(error.message); return 3; } throw error; }
      return 0;
    }
    case 'social-plan': {
      const social = loadSocialConfig(rootDir, flags);
      const monitor = new SocialMonitor({ db, cfg: social, xai: null, dispatcher: new AlertDispatcher([]), log });
      const plan = monitor.plan();
      log(`handles(${plan.handles.length}): ${plan.handles.join(', ')}`);
      log(`window: since ${plan.sinceIso}; x_search dates ${plan.fromDate}..${plan.toDate} (upper bound exclusive); model=${plan.model} prompt=${plan.promptVersion} requestHash=${plan.requestHash.slice(0, 16)}`);
      const d = monitor.xPollDecision();
      log(`budget: $${social.x.dailyBudgetUsd}/day, $${social.x.perRequestBudgetUsd}/request; cadence ${monitor.cadence()}; batches ${Math.ceil(social.x.handles.length / social.x.batchSize)} x <=${social.x.batchSize} handles, ${social.x.batchDelayMs / 1000}s apart; today=${JSON.stringify(monitor.budgetState())}`);
      log(`next poll: ${d.due ? `due now (${d.reason})` : `not due (${d.reason})`}; slot ${new Date(d.slotAt).toISOString()} next ${new Date(d.nextAt).toISOString()} lastSettled ${d.lastSettledAt === null ? '-' : new Date(d.lastSettledAt).toISOString()} attemptsForSlot=${d.attemptsForSlot}`);
      log('pricing reference: x_search $5 per 1k posts + $10 per 1k profiles fetched, plus model tokens (docs.x.ai/developers/pricing)');
      const key = xaiApiKeyFromEnv();
      if (!key) { log('XAI_API_KEY not set: key status not checked; no request sent'); return 0; }
      const status = keyPreflight(await new XaiClient({ apiKey: key }).apiKeyStatus(), plan.model, Date.now());
      log(`key: ${status.redactedKey ?? '?'} name=${status.keyName ?? '?'} acls=${status.acls.length} (${status.limitation})`);
      log('dry run: no /responses request sent');
      return 0;
    }
    case 'mentions': {
      const hours = Number(flags['hours'] ?? 24);
      const rows = listMentions(db, { sinceMs: Date.now() - hours * 3_600_000, limit: Number(flags['limit'] ?? 50), ...(flags['instrument'] ? { instrumentId: flags['instrument'] } : {}) });
      for (const m of rows.reverse()) log(`${new Date(m.postedAt ?? m.extractedAt).toISOString()} ${m.kind.padEnd(8)} ${(m.authorHandle ?? m.sourceId).padEnd(16)} ${m.tokenText.padEnd(12)} ${m.resolution.padEnd(10)} ${(m.instrumentId ?? '-').padEnd(34)} ${m.stance.padEnd(8)} conf=${m.confidence.toFixed(2)} ${m.matchKind} ${m.url ?? ''}`);
      log(`${rows.length} mentions in last ${hours}h`);
      return 0;
    }
    default:
      log(USAGE);
      return 2;
  }
}

main().then((code) => process.exit(code), (error) => {
  process.stderr.write(`error: ${(error as Error).stack ?? String(error)}\n`);
  process.exit(1);
});
