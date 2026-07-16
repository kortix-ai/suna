'use client';

import { useTranslations } from 'next-intl';
import { RefreshCw, ServerOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DriveExplorer, FileExplorerSourceProvider } from '@/features/project-files';
import { useServerStore } from '@/stores/server-store';
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
  const serverUrl = useServerStore((s) => s.getActiveServerUrl());
  const { data: health, isLoading: isHealthLoading, refetch } = useServerHealth();

  if (!isHealthLoading && !health?.healthy) {
    return (
      <div className="bg-background flex h-full flex-col items-center justify-center gap-4 p-8 text-center">
        <ServerOff className="text-muted-foreground/30 h-12 w-12" />
        <div>
          <h3 className="text-foreground text-base font-medium">
            {tHardcodedUi.raw(
              'featuresFilesComponentsFileExplorerPage.line546JsxTextServerNotReachable',
            )}
          </h3>
          <p className="text-muted-foreground mt-1.5 text-sm">
            {tHardcodedUi.raw(
              'featuresFilesComponentsFileExplorerPage.line548JsxTextCouldNotConnectTo',
            )}{' '}
            <code className="bg-muted rounded px-1.5 py-0.5 text-xs">{serverUrl}</code>
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => refetch()}>
          <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
          Retry
        </Button>
      </div>
    );
  }

  return <>{children}</>;
}
