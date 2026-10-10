'use client';

import { useQuery } from '@tanstack/react-query';
import { appConfig } from '@/lib/config';
import { parsePichiToken, type PichiTokenInfo } from '@/lib/pichi';

const REFRESH_MS = 30_000;

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`Blockscout ${res.status}`);
  return res.json();
}

/** $PICHI supply, holders and transfers from the Blockscout API (CORS-enabled, read-only). */
export function usePichiToken() {
  const address = appConfig.pichi.token;
  return useQuery<PichiTokenInfo>({
    queryKey: ['pichi-token', address],
    enabled: Boolean(address),
    refetchInterval: REFRESH_MS,
    retry: 1,
    queryFn: async () => {
      const base = `${appConfig.explorerUrl}/api/v2/tokens/${address}`;
      const [token, counters] = await Promise.all([fetchJson(base), fetchJson(`${base}/counters`).catch(() => undefined)]);
      const info = parsePichiToken(token, counters);
      if (!info) throw new Error('Unexpected token data from Blockscout');
      return info;
    },
  });
}
