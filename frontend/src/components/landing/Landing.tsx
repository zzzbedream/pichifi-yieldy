'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { animate, stagger } from 'animejs';
import { LiveCard } from './LiveCard';
import { HeroEmblem } from './HeroEmblem';
import { BioluminescentParticles } from './BioluminescentParticles';
import { LandingSections } from './LandingSections';
import { PILLARS, PROBLEMS, REPO_URL } from './content';
import l from './landing.module.css';

/** Public landing: what PICHIFI sells, the problem, how it works, proof and roadmap. The app lives at /app. */
export function Landing() {
  useEffect(() => {
    // Subtle Anime.js staggered reveal on mount
    const timer = setTimeout(() => {
      try {
        animate(`.${l.pillar}`, {
          opacity: [0, 1],
          translateY: [20, 0],
          delay: stagger(100),
          duration: 900,
          ease: 'outExpo',
        });
      } catch {
        // no-op if elements aren't ready
      }
    }, 120);

    return () => clearTimeout(timer);
  }, []);

  return (
    <div className={l.page}>
      <BioluminescentParticles />

      <nav className={l.nav} aria-label="Main">
        <Link href="/" className={l.brand}>
          <Image
            src="/pichifi-logo.jpg"
            alt="PICHIFI Logo"
            width={36}
            height={36}
            className={l.brandLogo}
            priority
          />
          <strong>PICHIFI</strong>
          <span className={l.vaultPill}>USDG VAULT</span>
        </Link>
        <div className={l.navLinks}>
          <a href="#product">Product</a>
          <a href="#problem">Problem</a>
          <a href="#how">How it works</a>
          <a href="#proof">Proof</a>
          <a href="#business">Business</a>
          <a href="#try">Try it</a>
          <a href="#roadmap">Roadmap</a>
          <Link href="/app" className={l.cta}>
            Launch app →
          </Link>
        </div>
      </nav>

      <main>
        <section className={l.hero} aria-labelledby="hero-title">
          <div className={l.heroContent}>
            <div className={l.heroBadge}>
              <span className={l.badgeDot} aria-hidden />
              <span>USDG · Robinhood Chain Testnet · Live</span>
            </div>
            <h1 id="hero-title" className={l.heroTitle}>
              Yield on USDG, run by an AI agent that <span className={l.goldHighlight}>proves every move</span>.
            </h1>
            <p className={l.lede}>
              PICHIFI is an autonomous USDG asset manager. Its agent routes capital between protected Uniswap v4
              liquidity ranges and Morpho Blue lending vaults, verified by on-chain cryptographic proofs before a
              single dollar moves.
            </p>
            <div className={l.ctaRow}>
              <Link href="/app" className={l.cta}>
                Launch app →
              </Link>
              <a href={REPO_URL} className={l.ctaGhost} target="_blank" rel="noopener noreferrer">
                Read the code ↗
              </a>
            </div>
            <div className={l.trustBadges}>
              <span>✦ Zero Custody</span>
              <span>✦ 100% On-Chain Proofs</span>
              <span>✦ Hook-Enforced Guardrails</span>
            </div>
          </div>

          <div className={l.heroSide}>
            <HeroEmblem />
            <LiveCard />
          </div>
        </section>

        <section id="product" className={l.section} aria-labelledby="product-title">
          <div className={l.sectionHead}>
            <div>
              <span className="eyebrow">What we offer</span>
              <h2 id="product-title">One deposit. An agent you can audit. Guardrails it cannot cross.</h2>
            </div>
            <p>
              For USDG holders and treasuries that want more than plain lending but need to verify every decision,
              and for tokenized-stock markets that need liquidity providers who are not picked off by arbitrage.
            </p>
          </div>
          <div className={l.pillars}>
            {PILLARS.map((p) => (
              <article key={p.tag} className={l.pillar}>
                <span className="eyebrow">{p.tag}</span>
                <h3>{p.title}</h3>
                <p>{p.body}</p>
              </article>
            ))}
          </div>
        </section>

        <section id="problem" className={l.section} aria-labelledby="problem-title">
          <div className={l.sectionHead}>
            <div>
              <span className="eyebrow">The problem</span>
              <h2 id="problem-title">Markets that never sleep, and capital nobody can verify.</h2>
            </div>
            <p>Three gaps meet on Robinhood Chain today. PICHIFI closes them in one vault.</p>
          </div>
          <div className={l.problems}>
            {PROBLEMS.map((p) => (
              <article key={p.title} className={l.problem}>
                <div className={l.problemFigure}>{p.figure}</div>
                <div>
                  <h3>{p.title}</h3>
                  <p>{p.body}</p>
                  {p.source && (
                    <a className={l.source} href={p.source.href} target="_blank" rel="noopener noreferrer">
                      Source: {p.source.label} ↗
                    </a>
                  )}
                </div>
              </article>
            ))}
          </div>
        </section>

        <LandingSections />
      </main>
    </div>
  );
}
