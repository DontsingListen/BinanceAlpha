import { canonicalJson, sha256OfText } from './hash.ts';
import { isFiniteNumber } from './math.ts';

/** Parameters of docs/04-strategy-spec.md, loaded from spec/policy-v0.proposed.json. */
export type PolicyParameters = {
  readonly warmupBars: number;
  readonly impulseBars: number;
  readonly baselineBars: number;
  readonly minQuoteVolume24h: number;
  readonly minPositiveVolumeFraction: number;
  readonly impulseReturnMin: number;
  readonly impulseVolumeRatioMin: number;
  readonly pullbackMin: number;
  readonly pullbackMax: number;
  readonly baseBars: number;
  readonly baseRangeMax: number;
  readonly baseVolumeRatioMax: number;
  readonly breakoutBuffer: number;
  readonly breakoutVolumeRatioMin: number;
  readonly breakoutExtensionMax: number;
  readonly baseStopBuffer: number;
  readonly confirmationBars: number;
  readonly confirmationWindowBars: number;
  readonly setupTtlHours: number;
  readonly cooldownBars: number;
  readonly freshnessMaxMs: number;
};

export type Policy = {
  readonly schemaVersion: number;
  readonly policyVersion: string;
  readonly status: string;
  readonly market: string;
  readonly quoteAsset: string;
  readonly timeframeMs: number;
  readonly parameters: PolicyParameters;
  /** sha256 of the canonical JSON of everything above. */
  readonly policyHash: string;
};

const PARAM_KEYS: readonly (keyof PolicyParameters)[] = [
  'warmupBars', 'impulseBars', 'baselineBars', 'minQuoteVolume24h', 'minPositiveVolumeFraction',
  'impulseReturnMin', 'impulseVolumeRatioMin', 'pullbackMin', 'pullbackMax', 'baseBars',
  'baseRangeMax', 'baseVolumeRatioMax', 'breakoutBuffer', 'breakoutVolumeRatioMin',
  'breakoutExtensionMax', 'baseStopBuffer', 'confirmationBars', 'confirmationWindowBars',
  'setupTtlHours', 'cooldownBars', 'freshnessMaxMs',
];

export class PolicyError extends Error {}

/** Validates the proposed policy document. Throws PolicyError with the exact violation. */
export function parsePolicy(doc: unknown): Policy {
  if (!doc || typeof doc !== 'object') throw new PolicyError('policy document must be an object');
  const d = doc as Record<string, unknown>;
  const schemaVersion = d['schemaVersion'];
  if (schemaVersion !== 1) throw new PolicyError(`unsupported policy schemaVersion: ${String(schemaVersion)}`);
  for (const key of ['policyVersion', 'status', 'market', 'quoteAsset'] as const) {
    if (typeof d[key] !== 'string' || !d[key]) throw new PolicyError(`policy.${key} must be a non-empty string`);
  }
  if (!isFiniteNumber(d['timeframeMs']) || d['timeframeMs'] <= 0) throw new PolicyError('policy.timeframeMs must be > 0');
  const rawParams = d['parameters'];
  if (!rawParams || typeof rawParams !== 'object') throw new PolicyError('policy.parameters must be an object');
  const p = rawParams as Record<string, unknown>;
  const params: Record<string, number> = {};
  for (const key of PARAM_KEYS) {
    const v = p[key];
    if (!isFiniteNumber(v)) throw new PolicyError(`policy.parameters.${key} must be a finite number`);
    params[key] = v;
  }
  const P = params as unknown as PolicyParameters;
  if (P.warmupBars !== P.impulseBars + P.baselineBars) throw new PolicyError('warmupBars must equal impulseBars + baselineBars');
  if (!(0 < P.pullbackMin && P.pullbackMin < P.pullbackMax && P.pullbackMax < 1)) throw new PolicyError('0 < pullbackMin < pullbackMax < 1 required');
  if (P.confirmationBars > P.confirmationWindowBars) throw new PolicyError('confirmationBars must be <= confirmationWindowBars');
  if (P.baseBars < 1 || P.impulseBars < 1 || P.baselineBars < 1) throw new PolicyError('window sizes must be >= 1');
  if (!(0 < P.minPositiveVolumeFraction && P.minPositiveVolumeFraction <= 1)) throw new PolicyError('minPositiveVolumeFraction must be in (0,1]');
  const core = {
    schemaVersion: 1,
    policyVersion: d['policyVersion'] as string,
    status: d['status'] as string,
    market: d['market'] as string,
    quoteAsset: d['quoteAsset'] as string,
    timeframeMs: d['timeframeMs'] as number,
    parameters: P,
  };
  return { ...core, policyHash: sha256OfText(canonicalJson(core)) };
}

export function setupTtlMs(policy: Policy): number {
  return policy.parameters.setupTtlHours * 3_600_000;
}
