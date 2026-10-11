import { describe, expect, it } from 'vitest';
import { computeLiveInputs, tradingDaysBetween } from '../src/market/live.js';
import { decide } from '../src/policy/policy.js';

const flat = (n: number, v: number) => Array.from({ length: n }, () => v);
const T = Date.parse('2026-10-09T20:00:00Z') / 1000; // a Friday close

describe('tradingDaysBetween', () => {
  it('counts weekdays after the start date', () => {
    expect(tradingDaysBetween('2026-10-09', '2026-10-12')).toBe(1); // Fri -> Mon
    expect(tradingDaysBetween('2026-10-09', '2026-10-16')).toBe(5);
    expect(tradingDaysBetween('2026-10-09', '2026-10-09')).toBe(0);
  });
});

describe('computeLiveInputs', () => {
  it('flat prices give zero vol and momentum', () => {
    const inputs = computeLiveInputs('NVDA', { closes: flat(30, 200), lastCloseTime: T, recessionPct: 0.62 });
    expect(inputs).toMatchObject({ scenario: 'live', spotE8: 200e8, realizedVolBps: 0, momentumBps: 0, earningsInDays: -1, recessionProbBps: 62 });
    expect(inputs.asOf).toBe('2026-10-09T20:00:00.000Z');
  });

  it('measures 20d momentum and realized vol from the last 21 closes', () => {
    const closes = [...flat(10, 1), ...Array.from({ length: 21 }, (_, i) => (i % 2 === 0 ? 100 : 102))];
    closes[closes.length - 1] = 110;
    const inputs = computeLiveInputs('NVDA', { closes, lastCloseTime: T, recessionPct: 1 });
    expect(inputs.momentumBps).toBe(1000);
    expect(inputs.realizedVolBps).toBeGreaterThan(2000);
    expect(inputs.impliedVolBps).toBe(inputs.realizedVolBps);
  });

  it('turns an earnings date into trading days and feeds the policy', () => {
    const inputs = computeLiveInputs('NVDA', { closes: flat(30, 200), lastCloseTime: T, earningsDate: '2026-10-12', recessionPct: 0.5 });
    expect(inputs.earningsInDays).toBe(1);
    expect(decide(inputs).regime).toBe(1); // earnings within 2 days -> VOLATILE
    expect(decide(inputs).inputsHash).toBe(decide({ ...inputs }).inputsHash); // deterministic
  });

  it('rejects too little history', () => {
    expect(() => computeLiveInputs('NVDA', { closes: flat(5, 200), lastCloseTime: T, recessionPct: 0 })).toThrow();
  });
});
