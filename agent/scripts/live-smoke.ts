/** Fetches one live market snapshot and shows the policy's decision for it. */
import { resolve } from 'node:path';
import { config as loadEnv } from 'dotenv';
import { startLiveFeed } from '../src/market/live.js';
import { decide } from '../src/policy/policy.js';
import { logger } from '../src/log.js';

loadEnv({ path: resolve(import.meta.dirname, '../../.env'), quiet: true });
const feed = startLiveFeed({
  symbol: process.env.MARKET_SYMBOL ?? 'NVDA',
  finnhubKey: process.env.FINNHUB_API_KEY,
  refreshSeconds: 3600,
  log: logger,
  onUpdate: () => {
    const inputs = feed.latest()!;
    const d = decide(inputs);
    console.log(JSON.stringify({ inputs, regime: d.regime, morphoBps: d.morphoBps, uniswapBps: d.uniswapBps, reasons: d.reasons }, null, 2));
    feed.stop();
  },
});
