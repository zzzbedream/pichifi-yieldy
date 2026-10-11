/**
 * Live market inputs for the policy. Network fetches happen here, outside the policy: each
 * refresh produces one immutable snapshot (stamped with the data source's own time), and the
 * pure, deterministic policy only ever sees snapshots — so every decision stays replayable.
 *
 * Sources: Yahoo Finance daily closes (spot, 20d momentum, 20d realized vol), Finnhub earnings
 * calendar, FRED RECPROUSM156N (smoothed US recession probability). There is no free implied-vol
 * feed, so implied vol uses realized vol as a proxy (stated in the UI).
 */
import type { Logger } from '../log.js';
import type { MarketInputs } from './scenarios.js';

const LOOKBACK = 20;
const TRADING_DAYS_PER_YEAR = 252;
const FETCH_TIMEOUT_MS = 15_000;

export interface LiveSources {
  /** Daily closes, oldest first, and the time (unix s) of the last close. */
  closes: number[];
  lastCloseTime: number;
  /** Next earnings date (YYYY-MM-DD), or undefined if none scheduled. */
  earningsDate?: string;
  /** Latest recession probability in percent (FRED units). */
  recessionPct: number;
}

/** Weekdays strictly after `from` up to and including `to` (both YYYY-MM-DD, UTC). */
export function tradingDaysBetween(from: string, to: string): number {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (!(end > start)) return 0;
  let days = 0;
  for (let t = start + 86_400_000; t <= end; t += 86_400_000) {
    const wd = new Date(t).getUTCDay();
    if (wd !== 0 && wd !== 6) days += 1;
  }
  return days;
}

/** Pure: turns raw source data into integer policy inputs. Throws on unusable data. */
export function computeLiveInputs(symbol: string, s: LiveSources): MarketInputs {
  const closes = s.closes.filter((c) => Number.isFinite(c) && c > 0);
  if (closes.length < LOOKBACK + 1) throw new Error(`need ${LOOKBACK + 1} closes, got ${closes.length}`);
  const window = closes.slice(-(LOOKBACK + 1));
  const returns = window.slice(1).map((c, i) => Math.log(c / window[i]!));
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, r) => a + (r - mean) ** 2, 0) / (returns.length - 1);
  const realizedVolBps = Math.round(Math.sqrt(variance * TRADING_DAYS_PER_YEAR) * 10_000);
  const spot = window[window.length - 1]!;
  const first = window[0]!;
  const asOfDate = new Date(s.lastCloseTime * 1000).toISOString().slice(0, 10);
  return {
    scenario: 'live',
    asOf: new Date(s.lastCloseTime * 1000).toISOString(),
    symbol,
    spotE8: Math.round(spot * 1e8),
    realizedVolBps,
    impliedVolBps: realizedVolBps,
    earningsInDays: s.earningsDate ? tradingDaysBetween(asOfDate, s.earningsDate) : -1,
    momentumBps: Math.round((spot / first - 1) * 10_000),
    recessionProbBps: Math.round(s.recessionPct * 100),
  };
}

async function get(url: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`${new URL(url).host} ${res.status}`);
  return res;
}

async function fetchYahooCloses(symbol: string): Promise<{ closes: number[]; lastCloseTime: number }> {
  const res = await get(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=3mo&interval=1d`, {
    headers: { 'user-agent': 'Mozilla/5.0 (pichifi-agent)' },
  });
  const json = (await res.json()) as { chart?: { result?: { timestamp?: number[]; indicators?: { quote?: { close?: (number | null)[] }[] } }[] } };
  const r = json.chart?.result?.[0];
  const ts = r?.timestamp ?? [];
  const raw = r?.indicators?.quote?.[0]?.close ?? [];
  const pairs = ts.map((t, i) => [t, raw[i]] as const).filter((p): p is readonly [number, number] => typeof p[1] === 'number');
  if (pairs.length === 0) throw new Error('yahoo: no closes');
  return { closes: pairs.map((p) => p[1]), lastCloseTime: pairs[pairs.length - 1]![0] };
}

async function fetchNextEarnings(symbol: string, key: string, fromDate: string): Promise<string | undefined> {
  const to = new Date(Date.parse(fromDate) + 200 * 86_400_000).toISOString().slice(0, 10);
  const res = await get(`https://finnhub.io/api/v1/calendar/earnings?symbol=${encodeURIComponent(symbol)}&from=${fromDate}&to=${to}&token=${key}`);
  const json = (await res.json()) as { earningsCalendar?: { date?: unknown }[] };
  const dates = (json.earningsCalendar ?? [])
    .map((e) => e.date)
    .filter((d): d is string => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) && d >= fromDate)
    .sort();
  return dates[0];
}

async function fetchRecessionPct(): Promise<number> {
  const res = await get('https://fred.stlouisfed.org/graph/fredgraph.csv?id=RECPROUSM156N');
  const rows = (await res.text()).trim().split(/\r?\n/).slice(1);
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const value = Number(rows[i]!.split(',')[1]);
    if (Number.isFinite(value)) return value;
  }
  throw new Error('fred: no value');
}

export interface LiveFeed {
  latest(): MarketInputs | null;
  stop(): void;
}

/** Refreshes a snapshot now and every `refreshSeconds`; keeps the last good one on failure. */
export function startLiveFeed(opts: { symbol: string; finnhubKey?: string; refreshSeconds: number; log: Logger; onUpdate?: () => void }): LiveFeed {
  let snapshot: MarketInputs | null = null;
  const refresh = async () => {
    try {
      const yahoo = await fetchYahooCloses(opts.symbol);
      const asOfDate = new Date(yahoo.lastCloseTime * 1000).toISOString().slice(0, 10);
      const [earningsDate, recessionPct] = await Promise.all([
        opts.finnhubKey ? fetchNextEarnings(opts.symbol, opts.finnhubKey, asOfDate) : Promise.resolve(undefined),
        fetchRecessionPct(),
      ]);
      const next = computeLiveInputs(opts.symbol, { ...yahoo, earningsDate, recessionPct });
      const changed = JSON.stringify(next) !== JSON.stringify(snapshot);
      snapshot = next;
      opts.log.info({ inputs: next }, 'live market snapshot');
      if (changed) opts.onUpdate?.();
    } catch (err) {
      opts.log.warn({ err }, 'live market refresh failed; keeping the last snapshot');
    }
  };
  void refresh();
  const timer = setInterval(() => void refresh(), opts.refreshSeconds * 1000);
  return { latest: () => snapshot, stop: () => clearInterval(timer) };
}
