/**
 * Token/pair discovery: snapshot the Alpha universe, map identities by alphaId only,
 * record exclusions with reasons, and select the collection scope under an explicit, hashed selection policy.
 */
import type { AlphaClient } from '../adapters/binance-alpha/client.ts';
import type { SymbolDto, TokenDto } from '../adapters/binance-alpha/dto.ts';
import { canonicalJson, sha256Hex, sha256OfText } from '../domain/hash.ts';
import type { Db } from '../storage/db.ts';
import { withTransaction } from '../storage/db.ts';
import { getInstrument, insertIdentityConflict, insertRawResponse, insertUniverseSnapshot, upsertInstrument, type InstrumentIdentity, type InstrumentRow } from '../storage/repos.ts';
import { recentMentionedInstruments } from '../storage/social-repos.ts';
import type { AppConfig } from './config.ts';

export class DiscoveryError extends Error {}

export type Excluded = { instrumentId: string; reason: string };

export type DiscoveryResult = {
  snapshotId: string;
  observedAt: number;
  selected: InstrumentRow[];
  excluded: Excluded[];
  counts: { tokens: number; symbols: number; quoteSymbols: number; eligible: number; selected: number; socialPinned: number; tokenRejected: number; symbolRejected: number; conflicts: number; identityChanges: number; newInstruments: number };
  selectionPolicyHash: string;
};

export function instrumentIdFor(cfg: AppConfig, symbol: string): string {
  return `${cfg.provider}:${cfg.marketType}:${symbol}`;
}

export async function discoverUniverse(db: Db, client: AlphaClient, cfg: AppConfig, now: number = Date.now()): Promise<DiscoveryResult> {
  const tokensRes = await client.getTokenList();
  if (tokensRes.outcome !== 'OK' || !tokensRes.value) throw new DiscoveryError(`token list: ${tokensRes.outcome} ${tokensRes.message ?? ''}`);
  const symbolsRes = await client.getExchangeInfo();
  if (symbolsRes.outcome !== 'OK' || !symbolsRes.value) throw new DiscoveryError(`exchange info: ${symbolsRes.outcome} ${symbolsRes.message ?? ''}`);
  const tokens = tokensRes.value;
  const symbols = symbolsRes.value;
  const observedAt = now;

  const selectionPolicy = {
    quoteAsset: cfg.quoteAsset, maxInstruments: cfg.selection.maxInstruments, orderBy: cfg.selection.orderBy,
    pinned: [...cfg.selection.pinned].sort(), only: [...cfg.selection.only].sort(), socialPinHours: cfg.selection.socialPinHours, socialMaxPinned: cfg.selection.socialMaxPinned,
    requireStatus: 'TRADING', excludeTokenOffline: true, excludeFullyDelisted: true,
  };
  const selectionPolicyHash = sha256OfText(canonicalJson(selectionPolicy));

  return withTransaction(db, () => {
    const tokenSha = tokensRes.attempt.rawSha256 as string;
    const symbolSha = symbolsRes.attempt.rawSha256 as string;
    insertRawResponse(db, tokenSha, tokensRes.rawText as string, observedAt);
    insertRawResponse(db, symbolSha, symbolsRes.rawText as string, observedAt);

    let conflicts = 0;
    const tokenByAlphaId = new Map<string, TokenDto>();
    for (const t of tokens) {
      const prev = tokenByAlphaId.get(t.alphaId);
      if (prev) {
        conflicts += 1;
        insertIdentityConflict(db, observedAt, 'DUPLICATE_ALPHA_ID', { alphaId: t.alphaId, a: prev, b: t });
        continue;
      }
      tokenByAlphaId.set(t.alphaId, t);
    }

    const excluded: Excluded[] = [];
    const eligible: { row: InstrumentRow; token: TokenDto }[] = [];
    let identityChanges = 0;
    let newInstruments = 0;
    let quoteSymbols = 0;
    const quoteSyms: SymbolDto[] = symbols.filter((s) => s.quoteAsset === cfg.quoteAsset);
    for (const s of quoteSyms) {
      quoteSymbols += 1;
      const instrumentId = instrumentIdFor(cfg, s.symbol);
      const token = tokenByAlphaId.get(s.baseAsset);
      if (!token) {
        conflicts += 1;
        insertIdentityConflict(db, observedAt, 'SYMBOL_WITHOUT_TOKEN', { symbol: s.symbol, baseAsset: s.baseAsset });
        excluded.push({ instrumentId, reason: 'SYMBOL_WITHOUT_TOKEN' });
        continue;
      }
      const identity: InstrumentIdentity = {
        instrumentId, provider: cfg.provider, marketType: cfg.marketType, symbol: s.symbol, alphaId: token.alphaId, baseAsset: s.baseAsset, quoteAsset: s.quoteAsset,
        displaySymbol: token.symbol, tokenName: token.name, chainId: token.chainId, chainName: token.chainName, contractAddress: token.contractAddress,
        status: s.status, tokenOffline: token.offline,
      };
      const change = upsertInstrument(db, identity, observedAt);
      if (change === 'new') newInstruments += 1;
      if (change === 'identity_changed') identityChanges += 1;
      if (s.status !== 'TRADING') { excluded.push({ instrumentId, reason: `STATUS_${s.status}` }); continue; }
      if (token.fullyDelisted) { excluded.push({ instrumentId, reason: 'TOKEN_FULLY_DELISTED' }); continue; }
      if (token.offline) { excluded.push({ instrumentId, reason: 'TOKEN_OFFLINE' }); continue; }
      const row = getInstrument(db, instrumentId) as InstrumentRow;
      eligible.push({ row, token });
    }

    // selection
    let selected: InstrumentRow[];
    const only = new Set(cfg.selection.only.flatMap((x) => [x, instrumentIdFor(cfg, x)]));
    if (only.size > 0) {
      selected = eligible.filter((e) => only.has(e.row.symbol) || only.has(e.row.instrumentId)).map((e) => e.row);
      for (const e of eligible) if (!selected.includes(e.row)) excluded.push({ instrumentId: e.row.instrumentId, reason: 'NOT_IN_ONLY_LIST' });
    } else {
      const pinned = new Set(cfg.selection.pinned.flatMap((x) => [x, instrumentIdFor(cfg, x)]));
      const ranked = [...eligible].sort((a, b) => {
        const pa = pinned.has(a.row.symbol) || pinned.has(a.row.instrumentId) ? 0 : 1;
        const pb = pinned.has(b.row.symbol) || pinned.has(b.row.instrumentId) ? 0 : 1;
        if (pa !== pb) return pa - pb;
        if (cfg.selection.orderBy === 'token_volume24h_desc') {
          const va = Number(a.token.volume24h ?? 0) || 0;
          const vb = Number(b.token.volume24h ?? 0) || 0;
          if (va !== vb) return vb - va;
        }
        return a.row.instrumentId < b.row.instrumentId ? -1 : a.row.instrumentId > b.row.instrumentId ? 1 : 0;
      });
      selected = ranked.slice(0, cfg.selection.maxInstruments).map((e) => e.row);
      for (const e of ranked.slice(cfg.selection.maxInstruments)) excluded.push({ instrumentId: e.row.instrumentId, reason: 'NOT_SELECTED_CAPACITY' });
    }

    // Social pins (ADR 0003): instruments mentioned by watched sources recently stay in scope beyond the capacity limit.
    const socialPinned: string[] = [];
    if (only.size === 0 && cfg.selection.socialPinHours > 0 && cfg.selection.socialMaxPinned > 0) {
      const eligibleById = new Map(eligible.map((e) => [e.row.instrumentId, e.row]));
      for (const m of recentMentionedInstruments(db, observedAt - cfg.selection.socialPinHours * 3_600_000)) {
        if (socialPinned.length >= cfg.selection.socialMaxPinned) break;
        const row = eligibleById.get(m.instrumentId);
        if (!row || selected.includes(row)) continue;
        selected.push(row);
        socialPinned.push(row.instrumentId);
      }
      for (let i = excluded.length - 1; i >= 0; i--) if (socialPinned.includes(excluded[i]!.instrumentId)) excluded.splice(i, 1);
    }

    const snapshotId = sha256Hex('snapshot', cfg.provider, observedAt, tokenSha, symbolSha).slice(0, 32);
    insertUniverseSnapshot(db, {
      snapshotId, provider: cfg.provider, observedAt, tokenListSha256: tokenSha, exchangeInfoSha256: symbolSha, selectionPolicyHash,
      tokenCount: tokens.length, symbolCount: symbols.length, eligibleCount: eligible.length, selectedCount: selected.length,
      members: { selectionPolicy, selected: selected.map((r) => r.instrumentId), excluded, socialPinned },
    });
    return {
      snapshotId, observedAt, selected, excluded, selectionPolicyHash,
      counts: {
        tokens: tokens.length, symbols: symbols.length, quoteSymbols, eligible: eligible.length, selected: selected.length, socialPinned: socialPinned.length,
        tokenRejected: tokensRes.rejected.length, symbolRejected: symbolsRes.rejected.length, conflicts, identityChanges, newInstruments,
      },
    };
  });
}
