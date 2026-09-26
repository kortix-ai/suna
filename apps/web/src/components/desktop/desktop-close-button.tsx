'use client';

import { XIcon } from '@phosphor-icons/react';

import { Button } from '@/components/ui/button';
import Hint from '@/components/ui/hint';
import { useTranslations } from '@/i18n/use-translations';

/**
 * Close, for a full-screen frame that the desktop shell cannot otherwise leave.
 *
 * The shell has no browser toolbar. On `/new` the only exit was Log out, and
 * the onboarding wizard had no exit before its last step. This is the missing
 * way out, drawn at the frame's top-right corner.
 *
 * Icon-only, unlike `DesktopBackControl`: it sits beside a labelled control
 * (Log out, Skip for now), and a second word there competes with it. `Hint`
 * and `aria-label` carry the name.
 *
 * Desktop only. `.kx-desktop-back` in globals.css shows it under
 * `html[data-desktop='true']`, so the web keeps the browser's own Back. The
 * host passes `onClose`, because only the host knows what closing means: `/new`
 * returns to the landing door, the wizard stamps onboarding first.
 */
export function DesktopCloseButton({ onClose }: { onClose: () => void }) {
  const t = useTranslations('common');
  return (
    <Hint label={t('close')} side="bottom" align="end">
      <Button
        type="button"
        variant="ghost"
        size="icon-base"
        aria-label={t('close')}
        onClick={onClose}
        className="kx-desktop-back text-muted-foreground hover:text-foreground shrink-0 active:scale-[0.96] motion-reduce:active:scale-100 [-webkit-app-region:no-drag] [app-region:no-drag]"
      >
        <XIcon className="size-4" />
      </Button>
    </Hint>
  );
}
