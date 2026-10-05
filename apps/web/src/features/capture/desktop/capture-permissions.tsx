'use client';

import { CursorClickIcon, KeyboardIcon, MicrophoneIcon, MonitorIcon, type Icon } from '@phosphor-icons/react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import Loading from '@/components/ui/loading';
import { SolidCheckIcon } from '@/features/icon/icons/solid-check-icon';
import { useTranslations } from '@/i18n/use-translations';
import type { DesktopCaptureStatus } from '@/lib/desktop';
import { cn } from '@/lib/utils';

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
 * while Audio is on. One "Allow access"
 * path; each row turns to "Allowed" as macOS answers (the status polls), and a
 * row that was missing while the dialog was open stays in view.
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
  // Adjusted during render, like the computer setup step: a granted row stays.
  const [shown, setShown] = useState<CaptureGrant[]>([]);
  const added = missing.filter((grant) => !shown.includes(grant));
  if (added.length > 0) setShown([...shown, ...added]);
  if (shown.length === 0) return null;

  return (
    <section className="space-y-3 rounded-md border p-4">
      <div className="space-y-1">
        <p className="text-sm font-medium">{t('title')}</p>
        <p className="text-muted-foreground text-xs text-pretty">{t('hint')}</p>
      </div>
      <ul className="divide-border divide-y">
        {shown.map((grant) => {
          const GrantIcon = ICONS[grant];
          const allowed = !missing.includes(grant);
          return (
            <li key={grant} className="flex items-center gap-3 py-2.5">
              <span className="bg-muted text-muted-foreground flex size-8 shrink-0 items-center justify-center rounded-sm">
                <GrantIcon className="size-4" />
              </span>
              <div className="min-w-0 flex-1 space-y-0.5">
                <p className="text-sm">{t(grant)}</p>
                <p className="text-muted-foreground truncate text-xs">{t(`${grant}Description`)}</p>
              </div>
              <span className={cn('flex shrink-0 items-center gap-1 text-xs', allowed ? 'text-foreground' : 'text-muted-foreground')}>
                {allowed ? <SolidCheckIcon className="text-kortix-green size-3.5" /> : null}
                {allowed ? t('allowed') : asked ? t('waiting') : t('needed')}
              </span>
            </li>
          );
        })}
      </ul>
      {missing.length > 0 ? (
        <div className="space-y-2">
          <Button
            className="w-full"
            disabled={requesting}
            onClick={() => {
              setAsked(true);
              onAllow();
            }}
          >
            {requesting ? <Loading className="size-4 shrink-0" /> : null}
            {t('allow')}
          </Button>
          {asked ? <p className="text-muted-foreground text-xs text-pretty">{t('settingsHint')}</p> : null}
        </div>
      ) : null}
    </section>
  );
}
