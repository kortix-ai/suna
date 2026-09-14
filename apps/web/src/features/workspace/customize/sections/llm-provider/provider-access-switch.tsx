'use client';

import { useTranslations } from '@/i18n/use-translations';
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
  const t = useTranslations('modelAccess');
  if (!access.data?.enforced) return null;
  const enabled = !access.data.disabledProviders.includes(providerId);
  const isDefault = access.defaultProvider === providerId;
  return (
    <label className="text-muted-foreground flex shrink-0 items-center gap-2 text-xs">
      <span>{enabled ? t('enabled') : t('disabled')}</span>
      <Switch
        checked={enabled}
        disabled={!canWrite || access.isUpdating || (isDefault && enabled)}
        aria-label={t('enableProvider', { name })}
        title={
          isDefault
            ? t('defaultProviderHint')
            : t('credentialsHint')
        }
        onCheckedChange={(next) => {
          void access
            .setEnabled({ target: 'provider', id: providerId, enabled: next })
            .catch((error: unknown) => {
              errorToast(
                error instanceof Error ? error.message : t('providerError'),
              );
            });
        }}
      />
    </label>
  );
}
