'use client';

import { useState } from 'react';
import { useBalance, useConnection } from 'wagmi';
import { appConfig } from '@/lib/config';
import ui from './ui.module.css';

/** Below this balance (0.0001 ETH) the wallet cannot pay for approve + deposit. */
const LOW_GAS_WEI = 100_000_000_000_000n;

/** Offers a one-time test-gas top-up from the agent when the connected wallet is (nearly) empty. */
export function GasDrip() {
  const { address, isConnected } = useConnection();
  const balance = useBalance({ address, query: { enabled: Boolean(address), refetchInterval: 10_000 } });
  const [state, setState] = useState<{ busy: boolean; message?: string; error?: string; tx?: string }>({ busy: false });

  if (!isConnected || !address || balance.data === undefined || balance.data.value >= LOW_GAS_WEI) return null;

  async function request() {
    setState({ busy: true });
    try {
      const res = await fetch(`${appConfig.agentApiUrl}/drip`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ address }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: unknown; explorerUrl?: unknown };
      if (!res.ok) throw new Error(typeof body.error === 'string' ? body.error : `Request failed (${res.status})`);
      setState({ busy: false, message: 'Test gas sent.', tx: typeof body.explorerUrl === 'string' ? body.explorerUrl : undefined });
      void balance.refetch();
    } catch (err) {
      setState({ busy: false, error: err instanceof Error ? err.message : 'Request failed' });
    }
  }

  return (
    <div className={ui.notice} role="status">
      <p style={{ margin: '0 0 var(--space-2)' }}>Your wallet has no test ETH for gas.</p>
      <button type="button" className={`${ui.button} ${ui.ghost}`} disabled={state.busy} onClick={() => void request()}>
        {state.busy ? 'Sending…' : 'Get test gas'}
      </button>{' '}
      <a href="https://faucet.testnet.chain.robinhood.com/" target="_blank" rel="noopener noreferrer">
        or use the official faucet ↗
      </a>
      {state.message && (
        <p style={{ margin: 'var(--space-2) 0 0' }}>
          {state.message}{' '}
          {state.tx && (
            <a href={state.tx} target="_blank" rel="noopener noreferrer">
              View tx ↗
            </a>
          )}
        </p>
      )}
      {state.error && <p className={ui.error}>{state.error}</p>}
    </div>
  );
}
