'use client';

import { usePichiToken } from '@/hooks/usePichiToken';
import { appConfig, explorerAddress } from '@/lib/config';
import { formatTokenAmount } from '@/lib/pichi';
import ui from './ui.module.css';

/** $PICHI community token launched on vibe/vibe (Robinhood Chain testnet). */
export function PichiPanel() {
  const { token, launchUrl } = appConfig.pichi;
  const query = usePichiToken();
  if (!token) return null;
  const info = query.data;

  return (
    <section className={ui.panel} aria-labelledby="pichi-heading">
      <h2 id="pichi-heading">${info?.symbol ?? 'PICHI'} on vibe/vibe</h2>
      {info ? (
        <div className={ui.rows}>
          <div className={ui.row}>
            <span>Holders</span>
            <span className="mono">{info.holders.toLocaleString('en-US')}</span>
          </div>
          {info.transfers !== undefined && (
            <div className={ui.row}>
              <span>Transfers</span>
              <span className="mono">{info.transfers.toLocaleString('en-US')}</span>
            </div>
          )}
          <div className={ui.row}>
            <span>Total supply</span>
            <span className="mono">{formatTokenAmount(info.totalSupply, info.decimals)}</span>
          </div>
        </div>
      ) : (
        <p className={ui.notice}>{query.error ? 'Token data unavailable right now.' : 'Loading token data…'}</p>
      )}
      <div className={ui.kv} style={{ marginTop: 'var(--space-3)' }}>
        {launchUrl && (
          <a className={ui.badge} href={launchUrl} target="_blank" rel="noopener noreferrer">
            Trade on vibe/vibe ↗
          </a>
        )}{' '}
        <a className={ui.badge} href={explorerAddress(token)} target="_blank" rel="noopener noreferrer">
          Blockscout ↗
        </a>
      </div>
      <p className={ui.notice}>Community token on Robinhood Chain testnet. No monetary value; not an investment.</p>
    </section>
  );
}
