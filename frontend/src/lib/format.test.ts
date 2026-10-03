import { describe, expect, it } from 'vitest';
import {
  bpsToPercent,
  formatUsd,
  parseUnitsSafe,
  pipsToPercent,
  relativeTime,
  share,
  shortHex,
  toUnits,
  wadToPercent,
} from './format';

describe('format', () => {
  it('converts raw units', () => {
    expect(toUnits(100_000_000_000n, 6)).toBe(100_000);
    expect(toUnits(1_500_000n, 6)).toBe(1.5);
  });

  it('formats USD and placeholders', () => {
    expect(formatUsd(100_214_550_000n)).toBe('$100,214.55');
    expect(formatUsd(undefined)).toBe('—');
  });

  it('formats fees and allocations', () => {
    expect(pipsToPercent(3_000)).toBe('0.30%');
    expect(pipsToPercent(50_000)).toBe('5.00%');
    expect(bpsToPercent(5_000)).toBe('50%');
    expect(wadToPercent(52_500_000_000_000_000n)).toBe('5.25%');
  });

  it('computes safe shares', () => {
    expect(share(50n, 100n)).toBe(0.5);
    expect(share(1n, 0n)).toBe(0);
    expect(share(undefined, 10n)).toBe(0);
  });

  it('parses user amounts strictly', () => {
    expect(parseUnitsSafe('100000', 6)).toBe(100_000_000_000n);
    expect(parseUnitsSafe('1.5', 6)).toBe(1_500_000n);
    expect(parseUnitsSafe('1.1234567', 6)).toBeNull();
    expect(parseUnitsSafe('-1', 6)).toBeNull();
    expect(parseUnitsSafe('abc', 6)).toBeNull();
  });

  it('shortens hex and renders relative time', () => {
    expect(shortHex('0x1234567890abcdef1234')).toBe('0x1234…1234');
    expect(relativeTime('2026-10-03T12:00:00Z', Date.parse('2026-10-03T12:02:30Z'))).toBe('2m ago');
  });
});
