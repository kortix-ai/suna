'use client';

/**
 * Kortix presentation — a keyboard-driven deck at /presentation, styled 1:1 with
 * the marketing site. Each slide is a responsive full-viewport homepage-style
 * section; the engine cross-fades between them (mirroring the home `Reveal`
 * entrance) and lays a slim navbar-style chrome on top. Theme-following — it
 * inherits the same light/dark system as the homepage, with the same toggle.
 *
 * → / Space / PageDown / J — next · ← / PageUp / K — prev · Home/End — first/last
 * G or Esc — overview · F — fullscreen · 1–9 — jump.
 */

import { KortixLogo } from '@/components/sidebar/kortix-logo';
import { ThemeToggle } from '@/components/home/theme-toggle';
import { cn } from '@/lib/utils';
import { AnimatePresence, motion } from 'motion/react';
import { ChevronLeft, ChevronRight, Grid2x2, Maximize, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { SLIDES } from './slides';

export default function PresentationPage() {
  const [index, setIndex] = useState(0);
  const [dir, setDir] = useState(1);
  const [overview, setOverview] = useState(false);
  const [mounted, setMounted] = useState(false);
  const touchX = useRef<number | null>(null);

  const total = SLIDES.length;

  const go = useCallback(
    (n: number, direction?: number) => {
      setDir(direction ?? (n > index ? 1 : -1));
      setIndex(Math.max(0, Math.min(total - 1, n)));
    },
    [index, total],
  );
  const next = useCallback(() => go(index + 1, 1), [go, index]);
  const prev = useCallback(() => go(index - 1, -1), [go, index]);

  useEffect(() => setMounted(true), []);

  /* Hash sync (#1-based) + back/forward. */
  useEffect(() => {
    const fromHash = () => {
      const n = parseInt(window.location.hash.replace('#', ''), 10);
      if (!Number.isNaN(n) && n >= 1 && n <= total) setIndex(n - 1);
    };
    fromHash();
    window.addEventListener('hashchange', fromHash);
    return () => window.removeEventListener('hashchange', fromHash);
  }, [total]);

  useEffect(() => {
    if (!mounted) return;
    const t = `#${index + 1}`;
    if (window.location.hash !== t) window.history.replaceState(null, '', t);
  }, [index, mounted]);

  /* Keyboard navigation. */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      switch (e.key) {
        case 'ArrowRight':
        case ' ':
        case 'PageDown':
        case 'j':
        case 'l':
          e.preventDefault();
          if (overview) setOverview(false);
          else next();
          break;
        case 'ArrowLeft':
        case 'PageUp':
        case 'k':
        case 'h':
          e.preventDefault();
          prev();
          break;
        case 'Home':
          e.preventDefault();
          go(0, -1);
          break;
        case 'End':
          e.preventDefault();
          go(total - 1, 1);
          break;
        case 'g':
        case 'G':
          e.preventDefault();
          setOverview((o) => !o);
          break;
        case 'Escape':
          setOverview((o) => !o);
          break;
        case 'f':
        case 'F':
          e.preventDefault();
          if (!document.fullscreenElement) document.documentElement.requestFullscreen?.();
          else document.exitFullscreen?.();
          break;
        default:
          if (/^[1-9]$/.test(e.key)) {
            const n = parseInt(e.key, 10) - 1;
            if (n < total) go(n);
          }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [next, prev, go, total, overview]);

  const slide = SLIDES[index];

  const toggleFs = () => {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen?.();
    else document.exitFullscreen?.();
  };

  return (
    <div className="bg-background text-foreground fixed inset-0 overflow-hidden">
      {/* ── Stage ──────────────────────────────────────────────────────── */}
      <div
        className="relative h-full w-full"
        onPointerDown={(e) => (touchX.current = e.clientX)}
        onPointerUp={(e) => {
          if (touchX.current == null) return;
          const dx = e.clientX - touchX.current;
          touchX.current = null;
          if (Math.abs(dx) > 70) (dx < 0 ? next : prev)();
        }}
      >
        <AnimatePresence mode="wait" custom={dir}>
          <motion.div
            key={slide.id}
            custom={dir}
            initial={{ opacity: 0, y: 24, filter: 'blur(8px)' }}
            animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
            exit={{ opacity: 0, y: -16, filter: 'blur(6px)' }}
            transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
            className="absolute inset-0"
          >
            {slide.node}
          </motion.div>
        </AnimatePresence>

        {/* ── Chrome (navbar-style) ───────────────────────────────────── */}
        <div className="pointer-events-none absolute inset-x-0 top-0 flex items-center justify-between px-6 py-5 sm:px-8">
          <KortixLogo variant="logomark" size={22} className="text-foreground" />
          <div className="pointer-events-auto flex items-center gap-3">
            <span className="text-muted-foreground hidden font-mono text-xs tracking-wider tabular-nums sm:inline">
              {String(index + 1).padStart(2, '0')} / {String(total).padStart(2, '0')}
            </span>
            <ThemeToggle />
          </div>
        </div>

        {/* slide label, bottom-left */}
        <div className="text-muted-foreground/70 pointer-events-none absolute bottom-6 left-6 font-mono text-xs tracking-wider uppercase sm:left-8">
          {slide.label}
        </div>
      </div>

      {/* ── Progress bar ───────────────────────────────────────────────── */}
      <div className="bg-border/40 absolute inset-x-0 top-0 h-0.5">
        <div
          className="bg-foreground h-full transition-[width] duration-300 ease-out"
          style={{ width: `${((index + 1) / total) * 100}%` }}
        />
      </div>

      {/* ── Floating controls ──────────────────────────────────────────── */}
      <div className="border-border bg-card/90 absolute bottom-5 left-1/2 z-20 flex -translate-x-1/2 items-center gap-1 rounded-sm border p-1.5 shadow-sm backdrop-blur-md">
        <Ctrl onClick={prev} disabled={index === 0} label="Previous">
          <ChevronLeft className="size-4" />
        </Ctrl>
        <span className="text-muted-foreground px-2 font-mono text-xs tabular-nums">
          {String(index + 1).padStart(2, '0')}
          <span className="text-muted-foreground/40"> / {String(total).padStart(2, '0')}</span>
        </span>
        <Ctrl onClick={next} disabled={index === total - 1} label="Next">
          <ChevronRight className="size-4" />
        </Ctrl>
        <span className="bg-border mx-0.5 h-4 w-px" />
        <Ctrl onClick={() => setOverview((o) => !o)} label="Overview (G)">
          <Grid2x2 className="size-3.5" />
        </Ctrl>
        <Ctrl onClick={toggleFs} label="Fullscreen (F)">
          <Maximize className="size-3.5" />
        </Ctrl>
      </div>

      {/* ── Overview grid ──────────────────────────────────────────────── */}
      <AnimatePresence>
        {overview ? (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="bg-background/95 absolute inset-0 z-30 overflow-y-auto backdrop-blur-sm"
          >
            <div className="flex items-center justify-between px-8 py-6">
              <span className="text-muted-foreground font-mono text-xs tracking-wider uppercase">
                Kortix · {total} slides
              </span>
              <button
                onClick={() => setOverview(false)}
                className="border-border bg-card text-muted-foreground hover:text-foreground flex size-9 items-center justify-center rounded-sm border transition-colors"
                aria-label="Close overview"
              >
                <X className="size-4" />
              </button>
            </div>
            <div className="grid grid-cols-2 gap-5 px-8 pb-16 sm:grid-cols-3 lg:grid-cols-4">
              {SLIDES.map((s, i) => (
                <Thumb
                  key={s.id}
                  active={i === index}
                  n={i + 1}
                  label={s.label}
                  onClick={() => {
                    go(i);
                    setOverview(false);
                  }}
                >
                  {s.node}
                </Thumb>
              ))}
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

function Ctrl({
  children,
  onClick,
  disabled,
  label,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className={cn(
        'text-muted-foreground flex size-8 items-center justify-center rounded-sm transition-colors',
        disabled ? 'opacity-30' : 'hover:bg-foreground/5 hover:text-foreground',
      )}
    >
      {children}
    </button>
  );
}

/** Overview thumbnail: the real slide rendered into a fixed 1280×720 frame, scaled. */
function Thumb({
  children,
  active,
  n,
  label,
  onClick,
}: {
  children: React.ReactNode;
  active: boolean;
  n: number;
  label: string;
  onClick: () => void;
}) {
  const W = 320;
  const BASE = 1280;
  const s = W / BASE;
  const H = (BASE * 9) / 16; // 720
  return (
    <button onClick={onClick} className="group flex flex-col gap-2 text-left">
      <div
        className={cn(
          'bg-background relative overflow-hidden rounded-sm border transition-colors',
          active ? 'border-foreground' : 'border-border group-hover:border-muted-foreground/40',
        )}
        style={{ width: W, height: H * s }}
      >
        <div
          className="bg-background absolute top-0 left-0 origin-top-left overflow-hidden"
          style={{ width: BASE, height: H, transform: `scale(${s})` }}
        >
          {children}
        </div>
      </div>
      <div className="flex items-center gap-2 px-0.5">
        <span className="text-muted-foreground/60 font-mono text-xs tabular-nums">
          {String(n).padStart(2, '0')}
        </span>
        <span className={cn('truncate text-xs', active ? 'text-foreground' : 'text-muted-foreground')}>
          {label}
        </span>
      </div>
    </button>
  );
}
