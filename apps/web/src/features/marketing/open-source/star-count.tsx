'use client';

import { useGitHubStars } from '@/hooks/utils/use-github-stars';
import { cn } from '@/lib/utils';
import { useEffect, useRef, useState, type ReactNode } from 'react';

const DURATION_MS = 1600;
const FORMATTER = new Intl.NumberFormat('en-US');

/**
 * True once the element has been at least partly on screen. Latches — it never
 * flips back — so the count-up runs exactly once per page load, not on every
 * scroll past.
 */
function useHasBeenSeen<T extends HTMLElement>(): [React.RefObject<T | null>, boolean] {
  const ref = useRef<T>(null);
  const [seen, setSeen] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    /* No IntersectionObserver (very old browser, or a test harness that stubs
       it away) means no trigger would ever fire — show the number instead. */
    if (typeof IntersectionObserver === 'undefined') {
      setSeen(true);
      return;
    }

    const obs = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          setSeen(true);
          obs.disconnect();
        }
      },
      { threshold: 0.2 },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  return [ref, seen];
}

/**
 * Counts 0 → `target` once `start` is true.
 *
 * Returns `null` until there is something honest to draw: the caller renders a
 * placeholder rather than a `0` that looks stuck or a `NaN` mid-fetch. The
 * effect is deliberately re-runnable (no "already done" latch) so React Strict
 * Mode's double-invoke in dev restarts the animation instead of freezing it at
 * zero; "once" is guaranteed upstream by `useHasBeenSeen`, which latches.
 */
function useCountUp(target: number | null, start: boolean): number | null {
  const [value, setValue] = useState<number | null>(null);

  useEffect(() => {
    if (!start || target === null) return;

    const reduced =
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    if (reduced) {
      setValue(target);
      return;
    }

    let frame = 0;
    const startedAt = performance.now();

    const tick = (now: number) => {
      const p = Math.min(1, (now - startedAt) / DURATION_MS);
      /* easeOutQuart — fast off the line, long settle on the last few hundred. */
      const eased = 1 - (1 - p) ** 4;
      setValue(Math.round(target * eased));
      if (p < 1) frame = requestAnimationFrame(tick);
      else setValue(target);
    };

    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [start, target]);

  return value;
}

/**
 * The one large numeral on the home page. `useGitHubStars` reads
 * `/api/github-stars`; `stars` is `null` while the request is in flight and
 * also if it fails, because a failure must never print an invented figure
 * under this caption. The `—` placeholder holds the line height either way, so
 * nothing reflows when the digits land.
 *
 * The hook takes no arguments here on purpose: the route is hardcoded to
 * `kortix-ai/suna` server-side and its `owner` / `repo` parameters are ignored.
 */
export function StarCount({ caption, className }: { caption: string; className?: string }): ReactNode {
  const { stars } = useGitHubStars();
  const [ref, seen] = useHasBeenSeen<HTMLDivElement>();
  const value = useCountUp(stars, seen);

  const settled = stars !== null && value === stars;

  return (
    <div ref={ref} className={className}>
      <div
        data-testid="agent-star-count"
        aria-label={stars === null ? caption : `${FORMATTER.format(stars)} ${caption}`}
        className={cn(
          'text-foreground text-6xl leading-none font-medium tracking-tight tabular-nums sm:text-7xl',
          /* Only the placeholder is dimmed; the digits never fade in mid-count. */
          value === null && 'text-muted-foreground/30',
        )}
      >
        {value === null ? '—' : FORMATTER.format(value)}
      </div>

      <p
        className={cn(
          'text-muted-foreground mt-4 font-mono text-[10px] tracking-widest uppercase transition-opacity duration-500',
          settled ? 'opacity-100' : 'opacity-60',
        )}
      >
        {caption}
      </p>
    </div>
  );
}
