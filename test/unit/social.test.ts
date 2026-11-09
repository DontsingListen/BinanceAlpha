import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AlphaClient } from '../../src/adapters/binance-alpha/client.ts';
import { parseExchangeInfo, parseTokenList } from '../../src/adapters/binance-alpha/dto.ts';
import { INITIAL_STATE } from '../../src/domain/types.ts';
import { openDatabase } from '../../src/storage/db.ts';
import { createRun, getInstrument, upsertHead, upsertInstrument } from '../../src/storage/repos.ts';
import { insertSocialPost, insertTokenMention, listMentions, listSocialSources, recentMentionedInstruments } from '../../src/storage/social-repos.ts';
import { AlertDispatcher, type Alert, type AlertSink } from '../../src/application/alerts.ts';
import { loadConfig } from '../../src/application/config.ts';
import { SocialMonitor } from '../../src/application/social.ts';
import { loadSocialConfig } from '../../src/application/social-config.ts';
import { discoverUniverse } from '../../src/application/universe.ts';

const ROOT = resolve(import.meta.dirname, '../..');
const NOW = Date.UTC(2026, 10, 6, 13, 0);
const UAI = 'binance-alpha:alpha:ALPHA_461USDT';

function tempSocial(xEnabled = false): { dir: string; configPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'alpha-social-'));
  const configPath = join(dir, 'social.json');
  writeFileSync(configPath, JSON.stringify({
    alertsJsonlPath: join(dir, 'alerts.jsonl'),
    x: { enabled: xEnabled, handles: xEnabled ? ['@fixture_alpha', 'fixture_alpha', 'fixture_beta'] : [] },
    telegram: { enabled: true, spoolDirectory: join(dir, 'inbox'), pollIntervalMs: 1000 },
    mentions: { stoplist: ['custom'] },
  }));
  return { dir, configPath };
}

function spoolEvent(dir: string, seq: number, id: number, text: string, date = Math.floor(NOW / 1000) - 60): void {
  writeFileSync(join(dir, `event-${String(seq).padStart(16, '0')}.json`), JSON.stringify({ schema: 1, seq, chat: { id: -1001, title: 'Alpha Calls', username: 'alphacalls' }, message: { id, date, edit_date: null, sender: { id: 5, username: 'caller', bot: false }, text, links: [], forward: false } }));
}

function setupDb() {
  const db = openDatabase(':memory:');
  upsertInstrument(db, { instrumentId: UAI, provider: 'binance-alpha', marketType: 'alpha', symbol: 'ALPHA_461USDT', alphaId: 'ALPHA_461', baseAsset: 'ALPHA_461', quoteAsset: 'USDT', displaySymbol: 'UAI', tokenName: 'UnifAI Network', chainId: '56', chainName: 'BSC', contractAddress: '0x3e5d4f8aee0d9b3082d5f6da5d6e225d17ba9ea0', status: 'TRADING', tokenOffline: false }, NOW - 1);
  return db;
}

test('social config: handles are normalized/deduplicated, stoplist extends the defaults, limits enforced', () => {
  const { configPath } = tempSocial(true);
  const cfg = loadSocialConfig(ROOT, { socialConfig: configPath });
  assert.deepEqual(cfg.x.handles, ['fixture_alpha', 'fixture_beta']);
  assert.ok(cfg.mentions.stoplist.includes('CUSTOM') && cfg.mentions.stoplist.includes('ATH'));
  assert.equal(cfg.telegram.enabled, true);
  const tooMany = tempSocial();
  writeFileSync(tooMany.configPath, JSON.stringify({ x: { enabled: true, handles: Array.from({ length: 21 }, (_, i) => `h${i}`) } }));
  assert.throws(() => loadSocialConfig(ROOT, { socialConfig: tooMany.configPath }), /exceed the x_search limit/);
});

test('telegram spool ingest: posts, regex mentions, MENTION alerts, ack and cleanup; MENTION_SETUP when the instrument has an active setup', async () => {
  const { dir, configPath } = tempSocial();
  const inbox = join(dir, 'inbox');
  const cfg = loadSocialConfig(ROOT, { socialConfig: configPath });
  const db = setupDb();
  const delivered: Alert[] = [];
  const sink: AlertSink = { name: 'capture', deliver: (a) => { delivered.push(a); } };
  const monitor = new SocialMonitor({ db, cfg, xai: null, dispatcher: new AlertDispatcher([sink]), log: () => {}, now: () => NOW });
  const { mkdirSync } = await import('node:fs');
  mkdirSync(inbox, { recursive: true });
  spoolEvent(inbox, 1, 10, '$UAI 二段突破，冲');
  spoolEvent(inbox, 2, 11, 'gm, no tokens here');
  spoolEvent(inbox, 3, 12, '$WARD 新币');
  writeFileSync(join(inbox, 'event-0000000000000004.json'), JSON.stringify({ schema: 2 }));
  writeFileSync(join(inbox, 'health.json'), JSON.stringify({ status: 'POLLING', updatedAt: NOW, channels: 1, pending: 0 }));

  const r1 = await monitor.ingestTelegram(NOW);
  assert.deepEqual({ files: r1.files, invalid: r1.invalid, newPosts: r1.newPosts, mentions: r1.mentions, alerts: r1.alerts, health: r1.health }, { files: 3, invalid: 1, newPosts: 3, mentions: 2, alerts: 2, health: 'POLLING' });
  assert.equal(JSON.parse(readFileSync(join(inbox, 'ack.json'), 'utf8')).nextSeq, 4);
  assert.ok(!existsSync(join(inbox, 'event-0000000000000001.json')) && existsSync(join(inbox, 'invalid-event-0000000000000004.json')));
  assert.equal(listSocialSources(db, 'telegram')[0]?.label, 'Alpha Calls');
  const uai = delivered.find((a) => a.instrumentId === UAI)!;
  assert.equal(uai.level, 'MENTION');
  assert.equal(uai.code, 'TOKEN_MENTION');
  assert.equal(uai.isFresh, true);
  assert.equal((uai.payload['post'] as { url: string }).url, 'https://t.me/alphacalls/10');
  assert.equal((uai.payload['mention'] as { resolution: string }).resolution, 'UNIQUE');
  assert.equal(delivered.find((a) => a.instrumentId === 'unresolved:WARD')?.level, 'MENTION');
  assert.equal(listMentions(db, { resolution: 'UNIQUE' }).length, 1);
  assert.deepEqual(recentMentionedInstruments(db, NOW - 3_600_000).map((m) => [m.instrumentId, m.mentions]), [[UAI, 1]]);

  const r2 = await monitor.ingestTelegram(NOW + 1000);
  assert.equal(r2.files, 0);
  assert.equal(r2.newPosts, 0);

  // an active setup on the mentioned instrument upgrades the alert level
  createRun(db, { runId: 'online-test', mode: 'online', startedAt: NOW - 10, endedAt: null, status: 'running', policyVersion: 'v0', policyHash: 'h', schemaVersion: 2, codeHash: 'c', config: {} });
  upsertHead(db, { runId: 'online-test', instrumentId: UAI, seq: 1, phase: 'BASE', lastOpenAt: null, state: { ...INITIAL_STATE, phase: 'BASE' }, updatedAt: NOW });
  spoolEvent(inbox, 5, 13, 'UAI 继续看，base 很稳');
  const r3 = await monitor.ingestTelegram(NOW + 2000);
  assert.equal(r3.alerts, 1);
  const setupAlert = delivered.at(-1)!;
  assert.equal(setupAlert.level, 'MENTION_SETUP');
  assert.equal((setupAlert.payload['market'] as { phase: string }).phase, 'BASE');
  assert.equal((setupAlert.payload['mention'] as { matchKind: string }).matchKind, 'symbol');
});

test('universe selection pins recently mentioned instruments beyond the capacity limit', async () => {
  const db = openDatabase(':memory:');
  const tokenDoc = JSON.parse(readFileSync(resolve(ROOT, 'test/fixtures/alpha-token-list-sample.json'), 'utf8')) as { data: unknown };
  const infoDoc = JSON.parse(readFileSync(resolve(ROOT, 'test/fixtures/alpha-exchange-info-sample.json'), 'utf8')) as { data: unknown };
  const fake = {
    getTokenList: async () => ({ outcome: 'OK', value: parseTokenList(tokenDoc.data).tokens, rawText: JSON.stringify(tokenDoc), attempt: { rawSha256: 'a'.repeat(64) }, rejected: [], message: null }),
    getExchangeInfo: async () => ({ outcome: 'OK', value: parseExchangeInfo(infoDoc.data).symbols, rawText: JSON.stringify(infoDoc), attempt: { rawSha256: 'b'.repeat(64) }, rejected: [], message: null }),
  } as unknown as AlphaClient;
  const base = loadConfig(ROOT, { maxInstruments: '1' });
  const cfg = { ...base, selection: { ...base.selection, orderBy: 'instrument_id_asc' as const, socialPinHours: 24, socialMaxPinned: 5 } };
  const first = await discoverUniverse(db, fake, cfg, NOW);
  assert.equal(first.selected.length, 1);
  assert.equal(first.counts.socialPinned, 0);
  const capacityExcluded = first.excluded.filter((e) => e.reason === 'NOT_SELECTED_CAPACITY').map((e) => e.instrumentId);
  assert.ok(capacityExcluded.length >= 1);
  const pinTarget = capacityExcluded[0]!;
  assert.ok(getInstrument(db, pinTarget));
  insertSocialPost(db, { postId: 'x:1', kind: 'x', sourceId: 'x:fixture_alpha', authorHandle: 'fixture_alpha', authorId: null, postedAt: NOW - 60_000, observedAt: NOW, text: 'call', url: 'https://x.com/fixture_alpha/status/1', evidence: 'API_CITATION', pollId: null, raw: {} });
  insertTokenMention(db, { mentionId: 'm1', postId: 'x:1', extractor: 'regex-v1', tokenText: 'X', matchKind: 'cashtag', instrumentId: pinTarget, resolution: 'UNIQUE', candidates: [pinTarget], stance: 'bullish', confidence: 0.8, extractedAt: NOW });
  const second = await discoverUniverse(db, fake, cfg, NOW + 1000);
  assert.equal(second.counts.socialPinned, 1);
  assert.equal(second.selected.length, 2);
  assert.ok(second.selected.some((r) => r.instrumentId === pinTarget));
  assert.ok(!second.excluded.some((e) => e.instrumentId === pinTarget));
  // an `only` list disables pinning
  const onlyCfg = { ...cfg, selection: { ...cfg.selection, only: [first.selected[0]!.symbol] } };
  const third = await discoverUniverse(db, fake, onlyCfg, NOW + 2000);
  assert.equal(third.counts.socialPinned, 0);
});
