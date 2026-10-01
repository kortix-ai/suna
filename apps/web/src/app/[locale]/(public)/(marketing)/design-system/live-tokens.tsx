'use client';

/**
 * Live token readouts for /design-system.
 *
 * Nothing in this file holds a token VALUE. Every swatch, rung, step, duration
 * and curve is painted through the real CSS variable or the real compiled
 * utility. The number or color printed beside it is read back with
 * getComputedStyle at runtime. If `globals.css` changes (it is generated from
 * `.agents/skills/kortix-brand/references/visual/visual-system.json`), this page
 * changes with it and cannot drift.
 *
 * The lists that feed these components hold token NAMES only.
 */

import { useTranslations } from '@/i18n/use-translations';
import { cn } from '@/lib/utils';
import { CheckIcon, CopyIcon } from '@phosphor-icons/react';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';

/** True while the page theme is dark. The theme is the `dark` class on <html>. */
export function useIsDark(): boolean {
  const [dark, setDark] = useState(false);
  useEffect(() => {
    const root = document.documentElement;
    const read = () => setDark(root.classList.contains('dark'));
    read();
    const observer = new MutationObserver(read);
    observer.observe(root, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);
  return dark;
}

/** Reads a custom property declared on :root (a plain value, not a color). */
function useRootVar(name: string): string {
  return useSyncExternalStore(
    () => () => {},
    () => getComputedStyle(document.documentElement).getPropertyValue(name).trim(),
    () => '',
  );
}

/** Any CSS color the browser understands, as sRGB hex (#rrggbbaa when translucent). */
function toHex(css: string): string | null {
  if (!css) return null;
  const ctx = document.createElement('canvas').getContext('2d');
  if (!ctx) return null;
  // Paint the opaque color and append the alpha byte: a canvas stores
  // translucent pixels premultiplied, which rounds a 10% white to #f5ffff1a.
  const alphaMatch = css.match(/\/\s*([\d.]+)(%?)\s*\)$/);
  const alpha = alphaMatch ? Number(alphaMatch[1]) / (alphaMatch[2] ? 100 : 1) : 1;
  if (alpha === 0) return null;
  ctx.fillStyle = alphaMatch ? css.replace(/\s*\/\s*[\d.]+%?\s*\)$/, ')') : css;
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
  const channels = alpha === 1 ? [r, g, b] : [r, g, b, Math.round(alpha * 255)];
  return `#${channels.map((n) => n.toString(16).padStart(2, '0')).join('')}`;
}

/** Computed background of `ref`, re-read when the page theme flips. */
function useResolvedBackground(token: string) {
  const ref = useRef<HTMLDivElement>(null);
  const pageDark = useIsDark();
  const [css, setCss] = useState('');
  useEffect(() => {
    if (ref.current) setCss(getComputedStyle(ref.current).backgroundColor);
  }, [pageDark, token]);
  return { ref, css, hex: toHex(css) };
}

/** A value you can click to copy. */
export function CopyValue({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      }}
      className="group inline-flex max-w-full cursor-pointer items-center gap-1.5"
    >
      <span className="text-muted-foreground group-hover:text-foreground truncate font-mono text-xs transition-colors">
        {value}
      </span>
      {copied ? (
        <CheckIcon className="text-kortix-green size-2.5 shrink-0" />
      ) : (
        <CopyIcon className="text-muted-foreground size-2.5 shrink-0" />
      )}
    </button>
  );
}

function SwatchPane({ token, scope, label }: { token: string; scope?: 'dark'; label: string }) {
  const { ref, css, hex } = useResolvedBackground(token);
  return (
    <div className="min-w-0">
      {/* `.dark` on the swatch itself re-declares every token for that element. */}
      <div ref={ref} className={cn('h-14', scope)} style={{ background: `var(${token})` }} />
      <div className="mt-2 flex min-w-0 flex-col gap-0.5 px-3">
        <span className="text-muted-foreground text-xs">{label}</span>
        {/* Hex when opaque. Chrome serializes resolved oklch as lab(), which reads as noise. */}
        <CopyValue value={hex ?? (css || '…')} />
      </div>
    </div>
  );
}

/**
 * One semantic color token. Painted with `var(--token)`. Shows the value the
 * browser resolved, in the page theme and, on a light page, in a `.dark` scope.
 */
export function TokenSwatch({
  token,
  title,
  note,
}: {
  token: string;
  title: string;
  note?: string;
}) {
  const t = useTranslations('hardcodedUi.i18nComplete');
  const pageDark = useIsDark();
  const light = t.raw('text99a7026172d4');
  const dark = t.raw('texte6bb5689beec');
  return (
    <div className="border-border overflow-hidden rounded-md border pb-2.5">
      <div className={cn('grid gap-x-px', pageDark ? 'grid-cols-1' : 'grid-cols-2')}>
        <SwatchPane token={token} label={pageDark ? dark : light} />
        {pageDark ? null : <SwatchPane token={token} scope="dark" label={dark} />}
      </div>
      <div className="mt-2.5 flex items-baseline justify-between gap-2 px-3">
        <span className="text-foreground truncate text-xs font-medium">{title}</span>
        <span className="text-muted-foreground shrink-0 font-mono text-xs">{token}</span>
      </div>
      {note ? <p className="text-muted-foreground mt-1 px-3 text-xs">{note}</p> : null}
    </div>
  );
}

/**
 * A `kortix-*` accent. The dot and the tint use the real utilities, so the page
 * proves they compile. The label beside them stays ink: accents fail AA as body
 * text (D5).
 */
export function AccentRow({
  token,
  name,
  meaning,
  dotClass,
  tintClass,
}: {
  token: string;
  name: string;
  meaning: string;
  /** Full literal class, e.g. `bg-kortix-green`. Tailwind must see it in source. */
  dotClass: string;
  /** Full literal class, e.g. `bg-kortix-green/15`. */
  tintClass: string;
}) {
  const { ref, css, hex } = useResolvedBackground(token);
  return (
    <div className="border-border flex items-center gap-3 border-b py-3 last:border-b-0">
      <div ref={ref} className={cn('size-3 shrink-0 rounded-full', dotClass)} />
      <div className={cn('flex h-6 shrink-0 items-center gap-1.5 rounded-sm px-2', tintClass)}>
        <span className={cn('size-1.5 rounded-full', dotClass)} />
        <span className="text-foreground text-xs">{name}</span>
      </div>
      <span className="text-muted-foreground min-w-0 flex-1 text-xs">{meaning}</span>
      <div className="hidden shrink-0 flex-col items-end sm:flex">
        {/* Hex when opaque. Chrome serializes resolved oklch as lab(), which reads as noise. */}
        <CopyValue value={hex ?? (css || '…')} />
      </div>
    </div>
  );
}

/** One type rung. Sized with `var(--text-<step>)`; the px is measured, not typed. */
export function TypeRow({
  step,
  role,
  sample,
  muted,
}: {
  /** The Tailwind step: `xs`, `sm`, `base`, `2xl`, … */
  step: string;
  role: string;
  sample: string;
  /** Legacy rung: shown, but marked so nobody adds a use. */
  muted?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const size = useRootVar(`--text-${step}`);
  const [px, setPx] = useState('');
  useEffect(() => {
    if (ref.current) setPx(getComputedStyle(ref.current).fontSize);
  }, [size]);
  return (
    <div className="border-border flex items-baseline gap-4 border-b py-3">
      <div className="w-24 shrink-0">
        <span className="text-muted-foreground font-mono text-xs">{`text-${step}`}</span>
      </div>
      <div className="w-28 shrink-0">
        <span className="text-muted-foreground font-mono text-xs">
          {size} · {px}
        </span>
      </div>
      <div className="min-w-0 flex-1">
        <span
          ref={ref}
          className="text-foreground block truncate font-medium"
          style={{ fontSize: `var(--text-${step})` }}
        >
          {sample}
        </span>
      </div>
      <div className="hidden max-w-56 shrink-0 sm:block">
        <span className="text-muted-foreground block truncate text-xs">
          {muted ? `${muted} · ` : ''}
          {role}
        </span>
      </div>
    </div>
  );
}

/** The base step, read from `--spacing`. */
export function SpacingBase() {
  const base = useRootVar('--spacing');
  return <CopyValue value={`--spacing: ${base}`} />;
}

/** One spacing step. Width is `calc(var(--spacing) * step)`; the px is measured. */
export function SpacingRow({ step }: { step: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const base = useRootVar('--spacing');
  const [px, setPx] = useState('');
  useEffect(() => {
    if (ref.current) setPx(`${Math.round(ref.current.getBoundingClientRect().width * 100) / 100}px`);
  }, [base]);
  return (
    <div className="flex items-center gap-4">
      <span className="text-muted-foreground w-8 shrink-0 text-right font-mono text-xs">{step}</span>
      <div
        ref={ref}
        className="bg-foreground h-5 rounded-sm"
        style={{ width: `calc(var(--spacing) * ${step})` }}
      />
      <span className="text-muted-foreground font-mono text-xs">{px}</span>
    </div>
  );
}

function toMs(value: string): string {
  const n = Number.parseFloat(value);
  if (Number.isNaN(n)) return '';
  return `${Math.round(value.endsWith('ms') ? n : n * 1000)}ms`;
}

/**
 * A transition demo that uses the real compiled utilities (`duration-fast`,
 * `ease-out`, …). The readout is the browser's computed transition. A utility
 * that does not compile reads the 150ms default here, so a dead token shows.
 */
export function MotionBar({
  label,
  durationClass,
  easingClass,
  note,
}: {
  label: string;
  /** Full literal class, e.g. `duration-fast`. Tailwind must see it in source. */
  durationClass: string;
  /** Full literal class, e.g. `ease-out`. */
  easingClass: string;
  note?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(false);
  const [read, setRead] = useState({ duration: '', easing: '' });

  useEffect(() => {
    if (!ref.current) return;
    const cs = getComputedStyle(ref.current);
    setRead({ duration: toMs(cs.transitionDuration), easing: cs.transitionTimingFunction });
  }, []);

  const replay = () => {
    setActive(false);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => setActive(true));
    });
  };

  return (
    <div className="flex items-center gap-4">
      <button
        type="button"
        onClick={replay}
        className="text-muted-foreground hover:text-foreground w-28 shrink-0 cursor-pointer text-left font-mono text-xs transition-colors"
      >
        {label}
      </button>
      <div className="bg-muted relative h-7 flex-1 overflow-hidden rounded-md">
        <div
          ref={ref}
          className={cn(
            'bg-foreground absolute inset-y-1 left-1 right-1 origin-left transition-transform',
            durationClass,
            easingClass,
            active ? 'scale-x-100' : 'scale-x-10',
          )}
        />
      </div>
      <div className="flex w-44 shrink-0 flex-col">
        <span className="text-foreground font-mono text-xs">{read.duration}</span>
        <span className="text-muted-foreground truncate font-mono text-xs">{read.easing}</span>
        {note ? <span className="text-muted-foreground truncate text-xs">{note}</span> : null}
      </div>
    </div>
  );
}
