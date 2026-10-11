'use client';

import { useCaptureWorkspace, useSetCaptureEnabled } from '@kortix/sdk/react';
import Link from 'next/link';

import { Button } from '@/components/ui/button';
import Loading from '@/components/ui/loading';
import { SettingsRow } from '@/components/ui/settings-row';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { errorToast } from '@/components/ui/toast';
import { useTranslations } from '@/i18n/use-translations';

import { captureHref } from './use-capture-area';

/**
 * Kortix Capture on the organization's Settings: the account switch
 * (`capture.manage`) and the way into the Capture area. Capture is off until
 * an admin turns it on here.
 */
export function CaptureAccountCard({
  accountId,
  showOpen = true,
}: {
  accountId: string;
  /** Off inside Capture itself, where the link would point at the page you are on. */
  showOpen?: boolean;
}) {
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
          {enabled && showOpen ? (
            <Button asChild variant="outline" size="sm">
              <Link href={captureHref(accountId, 'devices')}>{t('open')}</Link>
            </Button>
          ) : null}
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
