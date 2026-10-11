'use client';

import { useEffect, useRef, useState } from 'react';
import { postScenario, ScenarioBusyError, SCENARIO_LABEL, type AgentState, type MarketInputs, type ScenarioId } from '@/lib/agent';
import { bpsToPercent } from '@/lib/format';
import ui from './ui.module.css';

type DemoControlsProps = { state?: AgentState; onChanged: () => void };
type Queued = { scenario: ScenarioId; runsAt: number };

/** Wall clock for the countdown (event handlers only, never during render). */
const clock = (): number => Date.now();

/** Market inputs the agent sees (live or stress test) + one-click stress tests for anyone. */
export function DemoControls({ state, onChanged }: DemoControlsProps) {
  const [busy, setBusy] = useState<ScenarioId | null>(null);
  const [queued, setQueued] = useState<Queued | null>(null);
  const [now, setNow] = useState(clock);
  const [error, setError] = useState<string | null>(null);
  const [revertsAt, setRevertsAt] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const active = state?.scenario;
  const inputs = state?.inputs ?? state?.scenarios.find((s) => s.scenario === active);
  const isLive = active === 'live';

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  // Ticks the countdown while a click is queued.
  useEffect(() => {
    if (!queued) return;
    const id = setInterval(() => setNow(clock()), 1000);
    return () => clearInterval(id);
  }, [queued]);

  async function choose(scenario: ScenarioId) {
    if (timer.current) clearTimeout(timer.current);
    setQueued(null);
    setBusy(scenario);
    setError(null);
    try {
      const result = await postScenario(scenario);
      setRevertsAt(result.revertsAt);
      onChanged();
    } catch (err) {
      if (err instanceof ScenarioBusyError) {
        // Someone else just ran a stress test: queue this click and run it as soon as allowed.
        const waitMs = err.retryAfterSeconds * 1000 + 500;
        const start = clock();
        setQueued({ scenario, runsAt: start + waitMs });
        setNow(start);
        timer.current = setTimeout(() => void choose(scenario), waitMs);
      } else {
        setError(err instanceof Error ? err.message : 'Scenario switch failed');
      }
    } finally {
      setBusy(null);
    }
  }

  const secondsLeft = queued ? Math.max(0, Math.ceil((queued.runsAt - now) / 1000)) : 0;

  return (
    <section className={ui.panel} aria-labelledby="market-heading">
      <h2 id="market-heading">Market inputs</h2>
      <InputsTable inputs={inputs} />
      {isLive ? (
        <p className={ui.notice}>
          Live inputs{inputs ? ` (as of ${inputs.asOf.slice(0, 10)})` : ''}: Yahoo Finance daily closes, Finnhub earnings calendar, FRED
          recession probability. Implied vol uses realized vol as a proxy.
        </p>
      ) : (
        <p className={ui.notice}>Stress-test scenario (simulated inputs). The vault returns to live market inputs automatically.</p>
      )}

      <p className="eyebrow" style={{ marginTop: 'var(--space-4)' }}>
        Stress-test the agent — one click, no sign-up
      </p>
      <p className={ui.notice}>
        Each click triggers a real, BLS-verified rebalance on Robinhood testnet (about 30 s apart, an on-chain rule).
      </p>
      <div className={ui.scenarios}>
        {(Object.keys(SCENARIO_LABEL) as ScenarioId[]).map((id) => {
          const isQueued = queued?.scenario === id;
          const tag = busy === id ? '…' : isQueued ? `in ${secondsLeft}s` : id === active ? 'active' : id === 'live' ? 'return' : 'stress test';
          return (
            <button
              key={id}
              type="button"
              className={`${ui.button} ${ui.scenario} ${id === active ? '' : ui.ghost}`}
              disabled={busy !== null || id === active || isQueued}
              onClick={() => void choose(id)}
            >
              <span>{SCENARIO_LABEL[id]}</span>
              <span className="mono">{tag}</span>
            </button>
          );
        })}
      </div>
      {queued && (
        <p className={ui.notice} role="status">
          Queued: {SCENARIO_LABEL[queued.scenario]} runs automatically in {secondsLeft}s.
        </p>
      )}
      {revertsAt && active !== 'live' && !queued && (
        <p className={ui.notice} role="status">
          Back to live market inputs at {new Date(revertsAt).toLocaleTimeString()}.
        </p>
      )}
      {error && <p className={ui.error}>{error}</p>}
    </section>
  );
}

function InputsTable({ inputs }: { inputs?: MarketInputs | null }) {
  if (!inputs) return <p className={ui.notice}>Waiting for the agent…</p>;
  return (
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
  );
}
