/**
 * The sidebar: accounts, projects, the nav rows, and the session list.
 *
 * This file is the data half — every read is a `@kortix/sdk/react` hook or a
 * method on the one `kortix()` client, and every write is one of that client's
 * mutations (SPEC §5.2, §7). It renders `<SidebarView/>`, which owns pixels and
 * keys and knows nothing about the SDK.
 */

import { useAccounts, useChangeRequests, useProjectSessions, useProjects } from '@kortix/sdk/react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import type { ResolvedHost } from '../../auth/hosts.ts';
import { kortix } from '../../kortix.ts';
import { filterSessionsByTitle, groupSessionsByDay } from '../../lib/session-groups.ts';
import { ColumnPicker } from './column-picker.tsx';
import { type SidebarScreen, SidebarView } from './sidebar-view.tsx';

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
  onNavigate(screen: 'customize' | 'apps' | 'review' | 'files'): void;
  onProjectChange(projectId: string, accountId: string): void;
  onAccountChange(accountId: string): void;
  /**
   * The account this host actually resolved to, when the caller had none.
   *
   * Distinct from `onAccountChange`, which is a person PICKING another account
   * and therefore drops the open project and session. This one only fills a
   * blank: an env-token host (`KORTIX_API_KEY` with no `KORTIX_ACCOUNT_ID`)
   * boots with `accountId === null`, and without it every account-scoped screen
   * reads "No account on this host." while the sidebar header shows the account
   * by name.
   */
  onAccountResolved?(accountId: string): void;
  onAttach?(sessionId: string): void;
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
  onNavigate,
  onProjectChange,
  onAccountChange,
  onAccountResolved,
  onAttach,
  onToast,
}: SidebarProps) {
  const [picker, setPicker] = useState<'none' | 'account' | 'project'>('none');
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

  // The SDK owns both lists (`useAccounts` / `useProjects`, keyed by
  // `qk.accounts.list` / `qk.projects.list`), so the sidebar, the switcher and
  // every other reader share ONE cache entry and one in-flight request. A
  // hand-rolled key of this app's own invention did not: `staleTime` is
  // per-observer in React Query, so a copied fetcher silently becomes N
  // requests. `userId` is omitted on purpose — a TUI process holds one token
  // for its whole lifetime, so there is no second identity to bleed into.
  const accountsQuery = useAccounts();
  const projectsQuery = useProjects(effectiveAccountId ?? undefined);

  // `useChangeRequests` defaults to open change requests, which is exactly the
  // count the Review row wants. One bounded GET per project, cached.
  const changeRequestsQuery = useChangeRequests(projectId);
  const reviewCount = changeRequestsQuery.data?.change_requests?.length ?? null;

  const accounts = accountsQuery.data ?? [];
  const projects = projectsQuery.data ?? [];

  // Fill a blank account id once the list answers. Only when there is none:
  // a resolved account must never overwrite a picked one.
  useEffect(() => {
    if (accountId || !onAccountResolved) return;
    const resolved = effectiveAccountId || accounts[0]?.account_id;
    if (resolved) onAccountResolved(resolved);
  }, [accountId, effectiveAccountId, accounts[0]?.account_id, onAccountResolved]);

  // An account or project list that failed is an auth/host problem, not an
  // empty workspace. Say so on the account row and in the error line instead
  // of rendering "No account" over a picker with nothing in it.
  const authError = accountsQuery.isError
    ? `Accounts: ${errorText(accountsQuery.error)}`
    : projectsQuery.isError
      ? `Projects: ${errorText(projectsQuery.error)}`
      : null;
  const accountName =
    accounts.find((account) => account.account_id === effectiveAccountId)?.name ??
    (accountsQuery.isError
      ? 'account list failed'
      : accountsQuery.isLoading
        ? 'loading…'
        : (accounts[0]?.name ?? 'No account'));
  const projectName =
    projects.find((project) => project.project_id === projectId)?.name ??
    (projectId ? projectId.slice(0, 8) : 'No project');

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
      onToast?.('No project selected.', 'error');
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
  }, [projectId, onNewSession, onToast, sessionsQuery.refetch]);

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

  const attach = useCallback(
    (sessionId: string) => {
      if (onAttach) onAttach(sessionId);
      else onToast?.('Attach is not wired yet (features/terminal).', 'error');
    },
    [onAttach, onToast],
  );

  const pickerItems = useMemo(() => {
    if (picker === 'account')
      return accounts.map((account) => ({ id: account.account_id, label: account.name }));
    if (picker === 'project')
      return projects.map((project) => ({
        id: project.project_id,
        label: project.name,
        right: project.project_id === projectId ? 'active' : '',
      }));
    return [];
  }, [picker, accounts, projects, projectId]);

  const listError = sessionsQuery.isError ? errorText(sessionsQuery.error) : authError;
  const busyMessage = busy ?? (sessionsQuery.isFetchingNextPage ? 'loading more…' : null);

  if (picker !== 'none') {
    return (
      <ColumnPicker
        title={picker === 'account' ? 'Switch account' : 'Switch project'}
        items={pickerItems}
        width={width}
        height={height}
        onPick={(item) => {
          setPicker('none');
          if (picker === 'account') {
            onAccountChange(item.id);
            return;
          }
          const project = projects.find((entry) => entry.project_id === item.id);
          onProjectChange(item.id, project?.account_id ?? effectiveAccountId ?? '');
        }}
        onClose={() => setPicker('none')}
      />
    );
  }

  return (
    <SidebarView
      accountName={accountName}
      projectName={projectName}
      reviewCount={reviewCount}
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
      onOpenAccountPicker={() =>
        authError && accounts.length === 0 ? onToast?.(authError, 'error') : setPicker('account')
      }
      onOpenProjectPicker={() =>
        authError && projects.length === 0 ? onToast?.(authError, 'error') : setPicker('project')
      }
      onNewSession={() => void createSession()}
      onNavigate={(screen: SidebarScreen) => onNavigate(screen)}
      onRename={(sessionId, name) => void renameSession(sessionId, name)}
      onDelete={(sessionId) => void deleteSession(sessionId)}
      onAttach={attach}
      onFilterChange={setFilter}
      onReachEnd={reachEnd}
    />
  );
}
