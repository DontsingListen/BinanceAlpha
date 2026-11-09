import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnvelope, parseExchangeInfo, parseKlineRows, parseTokenList, toCandle, CandleValidationError } from '../../src/adapters/binance-alpha/dto.ts';
import { ROOT } from './helpers.ts';

const fx = (name: string) => readFileSync(resolve(ROOT, 'test/fixtures', name), 'utf8');

test('envelope: OK, NO_RECORDS, INVALID_SYMBOL, BAD_PARAM, HTML, schema error', () => {
  assert.equal(parseEnvelope(fx('alpha-klines-20rows.json')).outcome, 'OK');
  assert.equal(parseEnvelope(fx('alpha-klines-no-records.json')).outcome, 'NO_RECORDS');
  assert.equal(parseEnvelope(fx('alpha-klines-invalid-symbol.json')).outcome, 'INVALID_SYMBOL');
  assert.equal(parseEnvelope(fx('alpha-klines-bad-limit.json')).outcome, 'BAD_PARAM');
  assert.equal(parseEnvelope('<html><body>blocked</body></html>').outcome, 'NOT_JSON');
  assert.equal(parseEnvelope('{"data":[]}').outcome, 'SCHEMA_ERROR');
  assert.equal(parseEnvelope('{"code":"000000","success":false,"data":[]}').outcome, 'BUSINESS_ERROR');
});

test('kline rows: 12 string fields, alignment, close boundary, duplicates, ordering', () => {
  const env = parseEnvelope(fx('alpha-klines-20rows.json'));
  const parsed = parseKlineRows(env.data, 300_000);
  assert.equal(parsed.rows.length, 20);
  assert.equal(parsed.rejected.length, 0);
  for (let i = 1; i < parsed.rows.length; i++) assert.equal(parsed.rows[i]!.openTime - parsed.rows[i - 1]!.openTime, 300_000);
  assert.equal(parsed.rows[0]!.closeTime, parsed.rows[0]!.openTime + 299_999);
  const bad = parseKlineRows([
    ['1793496000000', '1', '1', '1', '1', '0', '1793496299999', '0', '0', '0', '0', '0'],
    ['1793496000000', '1', '1', '1', '1', '0', '1793496299999', '0', '0', '0', '0', '0'], // duplicate
    ['1793496000001', '1', '1', '1', '1', '0', '1793496300000', '0', '0', '0', '0', '0'], // misaligned
    ['1793496300000', '1', '1', '1', '1', '0', '1793496599998', '0', '0', '0', '0', '0'], // wrong close
    ['x', '1'], // short
  ], 300_000);
  assert.equal(bad.rows.length, 1);
  assert.equal(bad.rejected.length, 4);
});

test('toCandle: valid conversion and explicit rejections', () => {
  const env = parseEnvelope(fx('alpha-klines-20rows.json'));
  const row = parseKlineRows(env.data, 300_000).rows[0]!;
  const c = toCandle(row, 'v1', 300_000, row.closeTime + 5000);
  assert.equal(c.closeAt, row.openTime + 300_000);
  assert.ok(c.low <= c.close && c.close <= c.high);
  assert.throws(() => toCandle({ ...row, volume: '-1' }, 'v', 300_000, 0), CandleValidationError);
  assert.throws(() => toCandle({ ...row, close: '0' }, 'v', 300_000, 0), CandleValidationError);
  assert.throws(() => toCandle({ ...row, high: '1e400' }, 'v', 300_000, 0), CandleValidationError);
  assert.throws(() => toCandle({ ...row, low: String(Number(row.high) * 2) }, 'v', 300_000, 0), /OHLC out of order/);
});

test('token list: alphaId is the identity; display-name collisions stay separate', () => {
  const env = parseEnvelope(fx('alpha-token-list-sample.json'));
  const parsed = parseTokenList(env.data);
  assert.equal(parsed.rejected.length, 0);
  const ward = parsed.tokens.filter((t) => t.symbol === 'WARD');
  assert.equal(ward.length, 2);
  assert.notEqual(ward[0]!.alphaId, ward[1]!.alphaId);
  assert.equal(parseTokenList([{ symbol: 'X' }]).rejected.length, 1);
  assert.equal(parseTokenList([{ alphaId: 'ALPHA_1', tokenId: 't', chainId: '56', contractAddress: '0x', offline: false }]).rejected[0]?.reason, 'ALPHA_1: missing boolean flags');
});

test('exchange info: symbol must equal baseAsset+quoteAsset; status preserved', () => {
  const env = parseEnvelope(fx('alpha-exchange-info-sample.json'));
  const parsed = parseExchangeInfo(env.data);
  assert.equal(parsed.rejected.length, 0);
  assert.ok(parsed.symbols.some((s) => s.symbol === 'ALPHA_1005USDT' && s.baseAsset === 'ALPHA_1005' && s.quoteAsset === 'USDT' && s.status === 'TRADING'));
  assert.ok(parsed.symbols.some((s) => s.status === 'DELISTED'));
  const bad = parseExchangeInfo({ symbols: [{ symbol: 'FOOUSDT', status: 'TRADING', baseAsset: 'BAR', quoteAsset: 'USDT' }] });
  assert.equal(bad.rejected.length, 1);
});
