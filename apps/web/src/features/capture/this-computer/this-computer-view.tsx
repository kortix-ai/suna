'use client';

import * as DialogPrimitive from '@radix-ui/react-dialog';
import { DownloadSimpleIcon } from '@phosphor-icons/react';
import Link from 'next/link';
import { useEffect } from 'react';

import { Button } from '@/components/ui/button';
import { EmptyState } from '@/features/layout/section/empty-state';
import { useTranslations } from '@/i18n/use-translations';
import { desktopDownloadUrl, isDesktop } from '@/lib/desktop';
import { useCurrentAccountStore } from '@/stores/current-account-store';

import { CapturePage } from '../area/capture-area-shell';
import { captureHref } from '../area/use-capture-area';
import { CaptureThisComputer } from '../desktop/capture-section';
import { useDesktopCaptureStatus } from '../desktop/use-desktop-capture';

/**
 * This computer (`/capture/[accountId]/this-computer`): the desktop app's
 * "Record this computer" as a page. It records for the organization in the
 * route, so the page makes that account the selected one first. In a browser
 * there is no engine; the page says where to get the desktop app.
 */
export function ThisComputerView({ accountId }: { accountId: string }) {
  const t = useTranslations('capture.thisComputer');
  const tDevices = useTranslations('capture.devices');
  const selected = useCurrentAccountStore((state) => state.selectedAccountId);
  const select = useCurrentAccountStore((state) => state.setSelectedAccountId);
  const desktop = useDesktopCaptureStatus({ poll: true });
  const onDesktop = isDesktop();
  useEffect(() => {
    if (onDesktop && selected !== accountId) select(accountId);
  }, [onDesktop, selected, accountId, select]);
  const deviceId = desktop.data?.accountId === accountId ? desktop.data?.deviceId : null;

  return (
    <CapturePage
      title={t('title')}
      description={onDesktop ? t('description') : t('browserDescription')}
      breadcrumb={
        <nav aria-label={t('breadcrumb')} className="flex items-center gap-2 text-xs">
          <Link
            href={captureHref(accountId, 'devices')}
            className="text-muted-foreground hover:text-foreground"
          >
            {tDevices('title')}
          </Link>
          <span aria-hidden className="text-muted-foreground">
            /
          </span>
          <span className="text-foreground">{t('title')}</span>
        </nav>
      }
      actions={
        deviceId ? (
          <Button asChild variant="outline" size="sm">
            <Link href={captureHref(accountId, 'devices', `/${deviceId}`)}>{t('openTimeline')}</Link>
          </Button>
        ) : null
      }
    >
      {onDesktop ? (
        selected === accountId ? (
          // The desktop lane's content renders the slots of a Modal; a Dialog root gives its title and description their ids.
          <DialogPrimitive.Root open modal={false}>
            <div className="bg-background flex w-full max-w-xl flex-col rounded-md border pb-5">
              <CaptureThisComputer />
            </div>
          </DialogPrimitive.Root>
        ) : null
      ) : (
        <div className="bg-background rounded-md border px-4 py-12">
          <EmptyState
            size="sm"
            title={t('browserTitle')}
            description={t('browserBody')}
            action={
              <Button asChild variant="outline" size="sm" className="gap-1.5">
                <a href={desktopDownloadUrl()} target="_blank" rel="noreferrer">
                  <DownloadSimpleIcon className="size-3.5 shrink-0" />
                  {t('getDesktop')}
                </a>
              </Button>
            }
          />
        </div>
      )}
    </CapturePage>
  );
}
