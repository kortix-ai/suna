'use client';

/**
 * Shared vocabulary for the auth consent/status sub-surfaces (CLI, OAuth,
 * Slack, Teams, tunnel, GitHub setup): the same quiet frame as /auth, plus a
 * pending screen, terminal status screens, and flat detail rows.
 */

import { CopyButton } from '@/components/markdown/copy-button';
import Loading from '@/components/ui/loading';
import { AuthFrame } from '@/features/auth/auth-card-shell';
import { Rise, StepHeader } from '@/features/auth/auth-primitives';
import { cn } from '@/lib/utils';

/** Session checks and initial fetches — the frame with a quiet spinner. */
export function AuthPendingScreen() {
  return (
    <AuthFrame>
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
