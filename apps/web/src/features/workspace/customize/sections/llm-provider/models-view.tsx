'use client';

import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { errorToast } from '@/components/ui/toast';
import { EmptyState } from '@/features/layout/section/empty-state';
import { ErrorState } from '@/features/layout/section/error-state';
import { ModelSelector } from '@/features/session/model-selector';
import CustomizeSectionWrapper from '@/features/workspace/customize/sections/component/section-wrapper';
import { useModelDefaults } from '@/hooks/runtime/use-model-defaults';
import { useCustomizeStore } from '@/stores/customize-store';
import type { HarnessAuthKind, HarnessId } from '@kortix/sdk/projects-client';
import {
  CONNECTIONS_OPTIONAL_DESCRIPTION,
  KORTIX_INCLUDED_TITLE,
  gatewayRoutingPolicyKey,
  invalidateComposerCapabilityQueries,
  useModelsPage,
  useProjectModels,
} from '@kortix/sdk/react';
import { useIsMutating, useQueryClient } from '@tanstack/react-query';
import { Plug, Plus, Sparkles } from 'lucide-react';
import { useState } from 'react';

import { useConnectModal } from './connect-modal-host';
import { ConnectionRow } from './connection-row';
import { ManageConnectionModal } from './manage-connection-modal';
import { RuntimeRow } from './runtime-row';

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
}: {
  projectId: string;
  canWrite?: boolean;
}) {
  const queryClient = useQueryClient();
  const state = useModelsPage(projectId, canWrite);
  const { open: openConnectModal } = useConnectModal();
  const [manageConnectionId, setManageConnectionId] = useState<HarnessAuthKind | null>(null);

  // Default model — relocated here from `gateway-view.tsx`'s tab bar
  // (Task 17): same `useModelDefaults` write path, same inheritance chain
  // (project -> account -> platform) and the same routing-mutation guard, so
  // this is a mechanical move rather than a behavior change.
  const models = useProjectModels(projectId);
  const modelDefaults = useModelDefaults(projectId);
  const routingMutationCount = useIsMutating({ mutationKey: gatewayRoutingPolicyKey(projectId) });
  const effectiveDefault =
    modelDefaults.projectDefault ??
    modelDefaults.accountDefault ??
    modelDefaults.platformDefault ??
    null;

  // The managed gateway ("Kortix") is always included, so it never counts as
  // a "user connection" for the empty-state decision below — only a
  // subscription, an API key, or a custom endpoint the user actually set up
  // does. Its presence here (with `status: 'ready'`) is also the only signal
  // that the gateway itself is healthy: `useModelsPage` excludes it entirely
  // when it's neither configured, ready, nor in use (see
  // `packages/sdk/src/react/use-models-page.ts`'s connection filter), so an
  // absent/not-ready row means genuinely unavailable, not just "not set up".
  const managedGatewayConnection = state.connections.find((c) => c.kind === 'managed_gateway') ?? null;
  const managedGatewayHealthy = managedGatewayConnection?.status === 'ready';
  const userConnections = state.connections.filter((c) => c.kind !== 'managed_gateway');

  const connectFromRuntime = (harness: HarnessId) => {
    const subscription = HARNESS_SUBSCRIPTION[harness];
    const subscriptionReady =
      subscription != null &&
      state.connections.some((c) => c.id === subscription && c.status === 'ready');
    openConnectModal({
      harnessFilter: harness,
      connectKind: subscription && !subscriptionReady ? subscription : undefined,
    });
  };

  const manageConnection = state.connections.find((c) => c.id === manageConnectionId) ?? null;
  const initialLoad = state.isLoading && state.runtimes.length === 0 && state.connections.length === 0;

  // DISC-09: the deferred half of WS5-P2-b's guided runtime -> connect ->
  // model flow — a back-link from here to the Runtime section, where
  // profiles are declared/renamed (this list only shows what's already
  // declared). Same `setSection` action `agent-editor.tsx`'s "Manage
  // runtimes ->" cross-link uses, not a new navigation primitive; this is an
  // in-overlay switch, not a close, so there's nothing to close first.
  const manageRuntimes = () => useCustomizeStore.getState().setSection('runtime');

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
            onClick={() => openConnectModal({})}
          >
            <Plus className="size-4 shrink-0" />
            Connect
          </Button>
        ) : undefined
      }
    >
      <div className="space-y-5">
        {canWrite && (
          <section className="space-y-2">
            <Label>Default model</Label>
            <div className="bg-popover flex flex-col gap-3 rounded-md border px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-muted-foreground text-xs text-pretty">
                Used when an agent doesn&apos;t pick its own
              </p>
              <ModelSelector
                models={models}
                selectedModel={effectiveDefault}
                unsetLabel="Project default"
                disabled={
                  modelDefaults.isLoading || modelDefaults.isUpdating || routingMutationCount > 0
                }
                onSelect={(m) => {
                  if (!m) return;
                  void modelDefaults
                    .setProjectDefault(m)
                    .catch(() => errorToast('Could not update the project default'));
                }}
              />
            </div>
          </section>
        )}

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
                <div className="flex items-center justify-between gap-2">
                  <Label>Agent runtimes</Label>
                  <Button
                    type="button"
                    variant="text"
                    size="xs"
                    className="-mr-2.5 active:scale-[0.96] transition-transform"
                    onClick={manageRuntimes}
                  >
                    Manage agents →
                  </Button>
                </div>
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
              <Label>Your connections</Label>
              {userConnections.length === 0 ? (
                managedGatewayHealthy ? (
                  // The honest "you're set" reassurance: Kortix models work
                  // out of the box, connecting anything else is optional —
                  // never claim this when the managed gateway itself isn't
                  // actually available (see the legacy branch below).
                  <EmptyState
                    size="sm"
                    icon={Sparkles}
                    title={KORTIX_INCLUDED_TITLE}
                    description={CONNECTIONS_OPTIONAL_DESCRIPTION}
                    action={
                      canWrite ? (
                        <Button variant="outline" size="sm" onClick={() => openConnectModal({})}>
                          Connect
                        </Button>
                      ) : undefined
                    }
                  />
                ) : (
                  <EmptyState
                    size="sm"
                    icon={Plug}
                    title="No model services connected yet"
                    action={
                      canWrite ? (
                        <Button variant="outline" size="sm" onClick={() => openConnectModal({})}>
                          Connect
                        </Button>
                      ) : undefined
                    }
                  />
                )
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
      </div>

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
          openConnectModal({ connectKind: kind });
        }}
      />
    </CustomizeSectionWrapper>
  );
}
