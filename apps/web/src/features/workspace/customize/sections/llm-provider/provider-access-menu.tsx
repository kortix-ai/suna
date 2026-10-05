'use client';

import { useTranslations } from '@/i18n/use-translations';
import { DotsThreeIcon } from '@phosphor-icons/react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { errorToast } from '@/components/ui/toast';
import type { useModelAccess } from '@kortix/sdk/react';

type Access = ReturnType<typeof useModelAccess>;

/** Credential configuration stays available while inference is disabled. */
export function ProviderAccessMenu({
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
    <div data-provider-access={providerId} className="flex shrink-0 items-center gap-1.5">
      {!enabled && <Badge variant="secondary" size="sm">{t('disabled')}</Badge>}
      {canWrite && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="text-muted-foreground size-6" aria-label={t('manageProvider', { name })}>
              <DotsThreeIcon className="size-4 shrink-0" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="max-w-xs">
            <DropdownMenuItem
              disabled={access.isUpdating || (isDefault && enabled)}
              onSelect={() => {
                void access
                  .setEnabled({ target: 'provider', id: providerId, enabled: !enabled })
                  .catch((error: unknown) => {
                    errorToast(error instanceof Error ? error.message : t('providerError'));
                  });
              }}
            >
              {enabled ? t('disableProviderAction') : t('enableProviderAction')}
            </DropdownMenuItem>
            <p className="text-muted-foreground px-2 py-1.5 text-xs text-pretty">
              {isDefault && enabled ? t('defaultProviderHint') : t('credentialsHint')}
            </p>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}
