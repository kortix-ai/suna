'use client';

import { type AdminConnector, type ConnectorAuthorizationStrategy, deleteConnector } from '@kortix/sdk';
import { TrashIcon } from '@phosphor-icons/react';
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Label } from '@/components/ui/label';
import { errorToast, successToast } from '@/components/ui/toast';
import { connectorAuthorizationStrategyIsEditable } from '@/features/workspace/customize/sections/connector-profile-form';
import { AuthorizationStrategyField } from '@/features/workspace/customize/sections/connector-profile-modal';

export interface RungSettingsProps {
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
 * Settings — capabilities #4 and #11. `visibleRungs` (`connector-rungs.ts`)
 * already restricts this rung to writers and drops it for `computer`
 * connectors, so neither is re-checked here.
 *
 * Capability #1 (rename) is deliberately NOT here. It lived on this rung until
 * the JAY-270 review: a `computer` connector has no Settings rung, but the old
 * `ConnectorDetail` panel let it be renamed, so a rung placement silently
 * dropped a capability `computer` connectors have today. Rename now lives in
 * the modal header (`HeaderName`, `connector-modal.tsx`), decoupled from
 * having a Settings rung at all.
 *
 * Capability #8 (`ConnectionSection` / `ChannelConnectionSection`) is also NOT
 * here, and that is deliberate too. The Capability Inventory files it under
 * Settings, and the JAY-270 review asked Task 12 to SPLIT it: the credential
 * row (`onSetCredential`) is an Accounts concern, `HeadersEditor` and the
 * URL/config fields are Settings concerns. That split needs a prop on
 * `ConnectionSection` to render one half without the other, or two components
 * where there is one — either way, an edit to `connectors-view.tsx`, which is
 * frozen at a zero-line diff for this entire milestone. Checked directly: its
 * `ConnectorConfigFields` and `HeadersEditor` helpers are both module-private
 * (no `export`, `connectors-view.tsx:4137` and `:4254`), and `ConnectionSection`
 * itself has no prop that selects a subset of its own JSX — the credential row,
 * the config fields and the `SaveBar` share one `draft`/`save` mutation with no
 * seam between them. The split is not reachable from outside the file, so per
 * the ruling this rung renders NOTHING for #8: `ConnectionSection` (or
 * `ChannelConnectionSection` for `provider === 'channel'`) stays whole on
 * Accounts (`rung-accounts.tsx`), where Task 8/9/10 already mounted it. Mounting
 * either component here too would show the same credential form on two rungs
 * at once — worse than the form living one rung over from where the plan
 * originally filed it.
 */
export function RungSettings({
  projectId,
  connector,
  displayName,
  canWrite,
  strategyUpdating,
  onAuthorizationStrategyChange,
  onRemoved,
}: RungSettingsProps) {
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
      {/* Capability #4. `AuthorizationStrategyField`'s own locked branch
          already renders a labelled, bordered `bg-popover` box (see
          `connector-profile-modal.tsx`) — wrapping it in a second one here
          would nest two rounded boxes and print "Who it connects as" right
          above the field's own "Authorization owner" label. The section only
          adds the plain-language line the field itself has no room for. */}
      <section className="space-y-2">
        <Label>Who it connects as</Label>
        <p className="text-muted-foreground text-xs text-pretty">
          Project — one account everyone uses. Each person — everyone connects their own.
        </p>
        <AuthorizationStrategyField
          idPrefix={`connector-${connector.slug}`}
          value={connector.authorizationStrategy}
          onChange={onAuthorizationStrategyChange}
          disabled={!canWrite || !connectorAuthorizationStrategyIsEditable(connector.provider)}
          // Settled once the connector exists. Switching owner after the fact
          // silently changes WHOSE account every future session runs as, and
          // orphans the profiles and permission rules already attached under
          // the old owner — a change that looks like a toggle and behaves
          // like a migration.
          lockedReason="Set when the connector was created. Remove and re-add the connector to change it — switching now would orphan the connections and permission rules already stored under the current owner."
          pending={strategyUpdating}
        />
      </section>

      {/* Capability #11. Channel connectors are removed from their own
          connection form (`ChannelConnectionSection`'s disconnect), which is
          why the old panel excluded them here too. Neutral danger-zone row —
          `variant="destructive"` belongs on the confirm button inside
          `ConfirmDialog`, not on this panel. */}
      {!isChannel ? (
        <div className="bg-popover rounded-md border px-4 py-3">
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <p className="text-foreground text-sm font-medium">Remove connector</p>
              <p className="text-muted-foreground mt-0.5 text-xs text-pretty">
                Deletes it from kortix.yaml. Stored profiles and permission rules are dropped.
              </p>
            </div>
            <Button
              size="sm"
              variant="outline"
              className="shrink-0 gap-1.5"
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
            This removes <code className="font-mono">{connector.slug}</code> from kortix.yaml and
            drops its stored profile and permission rules. This can’t be undone.
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
