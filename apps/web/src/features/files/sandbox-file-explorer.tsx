'use client';

import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState } from '@/features/layout/section/error-state';
import { DriveExplorer, FileExplorerSourceProvider } from '@/features/project-files';
import { useBoundedRuntimeWait } from '@/features/session/use-bounded-runtime-wait';
import { useRuntimeStore } from '@kortix/sdk/react';
import {
  ArrowClockwiseIcon as RefreshCw,
  CloudSlashIcon as ServerOff,
} from '@phosphor-icons/react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
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
}: {
  embedded?: boolean;
  shareContext?: { projectId: string; sessionId: string };
} = {}) {
  return (
    <FileExplorerSourceProvider value={sandboxExplorerSource}>
      <SandboxServerGate>
        <DriveExplorer embedded={embedded} shareContext={shareContext} />
      </SandboxServerGate>
    </FileExplorerSourceProvider>
  );
}

/** Renders children only while the sandbox OpenCode server is reachable. */
function SandboxServerGate({ children }: { children: React.ReactNode }) {
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
      <div className="bg-background flex h-full flex-col gap-2 p-4">
        <Skeleton className="h-8 w-full py-0" />
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-9 w-full py-0" />
        ))}
      </div>
    );
  }

  if (!health?.healthy || healthWaitExpired) {
    return (
      <ErrorState
        icon={ServerOff}
        className="bg-background h-full"
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
    );
  }

  return <>{children}</>;
}
