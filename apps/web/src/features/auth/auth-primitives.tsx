'use client';

/**
 * Shared building blocks for the quiet, flat auth dialect: Kortix mark above a
 * left-aligned heading, slim notice strips, six-box code input, and the
 * two-part rise entrance. Used by /auth and every auth sub-surface.
 */

import {
  WarningIcon as DangerTriangleSolid,
  InfoIcon as InfoCircleSolid,
} from '@phosphor-icons/react';
import { m, useReducedMotion } from 'motion/react';
import { useRef } from 'react';

import { inputFocusClasses, inputSurfaceClasses } from '@/components/ui/input';
import { KortixLogo } from '@/components/ui/kortix-logo';
import {
  applyBackspace,
  applyBoxInput,
  CODE_LENGTH,
  insertDigits,
} from '@/features/auth/code-input-logic';
import { cn } from '@/lib/utils';

export const AUTH_EASE = [0.23, 1, 0.32, 1] as const;

/** Gentle entrance: header first, body ~60ms behind. Opacity-only under reduced motion. */
export function Rise({
  delay = 0,
  className,
  children,
}: {
  delay?: number;
  className?: string;
  children: React.ReactNode;
}) {
  const prefersReducedMotion = useReducedMotion();
  return (
    <m.div
      className={className}
      initial={{ opacity: 0, y: prefersReducedMotion ? 0 : 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, delay, ease: AUTH_EASE }}
    >
      {children}
    </m.div>
  );
}

/**
 * The mark on mobile. Pinned to the top-left of the viewport instead of riding
 * above the heading, so the centered column stays purely about the task. Its
 * `left-6` matches the `px-6` gutter of the auth `<main>`, so it sits on the
 * same optical edge as the fields below it. The parent surface must be
 * `relative`. Desktop keeps the inline mark inside `StepHeader`.
 *
 * `kx-auth-mobile-logo` lets globals.css move the mark below the title-bar
 * band in a narrow desktop-shell window, where that corner holds the macOS
 * traffic lights and the frame's Back control.
 */
export function AuthMobileLogo() {
  return (
    <div className="kx-auth-mobile-logo absolute top-6 left-6 z-10 md:hidden">
      <KortixLogo variant="icon" size={22} className="text-foreground" />
    </div>
  );
}

export function StepHeader({
  title,
  tagline,
  description,
  mark,
  markOnMobile = false,
}: {
  /** A string, or a string led by a status mark (a decided approval). */
  title: React.ReactNode;
  /**
   * Replaces the Kortix mark above the title, for a screen about two parties
   * (the Kortix ··· Slack handshake on a channel install). Desktop only, like
   * the mark it replaces: below `md` the frame's own corner logo stands.
   */
  mark?: React.ReactNode;
  /** Show the mark below `md` too. For a header outside `AuthFrame` (a modal),
   *  where no corner logo stands in for it on mobile. */
  markOnMobile?: boolean;
  /** Second line in the same size as the title, dimmed (entry step only). */
  tagline?: string;
  description?: React.ReactNode;
}) {
  return (
    <div className="mb-10">
      {mark ? (
        <div className={markOnMobile ? undefined : 'hidden md:block'}>{mark}</div>
      ) : (
        <KortixLogo variant="icon" size={22} className="text-foreground hidden md:block" />
      )}
      <h1
        className={cn(
          'text-foreground text-2xl font-medium tracking-tight md:mt-6',
          mark && markOnMobile && 'mt-6',
        )}
      >
        {title}
      </h1>
      {tagline ? (
        <p className="text-muted-foreground text-2xl font-medium tracking-tight text-balance">{tagline}</p>
      ) : null}
      {description ? (
        <p className="text-muted-foreground mt-2 text-sm text-pretty">{description}</p>
      ) : null}
    </div>
  );
}

export function FieldLabel({ htmlFor, children }: { htmlFor: string; children: React.ReactNode }) {
  return (
    <label htmlFor={htmlFor} className="text-muted-foreground text-sm font-medium">
      {children}
    </label>
  );
}

export function ErrorStrip({ message }: { message: string }) {
  return (
    <div className="bg-kortix-red/15 text-foreground mb-5 flex items-center gap-2 rounded-md px-3 py-2.5">
      <DangerTriangleSolid weight="fill" className="text-kortix-red size-4 shrink-0" />
      <span className="text-sm">{message}</span>
    </div>
  );
}

export function InfoStrip({ message }: { message: string }) {
  return (
    <div className="bg-muted text-foreground mb-5 flex items-center gap-2 rounded-md px-3 py-2.5">
      <InfoCircleSolid weight="fill" className="text-muted-foreground size-4 shrink-0" />
      <span className="text-sm">{message}</span>
    </div>
  );
}

export function SuccessStrip({ message }: { message: string }) {
  return (
    <div className="bg-muted text-foreground mb-5 flex items-center gap-2 rounded-md px-3 py-2.5">
      <InfoCircleSolid weight="fill" className="text-kortix-green size-4 shrink-0" />
      <span className="text-sm">{message}</span>
    </div>
  );
}

/* ─── Six-box code input ───────────────────────────────────────────────── */

export function CodeInput({
  value,
  onChange,
  disabled,
  autoFocus = true,
  invalid = false,
}: {
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean;
  autoFocus?: boolean;
  /** Marks the boxes destructive and replays the shake (row-level, once). */
  invalid?: boolean;
}) {
  const refs = useRef<Array<HTMLInputElement | null>>([]);

  const focusBox = (i: number) => refs.current[Math.max(0, Math.min(CODE_LENGTH - 1, i))]?.focus();

  const applyEdit = (edit: { next: string; focus: number } | null) => {
    if (!edit) return;
    onChange(edit.next);
    focusBox(edit.focus);
  };

  return (
    <div className={cn('flex gap-2.5', invalid && 'motion-safe:animate-shake')}>
      {Array.from({ length: CODE_LENGTH }, (_, i) => (
        <input
          key={i}
          ref={(el) => {
            refs.current[i] = el;
          }}
          type="text"
          inputMode="numeric"
          autoComplete={i === 0 ? 'one-time-code' : 'off'}
          aria-label={`Digit ${i + 1}`}
          value={value[i] ?? ''}
          disabled={disabled}
          autoFocus={autoFocus && i === 0}
          onChange={(e) => {
            applyEdit(applyBoxInput(value, i, e.target.value));
          }}
          onKeyDown={(e) => {
            if (e.key === 'Backspace') {
              e.preventDefault();
              applyEdit(applyBackspace(value, i));
            } else if (e.key === 'ArrowLeft') {
              focusBox(i - 1);
            } else if (e.key === 'ArrowRight') {
              focusBox(i + 1);
            }
          }}
          onPaste={(e) => {
            e.preventDefault();
            const digits = e.clipboardData.getData('text').replace(/\D/g, '');
            if (digits) applyEdit(insertDigits(value, i, digits));
          }}
          onFocus={(e) => e.currentTarget.select()}
          aria-invalid={invalid || undefined}
          className={cn(
            inputSurfaceClasses,
            inputFocusClasses,
            'text-foreground aria-invalid:border-destructive size-12 text-center text-lg font-medium tabular-nums transition-[border-color,box-shadow] duration-(--duration-fast) disabled:opacity-50',
          )}
        />
      ))}
    </div>
  );
}
