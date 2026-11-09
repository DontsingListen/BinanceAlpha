import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { XaiClient } from '../../src/adapters/xai/client.ts';
import { openDatabase } from '../../src/storage/db.ts';
import { upsertInstrument } from '../../src/storage/repos.ts';
import { listMentions, listSocialPolls, listSocialPosts } from '../../src/storage/social-repos.ts';
import { AlertDispatcher, type Alert, type AlertSink } from '../../src/application/alerts.ts';
import { SocialMonitor } from '../../src/application/social.ts';
import { loadSocialConfig } from '../../src/application/social-config.ts';

const ROOT = resolve(import.meta.dirname, '../..');
const NOW = Date.UTC(2026, 10, 7, 4, 0);
const UAI = 'binance-alpha:alpha:ALPHA_461USDT';
const POST_URL = 'https://x.com/fixture_alpha/status/111';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

test('x poll: an answer produced without x_search is XAI_NO_SEARCH (retryable, posts discarded); a searched answer stores posts, mentions and alerts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'alpha-social-x-'));
  const configPath = join(dir, 'social.json');
  writeFileSync(configPath, JSON.stringify({ alertsJsonlPath: join(dir, 'alerts.jsonl'), x: { enabled: true, handles: ['fixture_alpha', 'fixture_beta'], pollIntervalMs: 60 * 60_000, batchDelayMs: 0 }, telegram: { enabled: false } }));
  const cfg = loadSocialConfig(ROOT, { socialConfig: configPath });
  const db = openDatabase(':memory:');
  upsertInstrument(db, { instrumentId: UAI, provider: 'binance-alpha', marketType: 'alpha', symbol: 'ALPHA_461USDT', alphaId: 'ALPHA_461', baseAsset: 'ALPHA_461', quoteAsset: 'USDT', displaySymbol: 'UAI', tokenName: 'UnifAI Network', chainId: '56', chainName: 'BSC', contractAddress: '0x3e5d4f8aee0d9b3082d5f6da5d6e225d17ba9ea0', status: 'TRADING', tokenOffline: false }, NOW - 1);

  const post = { handle: 'fixture_alpha', url: POST_URL, posted_at: new Date(NOW - 3_600_000).toISOString(), text: '冲 $UAI', tokens: [{ symbol: 'UAI', name: 'UnifAI Network', contract: '', chain: 'BSC' }], stance: 'bullish' };
  const noSearchUsage = { input_tokens: 2020, output_tokens: 344, total_tokens: 2364, cost_in_usd_ticks: 32_506_000, num_sources_used: 0, num_server_side_tools_used: 0 };
  const searchedUsage = { input_tokens: 9000, output_tokens: 1200, total_tokens: 10_200, cost_in_usd_ticks: 2_500_000_000, num_sources_used: 7, num_server_side_tools_used: 2, server_side_tool_usage_details: { x_search_calls: 2, x_posts_fetched: 30, x_users_fetched: 2 } };
  const allFailedUsage = { input_tokens: 140_000, output_tokens: 1500, total_tokens: 141_500, cost_in_usd_ticks: 397_000_000, num_sources_used: 0, num_server_side_tools_used: 20, server_side_tool_usage_details: { x_search_calls: 20, x_posts_fetched: 0, x_users_fetched: 0 } };
  const call = (status: string) => ({ type: 'custom_tool_call', name: 'x_keyword_search', call_id: `c-${status}`, input: '{"query":"from:fixture_alpha"}', status });
  const payload = (usage: unknown, cite: boolean, calls: unknown[] = [call('completed'), call('completed')], posts: unknown[] = [post]) => ({
    id: 'resp_1', model: 'grok-4.3', status: 'completed', usage,
    output: [...calls, { type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ posts }), annotations: cite ? [{ type: 'url_citation', url: POST_URL }] : [] }] }],
  });
  const requests: Record<string, unknown>[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    if (String(url).endsWith('/api-key')) return jsonResponse({ api_key_disabled: false, api_key_blocked: false, team_blocked: false, acls: ['api-key:endpoint:*', 'api-key:model:*'], name: 'test key', redacted_api_key: 'xai-...abcd' });
    requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    if (requests.length === 1) return jsonResponse(payload(noSearchUsage, false, []));
    if (requests.length === 2) return jsonResponse(payload(allFailedUsage, false, Array.from({ length: 20 }, () => call('failed')), []));
    return jsonResponse(payload(searchedUsage, true, [call('completed'), call('failed')]));
  }) as typeof fetch;
  const delivered: Alert[] = [];
  const sink: AlertSink = { name: 'capture', deliver: (a) => { delivered.push(a); } };
  const monitor = new SocialMonitor({ db, cfg, xai: new XaiClient({ apiKey: 'xai-' + 'k'.repeat(40), fetchImpl }), dispatcher: new AlertDispatcher([sink]), log: () => {}, now: () => NOW });
  monitor.syncSources();

  // poll 1: the batch answers without searching, is re-queued once, and the retry's searches all fail -> no evidence, nothing stored
  const first = await monitor.pollX(NOW);
  assert.deepEqual([first.outcome, first.posts, first.newPosts, first.postsFetched], ['XAI_SEARCH_FAILED', 1, 0, 0]);
  assert.ok(Math.abs((first.costUsd ?? 0) - (0.0032506 + 0.0397)) < 1e-9);
  assert.equal(listSocialPosts(db, { limit: 10 }).length, 0);
  assert.deepEqual(listSocialPolls(db, { kind: 'x' }).map((p) => p.outcome), ['XAI_SEARCH_FAILED', 'XAI_NO_SEARCH']);
  assert.equal(monitor.xPollDecision(NOW + 60_000).reason, 'RETRY_WAIT');
  assert.equal(monitor.xPollDecision(NOW + 31 * 60_000).reason, 'RETRY');
  const prompt = String((requests[0]!['input'] as { content: string }[])[0]!.content);
  assert.ok(prompt.includes('@fixture_alpha, @fixture_beta') && prompt.includes(`Current time: ${new Date(NOW).toISOString()}`));
  assert.equal(requests[0]!['parallel_tool_calls'], false);

  const second = await monitor.pollX(NOW + 62 * 60_000);
  assert.deepEqual([second.outcome, second.newPosts, second.postsFetched, second.costUsd], ['OK', 1, 30, 0.25]); // one failed call among completed ones is partial coverage, still evidence
  assert.deepEqual([second.mentions, second.alerts], [2, 1]); // regex + model extractor both stored; one alert per post and token
  const alert = delivered.find((a) => a.instrumentId === UAI)!;
  assert.equal(alert.level, 'MENTION');
  assert.equal(alert.isFresh, true);
  assert.equal((alert.payload['post'] as { citationVerified: boolean; url: string }).citationVerified, true);
  assert.equal((alert.payload['source'] as { handle: string }).handle, 'fixture_alpha');
  assert.ok(listMentions(db, { instrumentId: UAI, sinceMs: 0, limit: 10 }).length >= 1);
  assert.equal(monitor.xPollDecision(NOW + 63 * 60_000).reason, 'BEFORE_SLOT'); // settled: no further billed request until the next slot
  assert.ok(Math.abs(monitor.budgetState(NOW).spentUsd - (0.0032506 + 0.0397 + 0.25)) < 1e-9);
});

test('x poll batches: handles go out in sequential batches over one shared window; a batched poll is one scheduling attempt', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'alpha-social-xb-'));
  const configPath = join(dir, 'social.json');
  writeFileSync(configPath, JSON.stringify({ alertsJsonlPath: join(dir, 'alerts.jsonl'), x: { enabled: true, handles: ['fixture_alpha', 'fixture_beta', 'fixture_delta'], pollIntervalMs: 60 * 60_000, batchSize: 2, batchDelayMs: 0 }, telegram: { enabled: false } }));
  const cfg = loadSocialConfig(ROOT, { socialConfig: configPath });
  const db = openDatabase(':memory:');
  const okUsage = { input_tokens: 500, output_tokens: 50, total_tokens: 550, cost_in_usd_ticks: 100_000_000, num_sources_used: 1, num_server_side_tools_used: 2, server_side_tool_usage_details: { x_search_calls: 2, x_posts_fetched: 4, x_users_fetched: 0 } };
  const failUsage = { ...okUsage, server_side_tool_usage_details: { x_search_calls: 2, x_posts_fetched: 0, x_users_fetched: 0 } };
  const call = (status: string) => ({ type: 'custom_tool_call', name: 'x_keyword_search', call_id: 'c', input: '{}', status });
  let failing = false;
  const batches: string[][] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    if (String(url).endsWith('/api-key')) return jsonResponse({ api_key_disabled: false, api_key_blocked: false, team_blocked: false, acls: ['api-key:endpoint:*', 'api-key:model:*'] });
    const body = JSON.parse(String(init?.body)) as { tools: { allowed_x_handles: string[] }[] };
    batches.push(body.tools[0]!.allowed_x_handles);
    const status = failing ? 'failed' : 'completed';
    return jsonResponse({ id: 'r', model: 'grok-4.3', status: 'completed', usage: failing ? failUsage : okUsage, output: [call(status), call(status), { type: 'message', content: [{ type: 'output_text', text: '{"posts":[]}', annotations: [] }] }] });
  }) as typeof fetch;
  const monitor = new SocialMonitor({ db, cfg, xai: new XaiClient({ apiKey: 'xai-' + 'k'.repeat(40), fetchImpl }), dispatcher: new AlertDispatcher([]), log: () => {}, now: () => NOW });
  const ok = await monitor.pollX(NOW);
  assert.deepEqual([ok.outcome, ok.postsFetched, ok.costUsd], ['OK', 8, 0.02]);
  assert.deepEqual(batches, [['fixture_alpha', 'fixture_beta'], ['fixture_delta']]);
  const rows = listSocialPolls(db, { kind: 'x' });
  assert.equal(rows.length, 2);
  assert.equal(new Set(rows.map((r) => r.windowTo)).size, 1);
  assert.equal(monitor.xPollDecision(NOW + 60_000).reason, 'BEFORE_SLOT');
  failing = true;
  batches.length = 0;
  const bad = await monitor.pollX(NOW + 61 * 60_000);
  assert.equal(bad.outcome, 'XAI_SEARCH_FAILED');
  assert.deepEqual(batches, [['fixture_alpha', 'fixture_beta'], ['fixture_delta'], ['fixture_alpha', 'fixture_beta'], ['fixture_delta']]); // each failed batch re-queued once, after the others
  const d = monitor.xPollDecision(NOW + 62 * 60_000);
  assert.deepEqual([d.reason, d.attemptsForSlot], ['RETRY_WAIT', 1]); // four failed batch rows = one attempt
  assert.equal(monitor.nextWindowStart(NOW + 62 * 60_000), NOW - 5 * 60_000); // from the last OK poll's window end
  // stepping (service loop): one batch per step, delay observed via nextBatchAt; a manual lookback override widens the window
  failing = false;
  const { run } = monitor.startXPoll(NOW + 120 * 60_000, NOW + 120 * 60_000 - 13 * 3_600_000);
  assert.ok(run && run.batches.length === 2 && run.sinceMs === NOW + 120 * 60_000 - 13 * 3_600_000);
  assert.equal(await monitor.stepXPoll(run!, NOW + 120 * 60_000), false);
  assert.equal(run!.sent, 1);
  assert.equal(await monitor.stepXPoll(run!, NOW + 121 * 60_000), true);
  assert.equal(run!.total.outcome, 'OK');
  assert.equal(listSocialPolls(db, { kind: 'x' }).filter((r) => r.windowFrom === new Date(NOW + 120 * 60_000 - 13 * 3_600_000).toISOString()).length, 2);
});
