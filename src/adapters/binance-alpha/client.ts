/**
 * Binance Alpha public market-data client with bounded retries, a shared rate budget,
 * source pausing (429/403/418) and a FetchAttempt record for every request.
 */
import { randomUUID } from 'node:crypto';
import { sha256OfText } from '../../domain/hash.ts';
import { httpGet, HttpTimeoutError, RateLimiter, sleep } from './http.ts';
import { parseEnvelope, parseExchangeInfo, parseKlineRows, parseTokenList } from './dto.ts';
import type { EnvelopeOutcome, RawKlineRow, Rejection, SymbolDto, TokenDto } from './dto.ts';

export const ALPHA_ENDPOINTS = {
  tokenList: '/bapi/defi/v1/public/wallet-direct/buw/wallet/cex/alpha/all/token/list',
  exchangeInfo: '/bapi/defi/v1/public/alpha-trade/get-exchange-info',
  klines: '/bapi/defi/v1/public/alpha-trade/klines',
} as const;

export const KLINES_MAX_LIMIT = 1500;

export type FetchOutcome = EnvelopeOutcome | 'HTTP_ERROR' | 'TIMEOUT' | 'NETWORK_ERROR' | 'RATE_LIMITED' | 'SOURCE_PAUSED';

export type FetchAttemptRecord = {
  readonly requestId: string;
  readonly endpoint: string;
  readonly params: Record<string, string | number>;
  readonly startedAt: number;
  readonly finishedAt: number;
  readonly httpStatus: number | null;
  readonly businessCode: string | null;
  readonly outcome: FetchOutcome;
  readonly rowCount: number | null;
  readonly errorClass: string | null;
  readonly errorMessage: string | null;
  readonly rawSha256: string | null;
  readonly rawBytes: number | null;
  readonly serverDateMs: number | null;
  readonly clockOffsetMs: number | null;
  readonly retryIndex: number;
};

export type FetchResult<T> = {
  readonly attempt: FetchAttemptRecord;
  readonly rawText: string | null;
  readonly outcome: FetchOutcome;
  readonly message: string | null;
  readonly value: T | null;
  readonly rejected: Rejection[];
};

export class SourcePausedError extends Error {
  readonly until: number;
  constructor(message: string, until: number) {
    super(message);
    this.until = until;
  }
}

export type AlphaClientOptions = {
  readonly baseUrl?: string;
  readonly ratePerSec?: number;
  readonly maxConcurrent?: number;
  readonly timeoutMs?: number;
  readonly maxRetries?: number;
  readonly userAgent?: string;
  readonly onAttempt?: (attempt: FetchAttemptRecord, rawText: string | null) => void;
};

export class AlphaClient {
  readonly baseUrl: string;
  readonly #limiter: RateLimiter;
  readonly #timeoutMs: number;
  readonly #maxRetries: number;
  readonly #userAgent: string;
  readonly #onAttempt: ((attempt: FetchAttemptRecord, rawText: string | null) => void) | undefined;
  #pausedUntil = 0;
  #pauseReason: string | null = null;
  /** Last measured server-minus-local clock offset in ms (Date header has 1s resolution). */
  lastClockOffsetMs: number | null = null;

  constructor(options: AlphaClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? 'https://www.binance.com';
    this.#limiter = new RateLimiter(options.ratePerSec ?? 1, options.maxConcurrent ?? 2);
    this.#timeoutMs = options.timeoutMs ?? 10_000;
    this.#maxRetries = options.maxRetries ?? 2;
    this.#userAgent = options.userAgent ?? 'binance-alpha-second-leg/0.1 (local research scanner)';
    this.#onAttempt = options.onAttempt;
  }

  get pauseState(): { until: number; reason: string | null } {
    return { until: this.#pausedUntil, reason: this.#pauseReason };
  }

  async getTokenList(): Promise<FetchResult<TokenDto[]>> {
    const r = await this.#requestWithRetry(ALPHA_ENDPOINTS.tokenList, {});
    if (r.outcome !== 'OK') return { ...r, value: null, rejected: [] };
    const parsed = parseTokenList(r.data);
    return { ...r, value: parsed.tokens, rejected: parsed.rejected };
  }

  async getExchangeInfo(): Promise<FetchResult<SymbolDto[]>> {
    const r = await this.#requestWithRetry(ALPHA_ENDPOINTS.exchangeInfo, {});
    if (r.outcome !== 'OK') return { ...r, value: null, rejected: [] };
    const parsed = parseExchangeInfo(r.data);
    return { ...r, value: parsed.symbols, rejected: parsed.rejected };
  }

  async getKlines(args: { symbol: string; interval: string; intervalMs: number; startTime?: number; endTime?: number; limit?: number }): Promise<FetchResult<RawKlineRow[]>> {
    const params: Record<string, string | number> = { symbol: args.symbol, interval: args.interval, limit: Math.min(args.limit ?? 500, KLINES_MAX_LIMIT) };
    if (args.startTime !== undefined) params['startTime'] = args.startTime;
    if (args.endTime !== undefined) params['endTime'] = args.endTime;
    const r = await this.#requestWithRetry(ALPHA_ENDPOINTS.klines, params);
    if (r.outcome !== 'OK') return { ...r, value: r.outcome === 'NO_RECORDS' ? [] : null, rejected: [] };
    const parsed = parseKlineRows(r.data, args.intervalMs);
    return { ...r, value: parsed.rows, rejected: parsed.rejected };
  }

  async #requestWithRetry(endpoint: string, params: Record<string, string | number>): Promise<FetchResult<never> & { data: unknown }> {
    let last: (FetchResult<never> & { data: unknown }) | null = null;
    for (let retry = 0; retry <= this.#maxRetries; retry++) {
      if (retry > 0) await sleep(backoffMs(retry));
      last = await this.#requestOnce(endpoint, params, retry);
      if (!isRetryable(last.outcome)) return last;
    }
    return last as FetchResult<never> & { data: unknown };
  }

  async #requestOnce(endpoint: string, params: Record<string, string | number>, retryIndex: number): Promise<FetchResult<never> & { data: unknown }> {
    const requestId = randomUUID();
    const now = Date.now();
    if (now < this.#pausedUntil) {
      const attempt = baseAttempt(requestId, endpoint, params, now, now, retryIndex, 'SOURCE_PAUSED', 'SourcePaused', this.#pauseReason);
      this.#onAttempt?.(attempt, null);
      throw new SourcePausedError(`source paused until ${new Date(this.#pausedUntil).toISOString()}: ${this.#pauseReason}`, this.#pausedUntil);
    }
    const url = new URL(endpoint, this.baseUrl);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
    try {
      const res = await this.#limiter.schedule(() => httpGet(url.toString(), this.#timeoutMs, this.#userAgent));
      const clockOffsetMs = res.serverDateMs === null ? null : res.serverDateMs - res.finishedAt;
      if (clockOffsetMs !== null) this.lastClockOffsetMs = clockOffsetMs;
      const rawSha256 = sha256OfText(res.text);
      const common = { requestId, endpoint, params, startedAt: res.startedAt, finishedAt: res.finishedAt, retryIndex, rawSha256, rawBytes: Buffer.byteLength(res.text), serverDateMs: res.serverDateMs, clockOffsetMs };
      if (res.status === 429 || res.status === 418 || res.status === 403) {
        const retryAfter = Number(res.headers.get('retry-after'));
        const pauseMs = res.status === 429 ? (Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 60_000) : 15 * 60_000;
        this.#pausedUntil = res.finishedAt + pauseMs;
        this.#pauseReason = `HTTP ${res.status}`;
        const outcome: FetchOutcome = res.status === 429 ? 'RATE_LIMITED' : 'HTTP_ERROR';
        const attempt: FetchAttemptRecord = { ...common, httpStatus: res.status, businessCode: null, outcome, rowCount: null, errorClass: `Http${res.status}`, errorMessage: `paused ${pauseMs}ms` };
        this.#onAttempt?.(attempt, res.text);
        return { attempt, rawText: res.text, outcome, message: attempt.errorMessage, value: null, rejected: [], data: null };
      }
      if (res.status !== 200) {
        const attempt: FetchAttemptRecord = { ...common, httpStatus: res.status, businessCode: null, outcome: 'HTTP_ERROR', rowCount: null, errorClass: `Http${res.status}`, errorMessage: res.text.slice(0, 200) };
        this.#onAttempt?.(attempt, res.text);
        return { attempt, rawText: res.text, outcome: 'HTTP_ERROR', message: attempt.errorMessage, value: null, rejected: [], data: null };
      }
      const env = parseEnvelope(res.text);
      const rowCount = Array.isArray(env.data) ? env.data.length : null;
      const attempt: FetchAttemptRecord = {
        ...common, httpStatus: res.status, businessCode: env.code, outcome: env.outcome, rowCount,
        errorClass: env.outcome === 'OK' ? null : env.outcome, errorMessage: env.outcome === 'OK' ? null : env.message,
      };
      this.#onAttempt?.(attempt, res.text);
      return { attempt, rawText: res.text, outcome: env.outcome, message: env.message, value: null, rejected: [], data: env.data };
    } catch (error) {
      if (error instanceof SourcePausedError) throw error;
      const finishedAt = Date.now();
      const isTimeout = error instanceof HttpTimeoutError;
      const outcome: FetchOutcome = isTimeout ? 'TIMEOUT' : 'NETWORK_ERROR';
      const attempt = baseAttempt(requestId, endpoint, params, now, finishedAt, retryIndex, outcome, (error as Error).name, (error as Error).message);
      this.#onAttempt?.(attempt, null);
      return { attempt, rawText: null, outcome, message: (error as Error).message, value: null, rejected: [], data: null };
    }
  }
}

function baseAttempt(requestId: string, endpoint: string, params: Record<string, string | number>, startedAt: number, finishedAt: number, retryIndex: number, outcome: FetchOutcome, errorClass: string | null, errorMessage: string | null): FetchAttemptRecord {
  return { requestId, endpoint, params, startedAt, finishedAt, httpStatus: null, businessCode: null, outcome, rowCount: null, errorClass, errorMessage, rawSha256: null, rawBytes: null, serverDateMs: null, clockOffsetMs: null, retryIndex };
}

function isRetryable(outcome: FetchOutcome): boolean {
  return outcome === 'TIMEOUT' || outcome === 'NETWORK_ERROR' || outcome === 'NOT_JSON';
}

function backoffMs(retry: number): number {
  const base = 1000 * 2 ** (retry - 1);
  return base + Math.floor(Math.random() * 500);
}
