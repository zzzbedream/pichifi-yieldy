'use client';

import Link from 'next/link';
import { useState } from 'react';
import { appConfig, robinhoodTestnet } from '@/lib/config';
import { FAUCET_URL } from './content';
import l from './landing.module.css';

type Eip1193 = { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> };

/** Three-step onboarding: add the network, get test ETH, open the app. */
export function TryIt() {
  const [status, setStatus] = useState<string | null>(null);

  async function addNetwork() {
    const ethereum = (window as unknown as { ethereum?: Eip1193 }).ethereum;
    if (!ethereum) {
      setStatus('No browser wallet found. Install MetaMask or Rabby first.');
      return;
    }
    try {
      await ethereum.request({
        method: 'wallet_addEthereumChain',
        params: [
          {
            chainId: `0x${robinhoodTestnet.id.toString(16)}`,
            chainName: robinhoodTestnet.name,
            nativeCurrency: robinhoodTestnet.nativeCurrency,
            rpcUrls: [appConfig.rpcUrl],
            blockExplorerUrls: [appConfig.explorerUrl],
          },
        ],
      });
      setStatus('Robinhood Chain testnet added to your wallet.');
    } catch (err) {
      setStatus(err instanceof Error ? err.message : 'The wallet rejected the request.');
    }
  }

  return (
    <ol className={`${l.steps} ${l.steps3}`} style={{ listStyle: 'none', margin: 0, padding: 0 }}>
      <li className={l.step}>
        <span className={l.stepN}>STEP 1</span>
        <h3>Add the network</h3>
        <p>Robinhood Chain testnet, chain id 46630.</p>
        <button type="button" className={l.ctaGhost} style={{ marginTop: 'var(--space-3)' }} onClick={() => void addNetwork()}>
          Add to wallet
        </button>
        {status && <p className={l.source} role="status">{status}</p>}
      </li>
      <li className={l.step}>
        <span className={l.stepN}>STEP 2</span>
        <h3>Get test ETH for gas</h3>
        <p>Free from the official Robinhood Chain faucet.</p>
        <a className={l.ctaGhost} style={{ marginTop: 'var(--space-3)' }} href={FAUCET_URL} target="_blank" rel="noopener noreferrer">
          Open faucet ↗
        </a>
      </li>
      <li className={l.step}>
        <span className={l.stepN}>STEP 3</span>
        <h3>Deposit test USDG</h3>
        <p>Connect, press “Get test USDG”, deposit, and watch the agent allocate it.</p>
        <Link className={l.cta} style={{ marginTop: 'var(--space-3)' }} href="/app#position">
          Open the app →
        </Link>
      </li>
    </ol>
  );
}
