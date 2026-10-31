/**
 * The Inbox screen: the person's notifications across projects (SPEC §5).
 *
 * This file is the data half. The list, the unread count and both read writes
 * come from `useNotificationInbox` (`@kortix/sdk/react`), which updates the
 * cache optimistically and rolls back on a rejected write. It renders
 * `<InboxView/>`, which knows nothing about the SDK.
 *
 * The inbox is gated by the project's `notification_center` flag (or
 * `artifacts` + `artifact_comments`), exactly as the web bell is.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';

import { openUrl } from '../../lib/open-url.ts';
import { theme } from '../../theme.ts';
import { type InboxRow, targetOf, toInboxRow, webUrlOf } from './inbox-model.ts';
import { InboxView } from './inbox-view.tsx';
import { useInbox } from './use-inbox.ts';

export interface InboxScreenProps {
  projectId: string | null;
  accountId: string | null;
  sessionId: string | null;
  focused: boolean;
  width: number;
  height: number;
  webBaseUrl: string;
  onBack(): void;
  onOpenSession(sessionId: string): void;
  onToast(message: string, kind?: 'info' | 'error'): void;
}

/** How often the age column is recomputed. */
const CLOCK_TICK_MS = 30_000;

function errorText(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error) return error;
  return 'Unknown error';
}

export function InboxScreen({
  projectId,
  accountId: _accountId,
  sessionId: _sessionId,
  focused,
  width,
  height,
  webBaseUrl,
  onBack,
  onOpenSession,
  onToast,
}: InboxScreenProps) {
  const [busy, setBusy] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);
    return () => clearInterval(timer);
  }, []);

  const { enabled, isLoading: gateLoading, inbox } = useInbox(projectId);
  const rows = useMemo(() => (inbox.data?.notifications ?? []).map(toInboxRow), [inbox.data]);

  const markRead = useCallback(
    (row: InboxRow) => {
      if (row.read) return;
      // The hook is optimistic and restores on error; the toast says so.
      inbox.markRead([row.id]).catch((error: unknown) => onToast(errorText(error), 'error'));
    },
    [inbox.markRead, onToast],
  );

  const openWeb = useCallback(
    (row: InboxRow) => {
      void openUrl(webUrlOf(row.url, webBaseUrl))
        .then(() => onToast('Opened in the browser.'))
        .catch((error: unknown) => onToast(errorText(error), 'error'));
    },
    [webBaseUrl, onToast],
  );

  const open = useCallback(
    (row: InboxRow) => {
      markRead(row);
      const target = targetOf(row, projectId, webBaseUrl);
      if (target.kind === 'session') onOpenSession(target.sessionId);
      else openWeb(row);
    },
    [markRead, projectId, webBaseUrl, onOpenSession, openWeb],
  );

  const markAllRead = useCallback(() => {
    setBusy('marking read…');
    inbox
      .markAllRead()
      .catch((error: unknown) => onToast(errorText(error), 'error'))
      .finally(() => setBusy(null));
  }, [inbox.markAllRead, onToast]);

  const refresh = useCallback(() => {
    setBusy('refreshing…');
    void inbox
      .refetch()
      .catch((error: unknown) => onToast(errorText(error), 'error'))
      .finally(() => setBusy(null));
  }, [inbox.refetch, onToast]);

  if (!projectId) {
    return (
      <box flexDirection="column" width={width}>
        <text fg={theme.faint}>No project selected.</text>
      </box>
    );
  }
  if (!gateLoading && !enabled) {
    return (
      <box flexDirection="column" width={width}>
        <text fg={theme.faint}>
          The inbox is off for this project (flag `notification_center`).
        </text>
      </box>
    );
  }

  return (
    <InboxView
      rows={rows}
      unreadCount={inbox.unreadCount}
      focused={focused}
      width={width}
      height={height}
      now={now}
      loading={gateLoading || inbox.isLoading}
      errorMessage={inbox.isError ? errorText(inbox.error) : null}
      busyMessage={busy}
      onOpen={open}
      onMarkRead={markRead}
      onMarkAllRead={markAllRead}
      onOpenWeb={openWeb}
      onRefresh={refresh}
      onBack={onBack}
    />
  );
}
