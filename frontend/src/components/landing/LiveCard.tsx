'use client';

import Link from 'next/link';
import { useVaultData } from '@/hooks/useVaultData';
import { REGIME_LABEL, type Regime } from '@/lib/agent';
import { formatUsd, pipsToPercent, share, wadToPercent } from '@/lib/format';
import l from './landing.module.css';

const REGIME_COLOR: Record<Regime, string> = {
  0: 'var(--regime-on)',
  1: 'var(--regime-volatile)',
  2: 'var(--regime-off)',
};

/** Live proof next to the headline: read straight from the vault on Robinhood Chain testnet. */
export function LiveCard() {
  const vault = useVaultData();
  const state = vault.agentState;
  const regime = state && state[3] > 0n ? (state[0] as Regime) : undefined;
  const [idle, morpho, uniswap] = vault.allocation ?? [0n, 0n, 0n];
  const total = idle + morpho + uniswap;
  const accent = regime === undefined ? 'var(--rule-strong)' : REGIME_COLOR[regime];

  return (
    <aside className={l.live} style={{ borderTopColor: accent }} aria-label="Live vault on Robinhood Chain testnet">
      <div className={l.liveHead}>
        <span className="eyebrow">
          <span className={l.liveDot} aria-hidden />
          Live vault · Robinhood testnet
        </span>
        <Link href="/app" className="eyebrow">
          Open ↗
        </Link>
      </div>
      <div className="eyebrow">Net asset value</div>
      <div className={l.liveNav}>{formatUsd(vault.totalAssets)}</div>
      <div className={l.liveBar} aria-hidden>
        <i style={{ flexGrow: share(morpho, total), background: 'var(--leg-morpho)' }} />
        <i style={{ flexGrow: share(uniswap, total), background: 'var(--leg-uniswap)' }} />
        <i style={{ flexGrow: share(idle, total), background: 'var(--leg-idle)' }} />
      </div>
      <div className={l.liveGrid}>
        <div>
          <span className="eyebrow">Agent regime</span>
          <span style={{ color: accent }}>{regime === undefined ? '—' : REGIME_LABEL[regime]}</span>
        </div>
        <div>
          <span className="eyebrow">Hook swap fee</span>
          <span>{pipsToPercent(vault.feePips)}</span>
        </div>
        <div>
          <span className="eyebrow">Morpho supply APR</span>
          <span>{wadToPercent(vault.supplyApr)}</span>
        </div>
        <div>
          <span className="eyebrow">Signer</span>
          <span>Amadeus BLS</span>
        </div>
      </div>
      <div className={l.verified}>✓ Every rebalance BLS12-381-verified on-chain before funds move</div>
    </aside>
  );
}
