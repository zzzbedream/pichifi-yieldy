import { bpsToPercent, formatUsd, share } from '@/lib/format';
import ui from './ui.module.css';

type AllocationBarProps = {
  allocation?: readonly [bigint, bigint, bigint];
  targetMorphoBps?: number;
  targetUniswapBps?: number;
  feePips?: number;
};

/** Stacked bar animated with transforms only (translateX + scaleX). */
export function AllocationBar({ allocation, targetMorphoBps, targetUniswapBps, feePips }: AllocationBarProps) {
  const [idle, morpho, uniswap] = allocation ?? [0n, 0n, 0n];
  const total = idle + morpho + uniswap;
  const fMorpho = share(morpho, total);
  const fUniswap = share(uniswap, total);
  const fIdle = Math.max(0, 1 - fMorpho - fUniswap);

  return (
    <section className={ui.allocation} aria-labelledby="alloc-heading">
      <div className={ui.sectionHead} style={{ borderBottom: 0, marginBottom: 0, paddingBottom: 0 }}>
        <h2 id="alloc-heading">Where the USDG is</h2>
        <span className="eyebrow">
          Target {bpsToPercent(targetMorphoBps)} Morpho · {bpsToPercent(targetUniswapBps)} Uniswap
        </span>
      </div>
      <div
        className={ui.bar}
        role="img"
        aria-label={`Morpho ${Math.round(fMorpho * 100)}%, Uniswap ${Math.round(fUniswap * 100)}%, idle ${Math.round(fIdle * 100)}%`}
      >
        <div className={`${ui.segment} ${ui.segMorpho}`} style={{ transform: `scaleX(${fMorpho})` }} />
        <div className={`${ui.segment} ${ui.segUniswap}`} style={{ transform: `translateX(${fMorpho * 100}%) scaleX(${fUniswap})` }} />
        <div className={`${ui.segment} ${ui.segIdle}`} style={{ transform: `translateX(${(fMorpho + fUniswap) * 100}%) scaleX(${fIdle})` }} />
      </div>
      <div className={ui.legs}>
        <Leg color="var(--leg-morpho)" name="Morpho Blue · safe harbour" value={morpho} fraction={fMorpho} note="Isolated USDG lending market — yield paid by borrowers." />
        <Leg
          color="var(--leg-uniswap)"
          name="Uniswap v4 · rhNVDA/USDG LP"
          value={uniswap}
          fraction={fUniswap}
          note={`Dynamic-fee hook charging ${feePips === undefined ? '—' : `${(feePips / 10_000).toFixed(2)}%`} per swap.`}
        />
        <Leg color="var(--leg-idle)" name="Idle buffer" value={idle} fraction={fIdle} note="Instant redemptions; redeployed on the next intent." />
      </div>
    </section>
  );
}

type LegProps = { color: string; name: string; value: bigint; fraction: number; note: string };

function Leg({ color, name, value, fraction, note }: LegProps) {
  return (
    <div className={ui.leg}>
      <div className={ui.legName}>
        <span className={ui.swatch} style={{ ['--swatch' as string]: color }} aria-hidden />
        {name}
      </div>
      <div className={ui.legValue}>
        {formatUsd(value)} <span className="eyebrow">{(fraction * 100).toFixed(1)}%</span>
      </div>
      <div className={ui.legNote}>{note}</div>
    </div>
  );
}
