/**
 * The Spaces screen: the project's channels and the caller's DMs (SPEC §5).
 *
 * This file is the data half. Spaces are `useProjectSpaces`; the threads of an
 * open space are `useProjectSessions({ spaceId })` — the same two reads the
 * web's `space-view.tsx` makes. A new thread is
 * `kortix().projects.createSession(projectId, { space_id })`. The SDK has no
 * plain "post a message" verb for a space: a thread is a session, so posting
 * means opening the session and typing there.
 *
 * Gated on the project's `project_channels` flag, as the web is.
 */

import type { ProjectSession, ProjectSpace } from '@kortix/sdk';
import { useFeatureFlag, useProjectSessions, useProjectSpaces } from '@kortix/sdk/react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { kortix } from '../../kortix.ts';
import { openUrl } from '../../lib/open-url.ts';
import { theme } from '../../theme.ts';
import { Spinner } from '../../ui/index.ts';
import { type SpaceRow, SpacesView, type ThreadRow } from './spaces-view.tsx';

export interface SpacesScreenProps {
  projectId: string | null;
  accountId: string | null;
  sessionId: string | null;
  focused: boolean;
  /** Inner columns. */
  width: number;
  /** Inner rows. */
  height: number;
  /** Kortix web origin, for "open in browser". */
  webBaseUrl: string;
  onBack(): void;
  onOpenSession(sessionId: string): void;
  onToast(message: string, kind?: 'info' | 'error'): void;
  /** Test seam for `o`. Defaults to `lib/open-url.ts`. */
  openUrlImpl?: (url: string) => Promise<unknown>;
}

const CLOCK_TICK_MS = 30_000;

function errorText(error: unknown): string {
  const status = (error as { status?: unknown } | null)?.status;
  const message =
    error instanceof Error && error.message
      ? error.message
      : typeof error === 'string' && error
        ? error
        : 'Unknown error';
  return typeof status === 'number' ? `HTTP ${status}: ${message}` : message;
}

function epochMs(iso: string | null | undefined): number {
  if (!iso) return Number.NaN;
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? Number.NaN : parsed;
}

export function spaceRow(space: ProjectSpace): SpaceRow {
  const dm = space.kind === 'dm';
  return {
    id: space.space_id,
    kind: space.kind,
    label: dm ? `@ ${space.dm_agent_name ?? space.name}` : `# ${space.slug ?? space.name}`,
    description: dm ? '' : (space.description ?? ''),
    badge: space.visibility === 'private' ? 'private' : '',
    updatedMs: epochMs(space.updated_at),
  };
}

/** A thread's title: the session name, else its first prompt, else a placeholder. */
export function threadTitle(session: ProjectSession): string {
  const named = session.custom_name || session.name;
  if (named) return named;
  const prompt = (session.first_prompt ?? '').split('\n')[0]?.trim();
  return prompt || 'Untitled thread';
}

export function threadRow(session: ProjectSession): ThreadRow {
  return {
    id: session.session_id,
    title: threadTitle(session),
    replies: session.reply_count ?? null,
    status: session.status,
    updatedMs: epochMs(session.updated_at),
  };
}

/** The web route of a space: `/c/<slug>` for a channel, `/dm/<agent>` for a DM. */
export function spaceWebUrl(
  webBaseUrl: string,
  projectId: string,
  space: Pick<ProjectSpace, 'kind' | 'slug' | 'dm_agent_name'>,
): string {
  const base = `${webBaseUrl.replace(/\/+$/, '')}/projects/${projectId}`;
  if (space.kind === 'dm') return `${base}/dm/${encodeURIComponent(space.dm_agent_name ?? '')}`;
  return `${base}/c/${encodeURIComponent(space.slug ?? '')}`;
}

export function SpacesScreen({
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
  openUrlImpl = openUrl,
}: SpacesScreenProps) {
  const [openSpaceId, setOpenSpaceId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);
    return () => clearInterval(timer);
  }, []);

  const flag = useFeatureFlag(projectId, 'project_channels');
  const spacesQuery = useProjectSpaces(projectId, { enabled: flag.enabled });
  const threadsQuery = useProjectSessions(projectId ?? '', {
    spaceId: openSpaceId ?? undefined,
    enabled: flag.enabled && Boolean(projectId) && openSpaceId !== null,
  });

  const spaces = useMemo(() => (spacesQuery.data ?? []).map(spaceRow), [spacesQuery.data]);
  const threads = useMemo(
    () => (openSpaceId ? threadsQuery.sessions.map(threadRow) : []),
    [openSpaceId, threadsQuery.sessions],
  );

  const raw = useMemo(
    () => new Map((spacesQuery.data ?? []).map((space) => [space.space_id, space])),
    [spacesQuery.data],
  );

  const openBrowser = useCallback(
    (row: SpaceRow) => {
      const space = raw.get(row.id);
      if (!projectId || !space) return;
      const url = spaceWebUrl(webBaseUrl, projectId, space);
      void openUrlImpl(url)
        .then(() => onToast(`Opened ${url}`))
        .catch((error: unknown) => onToast(errorText(error), 'error'));
    },
    [raw, projectId, webBaseUrl, openUrlImpl, onToast],
  );

  const newThread = useCallback(
    (row: SpaceRow) => {
      const space = raw.get(row.id);
      if (!projectId || !space) return;
      setBusy('starting a thread…');
      void kortix()
        .projects.createSession(projectId, {
          space_id: space.space_id,
          ...(space.kind === 'dm' && space.dm_agent_name
            ? { agent_name: space.dm_agent_name }
            : {}),
        })
        .then((created) => onOpenSession(created.session_id))
        .catch((error: unknown) => onToast(errorText(error), 'error'))
        .finally(() => setBusy(null));
    },
    [raw, projectId, onOpenSession, onToast],
  );

  const refresh = useCallback(() => {
    setBusy('refreshing…');
    void Promise.all([spacesQuery.refetch(), openSpaceId ? threadsQuery.refetch() : null])
      .catch((error: unknown) => onToast(errorText(error), 'error'))
      .finally(() => setBusy(null));
  }, [spacesQuery.refetch, threadsQuery.refetch, openSpaceId, onToast]);

  if (!projectId) return <text fg={theme.faint}>No project selected.</text>;
  if (flag.isLoading) return <Spinner label="checking Spaces" />;
  if (!flag.enabled) {
    return (
      <text fg={theme.faint}>
        Spaces are off: the project's Channels feature (project_channels) is not enabled.
      </text>
    );
  }

  return (
    <SpacesView
      spaces={spaces}
      threads={threads}
      focused={focused}
      width={width}
      height={height}
      now={now}
      loading={spacesQuery.isLoading}
      threadsLoading={threadsQuery.isLoading || threadsQuery.isScanning}
      errorMessage={spacesQuery.isError ? errorText(spacesQuery.error) : null}
      threadsError={threadsQuery.isError ? errorText(threadsQuery.error) : null}
      busyMessage={busy}
      onOpenSpace={setOpenSpaceId}
      onOpenThread={onOpenSession}
      onNewThread={newThread}
      onOpenBrowser={openBrowser}
      onRefresh={refresh}
      onBack={onBack}
    />
  );
}
