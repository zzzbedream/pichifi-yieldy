'use client';

import { useEffect, useRef } from 'react';
import Image from 'next/image';
import { animate } from 'animejs';
import l from './landing.module.css';

export function HeroEmblem() {
  const frameRef = useRef<HTMLDivElement | null>(null);
  const badgeRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!frameRef.current) return;

    // Organic breathing aura pulse powered by Anime.js
    const animAura = animate(frameRef.current, {
      scale: [1, 1.02],
      filter: [
        'drop-shadow(0 0 20px rgba(0, 229, 255, 0.25)) drop-shadow(0 0 40px rgba(229, 169, 60, 0.2))',
        'drop-shadow(0 0 35px rgba(0, 229, 255, 0.42)) drop-shadow(0 0 60px rgba(245, 158, 11, 0.38))',
      ],
      duration: 3600,
      loop: true,
      alternate: true,
      ease: 'inOutSine',
    });

    if (badgeRef.current) {
      animate(badgeRef.current, {
        translateY: [-2, 2],
        duration: 2800,
        loop: true,
        alternate: true,
        ease: 'inOutSine',
      });
    }

    return () => {
      try {
        animAura?.pause?.();
      } catch {
        // no-op
      }
    };
  }, []);

  return (
    <div className={l.emblemWrapper}>
      <div ref={frameRef} className={l.emblemFrame}>
        <div className={l.emblemGlowRing} aria-hidden />
        <div className={l.emblemImageContainer}>
          <Image
            src="/pichifi-hero.jpg"
            alt="PICHIFI — AI-Managed USDG Vault Emblem"
            width={640}
            height={360}
            priority
            className={l.emblemImage}
          />
        </div>
        <div ref={badgeRef} className={l.emblemBadge}>
          <span className={l.badgeDot} aria-hidden />
          <span>AUTONOMOUS YIELD GUARDIAN</span>
        </div>
      </div>
    </div>
  );
}
