/**
 * The Artifacts screen: documents and pages the project has shared.
 *
 * The data half. Every read and write is a `@kortix/sdk/react` hook:
 * `useFeatureFlag` (flag `artifacts`), `useArtifacts`, `useArtifact`,
 * `useArtifactText` and `useArtifactMutations`. The view owns pixels and keys.
 * With the flag off the screen reads one line that names it; no list request
 * is made.
 */

import {
  useArtifact,
  useArtifactMutations,
  useArtifactText,
  useArtifacts,
  useFeatureFlag,
} from '@kortix/sdk/react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { copyToClipboard } from '../../lib/clipboard.ts';
import { openUrl } from '../../lib/open-url.ts';
import {
  type ArtifactRow,
  orderRows,
  toArtifactRow,
  unavailableReason,
} from './artifacts-model.ts';
import { type ArtifactDetailData, ArtifactsView } from './artifacts-view.tsx';

/** How often the age column is recomputed. A minute is its smallest unit. */
const CLOCK_TICK_MS = 30_000;

export interface ArtifactsScreenProps {
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

function errorText(error: unknown): string {
  if (error instanceof Error && error.message) {
    const status = (error as { status?: unknown }).status;
    return typeof status === 'number' ? `${status} ${error.message}` : error.message;
  }
  return typeof error === 'string' && error ? error : 'Unknown error';
}

export function ArtifactsScreen({
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
}: ArtifactsScreenProps) {
  const [detailId, setDetailId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);
    return () => clearInterval(timer);
  }, []);

  const flag = useFeatureFlag(projectId, 'artifacts');
  const unavailable = unavailableReason({
    projectId,
    flagLoading: flag.isLoading,
    flagEnabled: flag.enabled,
  });
  // A null id disables the query: no list request while the flag is off.
  const listQuery = useArtifacts(flag.enabled ? projectId : null);
  const mutations = useArtifactMutations(projectId ?? '');

  const rows = useMemo<ArtifactRow[]>(
    () =>
      orderRows((listQuery.data ?? []).map((a) => toArtifactRow(a, webBaseUrl, projectId ?? ''))),
    [listQuery.data, webBaseUrl, projectId],
  );

  // Both mounted with `null` until Enter opens the pane.
  const detailQuery = useArtifact(flag.enabled ? projectId : null, detailId);
  const detailArtifact = detailQuery.data ?? null;
  const textQuery = useArtifactText(
    projectId,
    detailArtifact?.type === 'doc' ? detailArtifact : null,
  );

  const detail = useMemo<ArtifactDetailData | null>(() => {
    if (!detailId) return null;
    return {
      loading: detailQuery.isLoading,
      errorMessage: detailQuery.isError ? errorText(detailQuery.error) : null,
      files: (detailArtifact?.version.files ?? []).map((f) => ({ path: f.path, size: f.size })),
      text: textQuery.data ?? null,
      textLoading: textQuery.isLoading,
      textError: textQuery.isError ? errorText(textQuery.error) : null,
    };
  }, [detailId, detailQuery, detailArtifact, textQuery]);

  const run = useCallback(
    (label: string, work: Promise<unknown>, done: string) => {
      setBusy(label);
      void work
        .then(() => onToast(done))
        .catch((error: unknown) => onToast(errorText(error), 'error'))
        .finally(() => setBusy(null));
    },
    [onToast],
  );

  const refresh = useCallback(() => {
    setBusy('refreshing…');
    void listQuery
      .refetch()
      .catch((error: unknown) => onToast(errorText(error), 'error'))
      .finally(() => setBusy(null));
  }, [listQuery.refetch, onToast]);

  return (
    <ArtifactsView
      rows={rows}
      focused={focused}
      width={width}
      height={height}
      now={now}
      loading={flag.isLoading || listQuery.isLoading}
      unavailable={unavailable}
      errorMessage={listQuery.isError ? errorText(listQuery.error) : null}
      busyMessage={busy}
      detail={detail}
      onOpenDetails={setDetailId}
      onOpenWeb={(row) => {
        openUrl(row.webUrl).then(
          () => onToast(`Opened ${row.webUrl}`),
          (error: unknown) => onToast(errorText(error), 'error'),
        );
      }}
      onCopyLink={(row) => {
        void copyToClipboard(row.webUrl).then((result) => {
          if (result.ok) onToast('Link copied.');
          else onToast(`Copy failed: ${result.error ?? 'no clipboard tool'}`, 'error');
        });
      }}
      onRefresh={refresh}
      onRename={(row, title) =>
        run(
          'renaming…',
          mutations.update.mutateAsync({ artifactId: row.id, title }),
          `Renamed to ${title}.`,
        )
      }
      onPin={(row) =>
        run(
          row.pinned ? 'unpinning…' : 'pinning…',
          mutations.pin.mutateAsync({ artifactId: row.id, pinned: !row.pinned }),
          row.pinned ? 'Unpinned.' : 'Pinned.',
        )
      }
      onDelete={(row) =>
        run(
          'removing…',
          mutations.remove.mutateAsync(row.id),
          `Stopped sharing ${row.title}. Its files stay in Files.`,
        )
      }
      onOpenSession={onOpenSession}
      onBack={onBack}
    />
  );
}
