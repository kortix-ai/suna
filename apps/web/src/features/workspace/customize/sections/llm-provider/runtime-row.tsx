'use client';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import Loading from '@/components/ui/loading';
import { ProviderLogo } from '@/features/providers/provider-branding';
import type { HarnessId } from '@kortix/sdk/projects-client';
import type { ModelsPageConnection, ModelsPageRuntime } from '@kortix/sdk/react';
import type { ReactNode } from 'react';

import { ConnectionSelect } from './connection-select';

const HARNESS_ICON_PROVIDER_ID: Record<HarnessId, string> = {
  claude: 'anthropic',
  codex: 'codex',
  opencode: 'opencode',
  pi: 'pi',
};

function statusBadge(runtime: ModelsPageRuntime) {
  switch (runtime.status) {
    case 'ready':
      return (
        <Badge variant="success" size="sm">
          Connected
        </Badge>
      );
    case 'checking':
      return (
        <Badge variant="secondary" size="sm">
          Checking
        </Badge>
      );
    case 'needs-attention':
    case 'unavailable':
      return (
        <Badge variant="destructive" size="sm">
          {runtime.status === 'needs-attention' ? 'Needs attention' : 'Unavailable'}
        </Badge>
      );
    case 'ambiguous':
      return (
        <Badge variant="warning" size="sm">
          Choose connection
        </Badge>
      );
    case 'missing':
    default:
      return (
        <Badge variant="warning" size="sm">
          Needs connection
        </Badge>
      );
  }
}

export function RuntimeRow({
  projectId,
  runtime,
  connections,
  canWrite,
  onConnect,
  onManage,
}: {
  projectId: string;
  runtime: ModelsPageRuntime;
  connections: ModelsPageConnection[];
  canWrite: boolean;
  onConnect: (harness: HarnessId) => void;
  onManage: (connectionId: string) => void;
}) {
  let action: ReactNode = null;
  if (!canWrite) {
    action = null;
  } else if (runtime.status === 'checking') {
    action = (
      <Button size="sm" variant="outline" disabled className="min-h-10 gap-1.5">
        <Loading className="size-3.5 shrink-0" />
        Change
      </Button>
    );
  } else if (runtime.status === 'ready' || runtime.status === 'ambiguous') {
    action = (
      <ConnectionSelect
        projectId={projectId}
        harness={runtime.harness}
        connections={connections}
        compatibleConnectionIds={runtime.compatibleConnectionIds}
        selectedConnectionId={runtime.selectedConnectionId}
        triggerLabel={runtime.status === 'ambiguous' ? 'Choose' : 'Change'}
        onConnectAnother={() => onConnect(runtime.harness)}
      />
    );
  } else if (runtime.status === 'needs-attention' || runtime.status === 'unavailable') {
    action = (
      <Button
        size="sm"
        variant="outline"
        className="min-h-10 active:scale-[0.96] transition-transform"
        onClick={() =>
          runtime.selectedConnectionId ? onManage(runtime.selectedConnectionId) : onConnect(runtime.harness)
        }
      >
        Fix
      </Button>
    );
  } else {
    action = (
      <Button
        size="sm"
        className="min-h-10 active:scale-[0.96] transition-transform"
        onClick={() => onConnect(runtime.harness)}
      >
        Connect
      </Button>
    );
  }

  return (
    <li className="bg-popover rounded-md border px-4 py-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <ProviderLogo providerID={HARNESS_ICON_PROVIDER_ID[runtime.harness]} name={runtime.label} size="default" />
          <div className="min-w-0 flex-1 space-y-0.5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-foreground truncate text-sm font-medium">{runtime.label}</span>
              {statusBadge(runtime)}
            </div>
            <p className="text-muted-foreground truncate text-xs text-pretty">{runtime.modelSummary}</p>
          </div>
        </div>
        {action ? <div className="shrink-0 sm:self-center">{action}</div> : null}
      </div>
    </li>
  );
}
