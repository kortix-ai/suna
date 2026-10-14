'use client';

import { notFound } from 'next/navigation';

import { SettingsRowGroup } from '@/components/ui/settings-row';
import { useTranslations } from '@/i18n/use-translations';

import { CaptureAccountCard } from '../area/capture-account-card';
import { CapturePage } from '../area/capture-area-shell';
import { useCaptureArea } from '../area/use-capture-area';
import { CaptureSettingsPane } from './settings-view';

/**
 * /capture/[accountId]/settings: everything an organization decides about
 * Kortix Capture, in one place inside the Capture area (`capture.manage`).
 * The switch that turns Capture on or off for the organization, then the
 * policy every computer follows. The account settings carry nothing of Capture.
 */
export function CaptureSettingsPage({ accountId }: { accountId: string }) {
  const tNav = useTranslations('capture.area.nav');
  const t = useTranslations('capture.settings');
  const area = useCaptureArea(accountId);
  if (!area.canManage) notFound();
  return (
    <CapturePage title={tNav('settings')} description={t('description', { name: area.accountName })}>
      <div className="max-w-3xl space-y-10">
        <SettingsRowGroup>
          <CaptureAccountCard accountId={accountId} />
        </SettingsRowGroup>
        <CaptureSettingsPane accountId={accountId} />
      </div>
    </CapturePage>
  );
}
