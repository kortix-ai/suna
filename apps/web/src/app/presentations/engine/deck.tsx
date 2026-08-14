'use client';

import { useTranslations } from 'next-intl';
/**
 * Shared presentation engine — a keyboard-driven deck, styled 1:1 with the
 * marketing site. Each slide is a responsive full-viewport homepage-style
 * section; the engine cross-fades between them and lays a slim navbar-style
 * chrome on top. Theme-following — same light/dark system as the homepage.
 *
 * Reused by every deck route (e.g. /presentation, /presentation/platform);
 * pass the slide set in via `slides`.
 *
 * → / Space / PageDown / J — next · ← / PageUp / K — prev · Home/End — first/last
 * G or Esc — overview · F — fullscreen · 1–9 — jump · N — presenter notes.
 */

import { ThemeToggle } from '@/components/home/theme-toggle';
import { KortixLogo } from '@/components/sidebar/kortix-logo';
import { cn } from '@/lib/utils';
import {
  CaretLeftIcon as ChevronLeft,
  CaretRightIcon as ChevronRight,
  GridFourIcon as Grid2x2,
  CornersOutIcon as Maximize,
  NotepadIcon as Notepad,
  XIcon as X,
} from '@phosphor-icons/react';
import { AnimatePresence, m } from 'motion/react';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

/**
 * A slide can be a single picture or a **build**: `steps: 3` means → is pressed
 * four times on that slide, and `node` is called with the current step so the
 * diagram can add a stage each time. Advancing past the last step moves to the
 * next slide; reversing off step 0 lands on the previous slide at *its* last
 * step, so ← always undoes exactly what → just did.
 *
 * `notes` is the spoken script — what the presenter says. It never renders on
 * the stage, only in the presenter drawer (`N`), so a screen recording of the
 * deck stays clean. Pass an array to give each build step its own line.
 */
export type SlideDef = {
  id: string;
  label: string;
  node: ReactNode | ((step: number) => ReactNode);
  /** Extra build steps beyond the base picture. Total presses = steps + 1. */
  steps?: number;
  notes?: string | readonly string[];
};

export function Deck({
  slides,
  altDeck,
}: {
  slides: SlideDef[];
  /** Optional link to a sibling deck, shown in the chrome. */
  altDeck?: { href: string; label: string };
}) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const [index, setIndex] = useState(0);
  /** Which build stage of the current slide is showing. */
  const [step, setStep] = useState(0);
  const [dir, setDir] = useState(1);
  const [overview, setOverview] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);
  /** The drawer shows one slide's script, or the whole deck's for a rehearsal. */
  const [notesAll, setNotesAll] = useState(false);
  const [mounted, setMounted] = useState(false);
  const touchX = useRef<number | null>(null);

  const hasNotes = slides.some((s) => s.notes);

  const total = slides.length;
  const stepsOf = useCallback((i: number) => slides[i]?.steps ?? 0, [slides]);

  /** Jumping to a slide always lands on its first stage. */
  const go = useCallback(
    (n: number, direction?: number) => {
      setDir(direction ?? (n > index ? 1 : -1));
      setIndex(Math.max(0, Math.min(total - 1, n)));
      setStep(0);
    },
    [index, total],
  );

  const next = useCallback(() => {
    if (step < stepsOf(index)) {
      setStep((s) => s + 1);
      return;
    }
    if (index >= total - 1) return;
    setDir(1);
    setIndex(index + 1);
    setStep(0);
  }, [index, step, stepsOf, total]);

  /** Reversing off the first stage re-enters the previous slide fully built. */
  const prev = useCallback(() => {
    if (step > 0) {
      setStep((s) => s - 1);
      return;
    }
    if (index === 0) return;
    setDir(-1);
    setIndex(index - 1);
    setStep(stepsOf(index - 1));
  }, [index, step, stepsOf]);

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
        case 'n':
        case 'N':
          e.preventDefault();
          setNotesOpen((o) => !o);
          break;
        case 'Escape':
          // The drawer is the innermost layer, so it closes first.
          if (notesOpen) setNotesOpen(false);
          else setOverview((o) => !o);
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
  }, [next, prev, go, total, overview, notesOpen, step]);

  const slide = slides[index];
  const slideSteps = stepsOf(index);
  /** The stage cross-fades between slides only — a build step must not remount
      the tree, or the diagrams would restart instead of adding a stage. */
  const stageNode = typeof slide.node === 'function' ? slide.node(step) : slide.node;

  const noteFor = (s: SlideDef, at: number) =>
    Array.isArray(s.notes) ? (s.notes[Math.min(at, s.notes.length - 1)] ?? '') : (s.notes as string);

  /** Progress counts build steps, not slides, so the bar tracks the talk. */
  const buildsBefore = slides.slice(0, index).reduce((n, s) => n + (s.steps ?? 0) + 1, 0);
  const buildsTotal = slides.reduce((n, s) => n + (s.steps ?? 0) + 1, 0);
  const progress = ((buildsBefore + step + 1) / buildsTotal) * 100;

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
          <m.div
            key={slide.id}
            custom={dir}
            initial={{ opacity: 0, y: 24, filter: 'blur(8px)' }}
            animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
            exit={{ opacity: 0, y: -16, filter: 'blur(6px)' }}
            transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
            className="absolute inset-0"
          >
            {stageNode}
          </m.div>
        </AnimatePresence>

        {/* ── Chrome (navbar-style) ───────────────────────────────────── */}
        <div className="pointer-events-none absolute inset-x-0 top-0 flex items-center justify-between px-6 py-5 sm:px-8">
          <KortixLogo variant="logomark" size={22} className="text-foreground" />
          <div className="pointer-events-auto flex items-center gap-3">
            <Link
              href={altDeck?.href ?? '/presentations'}
              className="text-muted-foreground hover:text-foreground hidden font-mono text-xs tracking-wider transition-colors sm:inline"
            >
              {altDeck?.label ?? 'All decks'} ↗
            </Link>
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
          style={{ width: `${progress}%` }}
        />
      </div>

      {/* ── Floating controls ──────────────────────────────────────────── */}
      <div className="border-border bg-card/90 absolute bottom-5 left-1/2 z-20 flex -translate-x-1/2 items-center gap-1 rounded-sm border p-1.5 shadow-sm backdrop-blur-md">
        <Ctrl onClick={prev} disabled={index === 0 && step === 0} label="Previous">
          <ChevronLeft className="size-4" />
        </Ctrl>
        <span className="text-muted-foreground px-2 font-mono text-xs tabular-nums">
          {String(index + 1).padStart(2, '0')}
          <span className="text-muted-foreground/40"> / {String(total).padStart(2, '0')}</span>
        </span>
        {/* Build pips — how many presses are left on this slide. */}
        {slideSteps > 0 ? (
          <span className="flex items-center gap-1 pr-1">
            {Array.from({ length: slideSteps + 1 }, (_, i) => (
              <span
                key={i}
                className={cn(
                  'size-1.5 rounded-full transition-colors',
                  i <= step ? 'bg-foreground' : 'bg-muted-foreground/25',
                )}
              />
            ))}
          </span>
        ) : null}
        <Ctrl onClick={next} disabled={index === total - 1 && step === slideSteps} label="Next">
          <ChevronRight className="size-4" />
        </Ctrl>
        <span className="bg-border mx-0.5 h-4 w-px" />
        <Ctrl
          onClick={() => setOverview((o) => !o)}
          label={tI18nHardcoded.raw('autoAppPresentationDeckJsxAttrLabelOverviewG38c3b5e4')}
        >
          <Grid2x2 className="size-3.5" />
        </Ctrl>
        <Ctrl
          onClick={toggleFs}
          label={tI18nHardcoded.raw('autoAppPresentationDeckJsxAttrLabelFullscreenF28aed7ac')}
        >
          <Maximize className="size-3.5" />
        </Ctrl>
        {hasNotes ? (
          <Ctrl onClick={() => setNotesOpen((o) => !o)} label="Presenter notes (N)">
            <Notepad className={cn('size-3.5', notesOpen && 'text-foreground')} />
          </Ctrl>
        ) : null}
      </div>

      {/* ── Presenter notes ────────────────────────────────────────────────
          Never on the stage. The deck is screen-recorded, so the script lives
          behind `N` and the recording stays clean. */}
      <AnimatePresence>
        {notesOpen ? (
          <m.aside
            initial={{ y: '100%' }}
            animate={{ y: 0 }}
            exit={{ y: '100%' }}
            transition={{ duration: 0.32, ease: [0.16, 1, 0.3, 1] }}
            className="border-border bg-card/95 absolute inset-x-0 bottom-0 z-40 max-h-[46vh] overflow-y-auto border-t shadow-lg backdrop-blur-md"
          >
            <div className="mx-auto w-full max-w-4xl px-6 py-6 sm:px-8">
              <div className="mb-4 flex items-center justify-between gap-4">
                <span className="text-muted-foreground font-mono text-xs tracking-wider uppercase">
                  {notesAll
                    ? 'Full script'
                    : `Script · ${slide.label}${slideSteps > 0 ? ` · ${step + 1}/${slideSteps + 1}` : ''}`}
                </span>
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => setNotesAll((a) => !a)}
                    className="text-muted-foreground hover:text-foreground border-border rounded-sm border px-2.5 py-1 font-mono text-xs transition-colors"
                  >
                    {notesAll ? 'This slide' : 'Full script'}
                  </button>
                  <button
                    onClick={() => setNotesOpen(false)}
                    aria-label="Close presenter notes"
                    className="text-muted-foreground hover:text-foreground flex size-7 items-center justify-center rounded-sm transition-colors"
                  >
                    <X className="size-4" />
                  </button>
                </div>
              </div>

              {notesAll ? (
                <ol className="space-y-6">
                  {slides.map((s, i) => {
                    const lines = Array.isArray(s.notes)
                      ? s.notes
                      : [(s.notes as string | undefined) ?? '—'];
                    return (
                      <li key={s.id} className="flex gap-4">
                        <span className="text-muted-foreground/50 w-6 shrink-0 pt-0.5 font-mono text-xs tabular-nums">
                          {String(i + 1).padStart(2, '0')}
                        </span>
                        <div className="min-w-0 flex-1">
                          <p className="text-muted-foreground/70 font-mono text-[10px] tracking-widest uppercase">
                            {s.label}
                          </p>
                          {lines.map((line, li) => (
                            <p
                              key={li}
                              className="text-foreground mt-1.5 text-[15px] leading-relaxed whitespace-pre-line"
                            >
                              {lines.length > 1 ? (
                                <span className="text-muted-foreground/40 font-mono text-[11px]">
                                  {`→${li} `}
                                </span>
                              ) : null}
                              {line}
                            </p>
                          ))}
                        </div>
                      </li>
                    );
                  })}
                </ol>
              ) : (
                <p className="text-foreground text-base leading-relaxed whitespace-pre-line">
                  {noteFor(slide, step) || 'No script for this slide.'}
                </p>
              )}
            </div>
          </m.aside>
        ) : null}
      </AnimatePresence>

      {/* ── Overview grid ──────────────────────────────────────────────── */}
      <AnimatePresence>
        {overview ? (
          <m.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="bg-background/95 absolute inset-0 z-30 overflow-y-auto backdrop-blur-sm"
          >
            <div className="flex items-center justify-between px-8 py-6">
              <span className="text-muted-foreground font-mono text-xs tracking-wider uppercase">
                {tI18nHardcoded.raw('autoAppPresentationDeckJsxTextKortix28fe100d')}
                {total} slides
              </span>
              <button
                onClick={() => setOverview(false)}
                className="border-border bg-card text-muted-foreground hover:text-foreground flex size-9 items-center justify-center rounded-sm border transition-colors"
                aria-label={tI18nHardcoded.raw(
                  'autoAppPresentationDeckJsxAttrAriaLabelCloseOverviewf408b52c',
                )}
              >
                <X className="size-4" />
              </button>
            </div>
            <div className="grid grid-cols-2 gap-5 px-8 pb-16 sm:grid-cols-3 lg:grid-cols-4">
              {slides.map((s, i) => (
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
                  {/* Thumbnails show the slide fully built — a half-drawn
                      diagram is unrecognisable at 320px wide. */}
                  {typeof s.node === 'function' ? s.node(s.steps ?? 0) : s.node}
                </Thumb>
              ))}
            </div>
          </m.div>
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
        <span
          className={cn('truncate text-xs', active ? 'text-foreground' : 'text-muted-foreground')}
        >
          {label}
        </span>
      </div>
    </button>
  );
}
