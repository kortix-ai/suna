'use client';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import Loading from '@/components/ui/loading';
import { Modal, ModalBody, ModalContent, ModalHeader, ModalTitle } from '@/components/ui/modal';
import { errorToast, successToast } from '@/components/ui/toast';
import { ProviderLogo } from '@/features/providers/provider-branding';
import { LLM_PROVIDER_BY_ID } from '@/lib/llm-providers';
import {
  deleteProjectSecret,
  getProjectLlmCatalog,
  setActiveHarnessConnection,
  type HarnessAuthKind,
} from '@kortix/sdk/projects-client';
import {
  harnessLabel,
  invalidateComposerCapabilityQueries,
  type ModelsPageConnection,
  type ModelsPageRuntime,
} from '@kortix/sdk/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Unplug } from 'lucide-react';
import { useMemo, useState } from 'react';

import {
  CLAUDE_CODE_OAUTH_TOKEN_SECRET_NAME,
  CODEX_AUTH_JSON_SECRET_NAME,
  CUSTOM_LLM_SECRET_NAMES,
  LEGACY_OPENCODE_AUTH_JSON_SECRET_NAME,
  MANAGED_MODEL_ID_SET,
} from './constants';

const CONNECTION_ICON_PROVIDER_ID: Record<string, string> = {
  managed_gateway: 'kortix',
  claude_subscription: 'anthropic',
  codex_subscription: 'codex',
  anthropic_api_key: 'anthropic',
  openai_api_key: 'openai',
};

const SUBSCRIPTION_COPY: Partial<Record<HarnessAuthKind, string>> = {
  claude_subscription:
    'Models are selected by Claude Code. Kortix uses the harness default unless you choose a supported override when starting a session.',
  codex_subscription:
    'Models are selected by Codex. Kortix uses the harness default unless you choose a supported override when starting a session.',
};

const SECRET_NAMES_BY_KIND: Partial<Record<HarnessAuthKind, string[]>> = {
  claude_subscription: [CLAUDE_CODE_OAUTH_TOKEN_SECRET_NAME],
  codex_subscription: [CODEX_AUTH_JSON_SECRET_NAME, LEGACY_OPENCODE_AUTH_JSON_SECRET_NAME],
  anthropic_api_key: LLM_PROVIDER_BY_ID.get('anthropic')?.envVars ?? ['ANTHROPIC_API_KEY'],
  openai_api_key: LLM_PROVIDER_BY_ID.get('openai')?.envVars ?? ['OPENAI_API_KEY'],
  openai_compatible: [...CUSTOM_LLM_SECRET_NAMES],
  anthropic_compatible: [...CUSTOM_LLM_SECRET_NAMES],
};

const MANAGEABLE_KINDS = new Set<HarnessAuthKind>(Object.keys(SECRET_NAMES_BY_KIND) as HarnessAuthKind[]);

function ModelChips({ names, count }: { names: string[]; count: number }) {
  const shown = names.slice(0, 8);
  const more = count - shown.length;
  if (shown.length === 0) {
    return <p className="text-muted-foreground text-xs">{count} model{count === 1 ? '' : 's'} available</p>;
  }
  return (
    <div className="flex flex-wrap gap-1.5">
      {shown.map((name) => (
        <span key={name} className="bg-muted text-foreground rounded-full px-2.5 py-1 text-xs">
          {name}
        </span>
      ))}
      {more > 0 && <span className="text-muted-foreground px-1 text-xs">+{more} more</span>}
    </div>
  );
}

export function ManageConnectionModal({
  projectId,
  connection,
  runtimes,
  canWrite,
  open,
  onOpenChange,
  onReconnect,
}: {
  projectId: string;
  connection: ModelsPageConnection | null;
  runtimes: ModelsPageRuntime[];
  canWrite: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onReconnect: (kind: HarnessAuthKind) => void;
}) {
  const queryClient = useQueryClient();
  const [confirmOpen, setConfirmOpen] = useState(false);

  const catalogQuery = useQuery({
    queryKey: ['project-llm-catalog', projectId],
    queryFn: () => getProjectLlmCatalog(projectId),
    enabled: open && connection?.kind === 'managed_gateway',
    staleTime: 30_000,
  });

  const disconnect = useMutation({
    mutationFn: async () => {
      if (!connection) return;
      await Promise.all(
        connection.usedBy.map((harness) => setActiveHarnessConnection(projectId, harness, null)),
      );
      const names = SECRET_NAMES_BY_KIND[connection.kind] ?? [];
      await Promise.all(
        names.map((name) => deleteProjectSecret(projectId, name).catch(() => undefined)),
      );
    },
    onSuccess: () => {
      successToast(`${connection?.name} disconnected`);
      setConfirmOpen(false);
      onOpenChange(false);
      void invalidateComposerCapabilityQueries(queryClient, projectId);
    },
    onError: (err) => errorToast(err instanceof Error ? err.message : 'Failed to disconnect'),
  });

  const modelNames = useMemo(() => {
    if (!connection) return [];
    if (connection.kind === 'anthropic_api_key') {
      return (LLM_PROVIDER_BY_ID.get('anthropic')?.models ?? []).map((m) => m.name);
    }
    if (connection.kind === 'openai_api_key') {
      return (LLM_PROVIDER_BY_ID.get('openai')?.models ?? []).map((m) => m.name);
    }
    if (connection.kind === 'managed_gateway') {
      return Object.entries(catalogQuery.data?.models ?? {})
        .filter(([id]) => MANAGED_MODEL_ID_SET.has(id))
        .map(([id, model]) => model.name || id);
    }
    return [];
  }, [connection, catalogQuery.data]);

  if (!connection) return null;

  const manageable = MANAGEABLE_KINDS.has(connection.kind);
  const usedByLabels = connection.usedBy.map(harnessLabel);
  const otherRuntimesAffected = runtimes.filter((r) => connection.usedBy.includes(r.harness));

  return (
    <>
      <Modal open={open && !confirmOpen} onOpenChange={onOpenChange}>
        <ModalContent className="lg:max-w-md">
          <ModalHeader>
            <ModalTitle>{connection.name}</ModalTitle>
          </ModalHeader>
          <ModalBody className="space-y-4">
            <div className="bg-popover flex items-center gap-3 rounded-md border px-4 py-3">
              <ProviderLogo
                providerID={CONNECTION_ICON_PROVIDER_ID[connection.kind] ?? connection.kind}
                name={connection.name}
                size="default"
              />
              <div className="min-w-0 flex-1">
                <div className="text-foreground text-sm font-medium">{connection.name}</div>
                <p className="text-muted-foreground mt-0.5 text-xs">
                  {connection.statusReason ?? (connection.status === 'ready' ? 'Connected' : 'Checking…')}
                </p>
              </div>
              <Badge variant={connection.status === 'ready' ? 'success' : 'destructive'} size="sm">
                {connection.status === 'ready' ? 'Connected' : 'Needs attention'}
              </Badge>
            </div>

            <div className="space-y-1.5">
              <p className="text-xs font-medium">Used by</p>
              <p className="text-muted-foreground text-xs">
                {usedByLabels.length > 0 ? usedByLabels.join(', ') : 'Not currently used'}
              </p>
            </div>

            {SUBSCRIPTION_COPY[connection.kind] ? (
              <div className="space-y-1.5">
                <p className="text-xs font-medium">Models</p>
                <p className="text-muted-foreground text-xs text-pretty">{SUBSCRIPTION_COPY[connection.kind]}</p>
              </div>
            ) : connection.catalogState === 'available' ? (
              <div className="space-y-1.5">
                <p className="text-xs font-medium">Models</p>
                {connection.kind === 'managed_gateway' && catalogQuery.isLoading ? (
                  <Loading className="size-4 shrink-0" />
                ) : (
                  <ModelChips names={modelNames} count={connection.modelCount ?? 0} />
                )}
              </div>
            ) : null}

            {canWrite && manageable && (
              <div className="flex flex-wrap items-center gap-2 pt-1">
                <Button size="sm" variant="outline" onClick={() => onReconnect(connection.kind)}>
                  {connection.kind === 'openai_compatible' || connection.kind === 'anthropic_compatible'
                    ? 'Replace endpoint'
                    : connection.kind === 'anthropic_api_key' || connection.kind === 'openai_api_key'
                      ? 'Replace key'
                      : 'Reconnect'}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-muted-foreground hover:text-foreground gap-1.5"
                  onClick={() => setConfirmOpen(true)}
                >
                  <Unplug className="size-3.5 shrink-0" />
                  Disconnect
                </Button>
              </div>
            )}
          </ModalBody>
        </ModalContent>
      </Modal>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Disconnect connection"
        confirmLabel="Disconnect"
        confirmVariant="destructive"
        confirmIcon={<Unplug className="size-3.5 shrink-0" />}
        isPending={disconnect.isPending}
        onConfirm={() => disconnect.mutate()}
        description={
          <span className="text-xs">
            Remove <span className="text-foreground font-medium">{connection.name}</span>.{' '}
            {otherRuntimesAffected.length > 0 ? (
              <>
                {otherRuntimesAffected.map((r) => r.label).join(', ')} will fall back to a Harness
                default connection, or show &ldquo;Needs connection&rdquo; if none is available.{' '}
              </>
            ) : null}
            You&rsquo;ll need to reconnect to use it again.
          </span>
        }
      />
    </>
  );
}
