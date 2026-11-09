/** M0 data-contract probe: a few public requests, a JSON report and a plain summary. No persistence. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AlphaClient } from '../adapters/binance-alpha/client.ts';
import type { AppConfig } from './config.ts';

export async function probe(client: AlphaClient, cfg: AppConfig, log: (line: string) => void): Promise<string> {
  const startedAt = Date.now();
  const report: Record<string, unknown> = { startedAt: new Date(startedAt).toISOString(), baseUrl: client.baseUrl, checks: [] as unknown[] };
  const checks = report['checks'] as unknown[];
  const tokens = await client.getTokenList();
  checks.push({ endpoint: 'tokenList', outcome: tokens.outcome, http: tokens.attempt.httpStatus, code: tokens.attempt.businessCode, rows: tokens.value?.length ?? null, rejected: tokens.rejected.length, bytes: tokens.attempt.rawBytes, latencyMs: tokens.attempt.finishedAt - tokens.attempt.startedAt, clockOffsetMs: tokens.attempt.clockOffsetMs });
  const info = await client.getExchangeInfo();
  const usdtTrading = (info.value ?? []).filter((s) => s.quoteAsset === cfg.quoteAsset && s.status === 'TRADING');
  const quoteAssets: Record<string, number> = {};
  for (const s of info.value ?? []) quoteAssets[s.quoteAsset] = (quoteAssets[s.quoteAsset] ?? 0) + 1;
  const alphaIds = new Set((tokens.value ?? []).map((t) => t.alphaId));
  const unmapped = usdtTrading.filter((s) => !alphaIds.has(s.baseAsset)).map((s) => s.symbol);
  checks.push({ endpoint: 'exchangeInfo', outcome: info.outcome, http: info.attempt.httpStatus, rows: info.value?.length ?? null, rejected: info.rejected.length, quoteAssets, [`${cfg.quoteAsset}_TRADING`]: usdtTrading.length, unmappedToTokenList: unmapped, latencyMs: info.attempt.finishedAt - info.attempt.startedAt });
  const sample = usdtTrading[0];
  if (sample) {
    const k = await client.getKlines({ symbol: sample.symbol, interval: cfg.interval, intervalMs: cfg.intervalMs, limit: 1500 });
    const rows = k.value ?? [];
    const contiguous = rows.every((r, i) => i === 0 || r.openTime - (rows[i - 1] as typeof r).openTime === cfg.intervalMs);
    const last = rows[rows.length - 1];
    const lastIsOpen = last ? last.openTime + cfg.intervalMs > k.attempt.finishedAt : null;
    checks.push({ endpoint: 'klines', symbol: sample.symbol, outcome: k.outcome, http: k.attempt.httpStatus, rows: rows.length, rejected: k.rejected.length, contiguous, firstOpen: rows[0]?.openTime ?? null, lastOpen: last?.openTime ?? null, lastRowStillOpen: lastIsOpen, spanHours: rows.length ? ((last as typeof rows[0]).openTime - (rows[0] as typeof rows[0]).openTime) / 3_600_000 : null, latencyMs: k.attempt.finishedAt - k.attempt.startedAt, clockOffsetMs: k.attempt.clockOffsetMs });
    const far = await client.getKlines({ symbol: sample.symbol, interval: cfg.interval, intervalMs: cfg.intervalMs, startTime: startedAt - 400 * 86_400_000, endTime: startedAt - 399 * 86_400_000, limit: 10 });
    checks.push({ endpoint: 'klines(far past)', symbol: sample.symbol, outcome: far.outcome, code: far.attempt.businessCode, message: far.message });
  }
  const bad = await client.getKlines({ symbol: 'NOPE_XYZ' + cfg.quoteAsset, interval: cfg.interval, intervalMs: cfg.intervalMs, limit: 5 });
  checks.push({ endpoint: 'klines(invalid symbol)', outcome: bad.outcome, code: bad.attempt.businessCode, message: bad.message });
  report['endedAt'] = new Date().toISOString();
  const dir = join(cfg.rootDir, 'reports', 'm0');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `probe-${new Date(startedAt).toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(path, JSON.stringify(report, null, 2));
  for (const c of checks) log(JSON.stringify(c));
  return path;
}
