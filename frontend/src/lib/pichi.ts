/** $PICHI community token (vibe/vibe, Robinhood Chain testnet): Blockscout API parsing. */

export interface PichiTokenInfo {
  name: string;
  symbol: string;
  decimals: number;
  totalSupply: bigint;
  holders: number;
  transfers: number | undefined;
}

const isDigits = (v: unknown): v is string => typeof v === 'string' && /^\d+$/.test(v);

/**
 * Validates Blockscout's `/api/v2/tokens/{address}` (+ optional `/counters`) responses.
 * Returns null on any unexpected shape: external data is never trusted as-is.
 */
export function parsePichiToken(token: unknown, counters?: unknown): PichiTokenInfo | null {
  if (!token || typeof token !== 'object') return null;
  const t = token as Record<string, unknown>;
  if (typeof t.name !== 'string' || typeof t.symbol !== 'string') return null;
  if (!isDigits(t.decimals) || !isDigits(t.total_supply)) return null;
  const c = counters && typeof counters === 'object' ? (counters as Record<string, unknown>) : {};
  const holders = isDigits(c.token_holders_count) ? c.token_holders_count : t.holders_count;
  return {
    name: t.name.slice(0, 64),
    symbol: t.symbol.slice(0, 16),
    decimals: Number(t.decimals),
    totalSupply: BigInt(t.total_supply),
    holders: isDigits(holders) ? Number(holders) : 0,
    transfers: isDigits(c.transfers_count) ? Number(c.transfers_count) : undefined,
  };
}

/** Whole-token amount with thousands separators (no decimals). */
export function formatTokenAmount(raw: bigint, decimals: number): string {
  return (raw / 10n ** BigInt(decimals)).toLocaleString('en-US');
}
