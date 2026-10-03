/**
 * The vault's allocation policy — a pure, deterministic function of market inputs.
 * Same inputs always produce the same decision and the same `inputsHash`, so anyone can
 * replay a signed intent and audit it (determinism is what makes the agent verifiable).
 *
 * Integer math only; no clocks, no randomness, no network.
 */
import { keccak256, stringToHex, type Hex } from 'viem';
import { REGIME, type Regime } from '../intent/eip712.js';
import type { MarketInputs } from '../market/scenarios.js';

export const MODEL_ID = 'ayv-policy-v1';
export const MODEL_VERSION: Hex = keccak256(stringToHex(MODEL_ID));

/** Thresholds (bps) — part of the model version; change them => bump MODEL_ID. */
export const THRESHOLDS = Object.freeze({
  recessionRiskOff: 4_000,
  crashMomentum: -1_500,
  impliedVolVolatile: 6_000,
  realizedVolVolatile: 5_000,
  earningsWindowDays: 2,
});

export const ALLOCATIONS = Object.freeze({
  [REGIME.RISK_ON]: { morphoBps: 5_000, uniswapBps: 5_000 },
  [REGIME.VOLATILE]: { morphoBps: 7_000, uniswapBps: 3_000 },
  [REGIME.RISK_OFF]: { morphoBps: 10_000, uniswapBps: 0 },
});

export type ReasonCode =
  | 'RECESSION_PROBABILITY_HIGH'
  | 'PRICE_CRASH_MOMENTUM'
  | 'EARNINGS_WINDOW'
  | 'IMPLIED_VOL_ELEVATED'
  | 'REALIZED_VOL_ELEVATED'
  | 'CALM_MARKET';

export interface Decision {
  regime: Regime;
  morphoBps: number;
  uniswapBps: number;
  /** Volatility forwarded to the FeeEngine (drives the hook's swap fee). */
  volBps: number;
  reasons: ReasonCode[];
  inputsHash: Hex;
  modelVersion: Hex;
}

/** Stable JSON: object keys sorted recursively, no whitespace. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function hashInputs(inputs: MarketInputs): Hex {
  return keccak256(stringToHex(canonicalJson({ model: MODEL_ID, inputs })));
}

function classify(inputs: MarketInputs): { regime: Regime; reasons: ReasonCode[] } {
  const riskOff: ReasonCode[] = [];
  if (inputs.recessionProbBps >= THRESHOLDS.recessionRiskOff) riskOff.push('RECESSION_PROBABILITY_HIGH');
  if (inputs.momentumBps <= THRESHOLDS.crashMomentum) riskOff.push('PRICE_CRASH_MOMENTUM');
  if (riskOff.length > 0) return { regime: REGIME.RISK_OFF, reasons: riskOff };

  const volatile: ReasonCode[] = [];
  const earningsSoon = inputs.earningsInDays >= 0 && inputs.earningsInDays <= THRESHOLDS.earningsWindowDays;
  if (earningsSoon) volatile.push('EARNINGS_WINDOW');
  if (inputs.impliedVolBps >= THRESHOLDS.impliedVolVolatile) volatile.push('IMPLIED_VOL_ELEVATED');
  if (inputs.realizedVolBps >= THRESHOLDS.realizedVolVolatile) volatile.push('REALIZED_VOL_ELEVATED');
  if (volatile.length > 0) return { regime: REGIME.VOLATILE, reasons: volatile };

  return { regime: REGIME.RISK_ON, reasons: ['CALM_MARKET'] };
}

export function decide(inputs: MarketInputs): Decision {
  const { regime, reasons } = classify(inputs);
  const allocation = ALLOCATIONS[regime];
  const volBps = Math.min(Math.max(inputs.impliedVolBps, inputs.realizedVolBps), 10_000);
  return {
    regime,
    morphoBps: allocation.morphoBps,
    uniswapBps: allocation.uniswapBps,
    volBps: regime === REGIME.RISK_ON ? 0 : volBps,
    reasons,
    inputsHash: hashInputs(inputs),
    modelVersion: MODEL_VERSION,
  };
}
