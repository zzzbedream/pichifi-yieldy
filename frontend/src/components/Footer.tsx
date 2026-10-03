import { appConfig, explorerAddress } from '@/lib/config';
import { shortHex } from '@/lib/format';
import ui from './ui.module.css';

const LABELS: Record<keyof typeof appConfig.contracts, string> = {
  vault: 'Vault',
  feeEngine: 'Fee engine',
  verifier: 'BLS verifier',
  adapter: 'Uniswap v4 adapter',
  hook: 'Dynamic-fee hook',
  usdg: 'USDG',
  stock: 'rhNVDA (test)',
  morpho: 'Morpho Blue',
  irm: 'Interest rate model',
};

export function Footer({ agentIdentity }: { agentIdentity?: string }) {
  const entries = (Object.keys(LABELS) as (keyof typeof LABELS)[]).filter((k) => appConfig.contracts[k]);
  return (
    <footer className={ui.footer}>
      <div>
        <div className="eyebrow" style={{ marginBottom: 'var(--space-2)' }}>
          Contracts
        </div>
        <div className={ui.contracts}>
          {entries.map((key) => {
            const address = appConfig.contracts[key]!;
            return (
              <div key={key} style={{ display: 'contents' }}>
                <span>{LABELS[key]}</span>
                <a className="mono" href={explorerAddress(address)} target="_blank" rel="noopener noreferrer">
                  {shortHex(address, 10, 8)} ↗
                </a>
              </div>
            );
          })}
          {agentIdentity && (
            <>
              <span>Agent (Amadeus)</span>
              <span className="mono">{shortHex(agentIdentity, 10, 8)}</span>
            </>
          )}
        </div>
      </div>
      <div className={ui.honesty}>
        <div className="eyebrow">What is real vs simulated</div>
        <ul>
          <li>Real: on-chain BLS12-381 verification, Uniswap v4 PoolManager + hook, Morpho Blue, signed intents.</li>
          <li>Simulated: market scenarios, rhNVDA and its price oracle, test USDG (testnet only).</li>
          <li>
            Stylus: the Rust contracts are canonical and tested; this page targets the ABI-identical Solidity build while
            Stylus activations are paused network-wide.
          </li>
        </ul>
      </div>
    </footer>
  );
}
