'use client';

import { useEffect, useRef } from 'react';
import { animate } from 'animejs';

interface AnimatedCounterProps {
  value: number;
  decimals?: number;
  prefix?: string;
  suffix?: string;
  duration?: number;
  className?: string;
}

export function AnimatedCounter({
  value,
  decimals = 0,
  prefix = '',
  suffix = '',
  duration = 1400,
  className = '',
}: AnimatedCounterProps) {
  const spanRef = useRef<HTMLSpanElement | null>(null);
  const prevValRef = useRef(0);

  useEffect(() => {
    const el = spanRef.current;
    if (!el) return;

    const startVal = prevValRef.current;
    const endVal = value;
    prevValRef.current = value;

    const counter = { val: startVal };

    const anim = animate(counter, {
      val: endVal,
      duration,
      ease: 'outExpo',
      onUpdate: () => {
        if (el) {
          el.textContent = `${prefix}${counter.val.toLocaleString('en-US', {
            minimumFractionDigits: decimals,
            maximumFractionDigits: decimals,
          })}${suffix}`;
        }
      },
    });

    return () => {
      try {
        anim?.pause?.();
      } catch {
        // no-op
      }
    };
  }, [value, decimals, prefix, suffix, duration]);

  return (
    <span ref={spanRef} className={`mono ${className}`}>
      {prefix}
      {value.toLocaleString('en-US', {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
      })}
      {suffix}
    </span>
  );
}
