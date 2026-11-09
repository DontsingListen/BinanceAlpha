/** Repositories for social signal sources (ADR 0003): sources, provider polls, posts and token mentions. */
import type { Db } from './db.ts';

export type SocialSourceRow = { sourceId: string; kind: 'x' | 'telegram'; handle: string; label: string; enabled: boolean; config: unknown; firstSeenAt: number; lastSeenAt: number };

export function upsertSocialSource(db: Db, s: Omit<SocialSourceRow, 'firstSeenAt' | 'lastSeenAt'>, now: number): void {
  db.prepare(`INSERT INTO social_sources(source_id, kind, handle, label, enabled, config_json, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source_id) DO UPDATE SET handle = excluded.handle, label = excluded.label, enabled = excluded.enabled, config_json = excluded.config_json, last_seen_at = excluded.last_seen_at`)
    .run(s.sourceId, s.kind, s.handle, s.label, s.enabled ? 1 : 0, JSON.stringify(s.config), now, now);
}

export function disableSocialSourcesExcept(db: Db, kind: string, keepIds: readonly string[]): number {
  const placeholders = keepIds.map(() => '?').join(',');
  const r = db.prepare(`UPDATE social_sources SET enabled = 0 WHERE kind = ? AND enabled = 1${keepIds.length ? ` AND source_id NOT IN (${placeholders})` : ''}`).run(kind, ...keepIds);
  return Number(r.changes);
}

export function listSocialSources(db: Db, kind?: string): SocialSourceRow[] {
  const rows = (kind ? db.prepare('SELECT * FROM social_sources WHERE kind = ? ORDER BY source_id').all(kind) : db.prepare('SELECT * FROM social_sources ORDER BY source_id').all()) as Record<string, unknown>[];
  return rows.map((r) => ({
    sourceId: r['source_id'] as string, kind: r['kind'] as 'x' | 'telegram', handle: r['handle'] as string, label: r['label'] as string, enabled: r['enabled'] === 1,
    config: JSON.parse(r['config_json'] as string), firstSeenAt: r['first_seen_at'] as number, lastSeenAt: r['last_seen_at'] as number,
  }));
}

export type SocialPollRow = {
  pollId: string; kind: 'x' | 'telegram'; startedAt: number; finishedAt: number; windowFrom: string; windowTo: string; sources: readonly string[];
  requestHash: string; promptVersion: string; model: string; outcome: string; errorClass: string | null; httpStatus: number | null; rawSha256: string | null;
  costUsdTicks: number | null; postsFetched: number | null; usersFetched: number | null; inputTokens: number | null; outputTokens: number | null;
  postsReturned: number; postsNew: number; usage: unknown;
};

export function insertSocialPoll(db: Db, p: SocialPollRow): void {
  db.prepare(`INSERT OR REPLACE INTO social_polls(poll_id, kind, started_at, finished_at, window_from, window_to, sources_json, request_hash, prompt_version, model, outcome, error_class, http_status, raw_sha256,
    cost_usd_ticks, posts_fetched, users_fetched, input_tokens, output_tokens, posts_returned, posts_new, usage_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(p.pollId, p.kind, p.startedAt, p.finishedAt, p.windowFrom, p.windowTo, JSON.stringify(p.sources), p.requestHash, p.promptVersion, p.model, p.outcome, p.errorClass, p.httpStatus, p.rawSha256,
      p.costUsdTicks, p.postsFetched, p.usersFetched, p.inputTokens, p.outputTokens, p.postsReturned, p.postsNew, p.usage === undefined ? null : JSON.stringify(p.usage));
}

export function listSocialPolls(db: Db, opts: { kind?: string; limit?: number } = {}): SocialPollRow[] {
  const rows = db.prepare(`SELECT * FROM social_polls${opts.kind ? ' WHERE kind = ?' : ''} ORDER BY started_at DESC LIMIT ?`).all(...(opts.kind ? [opts.kind] : []), opts.limit ?? 20) as Record<string, unknown>[];
  return rows.map((r) => ({
    pollId: r['poll_id'] as string, kind: r['kind'] as 'x' | 'telegram', startedAt: r['started_at'] as number, finishedAt: r['finished_at'] as number, windowFrom: r['window_from'] as string, windowTo: r['window_to'] as string,
    sources: JSON.parse(r['sources_json'] as string) as string[], requestHash: r['request_hash'] as string, promptVersion: r['prompt_version'] as string, model: r['model'] as string, outcome: r['outcome'] as string,
    errorClass: (r['error_class'] as string | null) ?? null, httpStatus: (r['http_status'] as number | null) ?? null, rawSha256: (r['raw_sha256'] as string | null) ?? null,
    costUsdTicks: (r['cost_usd_ticks'] as number | null) ?? null, postsFetched: (r['posts_fetched'] as number | null) ?? null, usersFetched: (r['users_fetched'] as number | null) ?? null,
    inputTokens: (r['input_tokens'] as number | null) ?? null, outputTokens: (r['output_tokens'] as number | null) ?? null, postsReturned: r['posts_returned'] as number, postsNew: r['posts_new'] as number,
    usage: r['usage_json'] ? JSON.parse(r['usage_json'] as string) : null,
  }));
}

/** Provider-reported cost of all polls of a kind started at or after `sinceMs`; unknown costs count as `unknownPolls`. */
export function socialCostSince(db: Db, kind: string, sinceMs: number): { usdTicks: number; polls: number; unknownPolls: number } {
  const r = db.prepare('SELECT COALESCE(SUM(cost_usd_ticks), 0) AS ticks, COUNT(*) AS polls, SUM(cost_usd_ticks IS NULL) AS unknown FROM social_polls WHERE kind = ? AND started_at >= ?').get(kind, sinceMs) as { ticks: number; polls: number; unknown: number };
  return { usdTicks: Number(r.ticks), polls: Number(r.polls), unknownPolls: Number(r.unknown ?? 0) };
}

export type SocialPostRow = {
  postId: string; kind: 'x' | 'telegram'; sourceId: string; authorHandle: string | null; authorId: string | null; postedAt: number | null; observedAt: number;
  text: string; url: string | null; evidence: string; pollId: string | null; raw: unknown;
};

export function insertSocialPost(db: Db, p: SocialPostRow): boolean {
  const r = db.prepare('INSERT OR IGNORE INTO social_posts(post_id, kind, source_id, author_handle, author_id, posted_at, observed_at, text, url, evidence, poll_id, raw_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(p.postId, p.kind, p.sourceId, p.authorHandle, p.authorId, p.postedAt, p.observedAt, p.text, p.url, p.evidence, p.pollId, JSON.stringify(p.raw));
  return r.changes > 0;
}

function rowToPost(r: Record<string, unknown>): SocialPostRow {
  return {
    postId: r['post_id'] as string, kind: r['kind'] as 'x' | 'telegram', sourceId: r['source_id'] as string, authorHandle: (r['author_handle'] as string | null) ?? null, authorId: (r['author_id'] as string | null) ?? null,
    postedAt: (r['posted_at'] as number | null) ?? null, observedAt: r['observed_at'] as number, text: r['text'] as string, url: (r['url'] as string | null) ?? null, evidence: r['evidence'] as string,
    pollId: (r['poll_id'] as string | null) ?? null, raw: JSON.parse(r['raw_json'] as string),
  };
}

export function getSocialPost(db: Db, postId: string): SocialPostRow | null {
  const r = db.prepare('SELECT * FROM social_posts WHERE post_id = ?').get(postId) as Record<string, unknown> | undefined;
  return r ? rowToPost(r) : null;
}

export function listSocialPosts(db: Db, opts: { kind?: string; sinceMs?: number; limit?: number } = {}): SocialPostRow[] {
  const where: string[] = []; const params: (string | number)[] = [];
  if (opts.kind) { where.push('kind = ?'); params.push(opts.kind); }
  if (opts.sinceMs !== undefined) { where.push('observed_at >= ?'); params.push(opts.sinceMs); }
  const rows = db.prepare(`SELECT * FROM social_posts${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY observed_at DESC LIMIT ?`).all(...params, opts.limit ?? 50) as Record<string, unknown>[];
  return rows.map(rowToPost);
}

export type TokenMentionRow = {
  mentionId: string; postId: string; extractor: string; tokenText: string; matchKind: string; instrumentId: string | null; resolution: 'UNIQUE' | 'AMBIGUOUS' | 'UNRESOLVED';
  candidates: readonly string[]; stance: string; confidence: number; extractedAt: number;
};

export function insertTokenMention(db: Db, m: TokenMentionRow): boolean {
  const r = db.prepare('INSERT OR IGNORE INTO token_mentions(mention_id, post_id, extractor, token_text, match_kind, instrument_id, resolution, candidates_json, stance, confidence, extracted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(m.mentionId, m.postId, m.extractor, m.tokenText, m.matchKind, m.instrumentId, m.resolution, JSON.stringify(m.candidates), m.stance, m.confidence, m.extractedAt);
  return r.changes > 0;
}

export type MentionView = TokenMentionRow & { kind: string; sourceId: string; authorHandle: string | null; postedAt: number | null; url: string | null; text: string; evidence: string };

function rowToMentionView(r: Record<string, unknown>): MentionView {
  return {
    mentionId: r['mention_id'] as string, postId: r['post_id'] as string, extractor: r['extractor'] as string, tokenText: r['token_text'] as string, matchKind: r['match_kind'] as string,
    instrumentId: (r['instrument_id'] as string | null) ?? null, resolution: r['resolution'] as 'UNIQUE' | 'AMBIGUOUS' | 'UNRESOLVED', candidates: JSON.parse(r['candidates_json'] as string) as string[],
    stance: r['stance'] as string, confidence: r['confidence'] as number, extractedAt: r['extracted_at'] as number,
    kind: r['kind'] as string, sourceId: r['source_id'] as string, authorHandle: (r['author_handle'] as string | null) ?? null, postedAt: (r['posted_at'] as number | null) ?? null,
    url: (r['url'] as string | null) ?? null, text: r['text'] as string, evidence: r['evidence'] as string,
  };
}

export function listMentions(db: Db, opts: { sinceMs?: number; instrumentId?: string; resolution?: string; limit?: number } = {}): MentionView[] {
  const where: string[] = []; const params: (string | number)[] = [];
  if (opts.sinceMs !== undefined) { where.push('m.extracted_at >= ?'); params.push(opts.sinceMs); }
  if (opts.instrumentId) { where.push('m.instrument_id = ?'); params.push(opts.instrumentId); }
  if (opts.resolution) { where.push('m.resolution = ?'); params.push(opts.resolution); }
  const rows = db.prepare(`SELECT m.*, p.kind, p.source_id, p.author_handle, p.posted_at, p.url, p.text, p.evidence FROM token_mentions m JOIN social_posts p ON p.post_id = m.post_id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY m.extracted_at DESC LIMIT ?`).all(...params, opts.limit ?? 50) as Record<string, unknown>[];
  return rows.map(rowToMentionView);
}

/** Instruments with a UNIQUE-resolved mention at or after `sinceMs`, most recently mentioned first. */
export function recentMentionedInstruments(db: Db, sinceMs: number): { instrumentId: string; mentions: number; lastAt: number; authors: string[] }[] {
  const rows = db.prepare(`SELECT m.instrument_id, COUNT(*) AS n, MAX(COALESCE(p.posted_at, p.observed_at)) AS last_at, GROUP_CONCAT(DISTINCT COALESCE(p.author_handle, p.source_id)) AS authors
    FROM token_mentions m JOIN social_posts p ON p.post_id = m.post_id WHERE m.resolution = 'UNIQUE' AND m.instrument_id IS NOT NULL AND COALESCE(p.posted_at, p.observed_at) >= ?
    GROUP BY m.instrument_id ORDER BY last_at DESC`).all(sinceMs) as { instrument_id: string; n: number; last_at: number; authors: string | null }[];
  return rows.map((r) => ({ instrumentId: r.instrument_id, mentions: Number(r.n), lastAt: Number(r.last_at), authors: (r.authors ?? '').split(',').filter(Boolean) }));
}
