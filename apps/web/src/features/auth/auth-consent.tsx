'use client';

/**
 * Shared vocabulary for the auth consent/status sub-surfaces (CLI, OAuth,
 * Slack, Teams, tunnel, GitHub setup): the same quiet frame as /auth, plus a
 * pending screen, terminal status screens, and flat detail rows.
 */

import { CopyButton } from '@/components/markdown/copy-button';
import { Badge } from '@/components/ui/badge';
import { Copy } from '@/features/icon/icons/copy';
import { useTranslations } from '@/i18n/use-translations';
import { CheckIcon } from '@phosphor-icons/react';
import { AnimatePresence, m } from 'motion/react';
import { useState } from 'react';
import Loading from '@/components/ui/loading';
import { AuthFrame } from '@/features/auth/auth-card-shell';
import { Rise, StepHeader } from '@/features/auth/auth-primitives';
import { cn } from '@/lib/utils';

/** Session checks and initial fetches — the frame with a quiet spinner. */
export function AuthPendingScreen({
  footer = true,
}: {
  /**
   * Pass `false` when the screen this resolves into carries no legal line, so
   * the footer does not flash for the length of one fetch and then disappear.
   * Inside a consent flow leave it on: it stays pinned across the swap.
   */
  footer?: boolean;
}) {
  return (
    <AuthFrame footerVariant={footer ? 'default' : 'none'}>
      <div className="flex justify-center">
        <Loading className="text-muted-foreground size-5" />
      </div>
    </AuthFrame>
  );
}

/**
 * Terminal states (connected, denied, expired, missing link). Tone lives in
 * the copy; the frame stays as quiet as the /auth welcome state.
 */
export function AuthStatusScreen({
  title,
  description,
  action,
}: {
  title: string;
  description: React.ReactNode;
  /** Optional row below the header — a button or a quiet link. */
  action?: React.ReactNode;
}) {
  return (
    <AuthFrame>
      <Rise>
        <StepHeader title={title} description={description} />
      </Rise>
      {action ? <Rise delay={0.06}>{action}</Rise> : null}
    </AuthFrame>
  );
}

/** A one-line terminal command with the canonical animated copy button. */
export function CopyCommand({ command }: { command: string }) {
  return (
    <div className="border-border flex items-center justify-between gap-3 rounded-md border py-1.5 pr-1.5 pl-3.5">
      <code className="text-foreground truncate font-mono text-sm">{command}</code>
      <CopyButton code={command} />
    </div>
  );
}

/**
 * A command named inside a sentence ("Disconnect anytime with `/kortix logout`"),
 * as a badge that copies itself on click. The badge base is uppercase with
 * tight tracking, which is wrong for a command someone will type: it keeps its
 * own case and normal mono tracking.
 */
export function CopyCommandBadge({ command }: { command: string }) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // A blocked clipboard leaves the command readable in place.
    }
  };
  return (
    <Badge asChild variant="secondary">
      <button
        type="button"
        onClick={copy}
        aria-label={copied ? 'Copied' : `${tI18nComplete.raw('texte21f935f11d7')} ${command}`}
        className="hover:bg-secondary focus-visible:ring-ring gap-1.5 align-baseline tracking-normal normal-case transition-[background-color,scale] outline-none focus-visible:ring-2 active:scale-[0.96]"
      >
        {command}
        <span aria-hidden className="relative inline-flex size-3 shrink-0">
          <AnimatePresence initial={false} mode="popLayout">
            <m.span
              key={copied ? 'check' : 'copy'}
              initial={{ scale: 0.25, opacity: 0, filter: 'blur(4px)' }}
              animate={{ scale: 1, opacity: 1, filter: 'blur(0px)' }}
              exit={{ scale: 0.25, opacity: 0, filter: 'blur(4px)' }}
              transition={{ type: 'spring', duration: 0.3, bounce: 0 }}
              className="absolute inset-0 inline-flex items-center justify-center"
            >
              {copied ? <CheckIcon className="size-3" /> : <Copy className="size-3" />}
            </m.span>
          </AnimatePresence>
        </span>
      </button>
    </Badge>
  );
}

/** Flat bordered list for the facts behind a consent decision. */
export function DetailPanel({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <dl className={cn('border-border divide-border/60 divide-y rounded-md border', className)}>
      {children}
    </dl>
  );
}

export function DetailRow({
  label,
  value,
  mono,
}: {
  label: string;
  value: React.ReactNode;
  /** For technical values only (host:port, device codes) — not emails. */
  mono?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-3 px-3.5 py-2.5">
      <dt className="text-muted-foreground shrink-0 text-sm">{label}</dt>
      <dd className={cn('text-foreground truncate text-sm', mono && 'font-mono text-xs')}>
        {value}
      </dd>
    </div>
  );
}
