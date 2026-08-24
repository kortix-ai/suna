'use client';

import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState } from '@/features/layout/section/error-state';
import {
  DRIVE_ACTION_ROW_CLASS,
  DriveExplorer,
  FileExplorerSourceProvider,
} from '@/features/project-files';
import { useBoundedRuntimeWait } from '@/features/session/use-bounded-runtime-wait';
import { useRuntimeStore } from '@kortix/sdk/react';
import {
  ArrowClockwiseIcon as RefreshCw,
  CloudSlashIcon as ServerOff,
} from '@phosphor-icons/react';
import { useTranslations } from 'next-intl';
import { useState, type ReactNode } from 'react';
import { useServerHealth } from './hooks';
import { sandboxExplorerSource } from './sandbox-explorer-source';

/**
 * The shared Drive-style explorer ({@link DriveExplorer}) bound to the live
 * sandbox workspace: writable, searchable, and gated on the sandbox OpenCode
 * server being reachable. Mount inside a FilesStoreProvider for scoped
 * navigation state, or bare to drive the global files store (desktop tabs).
 */
export function SandboxFileExplorer({
  embedded = false,
  shareContext,
  leading,
  contentPanel,
}: {
  embedded?: boolean;
  shareContext?: { projectId: string; sessionId: string };
  /** Host chrome for the start of the explorer's action row — see {@link DriveExplorer}. */
  leading?: ReactNode;
  /** ARIA wiring when `leading` is a tab strip — see {@link DriveExplorer}. */
  contentPanel?: { id: string; labelledBy: string };
} = {}) {
  return (
    <FileExplorerSourceProvider value={sandboxExplorerSource}>
      <SandboxServerGate leading={leading}>
        <DriveExplorer
          embedded={embedded}
          shareContext={shareContext}
          leading={leading}
          contentPanel={contentPanel}
        />
      </SandboxServerGate>
    </FileExplorerSourceProvider>
  );
}

/**
 * Renders children only while the sandbox OpenCode server is reachable.
 *
 * `leading` (the host's tab strip) is repeated over the closed-gate states on
 * purpose: it is how the user switches away from a workspace that is still
 * booting or unreachable, so it must not vanish with the explorer.
 */
function SandboxServerGate({
  children,
  leading,
}: {
  children: React.ReactNode;
  leading?: ReactNode;
}) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const serverUrl = useRuntimeStore((s) => s.getActiveServerUrl());
  const { data: health, isLoading: isHealthLoading, refetch } = useServerHealth();
  const [retryAttempt, setRetryAttempt] = useState(0);
  const healthWaitExpired = useBoundedRuntimeWait(isHealthLoading, retryAttempt);

  const retry = () => {
    setRetryAttempt((attempt) => attempt + 1);
    void refetch();
  };

  // Hold the gate closed while the first probe is in flight. Rendering the
  // explorer during the probe made it mount, fail its own listing, and paint a
  // second failure UI a moment before this one replaced it.
  if (isHealthLoading && !healthWaitExpired) {
    return (
      <GateShell leading={leading}>
        <div className="flex flex-col gap-2 p-4">
          {Array.from({ length: 7 }).map((_, i) => (
            <Skeleton key={i} className="h-9 w-full py-0" />
          ))}
        </div>
      </GateShell>
    );
  }

  if (!health?.healthy || healthWaitExpired) {
    return (
      <GateShell leading={leading}>
        <ErrorState
          icon={ServerOff}
          className="min-h-0 flex-1"
          title={tHardcodedUi.raw(
            'featuresFilesComponentsFileExplorerPage.line546JsxTextServerNotReachable',
          )}
          description={
            <>
              {tHardcodedUi.raw(
                'featuresFilesComponentsFileExplorerPage.line548JsxTextCouldNotConnectTo',
              )}{' '}
              <code className="bg-muted rounded px-1.5 py-0.5 text-xs">{serverUrl}</code>
            </>
          }
          action={
            <Button variant="outline" size="sm" className="gap-1.5" onClick={retry}>
              <RefreshCw className="size-3.5 shrink-0" />
              Retry
            </Button>
          }
        />
      </GateShell>
    );
  }

  return <>{children}</>;
}

/**
 * Closed-gate layout: the host's action row on top, its state below. Keeps the
 * row's height and border identical to the open explorer's, so opening the
 * gate does not shift the content down.
 */
function GateShell({ leading, children }: { leading?: ReactNode; children: ReactNode }) {
  return (
    <div className="bg-background flex h-full min-h-0 flex-col">
      {leading ? <div className={DRIVE_ACTION_ROW_CLASS}>{leading}</div> : null}
      <div className="flex min-h-0 flex-1 flex-col">{children}</div>
    </div>
  );
}
