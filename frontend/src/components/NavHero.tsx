import { REASON_LABEL, REGIME_KEY, REGIME_LABEL, type DecisionRecord, type Regime } from '@/lib/agent';
import { formatUsd, pipsToPercent, wadToPercent } from '@/lib/format';
import ui from './ui.module.css';

type NavHeroProps = {
  totalAssets?: bigint;
  sharePrice?: bigint;
  regime?: Regime;
  feePips?: number;
  supplyApr?: bigint;
  paused?: boolean;
  latest?: DecisionRecord;
};

export function NavHero({ totalAssets, sharePrice, regime, feePips, supplyApr, paused, latest }: NavHeroProps) {
  const regimeClass = regime === undefined ? '' : ui[`regime_${REGIME_KEY[regime]}`];
  const reasons = latest?.decision.reasons ?? [];
  return (
    <section className={ui.hero} aria-labelledby="nav-heading">
      <div>
        <div className="eyebrow" id="nav-heading">
          Net asset value
        </div>
        <div className={ui.heroFigure}>{formatUsd(totalAssets)}</div>
        <div className={ui.heroStats}>
          <div className={ui.stat}>
            <div className="eyebrow">Share price</div>
            <div className={ui.statValue}>{sharePrice === undefined ? '—' : formatUsd(sharePrice, 6, 4)}</div>
          </div>
          <div className={ui.stat}>
            <div className="eyebrow">Hook swap fee</div>
            <div className={ui.statValue}>{pipsToPercent(feePips)}</div>
          </div>
          <div className={ui.stat}>
            <div className="eyebrow">Morpho supply APR</div>
            <div className={ui.statValue}>{wadToPercent(supplyApr)}</div>
          </div>
        </div>
      </div>
      <div className={`${ui.regimeCard} ${regimeClass}`} aria-live="polite">
        <div>
          <div className="eyebrow">Agent regime{paused ? ' · vault paused' : ''}</div>
          <div className={ui.regimeName}>{regime === undefined ? 'Awaiting first intent' : REGIME_LABEL[regime]}</div>
          <ul className={ui.reasonList}>
            {reasons.map((reason) => (
              <li key={reason}>{REASON_LABEL[reason] ?? reason}</li>
            ))}
          </ul>
        </div>
        <p className={ui.notice}>
          Decided by a deterministic policy, signed with the agent&apos;s Amadeus BLS12-381 key and verified on-chain
          before any funds move.
        </p>
      </div>
    </section>
  );
}
