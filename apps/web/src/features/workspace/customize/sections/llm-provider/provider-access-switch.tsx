'use client';

import { Switch } from '@/components/ui/switch';
import { errorToast } from '@/components/ui/toast';
import type { useModelAccess } from '@kortix/sdk/react';

type Access = ReturnType<typeof useModelAccess>;

/** Credential configuration stays available while inference is disabled. */
export function ProviderAccessSwitch({
  access,
  providerId,
  name,
  canWrite,
}: {
  access: Access;
  providerId: string;
  name: string;
  canWrite: boolean;
}) {
  if (!access.data?.enforced) return null;
  const enabled = !access.data.disabledProviders.includes(providerId);
  const isDefault = access.defaultProvider === providerId;
  return (
    <label className="text-muted-foreground flex shrink-0 items-center gap-2 text-xs">
      <span>{enabled ? 'Enabled' : 'Disabled'}</span>
      <Switch
        checked={enabled}
        disabled={!canWrite || access.isUpdating || (isDefault && enabled)}
        aria-label={`Enable ${name}`}
        title={
          isDefault
            ? 'Choose a project default from another provider before disabling this provider.'
            : 'Disable inference without removing credentials.'
        }
        onCheckedChange={(next) => {
          void access
            .setEnabled({ target: 'provider', id: providerId, enabled: next })
            .catch((error: unknown) => {
              errorToast(
                error instanceof Error ? error.message : 'Could not update provider access.',
              );
            });
        }}
      />
    </label>
  );
}

export function ManagedProviderAccess({ access, canWrite }: { access: Access; canWrite: boolean }) {
  if (!access.data?.enforced) return null;
  return (
    <div className="bg-popover flex items-center gap-4 rounded-md border px-4 py-3">
      <div className="min-w-0 flex-1 space-y-1">
        <p className="text-sm font-medium">Kortix Managed Models</p>
        <p className="text-muted-foreground text-xs">
          Use Kortix credits for inference. Turn off to use only your own providers.
        </p>
      </div>
      <ProviderAccessSwitch
        access={access}
        providerId="kortix"
        name="Kortix Managed Models"
        canWrite={canWrite}
      />
    </div>
  );
}
