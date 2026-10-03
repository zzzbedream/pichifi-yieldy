/**
 * Deterministic market snapshots the policy consumes. In the MVP these are curated
 * scenarios (clearly labelled "simulated" in the UI); in production they are replaced by
 * live feeds (Chainlink stock feeds, implied-vol and macro indicators) with the same shape.
 *
 * All numbers are integers: prices in 1e-8 USD, rates/vols in basis points.
 */
export interface MarketInputs {
  /** Snapshot identifier (part of the signed inputs hash). */
  scenario: ScenarioId;
  /** Snapshot timestamp, from the data source — never the wall clock. */
  asOf: string;
  symbol: string;
  spotE8: number;
  /** 20-day annualised realised volatility. */
  realizedVolBps: number;
  /** At-the-money implied volatility. */
  impliedVolBps: number;
  /** Trading days to the next earnings release (-1 = none scheduled). */
  earningsInDays: number;
  /** 20-day price momentum. */
  momentumBps: number;
  /** Model-implied 6-month recession probability. */
  recessionProbBps: number;
}

export type ScenarioId = 'calm' | 'earnings_volatility' | 'recession';

export const SCENARIOS: Readonly<Record<ScenarioId, MarketInputs>> = Object.freeze({
  calm: {
    scenario: 'calm',
    asOf: '2026-10-02T20:00:00Z',
    symbol: 'NVDA',
    spotE8: 180_00000000,
    realizedVolBps: 2_800,
    impliedVolBps: 3_100,
    earningsInDays: 34,
    momentumBps: 650,
    recessionProbBps: 1_500,
  },
  earnings_volatility: {
    scenario: 'earnings_volatility',
    asOf: '2026-10-02T20:00:00Z',
    symbol: 'NVDA',
    spotE8: 182_50000000,
    realizedVolBps: 4_200,
    impliedVolBps: 6_800,
    earningsInDays: 1,
    momentumBps: 300,
    recessionProbBps: 1_800,
  },
  recession: {
    scenario: 'recession',
    asOf: '2026-10-02T20:00:00Z',
    symbol: 'NVDA',
    spotE8: 151_20000000,
    realizedVolBps: 6_100,
    impliedVolBps: 7_400,
    earningsInDays: 34,
    momentumBps: -1_900,
    recessionProbBps: 5_200,
  },
});

export const SCENARIO_IDS = Object.keys(SCENARIOS) as ScenarioId[];

export function isScenarioId(value: unknown): value is ScenarioId {
  return typeof value === 'string' && (SCENARIO_IDS as string[]).includes(value);
}
