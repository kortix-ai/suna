/**
 * The sidebar: the workspace, the nav rows, and the session list.
 *
 * This file is the data half — every read is a `@kortix/sdk/react` hook or a
 * method on the one `kortix()` client, and every write is one of that client's
 * mutations (SPEC §5.2, §7). It renders `<SidebarView/>`, which owns pixels and
 * keys and knows nothing about the SDK.
 */

import { useChangeRequests, useProjectSessions } from '@kortix/sdk/react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import type { ResolvedHost } from '../../auth/hosts.ts';
import { kortix } from '../../kortix.ts';
import { filterSessionsByTitle, groupSessionsByDay } from '../../lib/session-groups.ts';
import { NO_WORKSPACE_TEXT, useWorkspaces } from '../../lib/workspaces.ts';
import { ColumnPicker } from './column-picker.tsx';
import { type SidebarNavItem, type SidebarScreen, SidebarView } from './sidebar-view.tsx';

export interface SidebarProps {
  host: ResolvedHost;
  accountId: string | null;
  projectId: string | null;
  selectedSessionId: string | null;
  focused: boolean;
  width: number;
  height: number;
  onOpenSession(sessionId: string): void;
  onNewSession(sessionId: string): void;
  /**
   * `+ New session` / `n`, session-first: open the draft instead of creating
   * an empty session on the server. The draft's first prompt creates it, the
   * same as `/new`. Without it the row creates the session at once.
   */
  onStartDraft?(): void;
  onNavigate(screen: SidebarScreen): void;
  /** The screen rows. Default: the four the sidebar always had. */
  nav?: readonly SidebarNavItem[];
  /** A workspace row was picked: its `project_id` and the account that owns it. */
  onProjectChange(projectId: string, accountId: string): void;
  /**
   * The account this host actually resolved to, when the caller had none.
   *
   * Distinct from `onProjectChange`, which is a person PICKING another
   * workspace and therefore drops the open session. This one only fills a
   * blank: an env-token host (`KORTIX_API_KEY` with no `KORTIX_ACCOUNT_ID`)
   * boots with `accountId === null`, and without it every account-scoped screen
   * reads "No account on this host." while the sidebar header shows the account
   * by name.
   */
  onAccountResolved?(accountId: string): void;
  onToast?(message: string, kind?: 'info' | 'error'): void;
}

/** Statuses that mean the row is still moving, so the list is worth polling. */
const LIVE_STATUSES = new Set(['queued', 'branching', 'provisioning', 'running']);
const LIVE_POLL_MS = 5000;
/** How often the age column is recomputed. A minute is the smallest unit it
 *  prints, so anything faster only spends renders. */
const CLOCK_TICK_MS = 30_000;

function errorText(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error) return error;
  return 'Unknown error';
}

export function Sidebar({
  host,
  accountId,
  projectId,
  selectedSessionId,
  focused,
  width,
  height,
  onOpenSession,
  onNewSession,
  onStartDraft,
  onNavigate,
  nav,
  onProjectChange,
  onAccountResolved,
  onToast,
}: SidebarProps) {
  const [picker, setPicker] = useState(false);
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);
    return () => clearInterval(timer);
  }, []);

  const effectiveAccountId = accountId ?? (host.accountId || null);

  const sessionsQuery = useProjectSessions(projectId ?? '', {
    enabled: Boolean(projectId),
    // Poll only while a row is still provisioning — the same bound `apps/web`
    // uses. A settled project costs one request per mount.
    refetchInterval: (sessions) =>
      sessions.some((session) => LIVE_STATUSES.has(session.status)) ? LIVE_POLL_MS : false,
  });

  // The SDK owns the lists (`useWorkspaces` reads `useAccounts` and the
  // per-account project lists through `projectsQueryOptions`), so the sidebar, the
  // switcher and every other reader share ONE cache entry and one in-flight
  // request. `userId` is omitted on purpose: a TUI process holds one token for
  // its whole lifetime, so there is no second identity to bleed into.
  const workspaces = useWorkspaces();

  // `useChangeRequests` defaults to open change requests, which is exactly the
  // count the Review row wants. One bounded GET per workspace, cached.
  const changeRequestsQuery = useChangeRequests(projectId);
  const reviewCount = changeRequestsQuery.data?.change_requests?.length ?? null;

  // Fill a blank account id once the list answers. Only when there is none:
  // a resolved account must never overwrite a picked one. The account of the
  // open workspace wins; an account with no workspace is never a fallback.
  const openRow = workspaces.rows.find((row) => row.id === projectId);
  const resolvedAccount = effectiveAccountId || openRow?.accountId || workspaces.rows[0]?.accountId;
  useEffect(() => {
    if (accountId || !onAccountResolved) return;
    if (resolvedAccount) onAccountResolved(resolvedAccount);
  }, [accountId, resolvedAccount, onAccountResolved]);

  // A list that failed is an auth/host problem, not "no workspace". Say so on
  // the workspace row and in the error line instead of rendering the
  // no-workspace line over a picker with nothing in it.
  const authError = workspaces.isError ? `Workspaces: ${errorText(workspaces.error)}` : null;
  const noWorkspace = !workspaces.isLoading && !workspaces.isError && workspaces.rows.length === 0;
  const workspaceName =
    openRow?.name ??
    (projectId
      ? projectId.slice(0, 8)
      : workspaces.isError
        ? 'workspace list failed'
        : workspaces.isLoading
          ? 'loading…'
          : noWorkspace
            ? 'No workspace yet'
            : 'Pick a workspace');

  const groups = useMemo(
    () => groupSessionsByDay(filterSessionsByTitle(sessionsQuery.sessions, filter), { now }),
    [sessionsQuery.sessions, filter, now],
  );

  const reachEnd = useCallback(() => {
    if (sessionsQuery.hasNextPage && !sessionsQuery.isFetchingNextPage) {
      void sessionsQuery.fetchNextPage();
    }
  }, [sessionsQuery.hasNextPage, sessionsQuery.isFetchingNextPage, sessionsQuery.fetchNextPage]);

  const createSession = useCallback(async () => {
    if (!projectId) {
      onToast?.(noWorkspace ? NO_WORKSPACE_TEXT : 'No workspace open. Pick one first.', 'error');
      return;
    }
    setBusy('creating session…');
    try {
      // No title: session titles are server-owned (memory
      // `session-titles-kortix-owned`), so the create body stays empty.
      const session = await kortix().projects.createSession(projectId);
      await sessionsQuery.refetch();
      onNewSession(session.session_id);
    } catch (error) {
      onToast?.(`Create failed: ${errorText(error)}`, 'error');
    } finally {
      setBusy(null);
    }
  }, [projectId, noWorkspace, onNewSession, onToast, sessionsQuery.refetch]);

  const renameSession = useCallback(
    async (sessionId: string, name: string) => {
      if (!projectId) return;
      setBusy('renaming…');
      try {
        await kortix().session(projectId, sessionId).update({ name });
        await sessionsQuery.refetch();
        onToast?.(`Renamed to ${name}`);
      } catch (error) {
        onToast?.(`Rename failed: ${errorText(error)}`, 'error');
      } finally {
        setBusy(null);
      }
    },
    [projectId, onToast, sessionsQuery.refetch],
  );

  const deleteSession = useCallback(
    async (sessionId: string) => {
      if (!projectId) return;
      setBusy('deleting…');
      try {
        await kortix().session(projectId, sessionId).delete();
        await sessionsQuery.refetch();
        onToast?.('Session deleted.');
      } catch (error) {
        onToast?.(`Delete failed: ${errorText(error)}`, 'error');
      } finally {
        setBusy(null);
      }
    },
    [projectId, onToast, sessionsQuery.refetch],
  );

  const pickerItems = useMemo(
    () =>
      workspaces.rows.map((row) => ({
        id: row.id,
        label: row.name,
        right: row.id === projectId ? 'active' : '',
      })),
    [workspaces.rows, projectId],
  );

  const listError = sessionsQuery.isError ? errorText(sessionsQuery.error) : authError;
  const busyMessage = busy ?? (sessionsQuery.isFetchingNextPage ? 'loading more…' : null);

  if (picker) {
    return (
      <ColumnPicker
        title="Switch workspace"
        items={pickerItems}
        width={width}
        height={height}
        emptyText={noWorkspace ? NO_WORKSPACE_TEXT : undefined}
        onPick={(item) => {
          setPicker(false);
          const row = workspaces.rows.find((entry) => entry.id === item.id);
          onProjectChange(item.id, row?.accountId ?? effectiveAccountId ?? '');
        }}
        onClose={() => setPicker(false)}
      />
    );
  }

  return (
    <SidebarView
      workspaceName={workspaceName}
      reviewCount={reviewCount}
      nav={nav}
      groups={groups}
      selectedSessionId={selectedSessionId}
      focused={focused}
      width={width}
      height={height}
      now={now}
      loading={sessionsQuery.isLoading}
      errorMessage={listError}
      busyMessage={busyMessage}
      onOpenSession={onOpenSession}
      onOpenWorkspacePicker={() =>
        authError && workspaces.rows.length === 0 ? onToast?.(authError, 'error') : setPicker(true)
      }
      onNewSession={() => (onStartDraft ? onStartDraft() : void createSession())}
      onNavigate={(screen: SidebarScreen) => onNavigate(screen)}
      onRename={(sessionId, name) => void renameSession(sessionId, name)}
      onDelete={(sessionId) => void deleteSession(sessionId)}
      onFilterChange={setFilter}
      onReachEnd={reachEnd}
    />
  );
}
