'use client';

import { useTranslations } from '@/i18n/use-translations';

import { ArrowCounterClockwiseIcon as RotateCcw } from '@phosphor-icons/react';
import type { ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import Loading from '@/components/ui/loading';
import { ErrorState } from '@/features/layout/section/error-state';
import type { SessionNoticeProps } from '@/features/session/session-notice-banner';
import { SidebarToggle } from '@/features/workspace/project-layout/sidebar-toggle';
import { useSandboxConnection } from '@/hooks/platform/use-sandbox-connection';

export function ProjectSessionRuntimeConnection({ children }: { children: ReactNode }) {
  // MID-SESSION reconnect detection only. Initial readiness is server-truth (seeded
  // by useSession from /start); this poller keeps the SDK-unified connection store's
  // status fresh so the reconnect/offline UI fires if the box drops after boot.
  useSandboxConnection();
  return <>{children}</>;
}

/* ─── The one Restart control ──────────────────────────────────────────── */

/**
 * Every terminal card on this route offers the same restart, so it renders from
 * one component: a real pending state (spinner + label + disabled, so a second
 * click cannot fire a second reboot) and no bespoke copy to drift.
 */
export function RestartSessionButton({
  restart,
  onRestart,
  label,
  pendingLabel,
}: {
  restart: { isPending: boolean };
  onRestart: () => void;
  label?: string;
  pendingLabel?: string;
}) {
  const t = useTranslations('sessionPage');
  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      onClick={onRestart}
      disabled={restart.isPending}
      aria-busy={restart.isPending}
    >
      {restart.isPending ? (
        <Loading className="size-3.5 shrink-0" />
      ) : (
        <RotateCcw className="size-3.5 shrink-0" />
      )}
      {restart.isPending ? (pendingLabel ?? t('restart.pending')) : (label ?? t('restart.label'))}
    </Button>
  );
}

/* ─── Headerless full-screen surfaces ──────────────────────────────────── */

/**
 * The sidebar opener for every surface on this route that has no header.
 *
 * `SessionSiteHeader` carries the opener, and it only renders once the chat
 * (or the instant shell) mounts. Every state before or instead of that — the
 * boot loader, the session-switch loader, the billing gate, and all five
 * terminal cards — is a bare centred block. Collapse the sidebar, then open a
 * session that is booting, stopped, or broken, and there was no control on
 * screen to bring the panel back: the app's primary navigation surface was
 * reachable only by reloading the page. That is the state a user is MOST
 * likely to want to leave.
 *
 * `SidebarToggle` self-gates — it returns null with no sidebar context, on the
 * Electron shell (which draws the canonical opener in the OS title-bar band),
 * and while the panel is already docked open on desktop — so wrapping every
 * such surface unconditionally cannot produce a second opener. `relative` is
 * load-bearing: the toggle positions itself `absolute top-2 left-2` against
 * the nearest positioned ancestor.
 */
export function HeaderlessSessionSurface({ children }: { children: ReactNode }) {
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <SidebarToggle placement="floating" />
      {children}
    </div>
  );
}

/* ─── Inline error card (used inside the project shell) ────────────────── */

export function InlineSessionError({
  title,
  message,
  detail,
  action,
}: {
  title: string;
  message: string;
  detail?: string;
  action?: ReactNode;
}) {
  return (
    <HeaderlessSessionSurface>
      <div className="flex min-h-0 flex-1 items-center justify-center px-6">
        <ErrorState
          title={title}
          description={message}
          action={
            detail || action ? (
              <div className="flex max-w-sm flex-col items-center gap-3">
                {detail ? (
                  <code className="border-border/60 bg-muted/40 text-muted-foreground max-w-full rounded-md border px-2 py-1 font-mono text-xs leading-relaxed break-all">
                    {detail}
                  </code>
                ) : null}
                {action}
              </div>
            ) : undefined
          }
        />
      </div>
    </HeaderlessSessionSurface>
  );
}

/* ─── The card-or-notice presenter ─────────────────────────────────────── */

/**
 * One terminal state, presented twice: a full-screen `InlineSessionError` when
 * there is no transcript to read (the card replaces the route), and a
 * composer-slot notice when the conversation stays on screen (nothing covers
 * it). The pair shares ONE title and ONE action; the notice's message prefers
 * the restart error when there is one — the caller folds it into
 * `noticeMessage` — while only the full-screen card carries the monospace
 * `detail` line. `tone` is optional: the destructive states pass it, the
 * legacy/dormant ones keep the default.
 */
export function presentTerminal({
  hasTranscript,
  title,
  message,
  noticeMessage,
  detail,
  action,
  tone,
}: {
  hasTranscript: boolean;
  title: string;
  message: string;
  noticeMessage: string;
  detail?: string;
  action: ReactNode;
  tone?: SessionNoticeProps['tone'];
}): { fullScreen: ReactNode | null; notice: SessionNoticeProps | null } {
  if (!hasTranscript) {
    return {
      fullScreen: (
        <InlineSessionError title={title} message={message} detail={detail} action={action} />
      ),
      notice: null,
    };
  }
  return {
    fullScreen: null,
    notice: { ...(tone ? { tone } : {}), title, message: noticeMessage, action },
  };
}
