/**
 * Social signal monitor (ADR 0003): polls watched X handles through xAI `x_search`, ingests the Telegram reader spool,
 * extracts and resolves token mentions, and emits local MENTION / MENTION_SETUP alerts. Writes only social_* tables,
 * raw_responses and alerts under its own `social-writer` lease; the kline engine is never fed from here.
 */
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { renameSync } from 'node:fs';
import { join } from 'node:path';
import { ackSpool, readSpool, type SpoolEvent } from '../adapters/telegram/spool.ts';
import { XaiClient, XaiError, keyPreflight } from '../adapters/xai/client.ts';
import { PROMPT_VERSION, parsePollResponse, planHandlePoll, type PolledPost, type PollPlan } from '../adapters/xai/x-poll.ts';
import { sha256Hex, sha256OfText } from '../domain/hash.ts';
import { buildCatalog, extractRegexMentions, resolveMention, type MentionCatalog, type ResolvedMention } from '../domain/mentions.ts';
import { ACTIVE_PHASES } from '../domain/types.ts';
import type { Db } from '../storage/db.ts';
import { withTransaction } from '../storage/db.ts';
import { acquireLease, getHead, getInstrument, insertAlert, insertRawResponse, latestRun, listEvents, listInstruments, releaseLease, updateAlertDelivery, type InstrumentRow } from '../storage/repos.ts';
import { disableSocialSourcesExcept, insertSocialPoll, insertSocialPost, insertTokenMention, listMentions, listSocialPolls, socialCostSince, upsertSocialSource, type SocialPostRow, type TokenMentionRow } from '../storage/social-repos.ts';
import type { Alert, AlertDispatcher, AlertLevel } from './alerts.ts';
import type { SocialConfig } from './social-config.ts';
import { decidePoll, describeCadence, isSettled, maxGapMs, type PollDecision } from './social-schedule.ts';
import { sleep } from '../adapters/binance-alpha/http.ts';

export const SOCIAL_RUN_ID = 'social';
export const REGEX_EXTRACTOR = 'regex-v1';
const DISCLAIMER = 'social mention collected from a watched source; model/regex extraction, not independently verified; not an order instruction';

export class SocialWriterBusyError extends Error {}

export type XPollSummary = { outcome: string; pollId: string | null; posts: number; newPosts: number; mentions: number; alerts: number; costUsd: number | null; postsFetched: number | null; durationMs: number; detail?: string };
/** An in-progress batched X poll (see startXPoll/stepXPoll): `queue` holds batch indexes still to send; a failed batch is re-queued once. */
export type XPollRun = { batches: string[][]; queue: number[]; retried: Set<number>; sent: number; sinceMs: number; windowTo: string; startedAt: number; nextBatchAt: number; outcomes: Record<number, string>; total: XPollSummary };
export type TelegramIngestSummary = { files: number; invalid: number; newPosts: number; mentions: number; alerts: number; health: string };

export type SocialMonitorOptions = { db: Db; cfg: SocialConfig; xai: XaiClient | null; dispatcher: AlertDispatcher; log: (line: string) => void; now?: () => number };

export class SocialMonitor {
  readonly #db: Db;
  readonly #cfg: SocialConfig;
  readonly #xai: XaiClient | null;
  readonly #dispatcher: AlertDispatcher;
  readonly #log: (line: string) => void;
  readonly #now: () => number;
  #catalog: { built: number; value: MentionCatalog } | null = null;
  #budgetNoticeAt = 0;
  #keyChecked = false;
  #stopping = false;
  #lease: { owner: string; ttl: number } | null = null;

  constructor(o: SocialMonitorOptions) {
    this.#db = o.db; this.#cfg = o.cfg; this.#xai = o.xai; this.#dispatcher = o.dispatcher; this.#log = o.log; this.#now = o.now ?? Date.now;
  }

  /** Registers configured X handles as sources; handles removed from config are disabled, never deleted. */
  syncSources(now = this.#now()): void {
    const ids: string[] = [];
    for (const h of this.#cfg.x.handles) {
      const id = `x:${h.toLowerCase()}`;
      ids.push(id);
      upsertSocialSource(this.#db, { sourceId: id, kind: 'x', handle: h, label: this.#cfg.x.labels[h.toLowerCase()] ?? h, enabled: this.#cfg.x.enabled, config: { url: `https://x.com/${h}` } }, now);
    }
    disableSocialSourcesExcept(this.#db, 'x', ids);
  }

  catalog(now = this.#now()): MentionCatalog {
    if (!this.#catalog || now - this.#catalog.built > 10 * 60_000) {
      this.#catalog = { built: now, value: buildCatalog(listInstruments(this.#db)) };
    }
    return this.#catalog.value;
  }

  /** Cost of today's (UTC) X polls; polls with unknown cost are charged the per-request budget (conservative). */
  budgetState(now = this.#now()): { spentUsd: number; limitUsd: number; exhausted: boolean; polls: number } {
    const dayStart = Math.floor(now / 86_400_000) * 86_400_000;
    const c = socialCostSince(this.#db, 'x', dayStart);
    const spentUsd = c.usdTicks / 10_000_000_000 + c.unknownPolls * this.#cfg.x.perRequestBudgetUsd;
    return { spentUsd, limitUsd: this.#cfg.x.dailyBudgetUsd, exhausted: spentUsd >= this.#cfg.x.dailyBudgetUsd, polls: c.polls };
  }

  /** Window start for the next poll: just before the last successful poll's window ended, bounded by lookbackMs. */
  nextWindowStart(now = this.#now()): number {
    const last = listSocialPolls(this.#db, { kind: 'x', limit: 60 }).find((p) => p.outcome === 'OK');
    const floor = now - this.#cfg.x.lookbackMs;
    const lastEnd = last ? Date.parse(last.windowTo) : Number.NaN;
    return Number.isFinite(lastEnd) ? Math.max(floor, lastEnd - 5 * 60_000) : floor;
  }

  plan(now = this.#now()): PollPlan {
    const x = this.#cfg.x;
    return planHandlePoll({ handles: x.handles, sinceMs: this.nextWindowStart(now), now, model: x.model, maxTurns: x.maxTurns, maxOutputTokens: x.maxOutputTokens });
  }

  /** Whether an X poll is due now, decided from the stored polls (restart-safe: a restart never adds a billed request). The batch rows of one poll share `windowTo` and count as one attempt, settled if any batch settled. */
  xPollDecision(now = this.#now()): PollDecision {
    const groups = new Map<string, { startedAt: number; outcome: string }>();
    for (const r of listSocialPolls(this.#db, { kind: 'x', limit: 60 })) {
      const g = groups.get(r.windowTo);
      if (!g) groups.set(r.windowTo, { startedAt: r.startedAt, outcome: r.outcome });
      else { g.startedAt = Math.min(g.startedAt, r.startedAt); if (!isSettled(g.outcome) && isSettled(r.outcome)) g.outcome = r.outcome; }
    }
    const attempts = [...groups.values()].sort((a, b) => b.startedAt - a.startedAt);
    return decidePoll({ cadence: this.#cfg.x.cadence, now, attempts, retryDelayMs: this.#cfg.x.retryDelayMs, maxAttemptsPerSlot: this.#cfg.x.maxAttemptsPerSlot });
  }

  #renewLease(): void {
    if (this.#lease) acquireLease(this.#db, 'social-writer', this.#lease.owner, this.#lease.ttl, this.#now());
  }

  cadence(): string { return describeCadence(this.#cfg.x.cadence); }

  /** An X mention is fresh while it could not have been seen by an earlier poll: the longest gap between polls plus an hour. */
  xFreshnessMs(): number {
    const c = this.#cfg.x.cadence;
    return c.kind === 'schedule' ? maxGapMs(c.schedule) + 60 * 60_000 : 2 * c.intervalMs;
  }

  /**
   * Starts a poll: the handle list in batches (one x_search request each, `batchDelayMs` apart) over one shared window.
   * Returns null (with the reason) when nothing should be sent. `sinceMs` overrides the window start for manual runs only.
   */
  startXPoll(now = this.#now(), sinceMs?: number): { run: XPollRun | null; skipped: string | null } {
    if (!this.#xai) return { run: null, skipped: 'SKIPPED_NO_API_KEY' };
    if (!this.#cfg.x.enabled) return { run: null, skipped: 'SKIPPED_DISABLED' };
    const budget = this.budgetState(now);
    if (budget.exhausted) {
      if (now - this.#budgetNoticeAt > 3_600_000) { this.#log(`[x] daily budget exhausted: spent≈$${budget.spentUsd.toFixed(2)} of $${budget.limitUsd} (polls=${budget.polls}); polling pauses until 00:00 UTC`); this.#budgetNoticeAt = now; }
      return { run: null, skipped: 'SKIPPED_BUDGET_EXHAUSTED' };
    }
    const x = this.#cfg.x;
    const batches: string[][] = [];
    for (let i = 0; i < x.handles.length; i += x.batchSize) batches.push(x.handles.slice(i, i + x.batchSize));
    const run: XPollRun = {
      batches, queue: batches.map((_, i) => i), retried: new Set(), sent: 0, sinceMs: sinceMs ?? this.nextWindowStart(now), windowTo: new Date(now).toISOString(), startedAt: now, nextBatchAt: now, outcomes: {},
      total: { outcome: 'OK', pollId: null, posts: 0, newPosts: 0, mentions: 0, alerts: 0, costUsd: null, postsFetched: null, durationMs: 0 },
    };
    return { run, skipped: null };
  }

  /** Sends the next queued batch of a poll; a batch without evidence is re-queued once (after the others). Returns true when the poll is finished (summary in `run.total`). */
  async stepXPoll(run: XPollRun, now = this.#now()): Promise<boolean> {
    const i = run.queue.shift();
    if (i === undefined) return this.#finishXPoll(run);
    if (run.sent > 0 && this.budgetState(now).exhausted) { this.#log('[x] daily budget exhausted mid-poll; remaining batches skipped'); for (const j of [i, ...run.queue]) run.outcomes[j] ??= 'SKIPPED_BUDGET_EXHAUSTED'; run.queue = []; return this.#finishXPoll(run); }
    const s = await this.#pollBatch(run.batches[i]!, run.sinceMs, run.windowTo, Math.max(run.startedAt, now), run.retried.has(i) ? 2 : 1);
    run.sent += 1;
    const t = run.total;
    run.outcomes[i] = s.outcome;
    t.posts += s.posts; t.newPosts += s.newPosts; t.mentions += s.mentions; t.alerts += s.alerts; t.durationMs += s.durationMs;
    if (s.costUsd !== null) t.costUsd = (t.costUsd ?? 0) + s.costUsd;
    if (s.postsFetched !== null) t.postsFetched = (t.postsFetched ?? 0) + s.postsFetched;
    const retry = !isSettled(s.outcome) && !run.retried.has(i);
    if (retry) { run.retried.add(i); run.queue.push(i); }
    if (run.batches.length > 1) this.#log(`[x] batch ${i + 1}/${run.batches.length}${run.retried.has(i) && !retry ? ' (retry)' : ''} (${run.batches[i]!.join(',')}) ${s.outcome} posts=${s.posts} new=${s.newPosts} mentions=${s.mentions} alerts=${s.alerts} fetched=${s.postsFetched ?? '-'} cost=${s.costUsd === null ? '-' : `$${s.costUsd.toFixed(3)}`} ${s.durationMs}ms${s.detail ? ` ${s.detail}` : ''}${retry ? '; re-queued once' : ''}`);
    run.nextBatchAt = this.#now() + this.#cfg.x.batchDelayMs;
    return run.queue.length === 0 ? this.#finishXPoll(run) : false;
  }

  #finishXPoll(run: XPollRun): true {
    const outcomes = run.batches.map((_, i) => run.outcomes[i] ?? 'STOPPED');
    const settled = outcomes.filter((o) => isSettled(o)).length;
    run.total.outcome = settled === run.batches.length ? 'OK' : settled > 0 ? `PARTIAL_${settled}_OF_${run.batches.length}` : outcomes[0] ?? 'POLL_FAILED';
    if (settled !== run.batches.length) run.total.detail = `batches: ${outcomes.join(',')}`;
    return true;
  }

  /** Runs a whole poll to completion, sleeping between batches (manual `--once` runs and tests; the service loop steps batches between Telegram ticks). */
  async pollX(now = this.#now(), sinceMs?: number): Promise<XPollSummary> {
    const { run, skipped } = this.startXPoll(now, sinceMs);
    if (!run) return { outcome: skipped ?? 'SKIPPED', pollId: null, posts: 0, newPosts: 0, mentions: 0, alerts: 0, costUsd: null, postsFetched: null, durationMs: 0 };
    for (;;) {
      if (run.sent > 0) {
        if (this.#stopping) { this.#finishXPoll(run); break; }
        await sleep(Math.max(0, run.nextBatchAt - this.#now()));
        this.#renewLease();
      }
      if (await this.stepXPoll(run, Math.max(now, this.#now()))) break;
    }
    return run.total;
  }

  async #pollBatch(handles: readonly string[], sinceMs: number, windowTo: string, now: number, attempt = 1): Promise<XPollSummary> {
    const startedAt = now;
    const xai = this.#xai;
    if (!xai) throw new XaiError('XAI_API_KEY_REQUIRED');
    const x = this.#cfg.x;
    const plan = planHandlePoll({ handles, sinceMs, now, model: x.model, maxTurns: x.maxTurns, maxOutputTokens: x.maxOutputTokens });
    const pollId = sha256Hex('x-poll', plan.requestHash, startedAt, attempt).slice(0, 32);
    const base = { pollId, kind: 'x' as const, startedAt, windowFrom: plan.sinceIso, windowTo, sources: plan.handles.map((h) => `x:${h.toLowerCase()}`), requestHash: plan.requestHash, promptVersion: plan.promptVersion, model: plan.model };
    try {
      if (!this.#keyChecked) { keyPreflight(await xai.apiKeyStatus(), plan.model, now); this.#keyChecked = true; }
      const res = await xai.responses(plan.request, this.#cfg.x.timeoutMs);
      const parsed = parsePollResponse(res.raw, plan);
      const rawSha = sha256OfText(res.rawText);
      const finishedAt = this.#now();
      const u = parsed.usage;
      // An answer without any server-side search, or whose searches all failed (rate limit), is not evidence: it is recorded with its
      // real cost as a retryable failure (the slot stays open for the retry policy) and its posts are discarded.
      const searched = (u.xSearchCalls ?? 0) > 0 || (u.serverToolsUsed ?? 0) > 0;
      const noEvidence = !searched ? 'XAI_NO_SEARCH' : parsed.toolCalls.total > 0 && parsed.toolCalls.completed === 0 ? 'XAI_SEARCH_FAILED' : null;
      if (noEvidence) {
        withTransaction(this.#db, () => {
          insertRawResponse(this.#db, rawSha, res.rawText, finishedAt);
          insertSocialPoll(this.#db, { ...base, finishedAt, outcome: noEvidence, errorClass: null, httpStatus: res.httpStatus, rawSha256: rawSha, costUsdTicks: u.costUsdTicks, postsFetched: u.xPostsFetched, usersFetched: u.xUsersFetched,
            inputTokens: u.inputTokens, outputTokens: u.outputTokens, postsReturned: parsed.posts.length, postsNew: 0, usage: { ...u, responseId: parsed.responseId, model: parsed.model, toolCalls: parsed.toolCalls, discardedPosts: parsed.posts.length } });
        });
        const detail = noEvidence === 'XAI_NO_SEARCH' ? 'model answered without calling x_search' : `all ${parsed.toolCalls.failed} search calls failed (rate limit?)`;
        return { outcome: noEvidence, pollId, posts: parsed.posts.length, newPosts: 0, mentions: 0, alerts: 0, costUsd: u.costUsd, postsFetched: u.xPostsFetched, durationMs: finishedAt - startedAt, detail: `${detail}; answer discarded, retried per schedule` };
      }
      if (parsed.toolCalls.failed > 0) this.#log(`[x] poll ${pollId}: ${parsed.toolCalls.failed} of ${parsed.toolCalls.total} search calls failed; coverage is partial`);
      let newPosts = 0, mentions = 0;
      const alerts: Alert[] = [];
      withTransaction(this.#db, () => {
        insertRawResponse(this.#db, rawSha, res.rawText, finishedAt);
        for (const post of parsed.posts) {
          const row: SocialPostRow = {
            postId: `x:${post.postId}`, kind: 'x', sourceId: `x:${post.handle.toLowerCase()}`, authorHandle: post.handle, authorId: null, postedAt: post.postedAt, observedAt: finishedAt,
            text: post.text, url: post.url, evidence: post.citationVerified ? 'API_CITATION' : 'MODEL_TEXT', pollId, raw: post,
          };
          if (!insertSocialPost(this.#db, row)) continue;
          newPosts += 1;
          const found = this.#mentionsForPost(row, post, finishedAt);
          mentions += found.stored;
          alerts.push(...found.alerts);
        }
        insertSocialPoll(this.#db, { ...base, finishedAt, outcome: parsed.completed ? 'OK' : `INCOMPLETE_${parsed.incompleteReason ?? parsed.status ?? 'UNKNOWN'}`.toUpperCase(), errorClass: null, httpStatus: res.httpStatus, rawSha256: rawSha,
          costUsdTicks: u.costUsdTicks, postsFetched: u.xPostsFetched, usersFetched: u.xUsersFetched, inputTokens: u.inputTokens, outputTokens: u.outputTokens, postsReturned: parsed.posts.length, postsNew: newPosts,
          usage: { ...u, responseId: parsed.responseId, model: parsed.model, toolCalls: parsed.toolCalls, rejected: parsed.rejected.slice(0, 20), citedPosts: parsed.citedPostIds.length } });
      });
      await this.#deliver(alerts);
      const costUsd = u.costUsd;
      if (costUsd !== null && costUsd > this.#cfg.x.perRequestBudgetUsd) this.#log(`[x] WARNING poll ${pollId} cost $${costUsd.toFixed(3)} exceeded perRequestBudgetUsd ${this.#cfg.x.perRequestBudgetUsd}`);
      return { outcome: parsed.completed ? 'OK' : 'INCOMPLETE', pollId, posts: parsed.posts.length, newPosts, mentions, alerts: alerts.length, costUsd, postsFetched: u.xPostsFetched, durationMs: finishedAt - startedAt, ...(parsed.rejected.length ? { detail: `rejected=${parsed.rejected.length}` } : {}) };
    } catch (error) {
      const finishedAt = this.#now();
      const code = error instanceof XaiError ? error.code : (error as Error).message === 'XAI_UNVERIFIABLE_COMPLETION' ? 'XAI_UNVERIFIABLE_COMPLETION' : 'POLL_FAILED';
      const httpStatus = error instanceof XaiError ? error.httpStatus : null;
      // A failed/timeout request may still have been charged: it is recorded with unknown cost, which the budget counts conservatively.
      insertSocialPoll(this.#db, { ...base, finishedAt, outcome: code, errorClass: (error as Error).constructor.name, httpStatus, rawSha256: null, costUsdTicks: null, postsFetched: null, usersFetched: null, inputTokens: null, outputTokens: null, postsReturned: 0, postsNew: 0, usage: null });
      return { outcome: code, pollId, posts: 0, newPosts: 0, mentions: 0, alerts: 0, costUsd: null, postsFetched: null, durationMs: finishedAt - startedAt, detail: code === 'POLL_FAILED' ? (error as Error).message.slice(0, 200) : '' };
    }
  }

  /** Consumes the Telegram spool: each valid event becomes a post (first version only; edits are ignored) with regex mentions. */
  async ingestTelegram(now = this.#now()): Promise<TelegramIngestSummary> {
    const dir = this.#cfg.telegram.spoolDirectory;
    const spool = readSpool(dir, 200);
    const summary: TelegramIngestSummary = { files: spool.events.length, invalid: spool.invalid.length, newPosts: 0, mentions: 0, alerts: 0, health: spool.health?.status ?? 'NO_HEALTH_FILE' };
    if (!spool.events.length && !spool.invalid.length) return summary;
    const alerts: Alert[] = [];
    withTransaction(this.#db, () => {
      for (const ev of spool.events) {
        const sourceId = `telegram:${ev.chat.id}`;
        upsertSocialSource(this.#db, { sourceId, kind: 'telegram', handle: ev.chat.username ?? String(ev.chat.id), label: ev.chat.title || ev.chat.username || String(ev.chat.id), enabled: true, config: { chatId: ev.chat.id } }, now);
        const row = telegramPost(ev, sourceId, now);
        if (!insertSocialPost(this.#db, row)) continue;
        summary.newPosts += 1;
        const found = this.#mentionsForPost(row, null, now);
        summary.mentions += found.stored;
        alerts.push(...found.alerts);
      }
    });
    await this.#deliver(alerts);
    summary.alerts = alerts.length;
    const maxSeq = spool.events.reduce((m, e) => Math.max(m, e.seq), 0);
    if (spool.events.length) ackSpool(dir, maxSeq + 1, spool.events.map((e) => e.file), now);
    for (const name of spool.invalid) { try { renameSync(join(dir, name), join(dir, `invalid-${name}`)); } catch { /* leave in place */ } }
    if (spool.invalid.length) this.#log(`[telegram] ${spool.invalid.length} invalid spool file(s) set aside as invalid-*: ${spool.invalid.slice(0, 3).join(', ')}`);
    return summary;
  }

  /** Extracts regex mentions (and, for X, the model's token list), stores them, and builds alerts for new confident ones. */
  #mentionsForPost(row: SocialPostRow, polled: PolledPost | null, now: number): { stored: number; alerts: Alert[] } {
    const catalog = this.catalog(now);
    const stoplist = new Set(this.#cfg.mentions.stoplist);
    const found: { m: ResolvedMention; extractor: string }[] = extractRegexMentions(row.text, catalog, stoplist).map((m) => ({ m, extractor: REGEX_EXTRACTOR }));
    if (polled) {
      const extractor = `grok:${this.#cfg.x.model}:${PROMPT_VERSION}`;
      for (const t of polled.tokens) {
        const r = resolveMention({ tokenText: t.symbol, matchKind: t.contract && !/^[A-Z0-9]{1,20}$/.test(t.symbol) ? 'contract' : 'cashtag', confidence: 0.7, stance: polled.stance, name: t.name, contract: t.contract }, catalog);
        found.push({ m: r, extractor });
      }
    }
    const alerts: Alert[] = [];
    const alerted = new Set<string>(); // one alert per post and token, even when several extractors found it
    let stored = 0;
    for (const { m, extractor } of found) {
      const mentionId = sha256Hex('mention', row.postId, extractor, m.tokenText.toUpperCase()).slice(0, 32);
      const rec: TokenMentionRow = { mentionId, postId: row.postId, extractor, tokenText: m.tokenText, matchKind: m.matchKind, instrumentId: m.instrumentId, resolution: m.resolution, candidates: m.candidates, stance: m.stance, confidence: m.confidence, extractedAt: now };
      if (!insertTokenMention(this.#db, rec)) continue;
      stored += 1;
      if (m.confidence < 0.5) continue; // stored for review, not alert-worthy
      const key = m.instrumentId ?? m.tokenText.toUpperCase();
      if (alerted.has(key)) continue;
      alerted.add(key);
      const alert = this.buildMentionAlert(rec, row, polled, now);
      insertAlert(this.#db, { ...alert, delivered: {} });
      alerts.push(alert);
    }
    return { stored, alerts };
  }

  buildMentionAlert(m: TokenMentionRow, post: SocialPostRow, polled: PolledPost | null, now: number): Alert {
    const instrument: InstrumentRow | null = m.instrumentId ? getInstrument(this.#db, m.instrumentId) : null;
    const market = instrument ? this.#marketContext(instrument.instrumentId, now) : null;
    const active = market !== null && (market.activePhase || market.recentOrderAt !== null);
    const level: AlertLevel = active ? 'MENTION_SETUP' : 'MENTION';
    const label = post.kind === 'x' ? this.#cfg.x.labels[(post.authorHandle ?? '').toLowerCase()] ?? post.authorHandle : post.sourceId;
    const postedAt = post.postedAt ?? post.observedAt;
    const freshnessMs = post.kind === 'x' ? this.xFreshnessMs() : 10 * 60_000;
    return {
      alertId: sha256Hex('social-alert', m.mentionId).slice(0, 32), eventId: sha256Hex('mention-event', m.mentionId).slice(0, 40), runId: SOCIAL_RUN_ID,
      instrumentId: m.instrumentId ?? `${m.resolution.toLowerCase()}:${m.tokenText}`, level, code: active ? 'TOKEN_MENTION_ACTIVE_SETUP' : 'TOKEN_MENTION', createdAt: now, isFresh: now - postedAt <= freshnessMs,
      payload: {
        mode: 'social', symbol: instrument?.symbol ?? m.tokenText, displaySymbol: instrument?.displaySymbol ?? m.tokenText, tokenName: instrument?.tokenName ?? null,
        source: { kind: post.kind, handle: post.authorHandle, label: label ?? null, sourceId: post.sourceId },
        post: { id: post.postId, url: post.url, postedAt: new Date(postedAt).toISOString(), excerpt: post.text.slice(0, 300), evidence: post.evidence, citationVerified: polled?.citationVerified ?? null },
        mention: { tokenText: m.tokenText, matchKind: m.matchKind, resolution: m.resolution, candidates: m.candidates, stance: m.stance, confidence: m.confidence, extractor: m.extractor },
        instrument: instrument ? { instrumentId: instrument.instrumentId, alphaId: instrument.alphaId, chain: instrument.chainName, contractAddress: instrument.contractAddress } : null,
        market, timing: { decisionBarCloseAt: new Date(postedAt).toISOString(), emittedAt: new Date(now).toISOString(), latencyMs: now - postedAt },
        disclaimer: DISCLAIMER,
      },
    };
  }

  #marketContext(instrumentId: string, now: number): { runId: string | null; phase: string | null; activePhase: boolean; lastEvent: string | null; lastEventAt: string | null; recentOrderAt: string | null } {
    const run = latestRun(this.#db, 'online');
    if (!run) return { runId: null, phase: null, activePhase: false, lastEvent: null, lastEventAt: null, recentOrderAt: null };
    const head = getHead(this.#db, run.runId, instrumentId);
    const last = listEvents(this.#db, { runId: run.runId, instrumentId, limit: 1, newest: true })[0] ?? null;
    const order = listEvents(this.#db, { runId: run.runId, instrumentId, codes: ['SECOND_LEG_BREAKOUT'], limit: 1, newest: true })[0] ?? null;
    const recentOrder = order && now - order.decisionBarCloseAt <= 24 * 3_600_000 ? order : null;
    return {
      runId: run.runId, phase: head?.phase ?? null, activePhase: head !== null && (ACTIVE_PHASES as readonly string[]).includes(head.phase),
      lastEvent: last?.code ?? null, lastEventAt: last ? new Date(last.decisionBarCloseAt).toISOString() : null, recentOrderAt: recentOrder ? new Date(recentOrder.decisionBarCloseAt).toISOString() : null,
    };
  }

  async #deliver(alerts: readonly Alert[]): Promise<void> {
    for (const a of alerts) {
      const delivered = await this.#dispatcher.dispatch(a);
      updateAlertDelivery(this.#db, a.alertId, delivered);
    }
  }

  /** Main loop: Telegram spool every telegram.pollIntervalMs; X polled when the cadence says it is due (checked once a minute), its batches stepped between ticks, under the `social-writer` lease. */
  async run(opts: { once: boolean; forceX?: boolean; forceSinceMs?: number }): Promise<void> {
    const owner = `${hostname()}#${process.pid}#${randomUUID().slice(0, 8)}`;
    const ttl = this.#cfg.lease.ttlMs;
    if (!acquireLease(this.#db, 'social-writer', owner, ttl, this.#now())) throw new SocialWriterBusyError('another social monitor holds the lease; refusing to start a second one');
    this.#lease = { owner, ttl };
    this.#stopping = false;
    const onSignal = () => { this.#stopping = true; this.#log('[social] stop requested'); };
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
    try {
      this.syncSources();
      const xActive = this.#cfg.x.enabled && this.#xai !== null;
      this.#log(`[social] x=${this.#cfg.x.enabled ? `${this.#cfg.x.handles.length} handles ${this.cadence()} (model ${this.#cfg.x.model}, budget $${this.#cfg.x.dailyBudgetUsd}/day)` : 'disabled'}${this.#xai ? '' : ' [no XAI_API_KEY: X polling off]'} telegram=${this.#cfg.telegram.enabled ? this.#cfg.telegram.spoolDirectory : 'disabled'} writer=${owner}`);
      let nextXCheck = 0;
      let lastReason = '';
      let xRun: { run: XPollRun; reason: string } | null = null;
      const summarize = (x: XPollSummary, reason: string) => this.#log(`[x] poll ${x.outcome} (${reason}) posts=${x.posts} new=${x.newPosts} mentions=${x.mentions} alerts=${x.alerts} fetched=${x.postsFetched ?? '-'} cost=${x.costUsd === null ? '-' : `$${x.costUsd.toFixed(3)}`} ${x.durationMs}ms${x.detail ? ` ${x.detail}` : ''}`);
      do {
        const now = this.#now();
        acquireLease(this.#db, 'social-writer', owner, ttl, now);
        if (this.#cfg.telegram.enabled) {
          const t = await this.ingestTelegram(now);
          if (t.files || t.invalid) this.#log(`[telegram] files=${t.files} invalid=${t.invalid} newPosts=${t.newPosts} mentions=${t.mentions} alerts=${t.alerts} reader=${t.health}`);
        }
        if (xActive && xRun) {
          if (now >= xRun.run.nextBatchAt && (await this.stepXPoll(xRun.run, now))) { summarize(xRun.run.total, xRun.reason); xRun = null; }
        } else if (xActive && now >= nextXCheck) {
          nextXCheck = now + 60_000;
          const d = this.xPollDecision(now);
          if (d.due || (opts.once && opts.forceX)) {
            const reason = d.due ? d.reason : 'FORCED';
            if (opts.once) {
              summarize(await this.pollX(now, opts.forceX ? opts.forceSinceMs : undefined), reason);
            } else {
              const { run, skipped } = this.startXPoll(now);
              if (!run) this.#log(`[x] poll ${skipped} (${reason})`);
              else if (await this.stepXPoll(run, now)) summarize(run.total, reason);
              else xRun = { run, reason };
            }
            lastReason = '';
          } else if (opts.once || d.reason !== lastReason) {
            this.#log(`[x] not due (${d.reason}); slot ${new Date(d.slotAt).toISOString()} next ${new Date(d.nextAt).toISOString()} attemptsForSlot=${d.attemptsForSlot}`);
            lastReason = d.reason;
          }
        } else if (!xActive && opts.once) {
          this.#log(`[x] poll ${this.#xai ? 'SKIPPED_DISABLED' : 'SKIPPED_NO_API_KEY'}`);
        }
        if (opts.once) break;
        await sleep(this.#cfg.telegram.enabled ? this.#cfg.telegram.pollIntervalMs : Math.min(60_000, Math.max(1000, (xRun ? xRun.run.nextBatchAt : nextXCheck) - this.#now())));
      } while (!this.#stopping);
      if (xRun) { this.#finishXPoll(xRun.run); summarize(xRun.run.total, xRun.reason); }
    } finally {
      this.#lease = null;
      releaseLease(this.#db, 'social-writer', owner);
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
    }
  }
}

/** Social context attached to kline alerts: mentions of the instrument by watched sources in the last 24 h. */
export function socialContextFor(db: Db): (instrumentId: string, now: number) => Record<string, unknown> | null {
  return (instrumentId, now) => {
    const rows = listMentions(db, { instrumentId, sinceMs: now - 24 * 3_600_000, limit: 50 });
    if (!rows.length) return null;
    const last = rows[0]!;
    return { mentions24h: rows.length, lastMentionAt: new Date(last.postedAt ?? last.extractedAt).toISOString(), lastMentionBy: `${last.kind}:${last.authorHandle ?? last.sourceId}`, lastStance: last.stance, lastUrl: last.url };
  };
}

function telegramPost(ev: SpoolEvent, sourceId: string, now: number): SocialPostRow {
  const url = ev.chat.username ? `https://t.me/${ev.chat.username}/${ev.message.id}` : null;
  return {
    postId: `telegram:${ev.chat.id}:${ev.message.id}`, kind: 'telegram', sourceId, authorHandle: ev.message.sender.username, authorId: ev.message.sender.id === null ? null : String(ev.message.sender.id),
    postedAt: ev.message.date * 1000, observedAt: now, text: ev.message.text, url, evidence: 'TELEGRAM_READER', pollId: null,
    raw: { seq: ev.seq, chat: ev.chat, links: ev.message.links, forward: ev.message.forward, editDate: ev.message.editDate, bot: ev.message.sender.bot },
  };
}
