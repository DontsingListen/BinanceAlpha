import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../src/storage/db.ts';
import { acquireLease, candleVersionsOfBar, insertCandleVersion, insertEvent, insertJournal, latestCandles, upsertInstrument } from '../../src/storage/repos.ts';
import { parseKlineRows } from '../../src/adapters/binance-alpha/dto.ts';

const row = (openTime: number, close: string) => parseKlineRows([[String(openTime), '1', '2', '0.5', close, '10', String(openTime + 299_999), '15', '3', '0', '0', '0']], 300_000).rows[0]!;

test('candle versions are idempotent for identical content and keep revisions side by side', () => {
  const db = openDatabase(':memory:');
  const a = insertCandleVersion(db, 'i', 300_000, row(300_000, '1.5'), 1000, null);
  const b = insertCandleVersion(db, 'i', 300_000, row(300_000, '1.5'), 2000, null);
  assert.equal(a.inserted, true);
  assert.equal(b.inserted, false);
  assert.equal(a.versionId, b.versionId);
  const c = insertCandleVersion(db, 'i', 300_000, row(300_000, '1.6'), 3000, null); // revision
  assert.equal(c.inserted, true);
  assert.equal(candleVersionsOfBar(db, 'i', 300_000, 300_000).length, 2);
  const latest = latestCandles(db, 'i', 300_000);
  assert.equal(latest.length, 1);
  assert.equal(latest[0]!.close, '1.6');
  assert.equal(latest[0]!.firstObservedAt, 3000);
});

test('events and journal rows are insert-once; identity changes bump the version', () => {
  const db = openDatabase(':memory:');
  const ev = { eventId: 'e1', runId: 'r', instrumentId: 'i', seq: 1, setupId: null, kind: 'TRANSITION' as const, code: 'WARMUP_COMPLETE' as const, fromPhase: 'WARMUP' as const, toPhase: 'IDLE' as const, decisionBarOpenAt: 0, decisionBarCloseAt: 300_000, emittedAt: 305_000, isFresh: true, candleVersionId: 'v', inputHash: 'h', policyHash: 'p', values: {}, thresholds: {} };
  assert.equal(insertEvent(db, ev), true);
  assert.equal(insertEvent(db, ev), false);
  const j = { runId: 'r', instrumentId: 'i', seq: 1, candleVersionId: 'v', openAt: 0, closeAt: 300_000, observedAt: 301_000, quality: 'OK', nowMs: 305_000, historyLength: 1, inputHash: 'h' };
  assert.equal(insertJournal(db, j), true);
  assert.equal(insertJournal(db, j), false);
  const id = { instrumentId: 'i', provider: 'p', marketType: 'alpha', symbol: 'ALPHA_1USDT', alphaId: 'ALPHA_1', baseAsset: 'ALPHA_1', quoteAsset: 'USDT', displaySymbol: 'X', tokenName: 'X', chainId: '56', chainName: 'BSC', contractAddress: '0xa', status: 'TRADING', tokenOffline: false };
  assert.equal(upsertInstrument(db, id, 1), 'new');
  assert.equal(upsertInstrument(db, { ...id, displaySymbol: 'Y' }, 2), 'same');
  assert.equal(upsertInstrument(db, { ...id, contractAddress: '0xb' }, 3), 'identity_changed');
});

test('writer lease blocks a second owner until expiry', () => {
  const db = openDatabase(':memory:');
  assert.equal(acquireLease(db, 'writer', 'a', 1000, 0), true);
  assert.equal(acquireLease(db, 'writer', 'b', 1000, 500), false);
  assert.equal(acquireLease(db, 'writer', 'a', 1000, 600), true);
  assert.equal(acquireLease(db, 'writer', 'b', 1000, 1700), true);
});
