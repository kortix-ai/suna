'use client';

import { useCaptureWorkspace, useSetCaptureEnabled } from '@kortix/sdk/react';

import Loading from '@kortix/ui/loading';
import { SettingsRow } from '@kortix/ui/settings-row';
import { Skeleton } from '@kortix/ui/skeleton';
import { Switch } from '@kortix/ui/switch';
import { errorToast } from '@kortix/ui/toast';
import { useTranslations } from '@/i18n/use-translations';

/**
 * The switch that turns Kortix Capture on or off for the organization
 * (`capture.manage`), at the top of the Capture area's Settings. Off, the whole
 * area shows the off state and computers stop recording into the organization.
 */
export function CaptureAccountCard({ accountId }: { accountId: string }) {
  const t = useTranslations('capture.account');
  const workspace = useCaptureWorkspace(accountId);
  const setEnabled = useSetCaptureEnabled(accountId);
  const enabled = workspace.data?.enabled ?? false;
  const canManage = workspace.data?.can_manage ?? false;
  return (
    <SettingsRow
      label={t('label')}
      description={canManage ? t('description') : t('descriptionReadOnly')}
    >
      {workspace.isLoading ? (
        <Skeleton className="h-5 w-9 shrink-0 rounded-full" />
      ) : (
        <span className="flex shrink-0 items-center gap-3">
          {setEnabled.isPending ? <Loading className="size-3.5 shrink-0" /> : null}
          <Switch
            checked={enabled}
            onCheckedChange={(on) =>
              setEnabled.mutate(on, { onError: () => errorToast(t('failed')) })
            }
            disabled={!canManage || setEnabled.isPending}
            aria-label={t('label')}
          />
        </span>
      )}
    </SettingsRow>
  );
}
