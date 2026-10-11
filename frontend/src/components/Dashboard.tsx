'use client';

import { useAgentFeed } from '@/hooks/useAgentFeed';
import { useVaultData } from '@/hooks/useVaultData';
import { appConfig, isConfigured } from '@/lib/config';
import type { Regime } from '@/lib/agent';
import { Header } from './Header';
import { NavHero } from './NavHero';
import { AllocationBar } from './AllocationBar';
import { DecisionFeed } from './DecisionFeed';
import { PositionPanel } from './PositionPanel';
import { DemoControls } from './DemoControls';
import { Footer } from './Footer';
import { PichiPanel } from './PichiPanel';
import { SectionNav } from './SectionNav';
import ui from './ui.module.css';

export function Dashboard() {
  const vault = useVaultData();
  const agent = useAgentFeed();
  const agentState = vault.agentState;
  const hasRebalanced = agentState !== undefined && agentState[3] > 0n;
  const regime = hasRebalanced ? (agentState[0] as Regime) : undefined;
  const latest = agent.decisions.find((d) => d.status === 'executed');

  return (
    <div className={ui.page}>
      <Header isStreaming={agent.streaming} />
      {!isConfigured && (
        <p className={ui.error}>
          Contract addresses are not configured. Run <code>node scripts/sync-frontend-env.mjs</code> after deploying.
        </p>
      )}
      <SectionNav />
      <div id="overview" className={ui.anchor}>
      <NavHero
        totalAssets={vault.totalAssets}
        sharePrice={vault.sharePrice}
        regime={regime}
        feePips={vault.feePips}
        supplyApr={vault.supplyApr}
        paused={vault.paused}
        latest={latest}
      />
      </div>
      <div id="allocation" className={ui.anchor}>
      <AllocationBar
        allocation={vault.allocation}
        targetMorphoBps={hasRebalanced ? agentState[1] : undefined}
        targetUniswapBps={hasRebalanced ? agentState[2] : undefined}
        feePips={vault.feePips}
      />
      </div>
      <div className={ui.main}>
        <div id="decisions" className={ui.anchor}>
        <DecisionFeed decisions={agent.decisions} isAgentReachable={!agent.error} />
        </div>
        <div className={ui.side}>
          <div id="position" className={ui.anchor}><PositionPanel sharePrice={vault.sharePrice} /></div>
          <div id="pichi" className={ui.anchor}><PichiPanel /></div>
          <div id="market" className={ui.anchor}>{appConfig.demoMode && <DemoControls state={agent.state} onChanged={() => void agent.refetchState()} />}</div>
        </div>
      </div>
      <div id="contracts" className={ui.anchor}><Footer agentIdentity={agent.state?.signer.identity} /></div>
    </div>
  );
}
