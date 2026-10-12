'use client';

import { useEffect, useRef } from 'react';
import { animate } from 'animejs';

interface Particle {
  x: number;
  y: number;
  size: number;
  color: string;
  speedY: number;
  driftX: number;
  opacity: number;
}

const COLORS = [
  'rgba(16, 185, 129, ', // bio-emerald
  'rgba(0, 229, 255, ',   // morpho-cyan
  'rgba(168, 85, 247, ', // mystic-orchid
  'rgba(245, 158, 11, ', // gold glow
];

export function BioluminescentParticles() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let animationFrameId: number;
    let width = (canvas.width = canvas.parentElement?.clientWidth || window.innerWidth);
    let height = (canvas.height = canvas.parentElement?.clientHeight || window.innerHeight);

    const handleResize = () => {
      if (!canvas) return;
      width = canvas.width = canvas.parentElement?.clientWidth || window.innerWidth;
      height = canvas.height = canvas.parentElement?.clientHeight || window.innerHeight;
    };
    window.addEventListener('resize', handleResize);

    const count = 38;
    const particles: Particle[] = Array.from({ length: count }, () => ({
      x: Math.random() * width,
      y: Math.random() * height,
      size: Math.random() * 2.8 + 1.2,
      color: COLORS[Math.floor(Math.random() * COLORS.length)],
      speedY: Math.random() * 0.45 + 0.15,
      driftX: (Math.random() - 0.5) * 0.35,
      opacity: Math.random() * 0.65 + 0.25,
    }));

    // Animate a global pulse property using Anime.js to give a synchronized breathing rhythm
    const pulseObj = { glow: 1 };
    const pulseAnimation = animate(pulseObj, {
      glow: [0.75, 1.35],
      duration: 3200,
      loop: true,
      alternate: true,
      ease: 'inOutSine',
    });

    const render = () => {
      ctx.clearRect(0, 0, width, height);

      for (let i = 0; i < particles.length; i++) {
        const p = particles[i];
        p.y -= p.speedY;
        p.x += p.driftX;

        if (p.y < -15) {
          p.y = height + 15;
          p.x = Math.random() * width;
        }
        if (p.x < -15) p.x = width + 15;
        if (p.x > width + 15) p.x = -15;

        const effectiveOpacity = Math.min(1, p.opacity * pulseObj.glow);
        const radius = p.size * pulseObj.glow;

        ctx.beginPath();
        ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
        ctx.fillStyle = `${p.color}${effectiveOpacity})`;
        ctx.shadowBlur = radius * 4.5;
        ctx.shadowColor = `${p.color}0.85)`;
        ctx.fill();
        ctx.shadowBlur = 0;
      }

      animationFrameId = requestAnimationFrame(render);
    };

    render();

    return () => {
      window.removeEventListener('resize', handleResize);
      cancelAnimationFrame(animationFrameId);
      try {
        pulseAnimation?.pause?.();
      } catch {
        // no-op
      }
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      style={{
        position: 'absolute',
        inset: 0,
        pointerEvents: 'none',
        zIndex: 0,
        width: '100%',
        height: '100%',
        opacity: 0.8,
      }}
      aria-hidden="true"
    />
  );
}
