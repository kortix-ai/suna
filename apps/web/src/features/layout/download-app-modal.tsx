'use client';

import { Button } from '@/components/ui/button';
import { Modal, ModalBody, ModalContent, ModalDescription, ModalHeader, ModalTitle } from '@/components/ui/modal';
import { localizedDownloadContent } from '@/features/marketing/download/content';
import { DESKTOP_ORDER, MOBILE_ORDER } from '@/features/marketing/download/detect-os';
import Image from 'next/image';
import { TerminalBlock } from '@/features/marketing/download/terminal-block';
import { useTranslations } from '@/i18n/use-translations';

/** Explicitly opened from the workspace menu; never tied to promo dismissal. */
export function DownloadAppModal({ open, onOpenChange }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations('hardcodedUi.i18nComplete');
  const copy = useTranslations('downloadAppModal');
  const stores = useTranslations('mobileAppPromo');
  const { hero, desktopCard, mobileCard, desktopRows: DESKTOP_ROWS, mobileRows: MOBILE_ROWS } = localizedDownloadContent(t);
  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <ModalContent className="lg:max-w-3xl">
        <ModalHeader>
          <ModalTitle>{hero.title}</ModalTitle>
          <ModalDescription>{hero.sub}</ModalDescription>
        </ModalHeader>
        <ModalBody>
          <div className="space-y-6">
            <section className="space-y-3">
              <h3 className="text-sm font-medium">{desktopCard.title}</h3>
              <div className="flex flex-wrap gap-2">
                {DESKTOP_ORDER.map((os) => (
                  <Button key={os} asChild variant="outline">
                    <a href={DESKTOP_ROWS[os].href}>{t('text8d602d64e902', { value0: DESKTOP_ROWS[os].label })}</a>
                  </Button>
                ))}
              </div>
            </section>
            <section className="space-y-3">
              <h3 className="text-sm font-medium">{mobileCard.title}</h3>
              <p className="text-muted-foreground hidden text-xs sm:block">{copy('scan')}</p>
              <div className="grid gap-5 sm:grid-cols-2">
                {MOBILE_ORDER.map((os) => (
                  <div key={os} className="flex flex-col items-start gap-3 lg:flex-row lg:items-center">
                    <Image src={`/images/mobile-app/${os}-qr.svg`} alt={copy('qr', { store: MOBILE_ROWS[os].hint })} width={128} height={128} className="hidden shrink-0 sm:block" unoptimized />
                    <Button asChild variant="outline">
                      <a href={MOBILE_ROWS[os].href} target="_blank" rel="noopener noreferrer">{t.raw('texted077f3d8125')} {stores(os === 'ios' ? 'appStore' : 'googlePlay')}</a>
                    </Button>
                  </div>
                ))}
              </div>
              <div className="flex justify-center gap-3 overflow-hidden">
                {[1, 2, 3].map((shot) => (
                  <Image key={shot} src={`/images/mobile-app/store-0${shot}.webp`} alt={copy('preview', { number: shot })} width={640} height={1385} className="h-48 w-auto rounded-md" />
                ))}
              </div>
            </section>
            <TerminalBlock />
          </div>
        </ModalBody>
      </ModalContent>
    </Modal>
  );
}
