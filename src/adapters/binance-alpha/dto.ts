/**
 * Boundary validation for Binance Alpha public REST responses.
 * Everything here converts untrusted JSON into explicit DTOs or explicit rejections.
 * Findings from the M0 probe (2026-11-06) that shape this file:
 *  - envelope: { code: "000000", message, messageDetail, data, success }
 *  - business codes seen: -1000 "No records found", -1121 "Invalid symbol", -1130 bad parameter (limit > 1500)
 *  - kline rows are arrays of 12 STRINGS, including openTime/closeTime; closeTime = openTime + 299999
 *  - the last kline row may be the still-open bar
 */
import type { Candle } from '../../domain/types.ts';
import { sha256Hex } from '../../domain/hash.ts';

export type EnvelopeOutcome = 'OK' | 'NO_RECORDS' | 'INVALID_SYMBOL' | 'BAD_PARAM' | 'BUSINESS_ERROR' | 'NOT_JSON' | 'SCHEMA_ERROR';

export type ParsedEnvelope = {
  readonly outcome: EnvelopeOutcome;
  readonly code: string | null;
  readonly message: string | null;
  readonly data: unknown;
};

export function parseEnvelope(text: string): ParsedEnvelope {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith('{')) return { outcome: 'NOT_JSON', code: null, message: trimmed.slice(0, 80), data: null };
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (error) {
    return { outcome: 'NOT_JSON', code: null, message: (error as Error).message, data: null };
  }
  if (!doc || typeof doc !== 'object') return { outcome: 'SCHEMA_ERROR', code: null, message: 'envelope is not an object', data: null };
  const d = doc as Record<string, unknown>;
  const code = typeof d['code'] === 'string' ? d['code'] : d['code'] === undefined ? null : String(d['code']);
  const message = typeof d['message'] === 'string' ? d['message'] : null;
  if (code === null || typeof d['success'] !== 'boolean') return { outcome: 'SCHEMA_ERROR', code, message: 'envelope missing code/success', data: null };
  if (d['success'] === true && code === '000000') return { outcome: 'OK', code, message, data: d['data'] };
  if (code === '-1000') return { outcome: 'NO_RECORDS', code, message, data: null };
  if (code === '-1121') return { outcome: 'INVALID_SYMBOL', code, message, data: null };
  if (code === '-1130') return { outcome: 'BAD_PARAM', code, message, data: null };
  return { outcome: 'BUSINESS_ERROR', code, message, data: null };
}

export type Rejection = { readonly index: number; readonly reason: string };

export type TokenDto = {
  readonly alphaId: string;
  readonly tokenId: string;
  readonly symbol: string;
  readonly name: string;
  readonly chainId: string;
  readonly chainName: string;
  readonly contractAddress: string;
  readonly listingCex: boolean;
  readonly offline: boolean;
  readonly fullyDelisted: boolean;
  readonly listingTime: number | null;
  readonly volume24h: string | null;
  readonly price: string | null;
  readonly liquidity: string | null;
  readonly marketCap: string | null;
};

const ALPHA_ID = /^ALPHA_\d+$/;

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function bool(v: unknown): boolean | null {
  return typeof v === 'boolean' ? v : null;
}

export function parseTokenList(data: unknown): { tokens: TokenDto[]; rejected: Rejection[] } {
  if (!Array.isArray(data)) return { tokens: [], rejected: [{ index: -1, reason: 'data is not an array' }] };
  const tokens: TokenDto[] = [];
  const rejected: Rejection[] = [];
  data.forEach((item, index) => {
    if (!item || typeof item !== 'object') return void rejected.push({ index, reason: 'not an object' });
    const o = item as Record<string, unknown>;
    const alphaId = str(o['alphaId']);
    const tokenId = str(o['tokenId']);
    const chainId = o['chainId'] === undefined || o['chainId'] === null ? null : String(o['chainId']);
    const contractAddress = str(o['contractAddress']);
    const offline = bool(o['offline']);
    const listingCex = bool(o['listingCex']);
    const fullyDelisted = bool(o['fullyDelisted']);
    if (!alphaId || !ALPHA_ID.test(alphaId)) return void rejected.push({ index, reason: 'missing or malformed alphaId' });
    if (!tokenId) return void rejected.push({ index, reason: `${alphaId}: missing tokenId` });
    if (chainId === null || contractAddress === null) return void rejected.push({ index, reason: `${alphaId}: missing chainId/contractAddress` });
    if (offline === null || listingCex === null || fullyDelisted === null) return void rejected.push({ index, reason: `${alphaId}: missing boolean flags` });
    const listingTimeRaw = o['listingTime'];
    const listingTime = typeof listingTimeRaw === 'number' && Number.isFinite(listingTimeRaw) ? listingTimeRaw : null;
    tokens.push({
      alphaId, tokenId,
      symbol: str(o['symbol']) ?? '',
      name: str(o['name']) ?? '',
      chainId, chainName: str(o['chainName']) ?? '',
      contractAddress,
      listingCex, offline, fullyDelisted, listingTime,
      volume24h: str(o['volume24h']), price: str(o['price']), liquidity: str(o['liquidity']), marketCap: str(o['marketCap']),
    });
  });
  return { tokens, rejected };
}

export type SymbolDto = {
  readonly symbol: string;
  readonly status: string;
  readonly baseAsset: string;
  readonly quoteAsset: string;
  readonly pricePrecision: number | null;
  readonly quantityPrecision: number | null;
};

export function parseExchangeInfo(data: unknown): { symbols: SymbolDto[]; rejected: Rejection[] } {
  if (!data || typeof data !== 'object') return { symbols: [], rejected: [{ index: -1, reason: 'data is not an object' }] };
  const raw = (data as Record<string, unknown>)['symbols'];
  if (!Array.isArray(raw)) return { symbols: [], rejected: [{ index: -1, reason: 'data.symbols is not an array' }] };
  const symbols: SymbolDto[] = [];
  const rejected: Rejection[] = [];
  raw.forEach((item, index) => {
    if (!item || typeof item !== 'object') return void rejected.push({ index, reason: 'not an object' });
    const o = item as Record<string, unknown>;
    const symbol = str(o['symbol']);
    const status = str(o['status']);
    const baseAsset = str(o['baseAsset']);
    const quoteAsset = str(o['quoteAsset']);
    if (!symbol || !status || !baseAsset || !quoteAsset) return void rejected.push({ index, reason: 'missing symbol/status/baseAsset/quoteAsset' });
    if (symbol !== baseAsset + quoteAsset) return void rejected.push({ index, reason: `${symbol}: symbol != baseAsset+quoteAsset` });
    symbols.push({
      symbol, status, baseAsset, quoteAsset,
      pricePrecision: typeof o['pricePrecision'] === 'number' ? o['pricePrecision'] : null,
      quantityPrecision: typeof o['quantityPrecision'] === 'number' ? o['quantityPrecision'] : null,
    });
  });
  return { symbols, rejected };
}

/** One kline row exactly as delivered (strings preserved), with validated integer times. */
export type RawKlineRow = {
  readonly openTime: number;
  readonly open: string;
  readonly high: string;
  readonly low: string;
  readonly close: string;
  readonly volume: string;
  readonly closeTime: number;
  readonly quoteVolume: string;
  readonly trades: string;
  readonly contentHash: string;
};

const INT = /^\d{1,16}$/;

export function parseKlineRows(data: unknown, intervalMs: number): { rows: RawKlineRow[]; rejected: Rejection[] } {
  if (!Array.isArray(data)) return { rows: [], rejected: [{ index: -1, reason: 'data is not an array' }] };
  const rows: RawKlineRow[] = [];
  const rejected: Rejection[] = [];
  data.forEach((item, index) => {
    if (!Array.isArray(item) || item.length < 9) return void rejected.push({ index, reason: 'row is not an array of >= 9 fields' });
    const f = item.map((v) => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : null));
    if (f.some((v) => v === null)) return void rejected.push({ index, reason: 'non-string/number field' });
    const s = f as string[];
    if (!INT.test(s[0] as string) || !INT.test(s[6] as string)) return void rejected.push({ index, reason: 'openTime/closeTime not integer' });
    const openTime = Number(s[0]);
    const closeTime = Number(s[6]);
    if (openTime % intervalMs !== 0) return void rejected.push({ index, reason: `openTime ${openTime} not aligned to ${intervalMs}` });
    if (closeTime !== openTime + intervalMs - 1) return void rejected.push({ index, reason: `closeTime ${closeTime} != openTime + interval - 1` });
    const core = [s[0], s[1], s[2], s[3], s[4], s[5], s[6], s[7], s[8]] as string[];
    rows.push({
      openTime, open: core[1] as string, high: core[2] as string, low: core[3] as string, close: core[4] as string,
      volume: core[5] as string, closeTime, quoteVolume: core[7] as string, trades: core[8] as string,
      contentHash: sha256Hex(...core),
    });
  });
  // reject duplicates (same openTime) within one page, keeping the first
  const seen = new Set<number>();
  const unique = rows.filter((r, i) => {
    if (seen.has(r.openTime)) { rejected.push({ index: i, reason: `duplicate openTime ${r.openTime} in page` }); return false; }
    seen.add(r.openTime);
    return true;
  });
  unique.sort((a, b) => a.openTime - b.openTime);
  return { rows: unique, rejected };
}

export class CandleValidationError extends Error {}

function finitePositive(label: string, text: string): number {
  const v = Number(text);
  if (!Number.isFinite(v) || v <= 0) throw new CandleValidationError(`${label} must be a finite positive number, got "${text}"`);
  return v;
}

function finiteNonNegative(label: string, text: string): number {
  const v = Number(text);
  if (!Number.isFinite(v) || v < 0) throw new CandleValidationError(`${label} must be a finite non-negative number, got "${text}"`);
  return v;
}

/** Maps a stored/raw row to the domain Candle; throws CandleValidationError on any invalid value. */
export function toCandle(row: RawKlineRow, versionId: string, intervalMs: number, observedAt: number): Candle {
  const open = finitePositive('open', row.open);
  const high = finitePositive('high', row.high);
  const low = finitePositive('low', row.low);
  const close = finitePositive('close', row.close);
  const baseVolume = finiteNonNegative('volume', row.volume);
  const quoteVolume = finiteNonNegative('quoteVolume', row.quoteVolume);
  const tradesNum = Number(row.trades);
  const tradeCount = Number.isFinite(tradesNum) && tradesNum >= 0 ? tradesNum : null;
  if (!(low <= Math.min(open, close) && Math.max(open, close) <= high)) {
    throw new CandleValidationError(`OHLC out of order at ${row.openTime}: o=${row.open} h=${row.high} l=${row.low} c=${row.close}`);
  }
  return {
    versionId, openAt: row.openTime, closeAt: row.openTime + intervalMs,
    open, high, low, close, baseVolume, quoteVolume, tradeCount, observedAt,
  };
}
