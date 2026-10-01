'use client';

/**
 * Shared vocabulary for the auth consent/status sub-surfaces (CLI, OAuth,
 * Slack, Teams, tunnel, GitHub setup): the same quiet frame as /auth, plus a
 * pending screen, terminal status screens, and flat detail rows.
 */

import { CopyButton } from '@/components/markdown/copy-button';
import { Badge } from '@/components/ui/badge';
import Loading from '@/components/ui/loading';
import { successToast } from '@/components/ui/toast';
import { AuthFrame } from '@/features/auth/auth-card-shell';
import { Rise, StepHeader } from '@/features/auth/auth-primitives';
import { useTranslations } from '@/i18n/use-translations';
import { cn } from '@/lib/utils';
import { CheckCircleIcon, MinusCircleIcon, XCircleIcon } from '@phosphor-icons/react';

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
 * own case, in mono at normal tracking.
 *
 * No copy or check glyph: the badge reads as the command and nothing else. A
 * toast says the copy happened, so the feedback is not lost with the icon.
 */
export function CopyCommandBadge({ command }: { command: string }) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      successToast(tI18nComplete.raw('text8d525e5f158b'));
    } catch {
      // A blocked clipboard leaves the command readable in place.
    }
  };
  return (
    <Badge asChild variant="secondary">
      <button
        type="button"
        onClick={copy}
        aria-label={`${tI18nComplete.raw('texte21f935f11d7')} ${command}`}
        className="hover:bg-secondary focus-visible:ring-ring align-baseline font-mono tracking-normal normal-case transition-[background-color,scale] outline-none focus-visible:ring-2 active:scale-[0.96]"
      >
        {command}
      </button>
    </Badge>
  );
}

const OUTCOME_MARK = {
  success: { icon: CheckCircleIcon, className: 'text-kortix-green' },
  destructive: { icon: XCircleIcon, className: 'text-kortix-red' },
  muted: { icon: MinusCircleIcon, className: 'text-muted-foreground' },
} as const;

/**
 * A title that states an outcome ("Action approved", "GitHub connected"): the
 * words at the leading edge, the mark at the trailing edge. The words carry the
 * meaning; the mark and its colour repeat it.
 */
export function OutcomeTitle({
  tone,
  children,
}: {
  tone: keyof typeof OUTCOME_MARK;
  children: React.ReactNode;
}) {
  const { icon: Icon, className } = OUTCOME_MARK[tone];
  return (
    <span className="flex items-center justify-between gap-3">
      <span className="min-w-0">{children}</span>
      <Icon weight="fill" aria-hidden className={cn('size-6 shrink-0', className)} />
    </span>
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
      <dd
        className={cn(
          'text-foreground truncate text-sm',
          mono && 'font-mono text-xs tracking-normal',
        )}
      >
        {value}
      </dd>
    </div>
  );
}
