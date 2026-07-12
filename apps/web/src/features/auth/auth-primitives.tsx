'use client';

/**
 * Shared building blocks for the quiet, flat auth dialect: Kortix mark above a
 * left-aligned heading, slim notice strips, six-box code input, and the
 * two-part rise entrance. Used by /auth and every auth sub-surface.
 */

import { DangerTriangleSolid, InfoCircleSolid } from '@mynaui/icons-react';
import { motion, useReducedMotion } from 'motion/react';
import { useRef } from 'react';

import { KortixLogo } from '@/components/ui/kortix-logo';
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
    <motion.div
      className={className}
      initial={{ opacity: 0, y: prefersReducedMotion ? 0 : 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, delay, ease: AUTH_EASE }}
    >
      {children}
    </motion.div>
  );
}

export function StepHeader({
  title,
  tagline,
  description,
}: {
  title: string;
  /** Second line in the same size as the title, dimmed (entry step only). */
  tagline?: string;
  description?: React.ReactNode;
}) {
  return (
    <div className="mb-10">
      <KortixLogo variant="icon" size={22} className="text-foreground" />
      <h1 className="text-foreground mt-6 text-2xl font-medium tracking-tight">{title}</h1>
      {tagline ? (
        <p className="text-muted-foreground/60 text-2xl font-medium tracking-tight">{tagline}</p>
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
    <div className="border-destructive/20 bg-destructive/10 text-destructive mb-5 flex items-center gap-2 rounded-md border px-3 py-2.5">
      <DangerTriangleSolid className="size-4 shrink-0" />
      <span className="text-sm">{message}</span>
    </div>
  );
}

export function InfoStrip({ message }: { message: string }) {
  return (
    <div className="border-border bg-muted/60 text-foreground/80 mb-5 flex items-center gap-2 rounded-md border px-3 py-2.5">
      <InfoCircleSolid className="size-4 shrink-0" />
      <span className="text-sm">{message}</span>
    </div>
  );
}

export function SuccessStrip({ message }: { message: string }) {
  return (
    <div className="border-border bg-muted/60 text-foreground/80 mb-5 flex items-center gap-2 rounded-md border px-3 py-2.5">
      <InfoCircleSolid className="text-kortix-green size-4 shrink-0" />
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

  const focusBox = (i: number) => refs.current[Math.max(0, Math.min(5, i))]?.focus();

  const insertAt = (i: number, text: string) => {
    const digits = text.replace(/\D/g, '');
    if (!digits) return;
    const next = (value.slice(0, i) + digits + value.slice(i + digits.length)).slice(0, 6);
    onChange(next);
    focusBox(i + digits.length);
  };

  return (
    <div className={cn('flex gap-2.5', invalid && 'motion-safe:animate-shake')}>
      {Array.from({ length: 6 }, (_, i) => (
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
            const v = e.target.value;
            insertAt(i, v.length > 1 ? v.slice(-1) : v);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Backspace') {
              e.preventDefault();
              if (value[i]) {
                onChange(value.slice(0, i) + value.slice(i + 1));
              } else {
                onChange(value.slice(0, Math.max(0, i - 1)) + value.slice(i));
                focusBox(i - 1);
              }
            } else if (e.key === 'ArrowLeft') {
              focusBox(i - 1);
            } else if (e.key === 'ArrowRight') {
              focusBox(i + 1);
            }
          }}
          onPaste={(e) => {
            e.preventDefault();
            insertAt(i, e.clipboardData.getData('text'));
          }}
          onFocus={(e) => e.currentTarget.select()}
          aria-invalid={invalid || undefined}
          className="border-border bg-input text-foreground focus:border-kortix-blue aria-invalid:border-destructive size-12 rounded-md border text-center text-lg font-medium tabular-nums transition-[border-color] outline-none disabled:opacity-50"
        />
      ))}
    </div>
  );
}
