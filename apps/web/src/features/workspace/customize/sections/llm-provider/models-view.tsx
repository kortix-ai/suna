'use client';

import { Button } from '@/components/ui/button';
import { Disclosure, DisclosureContent, DisclosureTrigger } from '@/components/ui/disclosure';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/features/layout/section/empty-state';
import { ErrorState } from '@/features/layout/section/error-state';
import CustomizeSectionWrapper from '@/features/workspace/customize/sections/component/section-wrapper';
import { useCustomizeStore } from '@/stores/customize-store';
import type { HarnessAuthKind, HarnessId } from '@kortix/sdk/projects-client';
import {
  CONNECTIONS_OPTIONAL_DESCRIPTION,
  invalidateComposerCapabilityQueries,
  useModelsPage,
} from '@kortix/sdk/react';
import { useQueryClient } from '@tanstack/react-query';
import { Bot, ChevronDown, Plug, Plus } from 'lucide-react';
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
  // The services drawer stays closed by default so the page reads as ONE list —
  // "these are my agents" — at a glance. Managing services/keys is a deliberate
  // second step, not a competing wall of rows.
  const [servicesOpen, setServicesOpen] = useState(false);

  // The managed gateway ("Kortix") is always included; a healthy row is the
  // only signal the gateway itself is available (`useModelsPage` drops it
  // entirely when it's neither configured, ready, nor in use). We only use it
  // to phrase the "connecting is optional" note in the drawer.
  const managedGatewayConnection =
    state.connections.find((c) => c.kind === 'managed_gateway') ?? null;
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
  const initialLoad =
    state.isLoading && state.runtimes.length === 0 && state.connections.length === 0;

  // Back-link from here to Agents, where agent engines are declared/renamed
  // (this list only shows what's already declared). Same in-overlay `setSection`
  // switch `agent-editor.tsx` used — not a close, so nothing to close first.
  const manageAgents = () => useCustomizeStore.getState().setSection('agents');

  return (
    <CustomizeSectionWrapper
      title="Models"
      description="See what each of your agents runs on, and change it anytime."
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
      <div className="space-y-6">
        {state.isError ? (
          <ErrorState
            title="Couldn't load your models"
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
          <div className="space-y-2">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-16 rounded-md" />
            ))}
          </div>
        ) : (
          <>
            {/* One primary list: the agents. Each row says, in plain words,
                what it runs on and how to change it. */}
            <section className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <Label>Your agents</Label>
                {state.runtimes.length > 0 ? (
                  <Button
                    type="button"
                    variant="text"
                    size="xs"
                    className="-mr-2.5 active:scale-[0.96] transition-transform"
                    onClick={manageAgents}
                  >
                    Manage agents →
                  </Button>
                ) : null}
              </div>
              {state.runtimes.length === 0 ? (
                <EmptyState
                  size="sm"
                  icon={Bot}
                  title="No agents yet"
                  description="Add an agent in the Agents section and it'll show up here."
                  action={
                    canWrite ? (
                      <Button variant="outline" size="sm" onClick={manageAgents}>
                        Go to Agents
                      </Button>
                    ) : undefined
                  }
                />
              ) : (
                <ul className="space-y-2">
                  {state.runtimes.map((runtime) => (
                    <RuntimeRow
                      key={runtime.id}
                      projectId={projectId}
                      runtime={runtime}
                      connections={state.connections}
                      canWrite={canWrite}
                      onConnect={connectFromRuntime}
                      onManage={(connectionId) =>
                        setManageConnectionId(connectionId as HarnessAuthKind)
                      }
                    />
                  ))}
                </ul>
              )}
            </section>

            {/* Secondary: the services and keys behind those agents, collapsed
                by default. Connect/disconnect, see the models each unlocks, and
                set your default model (in Kortix) all live here — no on-page
                second list echoing the agents above. */}
            <section className="space-y-2">
              <Label>Connections</Label>
              <Disclosure
                variant="outline"
                open={servicesOpen}
                onOpenChange={setServicesOpen}
                className="overflow-hidden"
              >
                <DisclosureTrigger variant="outline">
                  <Button
                    variant="popover"
                    className="flex h-auto w-full items-center justify-between gap-3 rounded-none px-4 py-3"
                  >
                    <span className="flex min-w-0 items-center gap-3 text-left">
                      <Plug className="text-muted-foreground size-4 shrink-0" />
                      <span className="min-w-0">
                        <span className="text-foreground block truncate text-sm font-medium">
                          Model services &amp; keys
                        </span>
                        <span className="text-muted-foreground block truncate text-xs">
                          Connect or remove services, and set your default model
                        </span>
                      </span>
                    </span>
                    <ChevronDown className="text-muted-foreground size-4 shrink-0 transition-transform group-data-[state=open]:rotate-180" />
                  </Button>
                </DisclosureTrigger>
                <DisclosureContent variant="outline" contentClassName="border-border border-t">
                  <div className="space-y-2 px-3 py-3">
                    {userConnections.length === 0 && managedGatewayHealthy ? (
                      <p className="text-muted-foreground px-1 text-xs text-pretty">
                        {CONNECTIONS_OPTIONAL_DESCRIPTION}
                      </p>
                    ) : null}
                    {state.connections.length > 0 ? (
                      <ul className="space-y-2">
                        {state.connections.map((connection) => (
                          <ConnectionRow
                            key={connection.id}
                            connection={connection}
                            canWrite={canWrite}
                            onManage={(connectionId) =>
                              setManageConnectionId(connectionId as HarnessAuthKind)
                            }
                          />
                        ))}
                      </ul>
                    ) : (
                      <p className="text-muted-foreground px-1 text-xs text-pretty">
                        No services connected yet.
                      </p>
                    )}
                    {canWrite ? (
                      <Button
                        variant="outline"
                        size="sm"
                        className="w-full gap-1.5"
                        onClick={() => openConnectModal({})}
                      >
                        <Plus className="size-3.5 shrink-0" />
                        Connect a service
                      </Button>
                    ) : null}
                  </div>
                </DisclosureContent>
              </Disclosure>
            </section>
          </>
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
