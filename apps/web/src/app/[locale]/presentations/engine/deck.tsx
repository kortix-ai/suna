'use client';

import { useTranslations } from '@/i18n/use-translations';
/**
 * Shared presentation engine: a keyboard-driven deck in the landing page's
 * frame. Each slide is one viewport of the landing (`frame.tsx`); the chrome
 * is the landing navbar's row on top and a hairline row of tools below.
 * Slide changes and panels are instant (motion.md: no motion on a keyboard
 * action). Theme-following, like the landing.
 *
 * Reused by every deck route (e.g. /presentation, /presentation/platform);
 * pass the slide set in via `slides`.
 *
 * → / Space / PageDown / J — next · ← / PageUp / K — prev · Home/End — first/last
 * G or Esc — overview · F — fullscreen · 1–9 — jump · N — presenter notes.
 */

import { ThemeToggle } from '@/components/home/theme-toggle';
import { KortixLogo } from '@/components/sidebar/kortix-logo';
import { cn } from '@kortix/ui';
import {
  CaretLeftIcon as ChevronLeft,
  CaretRightIcon as ChevronRight,
  GridFourIcon as Grid2x2,
  CornersOutIcon as Maximize,
  NotepadIcon as Notepad,
  XIcon as X,
} from '@phosphor-icons/react';
import { MarketingButton } from '@/features/marketing/kit/marketing-button';
import Link from 'next/link';
import { useCallback, useEffect, useEffectEvent, useRef, useState, type ReactNode } from 'react';

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
    (n: number) => {
      setIndex(Math.max(0, Math.min(total - 1, n)));
      setStep(0);
    },
    [total],
  );

  const next = useCallback(() => {
    if (step < stepsOf(index)) {
      setStep((s) => s + 1);
      return;
    }
    if (index >= total - 1) return;
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
  const onKey = useEffectEvent((e: KeyboardEvent) => {
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
        go(0);
        break;
      case 'End':
        e.preventDefault();
        go(total - 1);
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
  });
  useEffect(() => {
    const handler = (e: KeyboardEvent) => onKey(e);
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  const slide = slides[index];
  const slideSteps = stepsOf(index);
  /** The stage cross-fades between slides only — a build step must not remount
      the tree, or the diagrams would restart instead of adding a stage. */
  const stageNode = typeof slide.node === 'function' ? slide.node(step) : slide.node;

  const noteFor = (s: SlideDef, at: number) =>
    Array.isArray(s.notes)
      ? (s.notes[Math.min(at, s.notes.length - 1)] ?? '')
      : (s.notes as string);

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
      {/* ── Stage ──────────────────────────────────────────────────────────
          No animation between slides: navigation is keyboard-driven, and
          motion.md forbids animating a keyboard action. A build step changes
          opacity inside the slide (`Reveal`), so the tree never remounts. */}
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
        <div key={slide.id} className="absolute inset-0">
          {stageNode}
        </div>
      </div>

      {/* ── Top bar: the landing navbar's row ─────────────────────────────── */}
      <div className="absolute inset-x-0 top-0 z-20">
        <div className="bg-border/60 h-px w-full">
          <div className="bg-foreground h-full" style={{ width: `${progress}%` }} />
        </div>
        <div className="mx-auto flex h-16 w-full max-w-[1440px] items-center justify-between px-4 lg:px-24">
          <Link
            href="/presentations"
            className="text-foreground outline-ring flex h-16 items-center rounded-sm focus-visible:outline-2"
          >
            <KortixLogo size={15} variant="logomark" />
          </Link>
          <div className="flex items-center gap-3">
            <span className="text-muted-foreground hidden text-sm tabular-nums sm:inline">
              {String(index + 1).padStart(2, '0')} / {String(total).padStart(2, '0')}
            </span>
            <ThemeToggle />
            <MarketingButton variant="secondary" size="sm" asChild>
              <Link href={altDeck?.href ?? '/presentations'}>
                {altDeck?.label ?? tI18nHardcoded.raw('i18nComplete.text8195b47b3fd3')}
              </Link>
            </MarketingButton>
          </div>
        </div>
      </div>

      {/* ── Bottom bar: label, steps, tools ───────────────────────────────── */}
      <div className="absolute inset-x-0 bottom-0 z-20">
        <div className="mx-auto grid h-16 w-full max-w-[1440px] grid-cols-3 items-center px-4 lg:px-24">
          <span className="text-muted-foreground truncate text-sm">
            <span className="tabular-nums">{String(index + 1).padStart(2, '0')}</span>
            <span> · </span>
            {slide.label}
          </span>
          <div className="flex items-center justify-center gap-2">
            <Ctrl
              onClick={prev}
              disabled={index === 0 && step === 0}
              label={tI18nHardcoded.raw('i18nComplete.texta57b08a480b8')}
            >
              <ChevronLeft className="size-4" />
            </Ctrl>
            {/* Build pips: how many presses are left on this slide. */}
            <span className="flex min-w-8 items-center justify-center gap-1">
              {Array.from({ length: slideSteps + 1 }, (_, i) => (
                <span
                  key={i}
                  className={cn('size-1.5 rounded-full', i <= step ? 'bg-foreground' : 'bg-border')}
                />
              ))}
            </span>
            <Ctrl
              onClick={next}
              disabled={index === total - 1 && step === slideSteps}
              label={tI18nHardcoded.raw('i18nComplete.text1ff57a29d7c9')}
            >
              <ChevronRight className="size-4" />
            </Ctrl>
          </div>
          <div className="flex items-center justify-end gap-1">
            <Ctrl
              onClick={() => setOverview((o) => !o)}
              label={tI18nHardcoded.raw('autoAppPresentationDeckJsxAttrLabelOverviewG38c3b5e4')}
            >
              <Grid2x2 className="size-4" />
            </Ctrl>
            <Ctrl
              onClick={toggleFs}
              label={tI18nHardcoded.raw('autoAppPresentationDeckJsxAttrLabelFullscreenF28aed7ac')}
            >
              <Maximize className="size-4" />
            </Ctrl>
            {hasNotes ? (
              <Ctrl
                onClick={() => setNotesOpen((o) => !o)}
                label={tI18nHardcoded.raw('i18nComplete.text36a27da6cdf2')}
                active={notesOpen}
              >
                <Notepad className="size-4" />
              </Ctrl>
            ) : null}
          </div>
        </div>
      </div>

      {/* ── Presenter notes ────────────────────────────────────────────────
          Never on the stage. The deck is screen-recorded, so the script lives
          behind `N` and the recording stays clean. Opens at once: `N` is a key. */}
      {notesOpen ? (
        <aside className="border-border bg-background absolute inset-x-0 bottom-0 z-40 max-h-[46vh] overflow-y-auto border-t">
          <div className="mx-auto w-full max-w-[1440px] px-8 py-8 lg:px-28">
            <div className="mb-5 flex items-center justify-between gap-4">
              <span className="text-muted-foreground text-sm">
                {notesAll
                  ? tI18nHardcoded.raw('i18nComplete.text46ae82eac49f')
                  : tI18nHardcoded('i18nComplete.text390287e30d47', {
                      value0: slide.label,
                      value1: slideSteps > 0 ? ` · ${step + 1}/${slideSteps + 1}` : '',
                    })}
              </span>
              <div className="flex items-center gap-2">
                <MarketingButton variant="secondary" size="sm" onClick={() => setNotesAll((a) => !a)}>
                  {notesAll
                    ? tI18nHardcoded.raw('i18nComplete.textfd792ae48d11')
                    : tI18nHardcoded.raw('i18nComplete.text46ae82eac49f')}
                </MarketingButton>
                <Ctrl
                  onClick={() => setNotesOpen(false)}
                  label={tI18nHardcoded.raw('i18nComplete.textb0fb3804b44c')}
                >
                  <X className="size-4" />
                </Ctrl>
              </div>
            </div>

            {notesAll ? (
              <ol className="divide-border divide-y">
                {slides.map((s, i) => {
                  const lines = Array.isArray(s.notes)
                    ? s.notes
                    : [(s.notes as string | undefined) ?? '—'];
                  return (
                    <li key={s.id} className="grid grid-cols-12 gap-6 py-5">
                      <span className="text-muted-foreground col-span-3 text-sm">
                        <span className="tabular-nums">{String(i + 1).padStart(2, '0')}</span>
                        <span> · </span>
                        {s.label}
                      </span>
                      <div className="col-span-9 flex flex-col gap-3">
                        {lines.map((line, li) => (
                          <p
                            key={li}
                            className="text-foreground text-base leading-relaxed whitespace-pre-line"
                          >
                            {line}
                          </p>
                        ))}
                      </div>
                    </li>
                  );
                })}
              </ol>
            ) : (
              <p className="text-foreground max-w-3xl text-lg leading-relaxed whitespace-pre-line">
                {noteFor(slide, step) || tI18nHardcoded.raw('i18nComplete.text1b84926d58a9')}
              </p>
            )}
          </div>
        </aside>
      ) : null}

      {/* ── Overview: every slide, fully built, as hairline cells ───────────── */}
      {overview ? (
        <div className="bg-background absolute inset-0 z-30 overflow-y-auto">
          <div className="mx-auto w-full max-w-[1440px]">
            <div className="flex h-16 items-center justify-between px-4 lg:px-24">
              <span className="text-foreground text-sm">
                {tI18nHardcoded.raw('autoAppPresentationDeckJsxTextKortix28fe100d')} {total}{' '}
                {tI18nHardcoded.raw('i18nComplete.textfd2c8f1dc03c')}
              </span>
              <Ctrl
                onClick={() => setOverview(false)}
                label={tI18nHardcoded.raw(
                  'autoAppPresentationDeckJsxAttrAriaLabelCloseOverviewf408b52c',
                )}
              >
                <X className="size-4" />
              </Ctrl>
            </div>
          </div>
          <div className="kx-rail-fade border-y px-4 lg:px-17">
            <div className="bg-border mx-auto grid max-w-[1440px] grid-cols-2 gap-px sm:grid-cols-3 lg:grid-cols-4">
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
                  {/* Thumbnails show the slide fully built: a half-drawn
                      diagram is unrecognisable at this size. */}
                  {typeof s.node === 'function' ? s.node(s.steps ?? 0) : s.node}
                </Thumb>
              ))}
              {/* Fill the last row so no bare border-coloured block shows:
                  2 columns, 3 from `sm`, 4 from `lg`. */}
              {Array.from({ length: (4 - (total % 4)) % 4 }, (_, i) => (
                <div key={`lg-${i}`} aria-hidden className="bg-background hidden lg:block" />
              ))}
              {Array.from({ length: (3 - (total % 3)) % 3 }, (_, i) => (
                <div key={`sm-${i}`} aria-hidden className="bg-background hidden sm:block lg:hidden" />
              ))}
              {Array.from({ length: total % 2 }, (_, i) => (
                <div key={`xs-${i}`} aria-hidden className="bg-background sm:hidden" />
              ))}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Ctrl({
  children,
  onClick,
  disabled,
  active,
  label,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
  label: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className={cn(
        'outline-ring flex size-9 items-center justify-center rounded-sm transition-colors focus-visible:outline-2',
        active ? 'bg-muted text-foreground' : 'text-muted-foreground',
        disabled ? 'opacity-30' : 'hover:bg-muted hover:text-foreground',
      )}
    >
      {children}
    </button>
  );
}

/** Overview cell: the real slide rendered into a 1440×810 frame, scaled to fit. */
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
  const BASE = 1440;
  const s = W / BASE;
  const H = (BASE * 9) / 16;
  return (
    <button
      onClick={onClick}
      className={cn(
        'group flex flex-col items-start gap-3 p-5 text-left transition-colors',
        active ? 'bg-card' : 'bg-background hover:bg-card',
      )}
    >
      <div
        className={cn(
          'bg-background relative overflow-hidden rounded-sm border',
          active ? 'border-foreground' : 'border-border',
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
      <span className="text-sm">
        <span className="text-muted-foreground tabular-nums">{String(n).padStart(2, '0')}</span>
        <span className="text-muted-foreground"> · </span>
        <span className={active ? 'text-foreground' : 'text-muted-foreground'}>{label}</span>
      </span>
    </button>
  );
}
