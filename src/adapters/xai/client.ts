/**
 * xAI Responses API transport, adapted from a prior internal research transport (verified against docs.x.ai, 2026-11-05/06):
 * POST /v1/responses with the server-side `x_search` tool; `usage.cost_in_usd_ticks` covers tokens and tool fetches;
 * citations arrive as `url_citation` annotations. GET /v1/api-key reports key status/ACLs only; xAI has no per-key
 * spend limit, so budgets here are review thresholds, not hard guarantees. The key is never logged or stored.
 */

export const XAI_ORIGIN = 'https://api.x.ai/v1';
export const TICKS_PER_USD = 10_000_000_000;
const KEY_PATTERN = /^xai-[A-Za-z0-9]{40,200}$/;
const MAX_BODY_BYTES = 2_000_000;

export class XaiError extends Error {
  readonly code: string;
  readonly httpStatus: number | null;
  constructor(code: string, httpStatus: number | null = null) {
    super(code);
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

const count = (n: unknown): number | null => (Number.isSafeInteger(n) && (n as number) >= 0 ? (n as number) : null);
const safeToken = (value: unknown, pattern: RegExp): string | null => (typeof value === 'string' && pattern.test(value) && !/xai-[A-Za-z0-9]{20,}/.test(value) ? value : null);

/** Strips the API key, bearer tokens and control characters from any text that may be stored or logged. */
export function redact(value: string, secret = ''): string {
  return value
    .replaceAll(secret || '\u0000', '[REDACTED]')
    .replace(/xai-[A-Za-z0-9]{20,}/g, '[REDACTED]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
}

export type XaiUsage = {
  inputTokens: number | null; outputTokens: number | null; totalTokens: number | null; reasoningTokens: number | null; cachedInputTokens: number | null;
  costUsdTicks: number | null; costUsd: number | null; serverToolsUsed: number | null; sourcesUsed: number | null;
  xSearchCalls: number | null; xPostsFetched: number | null; xUsersFetched: number | null;
};

export function usageView(value: unknown): XaiUsage {
  const u = (value ?? {}) as Record<string, unknown>;
  const tools = (u['server_side_tool_usage_details'] ?? {}) as Record<string, unknown>;
  const ticks = count(u['cost_in_usd_ticks']);
  return {
    inputTokens: count(u['input_tokens']), outputTokens: count(u['output_tokens']), totalTokens: count(u['total_tokens']),
    reasoningTokens: count((u['output_tokens_details'] as Record<string, unknown> | undefined)?.['reasoning_tokens']),
    cachedInputTokens: count((u['input_tokens_details'] as Record<string, unknown> | undefined)?.['cached_tokens']),
    costUsdTicks: ticks, costUsd: ticks === null ? null : ticks / TICKS_PER_USD,
    serverToolsUsed: count(u['num_server_side_tools_used']), sourcesUsed: count(u['num_sources_used']),
    xSearchCalls: count(tools['x_search_calls']), xPostsFetched: count(tools['x_posts_fetched']), xUsersFetched: count(tools['x_users_fetched']),
  };
}

/** Canonical X post URL and status id, or null for anything that is not a post URL. Untrusted URLs are evidence, never navigation targets. */
export function xPostUrl(value: unknown): { url: string; postId: string; handle: string | null } | null {
  if (typeof value !== 'string' || value.length > 1000) return null;
  try {
    const u = new URL(value);
    if (u.protocol !== 'https:' || u.username || u.password || u.port || !['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com', 'mobile.twitter.com'].includes(u.hostname)) return null;
    const m = u.pathname.match(/^\/([A-Za-z0-9_]{1,15})\/status\/(\d{1,30})(?:\/(?:photo|video)\/\d+)?\/?$/);
    if (m) return { url: `https://x.com/${m[1]}/status/${m[2]}`, postId: m[2] as string, handle: m[1] as string };
    const i = u.pathname.match(/^\/i\/(?:web\/)?status\/(\d{1,30})\/?$/);
    if (i) return { url: `https://x.com/i/web/status/${i[1]}`, postId: i[1] as string, handle: null };
  } catch { /* not a URL */ }
  return null;
}

export type KeyStatus = { keyName: string | null; redactedKey: string | null; acls: string[]; checkedAt: number; limitation: string };

/** /v1/api-key proves authentication, enabled status and endpoint/model ACLs; it cannot prove remaining credit. */
export function keyPreflight(data: unknown, model: string, at: number): KeyStatus {
  const d = data as Record<string, unknown> | null;
  if (!d || typeof d !== 'object' || Array.isArray(d)) throw new XaiError('KEY_STATUS_UNVERIFIABLE');
  for (const f of ['api_key_disabled', 'api_key_blocked', 'team_blocked']) if (typeof d[f] !== 'boolean') throw new XaiError('KEY_STATUS_UNVERIFIABLE');
  if (d['api_key_disabled'] || d['api_key_blocked'] || d['team_blocked']) throw new XaiError('KEY_DISABLED_OR_BLOCKED');
  const acls = (Array.isArray(d['acls']) ? d['acls'] : []).filter((a): a is string => typeof a === 'string' && /^api-key:[a-z]+:[A-Za-z0-9_.*-]{1,80}$/.test(a));
  if (!acls.some((a) => /^api-key:endpoint:(?:\*|.*responses.*)$/.test(a))) throw new XaiError('KEY_ENDPOINT_ACL_INSUFFICIENT');
  if (!acls.some((a) => a === 'api-key:model:*' || a === `api-key:model:${model}`)) throw new XaiError('KEY_MODEL_ACL_INSUFFICIENT');
  return { keyName: safeToken(d['name'], /^[\w .-]{1,80}$/), redactedKey: safeToken(d['redacted_api_key'], /^xai-\.\.\.[A-Za-z0-9]{1,8}$/), acls, checkedAt: at, limitation: 'KEY_STATUS_AND_ACL_ONLY; NO_PER_KEY_SPEND_LIMIT_OR_BALANCE_ENDPOINT' };
}

export type XaiResponse = { raw: unknown; rawText: string; httpStatus: number; durationMs: number };

export type XaiClientOptions = { apiKey: string; fetchImpl?: typeof fetch; timeoutMs?: number; origin?: string };

export class XaiClient {
  readonly #apiKey: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #origin: string;
  constructor(o: XaiClientOptions) {
    if (!KEY_PATTERN.test(o.apiKey)) throw new XaiError('XAI_API_KEY_REQUIRED');
    this.#apiKey = o.apiKey;
    this.#fetch = o.fetchImpl ?? fetch;
    this.#timeoutMs = o.timeoutMs ?? 120_000;
    this.#origin = o.origin ?? XAI_ORIGIN;
  }

  async apiKeyStatus(): Promise<unknown> {
    return (await this.#json('/api-key', null, Math.min(this.#timeoutMs, 15_000))).raw;
  }

  async responses(body: Record<string, unknown>, timeoutMs = this.#timeoutMs): Promise<XaiResponse> {
    return this.#json('/responses', body, timeoutMs);
  }

  async #json(path: string, body: Record<string, unknown> | null, timeoutMs: number): Promise<XaiResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const startedAt = Date.now();
    try {
      const response = await this.#fetch(`${this.#origin}${path}`, {
        method: body ? 'POST' : 'GET', redirect: 'error',
        headers: { Authorization: `Bearer ${this.#apiKey}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}), signal: controller.signal,
      });
      const text = await readBounded(response);
      if (!response.ok) throw new XaiError(`XAI_HTTP_${response.status}`, response.status);
      let raw: unknown;
      try { raw = JSON.parse(text); } catch { throw new XaiError('XAI_INVALID_JSON', response.status); }
      return { raw, rawText: redact(text, this.#apiKey), httpStatus: response.status, durationMs: Date.now() - startedAt };
    } catch (cause) {
      if (cause instanceof XaiError) throw cause;
      if (controller.signal.aborted) throw new XaiError('XAI_TIMEOUT_CHARGE_MAY_BE_UNKNOWN');
      throw new XaiError('XAI_NETWORK_ERROR');
    } finally {
      clearTimeout(timer);
    }
  }
}

async function readBounded(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new XaiError('XAI_BODY_UNAVAILABLE', response.status);
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) { void reader.cancel().catch(() => {}); throw new XaiError('XAI_RESPONSE_TOO_LARGE', response.status); }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}
