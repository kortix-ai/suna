'use client';

import { useTranslations } from '@/i18n/use-translations';
import { Modal, ModalContent, ModalDescription, ModalTitle } from '@kortix/ui/modal';

import { localizedDownloadContent } from './content';
import { detectPlatform } from './detect-os';
import { DownloadOptions } from './download-options';

/**
 * The /download page as a full-screen overlay, opened from the workspace menu.
 * Same header, cards, QR code and Terminal block as the page: `DownloadOptions`
 * is shared, so the two surfaces stay one design. Full screen, not a dialog
 * box: the cards need the page's width, and a centred box squeezed them.
 *
 * Fades only. A 95% zoom on a surface the size of the viewport reads as the
 * whole app lurching.
 *
 * The options render only while open, so reading `navigator` during render
 * never runs on the server.
 */
export function DownloadModal({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const { hero } = localizedDownloadContent(tI18nComplete);

  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <ModalContent
        side="fullscreen"
        variant="base"
        animation="none"
        overlayClassName="data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 duration-(--duration-moderate)"
        className="bg-background data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 inset-0 h-dvh max-h-none w-screen max-w-none space-y-0 rounded-none! border-0 duration-(--duration-moderate) lg:top-0 lg:left-0 lg:block lg:h-dvh lg:max-w-none lg:translate-x-0 lg:translate-y-0"
        closeClassName="size-10 rounded-full"
      >
        <div className="mx-auto flex min-h-full w-full max-w-5xl flex-col justify-center px-6 py-16">
          <header className="mb-10 text-center">
            <ModalTitle className="text-foreground text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
              {hero.title}
            </ModalTitle>
            <ModalDescription className="text-muted-foreground mx-auto mt-3 max-w-md text-base text-balance">
              {hero.sub}
            </ModalDescription>
          </header>
          {open ? <DownloadOptions detected={detectPlatform(navigator.userAgent)} /> : null}
        </div>
      </ModalContent>
    </Modal>
  );
}
