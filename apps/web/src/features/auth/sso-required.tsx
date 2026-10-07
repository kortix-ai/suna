'use client';

/**
 * The account requires single sign-on and this session is a password (or
 * other non-IdP) sign-in: the API answers every request for that account with
 * the coded 403 `sso_required`, and the SDK dispatches `kortix:sso-required`.
 * The remedy is a new sign-in through the company's IdP, so this offers to
 * sign out. `/auth` routes a work email to its IdP.
 */
import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import Loading from '@/components/ui/loading';
import { useTranslations } from '@/i18n/use-translations';
import { performSignOut } from '@/lib/auth/perform-sign-out';

export const SSO_REQUIRED_EVENT = 'kortix:sso-required';

export function SsoRequiredProvider({ children }: { children?: React.ReactNode }) {
  const t = useTranslations('ssoRequired');
  const [open, setOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  useEffect(() => {
    const onRequired = () => setOpen(true);
    window.addEventListener(SSO_REQUIRED_EVENT, onRequired);
    return () => window.removeEventListener(SSO_REQUIRED_EVENT, onRequired);
  }, []);

  return (
    <>
      {children}
      <Dialog open={open} onOpenChange={(next) => !signingOut && setOpen(next)}>
        <DialogContent className="sm:max-w-md" data-sso-required>
          <DialogHeader>
            <DialogTitle>{t('title')}</DialogTitle>
            <DialogDescription>{t('description')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" disabled={signingOut} onClick={() => setOpen(false)}>
              {t('notNow')}
            </Button>
            <Button
              disabled={signingOut}
              onClick={() => {
                setSigningOut(true);
                void performSignOut();
              }}
            >
              {signingOut ? <Loading /> : null}
              {t('signOut')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
