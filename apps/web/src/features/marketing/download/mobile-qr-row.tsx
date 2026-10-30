'use client';

import { useTranslations } from '@/i18n/use-translations';
import { MobileStoreQr } from '@kortix/ui/internal/components/mobile-store-qr';

/**
 * The desktop visitor's way onto a phone, as a row of the Mobile card: the
 * shared store QR code and the line that says what it does. Same code and
 * copy as the project page's mobile-app introduction.
 */
export function MobileQrRow() {
  const t = useTranslations('mobileAppPromo');
  return (
    <div className="flex items-center gap-4 border-t px-6 py-4">
      <MobileStoreQr />
      <div className="min-w-0">
        <p className="text-foreground text-sm font-medium">{t('scanTitle')}</p>
        <p className="text-muted-foreground mt-1 text-xs text-balance">{t('scanDescription')}</p>
      </div>
    </div>
  );
}
