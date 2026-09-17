'use client';

import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/features/layout/section/empty-state';
import { ErrorState } from '@/features/layout/section/error-state';
import {
  DRIVE_ACTION_ROW_CLASS,
  DriveExplorer,
  FileExplorerSourceProvider,
} from '@/features/project-files';
import { ProjectFilesProvider, useProjectContext } from '@/features/project-files/context';
import { useBoundedRuntimeWait } from '@/features/session/use-bounded-runtime-wait';
import { useRuntimeStore } from '@kortix/sdk/react';
import {
  ArrowClockwiseIcon as RefreshCw,
  CloudSlashIcon as ServerOff,
  MoonIcon,
} from '@phosphor-icons/react';
import { useTranslations } from '@/i18n/use-translations';
import { useState, type ElementType, type ReactNode } from 'react';
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
  listingAs,
  mirrorRef,
}: {
  embedded?: boolean;
  shareContext?: { projectId: string; sessionId: string };
  /** Host chrome for the start of the explorer's action row — see {@link DriveExplorer}. */
  leading?: ReactNode;
  /** Element type for the listing region — see {@link DriveExplorer}. */
  listingAs?: ElementType<{ className?: string; children?: ReactNode }>;
  /**
   * Where to read the listing from once the sandbox parks: the project's bare
   * git mirror at this session's branch. Supplying it is what lets an idle
   * session show its files instead of only explaining itself.
   */
  mirrorRef?: { projectId: string; ref: string };
} = {}) {
  const explorer = (
    <FileExplorerSourceProvider value={sandboxExplorerSource}>
      <SandboxServerGate leading={leading}>
        <DriveExplorer
          embedded={embedded}
          shareContext={shareContext}
          leading={leading}
          listingAs={listingAs}
        />
      </SandboxServerGate>
    </FileExplorerSourceProvider>
  );
  if (!mirrorRef) return explorer;
  return <ProjectFilesProvider value={mirrorRef}>{explorer}</ProjectFilesProvider>;
}

/**
 * Renders children only while the sandbox OpenCode server is reachable.
 *
 * The session panel's tabs now sit ABOVE this gate rather than being threaded
 * through it, so a booting or unreachable workspace can no longer take the
 * user's way out of it down with the explorer.
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
  const { data: health, isLoading: isHealthLoading, parked, refetch } = useServerHealth();
  const mirror = useProjectContext();
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

  // A parked box is not an unreachable one. The server answered: the sandbox
  // is asleep. "Could not connect to <url>" would be a false report of a
  // network failure, and its Retry cannot wake the box — a read is refused for
  // exactly that purpose, so only a SEND resumes it.
  //
  // So open the gate: the explorer reads this session's branch from the git
  // mirror and the files are simply there. Only a mount with no project/ref to
  // read them from (the debug page) has nothing to show, and says so once.
  if (parked) {
    if (mirror?.projectId && mirror.ref) return <>{children}</>;
    return (
      <GateShell leading={leading}>
        <EmptyState
          icon={MoonIcon}
          className="min-h-0 flex-1"
          title="This session is idle"
          description="Its workspace stopped after a spell of inactivity. Send a message in the chat and it starts again automatically."
        />
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
              {tHardcodedUi.raw('i18nComplete.text942087cc2d41')}
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
