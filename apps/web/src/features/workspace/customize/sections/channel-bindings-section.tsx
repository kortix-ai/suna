'use client';

/**
 * Per-channel agent/model/join-policy overrides — the web management surface
 * for `chat_channel_bindings` (spec §2.5 "Channels become manageable"). Today
 * the only other way to change these is the in-Slack `/kortix agent|model|policy`
 * commands; this edits the same row through `PATCH …/channels/bindings/:id`.
 *
 * Shared between every channel profile in Connectors (Slack/Teams/Email) —
 * pass `platform` to scope the table to that connector's bindings only, or
 * omit it to show every binding across every connected channel.
 */

import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { errorToast, successToast } from '@/components/ui/toast';
import { ModelSelector } from '@/features/session/model-selector';
import { AgentSelector, flattenModels } from '@/features/session/session-chat-input';
import {
  type ChannelBinding,
  useChannelBindings,
  useUpdateChannelBinding,
} from '@/hooks/channels/use-channel-bindings';
import { modelKeyToWire, wireToModelKey } from '@/hooks/opencode/use-model-store';
import {
  type Agent,
  useOpenCodeProviders,
  useVisibleAgents,
} from '@/hooks/opencode/use-opencode-sessions';
import { listProjectAccess } from '@kortix/sdk/projects-client';
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

export function ChannelBindingsSection({
  projectId,
  canWrite,
  platform,
}: {
  projectId: string;
  canWrite: boolean;
  /** Scope the table to one platform's bindings (e.g. 'slack', 'teams'). Omit for all. */
  platform?: string;
}) {
  const bindingsQuery = useChannelBindings(projectId);
  const bindings = useMemo(() => {
    const all = bindingsQuery.data?.bindings ?? [];
    return platform ? all.filter((b) => b.platform === platform) : all;
  }, [bindingsQuery.data, platform]);

  if (bindingsQuery.isLoading) {
    return (
      <div className="space-y-1">
        <Skeleton className="h-8 rounded-md" />
        <Skeleton className="h-8 rounded-md" />
      </div>
    );
  }
  if (bindings.length === 0) return null;

  return (
    <div className="space-y-2">
      <Label>Channel bindings</Label>
      <p className="text-muted-foreground text-xs">
        Which agent, model, and join policy each connected channel uses. A channel with no override
        follows the project default.
      </p>
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead>Channel</TableHead>
            <TableHead>Agent</TableHead>
            <TableHead>Model</TableHead>
            <TableHead>Join policy</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {bindings.map((b) => (
            <ChannelBindingTableRow
              key={b.bindingId}
              projectId={projectId}
              binding={b}
              projectDefaultAgent={bindingsQuery.data?.projectDefaultAgent ?? null}
              canWrite={canWrite}
            />
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

const CONVERSATION_POLICIES: Array<{ value: ChannelBinding['conversationPolicy']; label: string }> =
  [
    { value: 'project_open', label: 'Project members can join' },
    { value: 'owner_only', label: 'Owner only' },
    { value: 'owner_approval', label: 'Owner approval' },
  ];

/** Label for the synthetic agent-picker entry meaning "inherit the project's default agent". */
function agentDefaultLabel(projectDefaultAgent: string | null): string {
  return projectDefaultAgent ? `Project default (${projectDefaultAgent})` : 'Project default';
}

/** Bare model id → the compact form callers below already assume (`kortix/x` → `x`). */
function stripOpencodeNamespace(model: string): string {
  return model.startsWith('kortix/') ? model.slice('kortix/'.length) : model;
}

/**
 * Honest one-line summary of what a channel's model binding will actually
 * run — including the case an explicit pin silently degrades because it's no
 * longer servable (BYOK key disconnected, managed model retired), which
 * `effectiveModel.source` surfaces as something other than `'explicit'`.
 */
function describeEffectiveModel(binding: ChannelBinding): string {
  if (binding.opencodeModel) {
    const label = stripOpencodeNamespace(binding.opencodeModel);
    return binding.effectiveModel.source === 'explicit'
      ? label
      : `${label} (unavailable — using default)`;
  }
  const resolved = binding.effectiveModel.model;
  return resolved ? `Project default (${stripOpencodeNamespace(resolved)})` : 'Project default';
}

function errorToastFallback(error: unknown) {
  errorToast(error instanceof Error ? error.message : 'Failed to update channel binding');
}

function ChannelBindingTableRow({
  projectId,
  binding,
  projectDefaultAgent,
  canWrite,
}: {
  projectId: string;
  binding: ChannelBinding;
  projectDefaultAgent: string | null;
  canWrite: boolean;
}) {
  const accessQuery = useQuery({
    queryKey: ['project-access', projectId],
    queryFn: () => listProjectAccess(projectId),
    staleTime: 20_000,
  });
  // `can_manage` is the coarse project-manage flag; AND it with the real
  // connector write leaf so a READ-only connector role can't edit bindings
  // (the PATCH route asserts project.connector.write and would 403).
  const canManage = Boolean(accessQuery.data?.can_manage) && canWrite;

  // Same agent source as the chat input / schedules pickers (spec: "use the
  // same component everywhere"). `projectId` does a server-side fetch of the
  // declared manifest agents — no live sandbox/session required, so it works
  // on a settings page with nothing running.
  const visibleAgents = useVisibleAgents({ projectId });
  const agentSelectorAgents = useMemo<Agent[]>(() => {
    const defaultEntry = {
      name: agentDefaultLabel(projectDefaultAgent),
      description: "Falls back to the project's configured default agent.",
      mode: 'primary',
      permission: {},
      options: {},
    } as unknown as Agent;
    const names = new Set(visibleAgents.map((a) => a.name));
    // Keep a currently-bound name in the list even if it was since renamed/
    // removed, so the picker never renders a value it can't display.
    const missingCurrent =
      binding.agentName && !names.has(binding.agentName)
        ? [
            {
              name: binding.agentName,
              mode: 'primary',
              permission: {},
              options: {},
            } as unknown as Agent,
          ]
        : [];
    return [defaultEntry, ...visibleAgents, ...missingCurrent];
  }, [visibleAgents, projectDefaultAgent, binding.agentName]);
  const selectedAgentValue = binding.agentName ?? agentDefaultLabel(projectDefaultAgent);

  const { data: providers } = useOpenCodeProviders();
  const models = useMemo(() => flattenModels(providers), [providers]);
  const selectedModel = binding.opencodeModel
    ? wireToModelKey(stripOpencodeNamespace(binding.opencodeModel))
    : null;

  const update = useUpdateChannelBinding();

  return (
    <TableRow className="hover:bg-transparent">
      <TableCell>
        <div className="min-w-0">
          <p className="text-sm font-medium">{binding.channelName ?? binding.channelId}</p>
          <p className="text-muted-foreground text-xs">{binding.workspaceId}</p>
        </div>
      </TableCell>
      <TableCell>
        <div className="bg-card rounded-2xl border px-2 py-1 inline-flex">
          <AgentSelector
            agents={agentSelectorAgents}
            selectedAgent={selectedAgentValue}
            onSelect={(v) =>
              update.mutate(
                {
                  projectId,
                  bindingId: binding.bindingId,
                  agentName: !v || v === agentDefaultLabel(projectDefaultAgent) ? null : v,
                },
                {
                  onSuccess: () => successToast('Channel agent updated'),
                  onError: (e) => errorToastFallback(e),
                },
              )
            }
            disabled={!canManage || update.isPending}
          />
        </div>
      </TableCell>
      <TableCell>
        {canManage ? (
          <div className="flex flex-col gap-1">
            <div className="bg-card rounded-2xl border px-2 py-1 inline-flex w-fit">
              <ModelSelector
                models={models}
                providers={providers}
                selectedModel={selectedModel}
                unsetLabel="Project default"
                onSelect={(m) =>
                  update.mutate(
                    {
                      projectId,
                      bindingId: binding.bindingId,
                      opencodeModel: m ? modelKeyToWire(m) : null,
                    },
                    {
                      onSuccess: () => successToast('Channel model updated'),
                      onError: (e) => errorToastFallback(e),
                    },
                  )
                }
              />
            </div>
            {!binding.opencodeModel ? (
              <p className="text-muted-foreground/70 text-xs">{describeEffectiveModel(binding)}</p>
            ) : null}
          </div>
        ) : (
          <Badge variant="outline" size="sm" className="font-mono">
            {describeEffectiveModel(binding)}
          </Badge>
        )}
      </TableCell>
      <TableCell>
        <Select
          value={binding.conversationPolicy}
          onValueChange={(v) =>
            update.mutate(
              {
                projectId,
                bindingId: binding.bindingId,
                conversationPolicy: v as ChannelBinding['conversationPolicy'],
              },
              {
                onSuccess: () => successToast('Join policy updated'),
                onError: (e) => errorToastFallback(e),
              },
            )
          }
          disabled={!canManage || update.isPending}
        >
          <SelectTrigger className="w-44" variant="popover">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {CONVERSATION_POLICIES.map((p) => (
              <SelectItem key={p.value} value={p.value}>
                {p.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </TableCell>
    </TableRow>
  );
}
