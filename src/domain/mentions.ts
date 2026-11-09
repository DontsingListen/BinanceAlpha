/**
 * Token-mention extraction and resolution against the Alpha instrument catalog. Pure: no I/O, deterministic for a
 * given text + catalog + stoplist. Resolution order: contract address > alphaId > $cashtag/#hashtag > bare symbol > name.
 * Display-symbol collisions (e.g. two WARD tokens) resolve to AMBIGUOUS with the candidate instrument ids listed.
 */

export type CatalogEntry = { instrumentId: string; displaySymbol: string; tokenName: string; alphaId: string; contractAddress: string; chainName: string };

export type MentionCatalog = {
  byContract: Map<string, CatalogEntry[]>;
  byAlphaId: Map<string, CatalogEntry[]>;
  bySymbol: Map<string, CatalogEntry[]>;
  byName: Map<string, CatalogEntry[]>;
  /** Symbols/names containing CJK characters, matched by substring because CJK text has no word boundaries. */
  cjkTerms: { term: string; kind: 'symbol' | 'name'; key: string }[];
};

export type MatchKind = 'contract' | 'alpha_id' | 'cashtag' | 'hashtag' | 'symbol' | 'name';
export type Resolution = 'UNIQUE' | 'AMBIGUOUS' | 'UNRESOLVED';
export type Stance = 'bullish' | 'bearish' | 'neutral' | 'unknown';

/** A token reference produced by an extractor (regex or model), before catalog resolution. */
export type MentionCandidate = { tokenText: string; matchKind: MatchKind; confidence: number; stance?: Stance; name?: string | null; contract?: string | null };

export type ResolvedMention = { tokenText: string; matchKind: MatchKind; instrumentId: string | null; resolution: Resolution; candidates: string[]; stance: Stance; confidence: number };

/** Words that collide with Alpha display symbols or are too generic to count as a bare (un-$-prefixed) symbol mention. */
export const DEFAULT_STOPLIST: readonly string[] = [
  'ATH', 'ATL', 'APY', 'APR', 'TVL', 'DEX', 'CEX', 'NFT', 'DAO', 'AMM', 'IDO', 'ICO', 'TGE', 'KOL', 'FOMO', 'FUD', 'PUMP', 'DUMP', 'MOON', 'LONG', 'SHORT', 'BUY', 'SELL', 'HOLD', 'HODL',
  'USD', 'USDT', 'USDC', 'BTC', 'ETH', 'BNB', 'SOL', 'XRP', 'DOGE', 'ALPHA', 'BINANCE', 'SPOT', 'PERP', 'CALL', 'PUT', 'NEW', 'TOP', 'HOT', 'BIG', 'ALL', 'AND', 'THE', 'FOR', 'NOT', 'YOU',
  'STAR', 'LIGHT', 'EDGE', 'BASED', 'BASE', 'STABLE', 'LAB', 'COLLECT', 'TAKE', 'CROSS', 'TAG', 'DNA', 'DOS', 'BEAT', 'CAP', 'ON', 'UP', 'AI', 'GO', 'OK', 'VIP', 'CEO', 'GM', 'GN',
];

const CJK = /[㐀-鿿豈-﫿]/;

export function buildCatalog(entries: readonly CatalogEntry[]): MentionCatalog {
  const cat: MentionCatalog = { byContract: new Map(), byAlphaId: new Map(), bySymbol: new Map(), byName: new Map(), cjkTerms: [] };
  const push = (m: Map<string, CatalogEntry[]>, key: string, e: CatalogEntry) => { const list = m.get(key); if (list) { if (!list.some((x) => x.instrumentId === e.instrumentId)) list.push(e); } else m.set(key, [e]); };
  for (const e of entries) {
    if (e.contractAddress) push(cat.byContract, e.contractAddress.toLowerCase(), e);
    if (e.alphaId) push(cat.byAlphaId, e.alphaId.toUpperCase(), e);
    const sym = e.displaySymbol.trim();
    if (sym) {
      push(cat.bySymbol, sym.toUpperCase(), e);
      if (CJK.test(sym) && sym.length >= 2) cat.cjkTerms.push({ term: sym, kind: 'symbol', key: sym.toUpperCase() });
    }
    const name = e.tokenName.trim();
    if (name) {
      push(cat.byName, name.toLowerCase(), e);
      if (CJK.test(name) && name.length >= 2) cat.cjkTerms.push({ term: name, kind: 'name', key: name.toLowerCase() });
    }
  }
  cat.cjkTerms.sort((a, b) => b.term.length - a.term.length);
  return cat;
}

function resolveList(list: CatalogEntry[] | undefined): { instrumentId: string | null; resolution: Resolution; candidates: string[] } {
  if (!list || list.length === 0) return { instrumentId: null, resolution: 'UNRESOLVED', candidates: [] };
  if (list.length === 1) return { instrumentId: list[0]!.instrumentId, resolution: 'UNIQUE', candidates: [list[0]!.instrumentId] };
  return { instrumentId: null, resolution: 'AMBIGUOUS', candidates: list.map((e) => e.instrumentId).sort() };
}

/** Resolves one candidate against the catalog. A contract or name hint on a symbol candidate can disambiguate collisions. */
export function resolveMention(c: MentionCandidate, catalog: MentionCatalog): ResolvedMention {
  const stance: Stance = c.stance ?? 'unknown';
  const text = c.tokenText.trim();
  if (c.contract) {
    const hit = resolveList(catalog.byContract.get(c.contract.toLowerCase()));
    if (hit.resolution === 'UNIQUE') return { tokenText: text, matchKind: 'contract', ...hit, stance, confidence: Math.max(c.confidence, 0.95) };
  }
  let hit: ReturnType<typeof resolveList>;
  switch (c.matchKind) {
    case 'contract': hit = resolveList(catalog.byContract.get(text.toLowerCase())); break;
    case 'alpha_id': hit = resolveList(catalog.byAlphaId.get(text.toUpperCase())); break;
    case 'name': hit = resolveList(catalog.byName.get(text.toLowerCase())); break;
    default: hit = resolveList(catalog.bySymbol.get(text.toUpperCase()));
  }
  if (hit.resolution === 'AMBIGUOUS' && c.name) {
    const narrowed = (catalog.bySymbol.get(text.toUpperCase()) ?? []).filter((e) => e.tokenName.toLowerCase() === (c.name as string).toLowerCase());
    if (narrowed.length === 1) hit = resolveList(narrowed);
  }
  return { tokenText: text, matchKind: c.matchKind, ...hit, stance, confidence: c.confidence };
}

const EVM_ADDRESS = /0x[0-9a-fA-F]{40}/g;
const BASE58_ADDRESS = /(?<![1-9A-HJ-NP-Za-km-z])[1-9A-HJ-NP-Za-km-z]{32,44}(?![1-9A-HJ-NP-Za-km-z])/g;
const CASHTAG = /(?<![A-Za-z0-9_])([$#])([A-Za-z][A-Za-z0-9]{1,15})(?![A-Za-z0-9_])/g;
const BARE_SYMBOL = /(?<![A-Za-z0-9_$#])([A-Z][A-Z0-9]{2,11})(?![A-Za-z0-9_])/g;
const ALPHA_ID = /(?<![A-Za-z0-9_])(ALPHA_\d{1,6})(?![A-Za-z0-9_])/g;

/** Deterministic extractor `regex-v1`: contract addresses, alphaIds, $cashtags/#hashtags, bare upper-case symbols, token names. */
export function extractRegexMentions(text: string, catalog: MentionCatalog, stoplist: ReadonlySet<string> = new Set(DEFAULT_STOPLIST)): ResolvedMention[] {
  const out = new Map<string, ResolvedMention>();
  const add = (c: MentionCandidate) => {
    const r = resolveMention(c, catalog);
    const key = `${r.matchKind}:${r.tokenText.toUpperCase()}`;
    const prev = out.get(key);
    if (!prev || prev.confidence < r.confidence) out.set(key, r);
  };
  for (const m of text.matchAll(EVM_ADDRESS)) add({ tokenText: m[0], matchKind: 'contract', confidence: 0.9 });
  for (const m of text.matchAll(BASE58_ADDRESS)) if (catalog.byContract.has(m[0].toLowerCase())) add({ tokenText: m[0], matchKind: 'contract', confidence: 0.9 });
  for (const m of text.matchAll(ALPHA_ID)) add({ tokenText: m[1] as string, matchKind: 'alpha_id', confidence: 0.9 });
  for (const m of text.matchAll(CASHTAG)) {
    const sym = (m[2] as string).toUpperCase();
    if (m[1] === '$') add({ tokenText: sym, matchKind: 'cashtag', confidence: 0.8 });
    else if (catalog.bySymbol.has(sym) && !stoplist.has(sym)) add({ tokenText: sym, matchKind: 'hashtag', confidence: 0.6 });
  }
  for (const m of text.matchAll(BARE_SYMBOL)) {
    const sym = m[1] as string;
    if (stoplist.has(sym) || !catalog.bySymbol.has(sym)) continue;
    add({ tokenText: sym, matchKind: 'symbol', confidence: 0.5 });
  }
  for (const t of catalog.cjkTerms) {
    if (!text.includes(t.term)) continue;
    add({ tokenText: t.term, matchKind: t.kind, confidence: 0.5 });
  }
  const lower = text.toLowerCase();
  for (const [name, list] of catalog.byName) {
    if (name.length < 4 || CJK.test(name) || stoplist.has(name.toUpperCase())) continue;
    const idx = lower.indexOf(name);
    if (idx < 0) continue;
    const before = idx === 0 ? ' ' : lower[idx - 1]!;
    const after = idx + name.length >= lower.length ? ' ' : lower[idx + name.length]!;
    if (/[a-z0-9_]/.test(before) || /[a-z0-9_]/.test(after)) continue;
    add({ tokenText: list[0]!.tokenName, matchKind: 'name', confidence: 0.4 });
  }
  return [...out.values()].sort((a, b) => b.confidence - a.confidence || a.tokenText.localeCompare(b.tokenText));
}

/** Normalizes an X handle: strips a leading @, validates X's handle alphabet. Returns null when invalid. */
export function normalizeXHandle(value: string): string | null {
  const h = value.trim().replace(/^@/, '');
  return /^[A-Za-z0-9_]{1,15}$/.test(h) ? h : null;
}
