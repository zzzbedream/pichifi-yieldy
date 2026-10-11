import Link from 'next/link';
import { BUSINESS, GUARANTEES, HONESTY, PROOF, REGIMES, REPO_URL, ROADMAP, STEPS } from './content';
import { TryIt } from './TryIt';
import l from './landing.module.css';

const REGIME_CLASS = { on: l.r_on, volatile: l.r_volatile, off: l.r_off } as const;
const STATUS_CLASS = { live: l.s_live, building: l.s_building, planned: l.s_planned } as const;

/** How it works, guarantees, proof, roadmap and closing call to action. */
export function LandingSections() {
  return (
    <>
      <section id="how" className={l.section} aria-labelledby="how-title">
        <div className={l.sectionHead}>
          <div>
            <span className="eyebrow">How it works</span>
            <h2 id="how-title">From market signal to verified rebalance.</h2>
          </div>
          <p>The agent proposes. The chain decides. Nothing moves without a valid signature from the agent&apos;s Amadeus key.</p>
        </div>
        <ol className={l.steps} style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {STEPS.map((s) => (
            <li key={s.n} className={l.step}>
              <span className={l.stepN}>STEP {s.n}</span>
              <h3>{s.title}</h3>
              <p>{s.body}</p>
            </li>
          ))}
        </ol>
        <div className={l.regimes}>
          {REGIMES.map((r) => (
            <article key={r.key} className={`${l.regime} ${REGIME_CLASS[r.key]}`}>
              <span className="eyebrow">Regime</span>
              <h3>{r.name}</h3>
              <dl>
                <dt>When</dt>
                <dd>{r.trigger}</dd>
                <dt>Allocation</dt>
                <dd className="mono">{r.alloc}</dd>
                <dt>Hook fee</dt>
                <dd className="mono">{r.fee}</dd>
              </dl>
            </article>
          ))}
        </div>
      </section>

      <section id="guarantees" className={l.section} aria-labelledby="guarantees-title">
        <div className={l.sectionHead}>
          <div>
            <span className="eyebrow">Enforced on-chain</span>
            <h2 id="guarantees-title">Guarantees the agent cannot override.</h2>
          </div>
          <p>Even a compromised agent key cannot drain the vault: the contract checks every rule on every move.</p>
        </div>
        <ol className={l.guarantees}>
          {GUARANTEES.map((g, i) => (
            <li key={g}>
              <span className={l.gNum}>{String(i + 1).padStart(2, '0')}</span>
              <span>{g}</span>
            </li>
          ))}
        </ol>
      </section>

      <section id="proof" className={l.section} aria-labelledby="proof-title">
        <div className={l.sectionHead}>
          <div>
            <span className="eyebrow">Proof, not promises</span>
            <h2 id="proof-title">Live on Robinhood Chain testnet today.</h2>
          </div>
          <p>Every number links to something you can check yourself.</p>
        </div>
        <div className={l.proof}>
          {PROOF.map((p) => (
            <a key={p.label} className={l.proofItem} href={p.href} target="_blank" rel="noopener noreferrer">
              <strong>{p.figure}</strong>
              <span>{p.label} ↗</span>
            </a>
          ))}
        </div>
      </section>

      <section id="business" className={l.section} aria-labelledby="business-title">
        <div className={l.sectionHead}>
          <div>
            <span className="eyebrow">Business model</span>
            <h2 id="business-title">We earn when the agent beats plain lending.</h2>
          </div>
          <p>
            USDG holders on Robinhood Chain already earn about 7% lending through Robinhood Earn on Morpho. PICHIFI charges
            for the excess, so incentives stay aligned with depositors.
          </p>
        </div>
        <div className={l.proof}>
          {BUSINESS.map((b) => (
            <div key={b.figure} className={l.proofItem}>
              <strong>{b.figure}</strong>
              <span>{b.label}</span>
            </div>
          ))}
        </div>
      </section>

      <section id="try" className={l.section} aria-labelledby="try-title">
        <div className={l.sectionHead}>
          <div>
            <span className="eyebrow">Try it in 60 seconds</span>
            <h2 id="try-title">Deposit on testnet and watch the agent work.</h2>
          </div>
          <p>Everything is free test money on Robinhood Chain testnet. No sign-up.</p>
        </div>
        <TryIt />
      </section>

      <section id="roadmap" className={l.section} aria-labelledby="roadmap-title">
        <div className={l.sectionHead}>
          <div>
            <span className="eyebrow">Where we are going</span>
            <h2 id="roadmap-title">Roadmap</h2>
          </div>
          <p>From a verified testnet vault to the default way to earn on USDG on Robinhood Chain.</p>
        </div>
        <div className={l.roadmap}>
          {ROADMAP.map((p) => (
            <article key={p.phase} className={l.phase}>
              <div className={l.phaseHead}>
                <h3>{p.phase}</h3>
                <span className={`eyebrow ${STATUS_CLASS[p.status]}`}>{p.status}</span>
              </div>
              <ul>
                {p.items.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </article>
          ))}
        </div>
      </section>

      <section className={l.closing} aria-labelledby="closing-title">
        <div>
          <h2 id="closing-title">See the agent work, live.</h2>
          <div className={l.ctaRow} style={{ marginTop: 'var(--space-6)' }}>
            <Link href="/app" className={l.cta}>
              Launch app →
            </Link>
            <a href={REPO_URL} className={l.ctaGhost} target="_blank" rel="noopener noreferrer">
              GitHub ↗
            </a>
          </div>
        </div>
        <div className={l.honesty}>
          <p>{HONESTY.real}</p>
          <p>{HONESTY.simulated}</p>
        </div>
      </section>

      <footer className={l.footer}>
        <span>PICHIFI · Agentic Yield Vaults · Robinhood Chain</span>
        <span>Colosseum Crypto World&apos;s Fair · Robinhood Chain track</span>
      </footer>
    </>
  );
}
