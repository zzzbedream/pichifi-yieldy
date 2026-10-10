import { describe, expect, it } from 'vitest';
import { formatTokenAmount, parsePichiToken } from './pichi';

const token = {
  name: 'PICHIFI',
  symbol: 'PICHI',
  decimals: '18',
  total_supply: '1000000000000000000000000000',
  holders_count: '12',
};

describe('parsePichiToken', () => {
  it('parses a Blockscout token with counters', () => {
    const info = parsePichiToken(token, { token_holders_count: '15', transfers_count: '42' });
    expect(info).toEqual({
      name: 'PICHIFI',
      symbol: 'PICHI',
      decimals: 18,
      totalSupply: 10n ** 27n,
      holders: 15,
      transfers: 42,
    });
  });

  it('falls back to holders_count when counters are missing', () => {
    expect(parsePichiToken(token)?.holders).toBe(12);
    expect(parsePichiToken(token)?.transfers).toBeUndefined();
  });

  it('rejects unexpected shapes', () => {
    expect(parsePichiToken(null)).toBeNull();
    expect(parsePichiToken({ ...token, total_supply: 'abc' })).toBeNull();
    expect(parsePichiToken({ ...token, name: 42 })).toBeNull();
  });

  it('formats whole-token amounts', () => {
    expect(formatTokenAmount(10n ** 27n, 18)).toBe('1,000,000,000');
  });
});
