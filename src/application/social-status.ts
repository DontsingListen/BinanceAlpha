import { readSpoolHealth } from '../adapters/telegram/spool.ts';
import type { Db } from '../storage/db.ts';
import { getHead, latestRun } from '../storage/repos.ts';
import { listMentions, listSocialPolls, listSocialSources, recentMentionedInstruments, socialCostSince } from '../storage/social-repos.ts';

const iso = (ms: number | null | undefined): string => (ms === null || ms === undefined ? '-' : new Date(ms).toISOString().slice(0, 16).replace('T', ' '));

export function printSocialStatus(db: Db, log: (line: string) => void, now: number, spoolDirectory: string | null): void {
  log('== social ==');
  const sources = listSocialSources(db);
  const polls = listSocialPolls(db, { kind: 'x', limit: 3 });
  if (!sources.length && !polls.length) { log('no social sources yet (config/social.json; run `social`)'); return; }
  const byKind: Record<string, { enabled: number; total: number }> = {};
  for (const s of sources) { const k = (byKind[s.kind] ??= { enabled: 0, total: 0 }); k.total += 1; if (s.enabled) k.enabled += 1; }
  log(`sources: ${JSON.stringify(byKind)}`);
  const cost = socialCostSince(db, 'x', Math.floor(now / 86_400_000) * 86_400_000);
  log(`x polls today: ${cost.polls} cost=$${(cost.usdTicks / 10_000_000_000).toFixed(3)}${cost.unknownPolls ? ` (+${cost.unknownPolls} unknown-cost)` : ''}`);
  for (const p of polls) log(`  poll ${iso(p.startedAt)} ${p.outcome} posts=${p.postsReturned} new=${p.postsNew} fetched=${p.postsFetched ?? '-'} cost=${p.costUsdTicks === null ? '-' : `$${(p.costUsdTicks / 10_000_000_000).toFixed(3)}`} model=${p.model} ${p.finishedAt - p.startedAt}ms`);
  if (spoolDirectory) {
    const h = readSpoolHealth(spoolDirectory);
    log(`telegram reader: ${h ? `${h.status} channels=${h.channels} pending=${h.pending ?? '-'} updated=${iso(h.updatedAt)}${h.detail ? ` ${h.detail}` : ''}` : `no health file in ${spoolDirectory} (reader not running or not logged in)`}`);
  }
  const run = latestRun(db, 'online');
  const mentioned = recentMentionedInstruments(db, now - 24 * 3_600_000).slice(0, 10);
  log(`mentioned instruments (24h, UNIQUE): ${mentioned.length}`);
  for (const m of mentioned) log(`  ${m.instrumentId.padEnd(36)} mentions=${m.mentions} last=${iso(m.lastAt)} phase=${run ? getHead(db, run.runId, m.instrumentId)?.phase ?? '-' : '-'} by=${m.authors.slice(0, 3).join(',')}`);
  const recent = listMentions(db, { sinceMs: now - 24 * 3_600_000, limit: 10 });
  log(`last ${recent.length} mentions (24h):`);
  for (const m of recent) log(`  ${iso(m.postedAt ?? m.extractedAt)} ${m.kind.padEnd(8)} ${(m.authorHandle ?? m.sourceId).padEnd(16)} ${m.tokenText.padEnd(12)} ${m.resolution.padEnd(10)} ${m.stance.padEnd(8)} ${m.url ?? ''}`);
}
