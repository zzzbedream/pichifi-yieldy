import { REASON_LABEL, REGIME_KEY, REGIME_LABEL, SCENARIO_LABEL, type DecisionRecord } from '@/lib/agent';
import { bpsToPercent, relativeTime, shortHex } from '@/lib/format';
import ui from './ui.module.css';

type DecisionFeedProps = { decisions: readonly DecisionRecord[]; isAgentReachable: boolean };

export function DecisionFeed({ decisions, isAgentReachable }: DecisionFeedProps) {
  return (
    <section aria-labelledby="feed-heading">
      <div className={ui.sectionHead}>
        <h2 id="feed-heading">Agent decisions</h2>
        <span className="eyebrow">Signed intents · newest first</span>
      </div>
      {decisions.length === 0 ? (
        <p className={ui.empty}>
          {isAgentReachable
            ? 'No intents yet. Deposit USDG and the agent will allocate it within seconds.'
            : 'The agent API is not reachable. On-chain state above is still live.'}
        </p>
      ) : (
        <ol className={ui.feed}>
          {decisions.map((d) => (
            <DecisionItem key={d.id} record={d} />
          ))}
        </ol>
      )}
    </section>
  );
}

function StatusBadge({ record }: { record: DecisionRecord }) {
  if (record.status === 'executed') {
    const scheme = record.signer.scheme === 'bls' ? 'BLS12-381 (Amadeus)' : 'ECDSA';
    return <span className={`${ui.badge} ${ui.badgeOk}`}>✓ {scheme} verified on-chain</span>;
  }
  if (record.status === 'failed') return <span className={`${ui.badge} ${ui.badgeBad}`}>✕ rejected · {record.error ?? 'reverted'}</span>;
  return <span className={`${ui.badge} ${ui.badgeWarn}`}>● signed · relaying</span>;
}

function DecisionItem({ record }: { record: DecisionRecord }) {
  const { decision, intent } = record;
  const regimeClass = ui[`regime_${REGIME_KEY[decision.regime]}`];
  const reasons = decision.reasons.map((r) => REASON_LABEL[r] ?? r).join(' · ');
  return (
    <li className={`${ui.decision} ${regimeClass}`}>
      <div className={ui.decisionRail} aria-hidden />
      <div>
        <div className={ui.decisionTop}>
          <span className={ui.decisionTitle}>
            {REGIME_LABEL[decision.regime]} — {SCENARIO_LABEL[record.scenario]}
          </span>
          <span className="eyebrow">
            Intent #{intent.nonce} · {relativeTime(record.createdAt)}
          </span>
        </div>
        <div className={ui.legNote}>{reasons}</div>
        <div className={ui.decisionGrid}>
          <div className={ui.kv}>
            <span className="eyebrow">Morpho</span>
            <span className="mono">{bpsToPercent(decision.morphoBps)}</span>
          </div>
          <div className={ui.kv}>
            <span className="eyebrow">Uniswap LP</span>
            <span className="mono">{bpsToPercent(decision.uniswapBps)}</span>
          </div>
          <div className={ui.kv}>
            <span className="eyebrow">Vol → fee engine</span>
            <span className="mono">{bpsToPercent(decision.volBps)}</span>
          </div>
          <div className={ui.kv}>
            <span className="eyebrow">Inputs hash</span>
            <span className="mono" title={decision.inputsHash}>
              {shortHex(decision.inputsHash)}
            </span>
          </div>
        </div>
        <div className={ui.proof}>
          <StatusBadge record={record} />
          <span className={ui.badge} title={intent.digest}>
            digest {shortHex(intent.digest)}
          </span>
          <span className={ui.badge} title={record.signer.identity}>
            signer {shortHex(record.signer.identity, 8, 6)}
          </span>
          {record.chain && (
            <a className={ui.badge} href={record.chain.explorerUrl} target="_blank" rel="noopener noreferrer">
              Blockscout tx ↗
            </a>
          )}
          {record.amadeus && (
            <a className={ui.badge} href={record.amadeus.explorerUrl} target="_blank" rel="noopener noreferrer">
              Amadeus anchor ↗
            </a>
          )}
        </div>
      </div>
    </li>
  );
}
