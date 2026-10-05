'use client';

import { CursorClickIcon, KeyboardIcon, MicrophoneIcon, MonitorIcon, type Icon } from '@phosphor-icons/react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import Loading from '@/components/ui/loading';
import { useTranslations } from '@/i18n/use-translations';
import type { DesktopCaptureStatus } from '@/lib/desktop';

import { CaptureRow, CaptureRowSection, GrantState } from './capture-rows';
import { missingGrants, type CaptureGrant } from './capture-state';

const ICONS: Record<CaptureGrant, Icon> = {
  screen: MonitorIcon,
  accessibility: CursorClickIcon,
  inputMonitoring: KeyboardIcon,
  microphone: MicrophoneIcon,
};

/**
 * Capture's macOS permissions, granted to Kortix: Screen Recording,
 * Accessibility, Input Monitoring while Actions is on, and the Microphone
 * while Audio is on. Quiet when all are granted. One "Allow access" (the only
 * path that asks macOS); each row turns "Allowed" as macOS answers, and a row
 * that was missing while the dialog was open stays in view.
 */
export function CapturePermissions({
  view,
  requesting,
  onAllow,
}: {
  view: DesktopCaptureStatus;
  requesting: boolean;
  onAllow: () => void;
}) {
  const t = useTranslations('capture.dialog.permissions');
  const [asked, setAsked] = useState(false);
  const missing = missingGrants(view);
  // Adjusted during render: a granted row stays.
  const [shown, setShown] = useState<CaptureGrant[]>([]);
  const added = missing.filter((grant) => !shown.includes(grant));
  if (added.length > 0) setShown([...shown, ...added]);
  if (shown.length === 0) return null;

  return (
    <CaptureRowSection
      title={t('title')}
      action={
        missing.length > 0 ? (
          <Button
            size="sm"
            disabled={requesting}
            onClick={() => {
              setAsked(true);
              onAllow();
            }}
          >
            {requesting ? <Loading className="size-4 shrink-0" /> : null}
            {t('allow')}
          </Button>
        ) : null
      }
      hint={missing.length === 0 ? null : asked ? t('settingsHint') : t('hint')}
    >
      {shown.map((grant) => {
        const allowed = !missing.includes(grant);
        return (
          <CaptureRow
            key={grant}
            icon={ICONS[grant]}
            title={t(grant)}
            description={t(`${grant}Description`)}
            trailing={<GrantState allowed={allowed} label={allowed ? t('allowed') : asked ? t('waiting') : t('needed')} />}
          />
        );
      })}
    </CaptureRowSection>
  );
}
