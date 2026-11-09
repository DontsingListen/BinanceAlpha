import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keyPreflight, redact, usageView, xPostUrl } from '../../src/adapters/xai/client.ts';
import { PROMPT_VERSION, parsePollResponse, planHandlePoll } from '../../src/adapters/xai/x-poll.ts';

const NOW = Date.UTC(2026, 10, 6, 13, 30); // 2026-11-06T13:30Z
const handles = ['fixture_alpha', 'fixture_beta', 'Fixture_Gamma'];

test('planHandlePoll builds an x_search request bounded to the handles and UTC dates with strict JSON output', () => {
  const plan = planHandlePoll({ handles, sinceMs: NOW - 3 * 3_600_000, now: NOW, model: 'grok-4.3', maxTurns: 2, maxOutputTokens: 6000 });
  const tools = plan.request['tools'] as Record<string, unknown>[];
  assert.equal(tools.length, 1);
  assert.equal(tools[0]?.['type'], 'x_search');
  assert.deepEqual(tools[0]?.['allowed_x_handles'], handles);
  assert.equal(tools[0]?.['from_date'], '2026-11-05'); // one day before the window start (day-granular filter)
  assert.equal(tools[0]?.['to_date'], '2026-11-07'); // exclusive upper bound covers the current partial day
  assert.equal(tools[0]?.['enable_video_understanding'], false);
  assert.equal(plan.request['max_turns'], 2);
  assert.equal(plan.request['store'], false);
  assert.equal(plan.request['parallel_tool_calls'], false); // parallel search bursts fail on the live API
  assert.ok(String((plan.request['input'] as { content: string }[])[0]!.content).includes('@fixture_alpha, @fixture_beta, @Fixture_Gamma'));
  const format = (plan.request['text'] as { format: Record<string, unknown> }).format;
  assert.equal(format['type'], 'json_schema');
  assert.equal(format['strict'], true);
  assert.equal(plan.promptVersion, PROMPT_VERSION);
  assert.equal(plan.sinceIso, '2026-11-06T10:30:00.000Z');
  assert.ok(/^[0-9a-f]{64}$/.test(plan.requestHash));
  assert.equal(planHandlePoll({ handles, sinceMs: NOW - 3 * 3_600_000, now: NOW, model: 'grok-4.3', maxTurns: 2, maxOutputTokens: 6000 }).requestHash, plan.requestHash);
  assert.throws(() => planHandlePoll({ handles: Array.from({ length: 21 }, (_, i) => `h${i}`), sinceMs: NOW - 1, now: NOW, model: 'grok-4.3', maxTurns: 1, maxOutputTokens: 100 }), /1\.\.20/);
});

function responsePayload(outputText: string, citations: string[]) {
  return {
    id: 'resp_abc', model: 'grok-4.3', status: 'completed',
    output: [
      { type: 'custom_tool_call', call_id: 'xs_1', name: 'x_search' },
      { type: 'message', content: [{ type: 'output_text', text: outputText, annotations: citations.map((url) => ({ type: 'url_citation', url })) }] },
    ],
    usage: { input_tokens: 1000, output_tokens: 200, total_tokens: 1200, cost_in_usd_ticks: 2_500_000_000, num_sources_used: 7, num_server_side_tools_used: 1, server_side_tool_usage_details: { x_search_calls: 1, x_posts_fetched: 30, x_users_fetched: 5 } },
  };
}

test('parsePollResponse keeps allowed-handle posts, normalizes tokens, marks citations, rejects others, reads cost', () => {
  const plan = planHandlePoll({ handles, sinceMs: NOW - 3_600_000, now: NOW, model: 'grok-4.3', maxTurns: 2, maxOutputTokens: 6000 });
  const posts = {
    posts: [
      { handle: 'fixture_alpha', url: 'https://x.com/fixture_alpha/status/111', posted_at: '2026-11-06T12:00:00Z', text: '冲 $uai', tokens: [{ symbol: '$uai', name: 'UnifAI Network', contract: '', chain: 'BSC' }], stance: 'bullish' },
      { handle: '@FIXTURE_beta', url: 'https://twitter.com/fixture_beta/status/222/photo/1', posted_at: 'not a date', text: 'gm', tokens: [], stance: 'neutral' },
      { handle: 'fixture_outside', url: 'https://x.com/fixture_outside/status/333', posted_at: '2026-11-06T12:00:00Z', text: 'x', tokens: [], stance: 'unknown' },
      { handle: 'fixture_alpha', url: 'javascript:alert(1)', posted_at: '2026-11-06T12:00:00Z', text: 'x', tokens: [], stance: 'unknown' },
      { handle: 'fixture_alpha', url: 'https://x.com/fixture_alpha/status/111', posted_at: '2026-11-06T12:00:00Z', text: 'dup', tokens: [], stance: 'unknown' },
      { handle: 'Fixture_Gamma', url: 'https://x.com/Fixture_Gamma/status/444', posted_at: '2026-11-06T12:30:00Z', text: 'ca', tokens: [{ symbol: '', name: '', contract: '0x' + 'b'.repeat(40), chain: '' }], stance: 'bearish' },
    ],
  };
  const r = parsePollResponse(responsePayload('```json\n' + JSON.stringify(posts) + '\n```', ['https://x.com/fixture_alpha/status/111', 'https://x.com/other/status/999']), plan);
  assert.equal(r.completed, true);
  assert.equal(r.posts.length, 3);
  assert.equal(r.posts[0]?.postId, '111');
  assert.equal(r.posts[0]?.citationVerified, true);
  assert.equal(r.posts[0]?.tokens[0]?.symbol, 'UAI');
  assert.equal(r.posts[0]?.stance, 'bullish');
  assert.equal(r.posts[1]?.handle, 'fixture_beta');
  assert.equal(r.posts[1]?.url, 'https://x.com/fixture_beta/status/222');
  assert.equal(r.posts[1]?.postedAt, null);
  assert.equal(r.posts[1]?.citationVerified, false);
  assert.equal(r.posts[2]?.tokens[0]?.contract, '0x' + 'b'.repeat(40));
  assert.deepEqual(r.rejected.map((x) => x.reason), ['HANDLE_NOT_ALLOWED', 'INVALID_POST_URL']);
  assert.equal(r.usage.costUsd, 0.25);
  assert.equal(r.usage.xPostsFetched, 30);
  assert.deepEqual(r.citedPostIds.sort(), ['111', '999']);
});

test('parsePollResponse tolerates non-JSON output and rejects error payloads', () => {
  const plan = planHandlePoll({ handles, sinceMs: NOW - 3_600_000, now: NOW, model: 'grok-4.3', maxTurns: 2, maxOutputTokens: 6000 });
  const r = parsePollResponse(responsePayload('I could not find anything.', []), plan);
  assert.equal(r.posts.length, 0);
  assert.equal(r.rejected[0]?.reason, 'OUTPUT_NOT_JSON');
  assert.throws(() => parsePollResponse({ error: { message: 'bad' } }, plan), /XAI_UNVERIFIABLE_COMPLETION/);
});

test('xPostUrl canonicalizes post links only; redact strips keys; keyPreflight checks ACLs', () => {
  assert.deepEqual(xPostUrl('https://mobile.twitter.com/Fixture_Gamma/status/12345/video/1'), { url: 'https://x.com/Fixture_Gamma/status/12345', postId: '12345', handle: 'Fixture_Gamma' });
  assert.equal(xPostUrl('https://x.com/i/web/status/777')?.handle, null);
  assert.equal(xPostUrl('https://x.com/Fixture_Gamma'), null);
  assert.equal(xPostUrl('http://x.com/Fixture_Gamma/status/1'), null);
  const key = 'xai-' + 'A'.repeat(50);
  assert.equal(redact(`Authorization: Bearer ${key} body ${key}\u0001`, key), 'Authorization: Bearer [REDACTED] body [REDACTED]');
  assert.equal(usageView({}).costUsd, null);
  const ok = keyPreflight({ api_key_disabled: false, api_key_blocked: false, team_blocked: false, acls: ['api-key:endpoint:*', 'api-key:model:*'], name: 'alpha', redacted_api_key: 'xai-...AB12' }, 'grok-4.3', NOW);
  assert.equal(ok.redactedKey, 'xai-...AB12');
  assert.throws(() => keyPreflight({ api_key_disabled: true, api_key_blocked: false, team_blocked: false, acls: ['api-key:endpoint:*', 'api-key:model:*'] }, 'grok-4.3', NOW), /KEY_DISABLED_OR_BLOCKED/);
  assert.throws(() => keyPreflight({ api_key_disabled: false, api_key_blocked: false, team_blocked: false, acls: ['api-key:endpoint:*', 'api-key:model:grok-4.7'] }, 'grok-4.3', NOW), /KEY_MODEL_ACL_INSUFFICIENT/);
});
