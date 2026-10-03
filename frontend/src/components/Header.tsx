'use client';

import { useConnect, useConnection, useConnectors, useDisconnect, useSwitchChain } from 'wagmi';
import { appConfig, robinhoodTestnet } from '@/lib/config';
import { shortHex } from '@/lib/format';
import ui from './ui.module.css';

type HeaderProps = { isStreaming: boolean };

export function Header({ isStreaming }: HeaderProps) {
  const buildLabel = appConfig.build === 'stylus' ? 'Rust · Stylus build' : 'Solidity build · Stylus activation paused';
  return (
    <header className={ui.header}>
      <div className={ui.wordmark}>
        <strong>Agentic Yield Vault</strong>
        <span className="eyebrow">USDG · Robinhood Chain</span>
      </div>
      <div className={ui.headerMeta}>
        <span className={ui.pill} title="Agent decision stream">
          <span className={`${ui.dot} ${isStreaming ? ui.dotLive : ui.dotOff}`} aria-hidden />
          {isStreaming ? 'Agent live' : 'Agent offline'}
        </span>
        <span className={ui.pill}>{robinhoodTestnet.name} · {robinhoodTestnet.id}</span>
        <span className={ui.pill} title="The Rust/Stylus contracts are canonical; this ABI-identical build runs while Stylus activations are paused network-wide.">
          {buildLabel}
        </span>
        <ConnectButton />
      </div>
    </header>
  );
}

function ConnectButton() {
  const { address, isConnected, chainId } = useConnection();
  const connectors = useConnectors();
  const connect = useConnect();
  const disconnect = useDisconnect();
  const switchChain = useSwitchChain();

  if (isConnected && chainId !== robinhoodTestnet.id) {
    return (
      <button className={ui.button} type="button" onClick={() => switchChain.mutate({ chainId: robinhoodTestnet.id })}>
        Switch to {robinhoodTestnet.name}
      </button>
    );
  }
  if (isConnected) {
    return (
      <button className={`${ui.button} ${ui.ghost}`} type="button" onClick={() => disconnect.mutate()} title="Disconnect">
        <span className="mono">{shortHex(address)}</span>
      </button>
    );
  }
  const injected = connectors[0];
  return (
    <button
      className={ui.button}
      type="button"
      disabled={!injected || connect.isPending}
      onClick={() => injected && connect.mutate({ connector: injected })}
    >
      {connect.isPending ? 'Connecting…' : 'Connect wallet'}
    </button>
  );
}
