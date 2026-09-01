'use client';

import { cn } from '@/lib/utils';
import { AnimatePresence, m, useReducedMotion } from 'motion/react';
import { useEffect, useMemo, useState } from 'react';

import { COMPOSER_TEXT_METRICS } from './composer-text-metrics';

/** Same idiom as `project-sidebar.tsx` — module-level, SSR-safe (false on the server). */
const isMac = typeof navigator !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.platform);

/** How long each hint stays before rotating to the next. */
const HOLD_MS = 6000;

/**
 * The swap animations, verbatim from `session-busy-indicator.tsx` so the two
 * rotating-text surfaces in a session read as one system: the outgoing line
 * rolls up and out while the incoming one rolls up from below (`popLayout`
 * overlaps them — a ticker, not a crossfade). `translateY(±100%)` is
 * self-relative, so the roll distance is exactly one line at any font size,
 * and the full `transform` string keeps it hardware-accelerated.
 */
const ROLL_SWAP = {
  initial: { transform: 'translateY(100%)', opacity: 0 },
  animate: { transform: 'translateY(0%)', opacity: 1 },
  exit: { transform: 'translateY(-100%)', opacity: 0 },
  transition: { type: 'spring', duration: 0.4, bounce: 0 },
} as const;

const FADE_SWAP = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  exit: { opacity: 0 },
  transition: { duration: 0.2, ease: 'easeOut' },
} as const;

/**
 * The rotating hint copy. Every line is pinned to a shortcut or feature that
 * actually exists in THIS composer — the old list claimed "Up arrow to recall
 * your last prompt", a textarea-era feature the TipTap rebuild dropped, so a
 * new line only enters this list with its handler named:
 *
 *  - `/` and `@`      → editor/composer-editor.tsx suggestion extensions
 *  - ⌘K / Ctrl+K      → workspace/command-palette.tsx
 *  - Tab              → `cycleAgent` in composer.tsx
 *  - ⌘, / Ctrl+,      → `useSettingsKeyboardShortcut` (project-settings-nav.tsx)
 *  - Shift+Enter      → hard break in editor/extensions.ts
 *  - drag & drop      → `handleDropFiles` in composer.tsx
 *
 * `base` is always index 0. That is what makes the platform-aware shortcuts
 * hydration-safe: the server renders index 0 (no `navigator`, no ⌘/Ctrl
 * decision in it), and every shortcut variant appears only after the first
 * client-side interval tick.
 */
export function buildPlaceholderVariants(base: string, mac: boolean): string[] {
  const mod = mac ? '⌘' : 'Ctrl+';
  return [
    base,
    'Type / for skills, commands, and files',
    'Type @ to mention files and agents',
    'Ask about any file in your workspace',
    `Press ${mod}K to open the command palette`,
    'Press Tab to switch agents',
    'Drag and drop files to attach them',
    "Ask what's changed in your project",
    'Press Shift+Enter for a new line',
    `Press ${mod}, to open settings`,
    'Ask to compact the session when it gets long',
  ];
}

export interface AnimatedComposerPlaceholderProps {
  /** The caller's base placeholder — always the first (and SSR-rendered) frame. */
  placeholder: string;
  /**
   * Empty draft, no lock, not disabled. While false the component renders
   * nothing and the interval stops; the editor's own static placeholder
   * takes over (locks and disabled states keep their functional copy).
   */
  active: boolean;
}

/**
 * The rotating placeholder, drawn OVER the TipTap editor rather than in it.
 *
 * TipTap's Placeholder extension paints a `::before` pseudo-element
 * (`content: attr(data-placeholder)` — globals.css), and pseudo-element
 * content cannot animate between two strings. So while this overlay is
 * active the composer passes `''` to the editor — the `::before` renders
 * empty — and this absolutely-positioned sibling carries the visible text.
 * `aria-hidden` + `pointer-events-none`: it is decoration over a live
 * textbox whose `aria-label` already names it.
 *
 * `initial={false}`: no roll-in on mount, and none when the overlay comes
 * back after a draft is deleted — a restored placeholder should read as
 * state, not an event. Only the interval's rotation animates.
 */
export function AnimatedComposerPlaceholder({
  placeholder,
  active,
}: AnimatedComposerPlaceholderProps) {
  const reduceMotion = useReducedMotion();
  const variants = useMemo(() => buildPlaceholderVariants(placeholder, isMac), [placeholder]);
  const [index, setIndex] = useState(0);

  // The index survives deactivation on purpose: type, delete, and the
  // rotation resumes where it was instead of restarting the same first hints.
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => {
      setIndex((i) => (i + 1) % variants.length);
    }, HOLD_MS);
    return () => clearInterval(id);
  }, [active, variants.length]);

  if (!active) return null;

  const swap = reduceMotion ? FADE_SWAP : ROLL_SWAP;

  return (
    <div
      aria-hidden
      // `inset-x-2` mirrors the wrapper's `px-2`; the font classes mirror
      // `ComposerEditor`'s own, so the overlay sits exactly where the static
      // placeholder would. `overflow-hidden` clips the roll to one line.
      //
      // `COMPOSER_TEXT_METRICS` is the rest of that mirror, and it is NOT
      // optional: `inset-x-2` only reaches the wrapper's padding box, so any
      // horizontal padding on the contenteditable inside it is invisible from
      // out here. Without this the overlay draws its first glyph at the
      // wrapper's edge while the caret underneath it sits one inset further
      // in — the placeholder and the cursor stop agreeing on where the line
      // starts. See composer-text-metrics.ts.
      className={cn(
        'text-muted-foreground pointer-events-none absolute inset-x-1 top-0 overflow-hidden text-sm',
        COMPOSER_TEXT_METRICS,
      )}
    >
      <AnimatePresence mode="popLayout" initial={false}>
        <m.span
          key={`${index}:${variants[index]}`}
          initial={swap.initial}
          animate={swap.animate}
          exit={swap.exit}
          transition={swap.transition}
          className="block min-w-0 truncate"
        >
          {variants[index]}
        </m.span>
      </AnimatePresence>
    </div>
  );
}
