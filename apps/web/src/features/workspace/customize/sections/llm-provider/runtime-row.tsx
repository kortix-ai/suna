'use client';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import Loading from '@/components/ui/loading';
import { ProviderLogo } from '@/features/providers/provider-branding';
import { cn } from '@/lib/utils';
import type { HarnessId } from '@kortix/sdk/projects-client';
import type { ModelsPageConnection, ModelsPageRuntime } from '@kortix/sdk/react';
import type { ReactNode } from 'react';

import { ConnectionSelect } from './connection-select';
import { runtimeStatusBadge } from './connection-status';

const HARNESS_ICON_PROVIDER_ID: Record<HarnessId, string> = {
  claude: 'anthropic',
  codex: 'codex',
  opencode: 'opencode',
  pi: 'pi',
};

/** Harnesses that own their own model choice — a subscription-backed engine
 *  (Claude Code, Codex) or Pi, which always runs the harness default. For
 *  these the model line reads "<engine> chooses the model" instead of naming a
 *  Kortix/BYOK default — stated plainly, never as a dead end. */
const HARNESS_PICKS_ITS_OWN_MODEL = new Set<HarnessId>(['claude', 'codex', 'pi']);

function statusBadge(runtime: ModelsPageRuntime) {
  const badge = runtimeStatusBadge(runtime.status);
  return (
    <Badge variant={badge.variant} size="sm">
      {badge.label}
    </Badge>
  );
}

/** The connection paying for a runtime, rendered inline as a subtle button
 *  that opens its Manage sheet (disconnect, models it unlocks, and — for
 *  Kortix — the default model). Read-only viewers see plain text. */
function ConnectionChip({
  name,
  canWrite,
  onClick,
}: {
  name: string;
  canWrite: boolean;
  onClick: () => void;
}) {
  if (!canWrite) return <span className="text-foreground font-medium">{name}</span>;
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'text-foreground font-medium underline decoration-dotted underline-offset-2',
        'decoration-muted-foreground/40 hover:decoration-foreground transition-colors',
      )}
    >
      {name}
    </button>
  );
}

/** Plain-language "what this agent runs on" line — no jargon ("runtime",
 *  "connection", "harness default"). An agent runs on a service and either
 *  uses its own model or a default you set. The service name is a live chip
 *  into its Manage sheet whenever one is resolved. */
function modelLine(
  runtime: ModelsPageRuntime,
  connection: ModelsPageConnection | null,
  canWrite: boolean,
  onManage: (connectionId: string) => void,
): ReactNode {
  if (runtime.status === 'checking') return `Checking ${runtime.label}…`;

  const chip = connection ? (
    <ConnectionChip
      name={connection.name}
      canWrite={canWrite}
      onClick={() => onManage(connection.id)}
    />
  ) : null;

  if (runtime.status === 'ready' && connection) {
    const policy = HARNESS_PICKS_ITS_OWN_MODEL.has(runtime.harness)
      ? `${runtime.label} chooses the model`
      : connection.kind === 'managed_gateway'
        ? 'model chosen automatically'
        : 'uses your default model';
    return (
      <>
        Runs on {chip} — {policy}
      </>
    );
  }

  if (runtime.status === 'needs-attention') {
    return chip ? <>{chip} needs reconnecting</> : 'Needs reconnecting to keep working';
  }
  if (runtime.status === 'ambiguous') return 'Pick which service this agent uses';
  if (runtime.status === 'unavailable') return 'Currently unavailable';
  return 'Not set up yet — connect a model service';
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
  const connection = connections.find((c) => c.id === runtime.selectedConnectionId) ?? null;

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
          runtime.selectedConnectionId
            ? onManage(runtime.selectedConnectionId)
            : onConnect(runtime.harness)
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
          <ProviderLogo
            providerID={HARNESS_ICON_PROVIDER_ID[runtime.harness]}
            name={runtime.label}
            size="default"
          />
          <div className="min-w-0 flex-1 space-y-0.5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-foreground truncate text-sm font-medium">{runtime.label}</span>
              {statusBadge(runtime)}
            </div>
            <p className="text-muted-foreground text-xs text-pretty">
              {modelLine(runtime, connection, canWrite, onManage)}
            </p>
          </div>
        </div>
        {action ? <div className="shrink-0 sm:self-center">{action}</div> : null}
      </div>
    </li>
  );
}
