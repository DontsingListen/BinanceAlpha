import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCatalog, extractRegexMentions, normalizeXHandle, resolveMention } from '../../src/domain/mentions.ts';

const UAI = 'binance-alpha:alpha:ALPHA_461USDT';
const WARD1 = 'binance-alpha:alpha:ALPHA_1USDT';
const WARD2 = 'binance-alpha:alpha:ALPHA_2USDT';
const LOBSTER = 'binance-alpha:alpha:ALPHA_772USDT';
const entries = [
  { instrumentId: UAI, displaySymbol: 'UAI', tokenName: 'UnifAI Network', alphaId: 'ALPHA_461', contractAddress: '0x3e5d4f8aee0d9b3082d5f6da5d6e225d17ba9ea0', chainName: 'BSC' },
  { instrumentId: WARD1, displaySymbol: 'WARD', tokenName: 'Ward One', alphaId: 'ALPHA_1', contractAddress: '0x' + '1'.repeat(40), chainName: 'BSC' },
  { instrumentId: WARD2, displaySymbol: 'WARD', tokenName: 'Ward Two', alphaId: 'ALPHA_2', contractAddress: '0x' + '2'.repeat(40), chainName: 'ETH' },
  { instrumentId: LOBSTER, displaySymbol: '龙虾', tokenName: '龙虾', alphaId: 'ALPHA_772', contractAddress: '0x' + '3'.repeat(40), chainName: 'BSC' },
  { instrumentId: 'binance-alpha:alpha:ALPHA_444USDT', displaySymbol: 'ON', tokenName: 'Onchain', alphaId: 'ALPHA_444', contractAddress: '0x' + '4'.repeat(40), chainName: 'BSC' },
  { instrumentId: 'binance-alpha:alpha:ALPHA_10USDT', displaySymbol: 'Fartcoin', tokenName: 'Fartcoin', alphaId: 'ALPHA_10', contractAddress: '9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump', chainName: 'SOL' },
];
const catalog = buildCatalog(entries);

test('cashtag, contract address and alphaId resolve uniquely; stoplisted/short bare words are not mentions', () => {
  const out = extractRegexMentions('冲 $UAI 了，合约 0x3e5d4f8aee0d9b3082d5f6da5d6e225d17ba9ea0，ALPHA_461 ON 链上 on fire, ATH soon', catalog);
  const byKind = new Map(out.map((m) => [m.matchKind, m]));
  assert.equal(byKind.get('cashtag')?.instrumentId, UAI);
  assert.equal(byKind.get('cashtag')?.resolution, 'UNIQUE');
  assert.equal(byKind.get('contract')?.instrumentId, UAI);
  assert.equal(byKind.get('alpha_id')?.instrumentId, UAI);
  assert.ok(!out.some((m) => m.tokenText === 'ON' || m.tokenText === 'ATH'));
  assert.equal(out[0]?.confidence, 0.9); // sorted by confidence
});

test('display-symbol collision is AMBIGUOUS with sorted candidates; a project-name hint disambiguates', () => {
  const [m] = extractRegexMentions('$WARD to the moon', catalog);
  assert.equal(m?.resolution, 'AMBIGUOUS');
  assert.equal(m?.instrumentId, null);
  assert.deepEqual(m?.candidates, [WARD1, WARD2]);
  const r = resolveMention({ tokenText: 'WARD', matchKind: 'cashtag', confidence: 0.7, name: 'Ward Two', stance: 'bullish' }, catalog);
  assert.equal(r.instrumentId, WARD2);
  assert.equal(r.resolution, 'UNIQUE');
  assert.equal(r.stance, 'bullish');
});

test('a contract hint on a model candidate wins over a colliding symbol', () => {
  const r = resolveMention({ tokenText: 'WARD', matchKind: 'cashtag', confidence: 0.7, contract: '0x' + '1'.repeat(40) }, catalog);
  assert.equal(r.instrumentId, WARD1);
  assert.equal(r.matchKind, 'contract');
  assert.ok(r.confidence >= 0.95);
});

test('CJK symbols match by substring; unknown cashtags and 0x contracts are kept as UNRESOLVED; unknown base58 strings are ignored', () => {
  const out = extractRegexMentions('今晚看龙虾和 $PEPE，合约 0x' + 'a'.repeat(40) + ' 以及 ' + 'So11111111111111111111111111111111111111112', catalog);
  const lobster = out.find((m) => m.tokenText === '龙虾');
  assert.equal(lobster?.instrumentId, LOBSTER);
  assert.equal(out.find((m) => m.tokenText === 'PEPE')?.resolution, 'UNRESOLVED');
  assert.equal(out.find((m) => m.matchKind === 'contract')?.resolution, 'UNRESOLVED');
  assert.ok(!out.some((m) => m.tokenText.startsWith('So111')));
});

test('bare upper-case symbols and latin token names match only as whole words; solana contract resolves', () => {
  const out = extractRegexMentions('UAI breaking out, fartcoin again? 9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump', catalog);
  assert.equal(out.find((m) => m.matchKind === 'symbol')?.instrumentId, UAI);
  assert.equal(out.find((m) => m.matchKind === 'name')?.instrumentId, 'binance-alpha:alpha:ALPHA_10USDT');
  assert.equal(out.find((m) => m.matchKind === 'contract')?.instrumentId, 'binance-alpha:alpha:ALPHA_10USDT');
  assert.equal(extractRegexMentions('UAIX is not UAI_2 and xuai', catalog).length, 0);
});

test('normalizeXHandle strips @ and rejects invalid handles', () => {
  assert.equal(normalizeXHandle('@Fixture_Gamma'), 'Fixture_Gamma');
  assert.equal(normalizeXHandle(' fixture_delta '), 'fixture_delta');
  assert.equal(normalizeXHandle('bad handle!'), null);
  assert.equal(normalizeXHandle('toolonghandle_16c'), null);
});
