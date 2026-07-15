'use client';

import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/features/layout/section/empty-state';
import { ErrorState } from '@/features/layout/section/error-state';
import CustomizeSectionWrapper from '@/features/workspace/customize/sections/component/section-wrapper';
import type { HarnessAuthKind, HarnessId } from '@kortix/sdk/projects-client';
import { invalidateComposerCapabilityQueries, useModelsPage } from '@kortix/sdk/react';
import { useQueryClient } from '@tanstack/react-query';
import { Plug, Plus } from 'lucide-react';
import { useEffect, useState } from 'react';

import { ConnectModelModal } from './connect-model-modal';
import { ConnectionRow } from './connection-row';
import { ManageConnectionModal } from './manage-connection-modal';
import { RuntimeRow } from './runtime-row';

type ConnectState = { open: boolean; harnessFilter: HarnessId | null; initialKind: HarnessAuthKind | null };
const CONNECT_CLOSED: ConnectState = { open: false, harnessFilter: null, initialKind: null };

/** The flagship connect method per harness — "Connect Claude Code" lands the
 *  user directly in this form (skipping the method list) as long as it isn't
 *  connected yet. Once it is, the generic method list takes over so "connect
 *  another service" isn't hijacked. */
const HARNESS_SUBSCRIPTION: Partial<Record<HarnessId, HarnessAuthKind>> = {
  claude: 'claude_subscription',
  codex: 'codex_subscription',
};

export function ModelsView({
  projectId,
  canWrite = false,
  connectRequest = null,
}: {
  projectId: string;
  canWrite?: boolean;
  /** Deep link: open the Connect modal directly on this method's form (used
   *  by composer "Connect Claude Code"-style CTAs). The nonce distinguishes
   *  repeat requests while the view stays mounted. */
  connectRequest?: { kind: HarnessAuthKind; nonce: number } | null;
}) {
  const queryClient = useQueryClient();
  const state = useModelsPage(projectId, canWrite);
  const [connectState, setConnectState] = useState<ConnectState>(CONNECT_CLOSED);
  const [manageConnectionId, setManageConnectionId] = useState<HarnessAuthKind | null>(null);

  useEffect(() => {
    if (!connectRequest || !canWrite) return;
    setConnectState({ open: true, harnessFilter: null, initialKind: connectRequest.kind });
  }, [connectRequest?.nonce, connectRequest?.kind, canWrite]);

  const connectFromRuntime = (harness: HarnessId) => {
    const subscription = HARNESS_SUBSCRIPTION[harness];
    const subscriptionReady =
      subscription != null &&
      state.connections.some((c) => c.id === subscription && c.status === 'ready');
    setConnectState({
      open: true,
      harnessFilter: harness,
      initialKind: subscription && !subscriptionReady ? subscription : null,
    });
  };

  const manageConnection = state.connections.find((c) => c.id === manageConnectionId) ?? null;
  const initialLoad = state.isLoading && state.runtimes.length === 0 && state.connections.length === 0;

  return (
    <CustomizeSectionWrapper
      title="Models"
      description="Connect model services and choose what each agent runtime uses."
      action={
        canWrite ? (
          <Button
            size="sm"
            variant="secondary"
            className="gap-1.5 active:scale-[0.96] transition-transform"
            onClick={() => setConnectState({ open: true, harnessFilter: null, initialKind: null })}
          >
            <Plus className="size-4 shrink-0" />
            Connect
          </Button>
        ) : undefined
      }
    >
      {state.isError ? (
        <ErrorState
          title="Couldn't load model connections"
          action={
            <Button
              variant="outline"
              size="sm"
              onClick={() => void invalidateComposerCapabilityQueries(queryClient, projectId)}
            >
              Retry
            </Button>
          }
        />
      ) : initialLoad ? (
        <div className="space-y-5">
          <div className="space-y-2">
            {[0, 1].map((i) => (
              <Skeleton key={i} className="h-16 rounded-md" />
            ))}
          </div>
          <div className="space-y-2">
            {[0, 1].map((i) => (
              <Skeleton key={i} className="h-16 rounded-md" />
            ))}
          </div>
        </div>
      ) : (
        <div className="space-y-5">
          {state.runtimes.length > 0 && (
            <section className="space-y-2">
              <Label>Agent runtimes</Label>
              <ul className="space-y-2">
                {state.runtimes.map((runtime) => (
                  <RuntimeRow
                    key={runtime.id}
                    projectId={projectId}
                    runtime={runtime}
                    connections={state.connections}
                    canWrite={canWrite}
                    onConnect={connectFromRuntime}
                    onManage={(connectionId) => setManageConnectionId(connectionId as HarnessAuthKind)}
                  />
                ))}
              </ul>
            </section>
          )}

          <section className="space-y-2">
            <Label>Connections</Label>
            {state.connections.length === 0 ? (
              <EmptyState
                size="sm"
                icon={Plug}
                title="No model services connected yet"
                action={
                  canWrite ? (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setConnectState({ open: true, harnessFilter: null, initialKind: null })}
                    >
                      Connect
                    </Button>
                  ) : undefined
                }
              />
            ) : (
              <ul className="space-y-2">
                {state.connections.map((connection) => (
                  <ConnectionRow
                    key={connection.id}
                    connection={connection}
                    canWrite={canWrite}
                    onManage={(connectionId) => setManageConnectionId(connectionId as HarnessAuthKind)}
                  />
                ))}
              </ul>
            )}
          </section>
        </div>
      )}

      <ConnectModelModal
        projectId={projectId}
        open={connectState.open}
        onOpenChange={(open) => setConnectState((current) => ({ ...current, open }))}
        runtimes={state.runtimes}
        connections={state.connections}
        harnessFilter={connectState.harnessFilter}
        initialKind={connectState.initialKind}
        onConnected={() => setConnectState(CONNECT_CLOSED)}
      />

      <ManageConnectionModal
        projectId={projectId}
        connection={manageConnection}
        runtimes={state.runtimes}
        canWrite={canWrite}
        open={manageConnectionId !== null}
        onOpenChange={(open) => {
          if (!open) setManageConnectionId(null);
        }}
        onReconnect={(kind) => {
          setManageConnectionId(null);
          setConnectState({ open: true, harnessFilter: null, initialKind: kind });
        }}
      />
    </CustomizeSectionWrapper>
  );
}
