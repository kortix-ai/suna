'use client';

/**
 * Tool-view design system — shared primitives.
 *
 * Vercel-level mono aesthetic:
 *   • Hairline borders (`border-border/50`) and subtle fills (`bg-foreground/[0.02–0.04]`).
 *   • Tight typography — 12.5px titles, 11.5px metadata, tracking-tight.
 *   • Numeric values use `tabular-nums`.
 *   • Status conveyed by tiny dots + label, not colored pills.
 *   • Sections separated by 1px dividers, not card-in-card.
 *
 * Every tool-view file should compose these instead of rolling its own Card
 * / CardHeader / Badge chrome. That's how the new look stays consistent.
 */

import React from 'react';
import { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

// ── Shell ────────────────────────────────────────────────────────────────────

interface ToolViewShellProps {
  children: React.ReactNode;
  className?: string;
}

/**
 * Outer container for every tool view: full-height card with hairline edges,
 * `bg-card` so it lifts gently off the panel background.
 */
export function ToolViewShell({ children, className }: ToolViewShellProps) {
  return (
    <div
      className={cn(
        'flex flex-col h-full overflow-hidden bg-card text-foreground',
        className,
      )}
      data-slot="tool-view-shell"
    >
      {children}
    </div>
  );
}

// ── Header ───────────────────────────────────────────────────────────────────

interface ToolViewHeadProps {
  icon: LucideIcon;
  title: string;
  /** Path / detail rendered inline next to the title in mono. */
  detail?: string;
  /** Right-aligned action area — usually small text + dots. */
  actions?: React.ReactNode;
  /** Optional click handler for the title (e.g. open file). */
  onTitleClick?: () => void;
  className?: string;
}

/**
 * Tight header row. One line, hairline bottom border, no fills.
 *   [icon] Title  · /optional/path                              <actions>
 */
export function ToolViewHead({
  icon: Icon,
  title,
  detail,
  actions,
  onTitleClick,
  className,
}: ToolViewHeadProps) {
  return (
    <div
      className={cn(
        'flex-shrink-0 h-10 px-4 flex items-center gap-2.5 border-b border-border/50',
        className,
      )}
    >
      <Icon className="w-3.5 h-3.5 text-muted-foreground/70 flex-shrink-0" />
      <div className="flex items-baseline gap-2 min-w-0 flex-1 overflow-hidden">
        {onTitleClick ? (
          <button
            type="button"
            onClick={onTitleClick}
            className="text-[12.5px] font-medium tracking-tight truncate hover:text-foreground/70 transition-colors cursor-pointer"
          >
            {title}
          </button>
        ) : (
          <span className="text-[12.5px] font-medium tracking-tight truncate">{title}</span>
        )}
        {detail && (
          <span
            className="text-[11.5px] text-muted-foreground/60 font-mono truncate"
            title={detail}
          >
            {detail}
          </span>
        )}
      </div>
      {actions && <div className="flex items-center gap-2 flex-shrink-0">{actions}</div>}
    </div>
  );
}

// ── Body ─────────────────────────────────────────────────────────────────────

interface ToolViewBodyProps {
  children: React.ReactNode;
  /** Remove default padding (when the inner content owns its own padding). */
  padded?: boolean;
  className?: string;
}

/**
 * Scrollable body region. Padding is on by default at the section level —
 * pass `padded={false}` for full-bleed content like diffs.
 */
export function ToolViewBody({ children, padded = true, className }: ToolViewBodyProps) {
  return (
    <div
      className={cn(
        'flex-1 min-h-0 overflow-auto',
        padded && 'px-4 py-3',
        className,
      )}
    >
      {children}
    </div>
  );
}

// ── Section ──────────────────────────────────────────────────────────────────

interface ToolViewSectionProps {
  /** Uppercase label rendered above the section. */
  label?: string;
  /** Right-aligned slot on the label row (e.g. counts, copy button). */
  labelRight?: React.ReactNode;
  children: React.ReactNode;
  /** Skip the inner gap (let children handle their own spacing). */
  flush?: boolean;
  className?: string;
}

/**
 * Labeled content block. Label sits above content in tracked uppercase
 * lowercase muted text. No card-in-card nesting.
 */
export function ToolViewSection({
  label,
  labelRight,
  children,
  flush = false,
  className,
}: ToolViewSectionProps) {
  return (
    <section className={cn('flex flex-col', !flush && 'gap-2', className)}>
      {(label || labelRight) && (
        <div className="flex items-center justify-between">
          {label ? <ToolViewLabel>{label}</ToolViewLabel> : <span />}
          {labelRight && (
            <div className="flex items-center gap-2 text-[11px] text-muted-foreground/70 tracking-tight">
              {labelRight}
            </div>
          )}
        </div>
      )}
      {children}
    </section>
  );
}

// ── Label ────────────────────────────────────────────────────────────────────

export function ToolViewLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-[10.5px] font-medium uppercase tracking-[0.08em] text-muted-foreground/60">
      {children}
    </span>
  );
}

// ── Footer ───────────────────────────────────────────────────────────────────

interface ToolViewFootProps {
  /** Left-aligned status / summary (small text). */
  children?: React.ReactNode;
  /** Right-aligned timestamp string. */
  timestamp?: string;
  className?: string;
}

export function ToolViewFoot({ children, timestamp, className }: ToolViewFootProps) {
  return (
    <div
      className={cn(
        'flex-shrink-0 h-9 px-4 flex items-center justify-between gap-3 border-t border-border/50 text-[11.5px] tracking-tight',
        className,
      )}
    >
      <div className="flex items-center gap-2 text-muted-foreground/80 min-w-0 truncate">
        {children}
      </div>
      {timestamp && (
        <span className="text-[11px] text-muted-foreground/60 tabular-nums flex-shrink-0">
          {timestamp}
        </span>
      )}
    </div>
  );
}

// ── Status Dot ───────────────────────────────────────────────────────────────

type StatusTone = 'active' | 'success' | 'idle' | 'error' | 'warn';

const TONE_CLASS: Record<StatusTone, string> = {
  active: 'bg-foreground animate-pulse',
  success: 'bg-foreground',
  idle: 'bg-foreground/35',
  error: 'bg-red-500/80',
  warn: 'bg-foreground/60',
};

export function StatusDot({
  tone = 'idle',
  className,
}: {
  tone?: StatusTone;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn('w-1.5 h-1.5 rounded-full flex-shrink-0', TONE_CLASS[tone], className)}
    />
  );
}

interface StatusProps {
  tone?: StatusTone;
  children: React.ReactNode;
}

/** Inline status: tiny dot + label, no chip background. */
export function Status({ tone = 'idle', children }: StatusProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 text-[11px] tracking-tight',
        tone === 'error' ? 'text-red-500/90' : 'text-muted-foreground/80',
      )}
    >
      <StatusDot tone={tone} />
      {children}
    </span>
  );
}

// ── KeyValueRow ──────────────────────────────────────────────────────────────

interface KeyValueRowProps {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
}

/**
 * Single key/value line. Used for metadata blocks (id, created, updated,
 * branch, etc.). Label is muted-foreground, value is foreground.
 */
export function KeyValueRow({ label, value, mono = false }: KeyValueRowProps) {
  return (
    <div className="flex items-baseline gap-3 text-[12px] py-1">
      <span className="text-muted-foreground/60 w-20 flex-shrink-0 tracking-tight">{label}</span>
      <span
        className={cn(
          'min-w-0 flex-1 truncate text-foreground/90',
          mono && 'font-mono text-[11.5px]',
        )}
      >
        {value}
      </span>
    </div>
  );
}

// ── CodeBlock ────────────────────────────────────────────────────────────────

interface CodeBlockProps {
  children: React.ReactNode;
  /** Tag rendered as a faint top-right label (e.g. "bash", "json"). */
  lang?: string;
  className?: string;
}

/**
 * Quiet monospace code container. No chunky fills — hairline border + the
 * subtlest tint so it lifts off the panel without shouting.
 */
export function CodeBlock({ children, lang, className }: CodeBlockProps) {
  return (
    <div
      className={cn(
        'relative rounded-2xl border border-border/50 bg-foreground/[0.025] overflow-hidden',
        className,
      )}
    >
      {lang && (
        <span className="absolute top-1.5 right-2 text-[10px] font-mono text-muted-foreground/40 uppercase tracking-wider select-none">
          {lang}
        </span>
      )}
      <pre className="p-3 font-mono text-[12px] leading-relaxed text-foreground/85 whitespace-pre-wrap break-words overflow-x-auto">
        {children}
      </pre>
    </div>
  );
}

// ── Divider ──────────────────────────────────────────────────────────────────

export function ToolViewDivider({ className }: { className?: string }) {
  return <div role="separator" className={cn('h-px bg-border/50', className)} />;
}

// ── Counters / inline metadata bits ─────────────────────────────────────────

export function Counter({
  value,
  label,
}: {
  value: React.ReactNode;
  label?: string;
}) {
  return (
    <span className="inline-flex items-baseline gap-1 text-[11px] text-muted-foreground/80 tracking-tight tabular-nums">
      <span className="text-foreground/90 font-medium">{value}</span>
      {label && <span>{label}</span>}
    </span>
  );
}

/** Subtle `+N / -N` paired counters for diff-ish summaries. */
export function DiffCounter({ adds = 0, dels = 0 }: { adds?: number; dels?: number }) {
  if (!adds && !dels) return null;
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] font-mono tracking-tight tabular-nums">
      {adds > 0 && <span className="text-foreground/85">+{adds}</span>}
      {dels > 0 && <span className="text-muted-foreground/70">−{dels}</span>}
    </span>
  );
}
