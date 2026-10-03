/** Display helpers. Inputs are raw on-chain integers; outputs are display strings. */

export const USDG_DECIMALS = 6;
export const SHARE_DECIMALS = 12;
const WAD = 10n ** 18n;

export function toUnits(raw: bigint, decimals: number): number {
  const base = 10n ** BigInt(decimals);
  const whole = raw / base;
  const frac = raw % base;
  return Number(whole) + Number(frac) / Number(base);
}

export function formatUsd(raw: bigint | undefined, decimals = USDG_DECIMALS, maxFraction = 2): string {
  if (raw === undefined) return '—';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: maxFraction,
    maximumFractionDigits: maxFraction,
  }).format(toUnits(raw, decimals));
}

export function formatAmount(raw: bigint | undefined, decimals: number, maxFraction = 2): string {
  if (raw === undefined) return '—';
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: maxFraction }).format(toUnits(raw, decimals));
}

/** Pips (1e-6) to percent string: 3000 -> "0.30%". */
export function pipsToPercent(pips: number | undefined): string {
  if (pips === undefined) return '—';
  return `${(pips / 10_000).toFixed(2)}%`;
}

export function bpsToPercent(bps: number | undefined, digits = 0): string {
  if (bps === undefined) return '—';
  return `${(bps / 100).toFixed(digits)}%`;
}

/** WAD APR to percent string. */
export function wadToPercent(wad: bigint | undefined, digits = 2): string {
  if (wad === undefined) return '—';
  return `${((Number(wad) / Number(WAD)) * 100).toFixed(digits)}%`;
}

/** Fraction (0..1) of `part` within `total`, safe for zero totals. */
export function share(part: bigint | undefined, total: bigint | undefined): number {
  if (!part || !total || total === 0n) return 0;
  return Number((part * 1_000_000n) / total) / 1_000_000;
}

export function shortHex(value: string | undefined, head = 6, tail = 4): string {
  if (!value) return '—';
  if (value.length <= head + tail + 2) return value;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

/** Parses a user-entered decimal string into raw units; null when invalid. */
export function parseUnitsSafe(input: string, decimals: number): bigint | null {
  const trimmed = input.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return null;
  const [whole, frac = ''] = trimmed.split('.');
  if (frac.length > decimals) return null;
  return BigInt(whole!) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, '0') || '0');
}

export function relativeTime(iso: string, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3600)}h ago`;
}
