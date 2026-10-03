import { describe, expect, it } from 'vitest';
import { canonicalJson, decide, hashInputs, MODEL_VERSION } from '../src/policy/policy.js';
import { SCENARIOS } from '../src/market/scenarios.js';
import { REGIME } from '../src/intent/eip712.js';

describe('policy', () => {
  it('is deterministic: same inputs give the same decision and inputsHash', () => {
    const a = decide(SCENARIOS.calm);
    const b = decide({ ...SCENARIOS.calm });
    expect(a).toEqual(b);
    expect(a.inputsHash).toBe(hashInputs(SCENARIOS.calm));
    expect(a.modelVersion).toBe(MODEL_VERSION);
  });

  it('calm market -> RISK_ON 50/50 with base fee (volBps 0)', () => {
    const d = decide(SCENARIOS.calm);
    expect(d.regime).toBe(REGIME.RISK_ON);
    expect([d.morphoBps, d.uniswapBps, d.volBps]).toEqual([5_000, 5_000, 0]);
    expect(d.reasons).toEqual(['CALM_MARKET']);
  });

  it('earnings window -> VOLATILE, smaller LP leg, vol forwarded to the fee engine', () => {
    const d = decide(SCENARIOS.earnings_volatility);
    expect(d.regime).toBe(REGIME.VOLATILE);
    expect([d.morphoBps, d.uniswapBps]).toEqual([7_000, 3_000]);
    expect(d.volBps).toBe(6_800);
    expect(d.reasons).toContain('EARNINGS_WINDOW');
    expect(d.reasons).toContain('IMPLIED_VOL_ELEVATED');
  });

  it('recession signal -> RISK_OFF, 100% Morpho, no LP', () => {
    const d = decide(SCENARIOS.recession);
    expect(d.regime).toBe(REGIME.RISK_OFF);
    expect([d.morphoBps, d.uniswapBps]).toEqual([10_000, 0]);
    expect(d.reasons).toEqual(['RECESSION_PROBABILITY_HIGH', 'PRICE_CRASH_MOMENTUM']);
  });

  it('any input change changes the inputsHash', () => {
    const tweaked = { ...SCENARIOS.calm, spotE8: SCENARIOS.calm.spotE8 + 1 };
    expect(hashInputs(tweaked)).not.toBe(hashInputs(SCENARIOS.calm));
  });

  it('canonical JSON sorts keys recursively and drops undefined', () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: undefined } })).toBe('{"a":{"d":[2,{"y":2,"z":1}]},"b":1}');
  });

  it('caps forwarded volatility at 100%', () => {
    const d = decide({ ...SCENARIOS.earnings_volatility, impliedVolBps: 25_000 });
    expect(d.volBps).toBe(10_000);
  });

  it('allocations always respect the vault guardrails', () => {
    for (const s of Object.values(SCENARIOS)) {
      const d = decide(s);
      expect(d.morphoBps + d.uniswapBps).toBeLessThanOrEqual(10_000);
      expect(d.uniswapBps).toBeLessThanOrEqual(7_000);
      if (d.regime === REGIME.RISK_OFF) expect(d.uniswapBps).toBe(0);
    }
  });
});
