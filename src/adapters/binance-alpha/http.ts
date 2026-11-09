/** Shared rate limiter + HTTP GET with timeout. All same-origin calls go through one limiter. */

export type HttpResponse = {
  readonly status: number;
  readonly text: string;
  readonly headers: Headers;
  readonly startedAt: number;
  readonly finishedAt: number;
  /** Parsed Date header (1s resolution) or null. */
  readonly serverDateMs: number | null;
};

export class HttpTimeoutError extends Error {}

export class RateLimiter {
  #ratePerSec: number;
  #maxConcurrent: number;
  #running = 0;
  #nextSlotAt = 0;
  #queue: (() => void)[] = [];

  constructor(ratePerSec: number, maxConcurrent: number) {
    this.#ratePerSec = ratePerSec;
    this.#maxConcurrent = maxConcurrent;
  }

  async schedule<T>(fn: () => Promise<T>): Promise<T> {
    await this.#acquire();
    try {
      return await fn();
    } finally {
      this.#running -= 1;
      const next = this.#queue.shift();
      if (next) next();
    }
  }

  async #acquire(): Promise<void> {
    if (this.#running >= this.#maxConcurrent) {
      await new Promise<void>((resolve) => this.#queue.push(resolve));
    }
    this.#running += 1;
    const now = Date.now();
    const slot = Math.max(now, this.#nextSlotAt);
    this.#nextSlotAt = slot + 1000 / this.#ratePerSec;
    if (slot > now) await sleep(slot - now);
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function httpGet(url: string, timeoutMs: number, userAgent: string): Promise<HttpResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { accept: 'application/json', 'user-agent': userAgent },
      signal: controller.signal,
      redirect: 'manual',
    });
    const text = await res.text();
    const finishedAt = Date.now();
    const dateHeader = res.headers.get('date');
    const serverDateMs = dateHeader ? Date.parse(dateHeader) : NaN;
    return { status: res.status, text, headers: res.headers, startedAt, finishedAt, serverDateMs: Number.isFinite(serverDateMs) ? serverDateMs : null };
  } catch (error) {
    if ((error as Error).name === 'AbortError') throw new HttpTimeoutError(`timeout after ${timeoutMs}ms: ${url}`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
