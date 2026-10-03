/** Types and calls for the agent API (agent/src/api/server.ts). */
import { appConfig } from './config';

export type Regime = 0 | 1 | 2;
export type ScenarioId = 'calm' | 'earnings_volatility' | 'recession';

export interface MarketInputs {
  scenario: ScenarioId;
  asOf: string;
  symbol: string;
  spotE8: number;
  realizedVolBps: number;
  impliedVolBps: number;
  earningsInDays: number;
  momentumBps: number;
  recessionProbBps: number;
}

export interface DecisionRecord {
  id: string;
  createdAt: string;
  trigger: string;
  scenario: ScenarioId;
  inputs: MarketInputs;
  decision: {
    regime: Regime;
    morphoBps: number;
    uniswapBps: number;
    volBps: number;
    reasons: string[];
    inputsHash: string;
    modelVersion: string;
  };
  intent: { nonce: string; deadline: string; digest: string };
  signer: { scheme: 'bls' | 'ecdsa'; identity: string; proof: string };
  amadeus: { txHash: string; explorerUrl: string } | null;
  chain: { txHash: string; blockNumber: string; status: string; explorerUrl: string } | null;
  status: 'signed' | 'executed' | 'failed';
  error?: string;
}

export interface AgentState {
  signer: { scheme: 'bls' | 'ecdsa'; identity: string };
  scenario: ScenarioId;
  scenarios: MarketInputs[];
  vault: string;
  chainId: number;
  latest: DecisionRecord | null;
}

export const REGIME_LABEL: Record<Regime, string> = { 0: 'Risk on', 1: 'Volatile', 2: 'Risk off' };
export const REGIME_KEY: Record<Regime, 'on' | 'volatile' | 'off'> = { 0: 'on', 1: 'volatile', 2: 'off' };

export const SCENARIO_LABEL: Record<ScenarioId, string> = {
  calm: 'Calm market',
  earnings_volatility: 'Earnings week',
  recession: 'Recession signal',
};

export const REASON_LABEL: Record<string, string> = {
  RECESSION_PROBABILITY_HIGH: 'Recession probability above 40%',
  PRICE_CRASH_MOMENTUM: '20-day momentum below −15%',
  EARNINGS_WINDOW: 'Earnings release within 2 days',
  IMPLIED_VOL_ELEVATED: 'Implied volatility above 60%',
  REALIZED_VOL_ELEVATED: 'Realized volatility above 50%',
  CALM_MARKET: 'No risk triggers — provide liquidity',
};

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${appConfig.agentApiUrl}${path}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`Agent API ${path} failed (${res.status})`);
  return (await res.json()) as T;
}

export const fetchAgentState = () => getJson<AgentState>('/state');
export const fetchDecisions = () => getJson<{ decisions: DecisionRecord[] }>('/decisions');

export async function postScenario(scenario: ScenarioId, token: string): Promise<void> {
  const res = await fetch(`${appConfig.agentApiUrl}/scenario`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ scenario }),
  });
  if (res.status === 401) throw new Error('Demo token rejected');
  if (!res.ok) throw new Error(`Scenario switch failed (${res.status})`);
}

/** Pure reducer: newest first, records replaced by id (no in-place mutation). */
export function mergeDecision(list: readonly DecisionRecord[], record: DecisionRecord): DecisionRecord[] {
  return [record, ...list.filter((r) => r.id !== record.id)].slice(0, 50);
}
