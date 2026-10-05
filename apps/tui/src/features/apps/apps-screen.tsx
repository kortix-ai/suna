/**
 * The Apps screen: the project's deployed Apps (SPEC §5.7).
 *
 * This file is the data half — every read is a `@kortix/sdk/react` hook or a
 * method on the one `kortix()` client, and every write is one of those. It
 * renders `<AppsView/>`, which owns pixels and keys and knows nothing about
 * the SDK.
 *
 * The status words and the access-mode phrases are the web's, verbatim
 * (`apps/web/src/features/apps/apps-view.tsx` `appStatus` / `ACCESS_COPY`), so
 * one App reads the same in both clients.
 */

import type { App, AppDeployment } from '@kortix/sdk';
import { useAppDeployments, useProjectApps } from '@kortix/sdk/react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { kortix } from '../../kortix.ts';
import { openUrl } from '../../lib/open-url.ts';
import { glyph as GLYPH, theme } from '../../theme.ts';
import { type AppDetail, type AppRow, type AppStatus, AppsView } from './apps-view.tsx';

/**
 * Access modes `v` offers, with the web's own phrase for each.
 *
 * `restricted` needs a member/group list and `password` needs a password —
 * neither is a one-keystroke change, so both stay in the web app. An App
 * already in one of those modes still READS its mode correctly; `v` only
 * offers the three modes the choice itself fully specifies.
 */
export const VISIBILITY_OPTIONS = ['private', 'project', 'public'] as const;

/** `App.access_mode` → the web's phrase for it (`ACCESS_COPY`). */
export const ACCESS_PHRASE: Record<string, string> = {
  private: 'Just you',
  project: 'Whole team',
  restricted: 'Select members',
  public: 'Anyone with the URL',
  password: 'Anyone with the password',
};

/** The command that creates the first App. Printed in the empty state. */
export const FIRST_DEPLOY_COMMAND = 'kortix apps deploy .';

/** How often the age column is recomputed. A minute is its smallest unit. */
const CLOCK_TICK_MS = 30_000;

export interface AppsScreenProps {
  projectId: string | null;
  /** The account the project belongs to. Carried for the caller's header. */
  accountId: string | null;
  focused: boolean;
  width: number;
  height: number;
  onBack(): void;
  onToast?(message: string, kind?: 'info' | 'error'): void;
  /**
   * Copy to the system clipboard. `src/lib/clipboard.ts` holds the
   * implementation; the host injects it so this screen stays free of process
   * spawning. Without it `y` toasts the URL, which still leaves it selectable
   * with the mouse.
   */
  onCopy?(text: string): void | Promise<void>;
  /** Test seam for `o`. Defaults to `lib/open-url.ts`. */
  openUrlImpl?: (url: string) => Promise<unknown>;
}

function errorText(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error) return error;
  return 'Unknown error';
}

function epochMs(iso: string | null | undefined): number {
  if (!iso) return Number.NaN;
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? Number.NaN : parsed;
}

/**
 * How an App reads on one row.
 *
 * `active_deployment_id` is read FIRST, exactly as the web does: an App that
 * has never been deployed still carries `desired_state: 'running'`, so asking
 * the desired state first labels a nonexistent deployment "Running".
 *
 * Only the App record is consulted. A per-row deployment fetch would be one
 * request per App on every list render; the live pipeline status
 * (`building`, `failed`) is a detail-pane read.
 */
export function appStatus(app: App): AppStatus {
  if (!app.active_deployment_id)
    return { glyph: GLYPH.stopped, word: 'Not deployed', tone: 'idle' };
  if (app.desired_state === 'stopped')
    return { glyph: GLYPH.stopped, word: 'Suspended', tone: 'idle' };
  return { glyph: GLYPH.running, word: 'Running', tone: 'ok' };
}

/** `2 vCPU · 4 GB RAM · 10 GB disk`. */
export function machineText(app: App): string {
  const { cpu, memory_gb, disk_gb } = app.machine;
  return `${cpu} vCPU · ${memory_gb} GB RAM · ${disk_gb} GB disk`;
}

/** Whole seconds as the shortest exact unit: `600` → `10m`. */
export function durationText(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return 'never';
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}

export function toRow(app: App): AppRow {
  return {
    id: app.app_id,
    name: app.name || app.slug,
    url: app.url ?? '',
    status: appStatus(app),
    visibility: app.access_mode,
    updatedMs: epochMs(app.updated_at),
  };
}

/**
 * The deployment the detail pane describes: the App's active one, or the
 * newest when the App has none. A first deploy that is still building has no
 * `active_deployment_id` yet, and that is exactly the row worth showing.
 */
export function activeDeployment(
  app: App,
  deployments: AppDeployment[] | undefined,
): AppDeployment | null {
  if (!deployments || deployments.length === 0) return null;
  const active = deployments.find((entry) => entry.deployment_id === app.active_deployment_id);
  if (active) return active;
  return [...deployments].sort((a, b) => b.version - a.version)[0] ?? null;
}

export function AppsScreen({
  projectId,
  accountId: _accountId,
  focused,
  width,
  height,
  onBack,
  onToast,
  onCopy,
  openUrlImpl = openUrl,
}: AppsScreenProps) {
  const [detailAppId, setDetailAppId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);
    return () => clearInterval(timer);
  }, []);

  const appsQuery = useProjectApps(projectId);
  const apps = useMemo<App[]>(() => appsQuery.data ?? [], [appsQuery.data]);
  const rows = useMemo(() => apps.map(toRow), [apps]);

  // Mounted with `null` until Enter opens the pane, so an idle list never pays
  // for the 5-second deployment poll `useAppDeployments` installs.
  const deploymentsQuery = useAppDeployments(projectId, detailAppId);
  const detailApp = apps.find((app) => app.app_id === detailAppId) ?? null;

  const detail = useMemo<AppDetail | null>(() => {
    if (!detailApp) return null;
    const deployment = activeDeployment(detailApp, deploymentsQuery.data);
    return {
      loading: deploymentsQuery.isLoading,
      version: deployment?.version ?? null,
      deployStatus: deployment?.status ?? null,
      deployedAtMs: deployment?.ready_at ? epochMs(deployment.ready_at) : null,
      provider: deployment?.hosting_provider ?? null,
      sourceKind: deployment?.source_kind ?? null,
      error: deployment?.error ?? null,
      machine: machineText(detailApp),
      idleTimeout: durationText(detailApp.idle_timeout_seconds),
      appId: detailApp.app_id,
    };
  }, [detailApp, deploymentsQuery.data, deploymentsQuery.isLoading]);

  /**
   * The URL a browser on THIS machine can actually load.
   *
   * A private or team-only App answers the bare origin with a redirect to
   * sign in; the web opens a short-lived access-session URL instead, which
   * exchanges into a host-only cookie (`createAppAccessSession`). The TUI
   * mints one per keystroke rather than per render — a list of N Apps minting
   * N sessions on mount is the exact 403 storm `useAppAccess` documents.
   * A failure falls back to the bare URL: a public App needs no session.
   */
  const resolveOpenUrl = useCallback(
    async (row: AppRow): Promise<string> => {
      if (!projectId) return row.url;
      const app = apps.find((entry) => entry.app_id === row.id);
      if (app?.viewer_can_access === false) return row.url;
      if (row.visibility === 'public') return row.url;
      try {
        const session = await kortix().project(projectId).apps.access.session(row.id);
        return session.url || row.url;
      } catch {
        return row.url;
      }
    },
    [projectId, apps],
  );

  const openRowUrl = useCallback(
    (row: AppRow) => {
      if (!row.url) {
        onToast?.(`${row.name} is not deployed yet.`, 'error');
        return;
      }
      setBusy('opening…');
      void (async () => {
        try {
          const target = await resolveOpenUrl(row);
          await openUrlImpl(target);
          onToast?.(`Opened ${row.url}`);
        } catch (error) {
          onToast?.(errorText(error), 'error');
        } finally {
          setBusy(null);
        }
      })();
    },
    [onToast, openUrlImpl, resolveOpenUrl],
  );

  const copyRowUrl = useCallback(
    (row: AppRow) => {
      if (!row.url) {
        onToast?.(`${row.name} is not deployed yet.`, 'error');
        return;
      }
      if (!onCopy) {
        onToast?.(row.url);
        return;
      }
      void (async () => {
        try {
          await onCopy(row.url);
          onToast?.('URL copied.');
        } catch (error) {
          onToast?.(`Copy failed: ${errorText(error)}`, 'error');
        }
      })();
    },
    [onCopy, onToast],
  );

  const refresh = useCallback(() => {
    setBusy('refreshing…');
    void appsQuery
      .refetch()
      .catch((error: unknown) => onToast?.(errorText(error), 'error'))
      .finally(() => setBusy(null));
  }, [appsQuery.refetch, onToast]);

  const setState = useCallback(
    (row: AppRow, next: 'running' | 'stopped') => {
      if (row.status.word === 'Not deployed') {
        // `startApp` only flips `desired_state`; with no deployment behind it
        // there is nothing to start, and the API answers 409.
        onToast?.(`${row.name} has no deployment yet. Run \`${FIRST_DEPLOY_COMMAND}\`.`, 'error');
        return;
      }
      setBusy(next === 'running' ? 'starting…' : 'suspending…');
      const run = next === 'running' ? appsQuery.start : appsQuery.stop;
      void run
        .mutateAsync(row.id)
        .then(() => onToast?.(`${row.name} ${next === 'running' ? 'is ready' : 'suspended'}.`))
        .catch((error: unknown) => onToast?.(errorText(error), 'error'))
        .finally(() => setBusy(null));
    },
    [appsQuery.start, appsQuery.stop, onToast],
  );

  const setVisibility = useCallback(
    (row: AppRow, mode: string) => {
      if (!projectId) return;
      if (mode === row.visibility) {
        onToast?.(`${row.name} is already ${mode}.`);
        return;
      }
      setBusy('updating access…');
      void (async () => {
        try {
          // `updateAppAccess` replaces the whole policy. The three modes this
          // screen offers carry no member/group list by definition, so the
          // mode alone is the complete policy.
          await kortix()
            .project(projectId)
            .apps.access.update(row.id, { mode: mode as 'private' | 'project' | 'public' });
          await appsQuery.refetch();
          onToast?.(`${row.name}: ${ACCESS_PHRASE[mode] ?? mode}.`);
        } catch (error) {
          onToast?.(errorText(error), 'error');
        } finally {
          setBusy(null);
        }
      })();
    },
    [projectId, appsQuery.refetch, onToast],
  );

  if (!projectId) {
    return (
      <box flexDirection="column" width={width}>
        <text fg={theme.faint}>No project selected.</text>
      </box>
    );
  }

  return (
    <AppsView
      rows={rows}
      focused={focused}
      width={width}
      height={height}
      now={now}
      loading={appsQuery.isLoading}
      errorMessage={appsQuery.isError ? errorText(appsQuery.error) : null}
      busyMessage={busy}
      detail={detail}
      visibilityOptions={VISIBILITY_OPTIONS}
      emptyHint={FIRST_DEPLOY_COMMAND}
      accessPhrase={ACCESS_PHRASE}
      onOpenDetails={setDetailAppId}
      onOpenUrl={openRowUrl}
      onCopyUrl={copyRowUrl}
      onRefresh={refresh}
      onSetState={setState}
      onSetVisibility={setVisibility}
      onBack={onBack}
    />
  );
}
