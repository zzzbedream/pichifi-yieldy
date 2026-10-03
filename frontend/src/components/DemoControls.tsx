'use client';

import { useState } from 'react';
import { postScenario, SCENARIO_LABEL, type AgentState, type ScenarioId } from '@/lib/agent';
import { bpsToPercent } from '@/lib/format';
import ui from './ui.module.css';

const TOKEN_KEY = 'ayv-demo-token';

function readToken(): string {
  try {
    return sessionStorage.getItem(TOKEN_KEY) ?? '';
  } catch {
    return '';
  }
}

type DemoControlsProps = { state?: AgentState; onChanged: () => void };

/** Market inputs the agent currently sees (simulated scenarios) + presenter controls. */
export function DemoControls({ state, onChanged }: DemoControlsProps) {
  const [token, setToken] = useState(readToken);
  const [busy, setBusy] = useState<ScenarioId | null>(null);
  const [error, setError] = useState<string | null>(null);
  const active = state?.scenario;
  const inputs = state?.scenarios.find((s) => s.scenario === active);

  async function choose(scenario: ScenarioId) {
    setBusy(scenario);
    setError(null);
    try {
      sessionStorage.setItem(TOKEN_KEY, token);
    } catch {
      // storage unavailable (private mode) — token stays in memory only
    }
    try {
      await postScenario(scenario, token);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Scenario switch failed');
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className={ui.panel} aria-labelledby="market-heading">
      <h2 id="market-heading">Market inputs</h2>
      {inputs ? (
        <div className={ui.rows}>
          <div className={ui.row}>
            <span>{inputs.symbol} spot</span>
            <span className="mono">${(inputs.spotE8 / 1e8).toFixed(2)}</span>
          </div>
          <div className={ui.row}>
            <span>Implied / realized vol</span>
            <span className="mono">
              {bpsToPercent(inputs.impliedVolBps)} / {bpsToPercent(inputs.realizedVolBps)}
            </span>
          </div>
          <div className={ui.row}>
            <span>Earnings in</span>
            <span className="mono">{inputs.earningsInDays < 0 ? '—' : `${inputs.earningsInDays} days`}</span>
          </div>
          <div className={ui.row}>
            <span>20d momentum</span>
            <span className="mono">{bpsToPercent(inputs.momentumBps, 1)}</span>
          </div>
          <div className={ui.row}>
            <span>Recession probability</span>
            <span className="mono">{bpsToPercent(inputs.recessionProbBps)}</span>
          </div>
        </div>
      ) : (
        <p className={ui.notice}>Waiting for the agent…</p>
      )}
      <p className={ui.notice}>Simulated scenario feed (testnet). Production swaps in Chainlink stock feeds and macro data.</p>

      <div className={ui.field} style={{ marginTop: 'var(--space-4)' }}>
        <label className="eyebrow" htmlFor="demo-token">
          Presenter token
        </label>
        <div className={ui.inputRow}>
          <input id="demo-token" type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="DEMO_API_TOKEN" />
        </div>
      </div>
      <div className={ui.scenarios}>
        {(Object.keys(SCENARIO_LABEL) as ScenarioId[]).map((id) => (
          <button
            key={id}
            type="button"
            className={`${ui.button} ${ui.scenario} ${id === active ? '' : ui.ghost}`}
            disabled={busy !== null || !token}
            onClick={() => void choose(id)}
          >
            <span>{SCENARIO_LABEL[id]}</span>
            <span className="mono">{busy === id ? '…' : id === active ? 'active' : 'inject'}</span>
          </button>
        ))}
      </div>
      {error && <p className={ui.error}>{error}</p>}
    </section>
  );
}
