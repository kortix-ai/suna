'use client';

import {
  type AdminConnector,
  type ConnectorAuthorizationStrategy,
  deleteConnector,
} from '@kortix/sdk';
import { TrashIcon } from '@phosphor-icons/react';
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Label } from '@/components/ui/label';
import { errorToast, successToast } from '@/components/ui/toast';
import { connectorAuthorizationStrategyIsEditable } from '@/features/workspace/customize/sections/connector-connection-form';
import { AuthorizationStrategyField } from '@/features/workspace/customize/sections/connector-connection-modal';

export interface ConnectorSettingsProps {
  projectId: string;
  connector: AdminConnector;
  displayName: string;
  canWrite: boolean;
  /** The authorization owner is mid-update — freeze the Remove control too. */
  strategyUpdating: boolean;
  onAuthorizationStrategyChange: (next: ConnectorAuthorizationStrategy) => void;
  onRemoved: () => void;
}

/**
 * Settings — who the connector runs as, and removing it.
 *
 * `connectorTabs` already restricts this tab to writers and drops it for
 * `computer` connectors, so neither is re-checked here.
 *
 * Two rows, one shape: label, statement, trailing control. Every row is a
 * `bg-popover rounded-md border px-4 py-3` box, so they line up as one wall.
 *
 * Renaming is not here — it lives in the modal header (`HeaderName`), so
 * `computer` connectors keep it without having a Settings tab.
 */
export function ConnectorSettings({
  projectId,
  connector,
  displayName,
  canWrite,
  strategyUpdating,
  onAuthorizationStrategyChange,
  onRemoved,
}: ConnectorSettingsProps) {
  const isChannel = connector.provider === 'channel';
  const [confirmDelete, setConfirmDelete] = useState(false);

  const remove = useMutation({
    mutationFn: () => deleteConnector(projectId, connector.slug),
    onSuccess: () => {
      successToast(`Removed ${displayName}`);
      onRemoved();
    },
    onError: (e: Error) => errorToast(e.message || 'Failed to remove'),
  });

  return (
    <div className="space-y-5">
      {/* Capability #4. `hideLabel` drops the field's own "Authorization owner"
          heading so "Connects as" is the only name for this control — the field
          already states the value, the owner and why it is fixed inside its own
          row, and a second heading in a second vocabulary was the thing that
          made this tab read as noise. */}
      <section className="space-y-2">
        <Label>Connects as</Label>
        <AuthorizationStrategyField
          idPrefix={`connector-${connector.slug}`}
          value={connector.authorizationStrategy}
          // The write path is unreachable BY DESIGN, not missing.
          // `onAuthorizationStrategyChange` is the real
          // `setConnectorAuthorizationStrategy` mutation (`connector-modal.tsx`);
          // `disabled` and `pending` compute real values every render.
          // `lockedReason` is the only thing forcing the control off, so
          // re-enabling editing is deleting that one prop.
          onChange={onAuthorizationStrategyChange}
          disabled={!canWrite || !connectorAuthorizationStrategyIsEditable(connector.provider)}
          pending={strategyUpdating}
          lockedReason="Set when the connector was added. To change it, remove the connector and add it again — saved connections and tool rules are lost."
          hideLabel
        />
      </section>

      {/* Capability #11. Channel connectors disconnect from their own connection
          form (`ChannelConnectionSection`), so they get no Remove row here.
          The row stays neutral — `variant="destructive"` belongs on the confirm
          button inside `ConfirmDialog`, not on the panel. */}
      {!isChannel ? (
        <div className="bg-popover rounded-md border px-4 py-3">
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <p className="text-foreground text-sm font-medium">Remove connector</p>
              <p className="text-muted-foreground mt-0.5 text-xs text-pretty">
                Its saved connections and tool rules are deleted too.
              </p>
            </div>
            <Button
              size="sm"
              variant="outline"
              className="shrink-0 gap-1.5 active:scale-[0.96]"
              onClick={() => setConfirmDelete(true)}
              disabled={strategyUpdating}
            >
              <TrashIcon className="size-3.5 shrink-0" />
              Remove
            </Button>
          </div>
        </div>
      ) : null}

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Remove ${displayName}?`}
        description={
          <>
            This deletes <code className="font-mono">{connector.slug}</code>, its saved connections
            and its tool rules. This can’t be undone.
          </>
        }
        confirmLabel="Remove connector"
        confirmVariant="destructive"
        confirmIcon={<TrashIcon className="size-4 shrink-0" />}
        isPending={remove.isPending}
        onConfirm={() => remove.mutate()}
      />
    </div>
  );
}
