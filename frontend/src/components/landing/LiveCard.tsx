'use client';

import Link from 'next/link';
import { useVaultData } from '@/hooks/useVaultData';
import { REGIME_LABEL, type Regime } from '@/lib/agent';
import { pipsToPercent, share, toUnits, USDG_DECIMALS, wadToPercent } from '@/lib/format';
import { AnimatedCounter } from './AnimatedCounter';
import l from './landing.module.css';

const REGIME_COLOR: Record<Regime, string> = {
  0: 'var(--bio-emerald)',
  1: 'var(--vault-gold)',
  2: 'var(--morpho-cyan)',
};

/** Live proof next to the headline: read straight from the vault on Robinhood Chain testnet. */
export function LiveCard() {
  const vault = useVaultData();
  const state = vault.agentState;
  const regime = state && state[3] > 0n ? (state[0] as Regime) : undefined;
  const [idle, morpho, uniswap] = vault.allocation ?? [0n, 0n, 0n];
  const total = idle + morpho + uniswap;
  const accent = regime === undefined ? 'var(--rule-gold)' : REGIME_COLOR[regime];
  const assetNumber = vault.totalAssets ? toUnits(vault.totalAssets, USDG_DECIMALS) : 0;

  return (
    <aside className={l.live} style={{ borderTopColor: accent }} aria-label="Live vault on Robinhood Chain testnet">
      <div className={l.liveHead}>
        <span className="eyebrow">
          <span className={l.liveDot} style={{ background: accent }} aria-hidden />
          Live USDG Vault · Robinhood Testnet
        </span>
        <Link href="/app" className={l.liveLink}>
          Open App ↗
        </Link>
      </div>

      <div className={l.liveNavBlock}>
        <span className="eyebrow">Net Asset Value (USDG)</span>
        <div className={l.liveNav}>
          {vault.totalAssets ? (
            <AnimatedCounter value={assetNumber} prefix="$" decimals={2} duration={1600} />
          ) : (
            <span className="mono">—</span>
          )}
        </div>
      </div>

      <div className={l.liveAllocationHead}>
        <span className="eyebrow">Dynamic Liquidity Allocation</span>
      </div>

      <div className={l.liveBar} aria-hidden>
        <i
          style={{ flexGrow: share(morpho, total) || 1, background: 'var(--leg-morpho)' }}
          title="Morpho Blue Lending"
        />
        <i
          style={{ flexGrow: share(uniswap, total) || 1, background: 'var(--leg-uniswap)' }}
          title="Uniswap v4 Hook LP"
        />
        <i
          style={{ flexGrow: share(idle, total) || 1, background: 'var(--leg-idle)' }}
          title="Protected Idle Buffer"
        />
      </div>

      <div className={l.allocationLegend}>
        <span className={l.legendItem}>
          <span className={l.legendDot} style={{ background: 'var(--leg-morpho)' }} />
          Morpho Blue
        </span>
        <span className={l.legendItem}>
          <span className={l.legendDot} style={{ background: 'var(--leg-uniswap)' }} />
          Uniswap v4
        </span>
        <span className={l.legendItem}>
          <span className={l.legendDot} style={{ background: 'var(--leg-idle)' }} />
          Idle Buffer
        </span>
      </div>

      <div className={l.liveGrid}>
        <div className={l.gridCell}>
          <span className="eyebrow">Agent Regime</span>
          <span className={l.cellValue} style={{ color: accent }}>
            {regime === undefined ? 'LIVE (IDLE)' : REGIME_LABEL[regime]}
          </span>
        </div>
        <div className={l.gridCell}>
          <span className="eyebrow">Hook Swap Fee</span>
          <span className={l.cellValue}>{pipsToPercent(vault.feePips)}</span>
        </div>
        <div className={l.gridCell}>
          <span className="eyebrow">Morpho Supply APR</span>
          <span className={l.cellValue}>{wadToPercent(vault.supplyApr)}</span>
        </div>
        <div className={l.gridCell}>
          <span className="eyebrow">Signer Key</span>
          <span className={l.cellValue}>Amadeus BLS12</span>
        </div>
      </div>

      <div className={l.verified}>
        <span className={l.checkIcon}>✓</span>
        <span>Every rebalance BLS-verified on-chain before funds move</span>
      </div>
    </aside>
  );
}
