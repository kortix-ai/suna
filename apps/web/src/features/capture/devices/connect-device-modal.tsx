'use client';

import { ArrowUpRightIcon, DownloadSimpleIcon } from '@phosphor-icons/react';
import Link from 'next/link';

import { Button } from '@/components/ui/button';
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalDescription,
  ModalFooter,
  ModalHeader,
  ModalTitle,
} from '@/components/ui/modal';
import { useTranslations } from '@/i18n/use-translations';
import { desktopDownloadUrl } from '@/lib/desktop';

/** The Kortix desktop app, per OS (`desktopDownloadUrl`: `/download/<os>` redirects to the latest installer). */
const DESKTOP_OS = ['macos', 'windows', 'linux'] as const;

/** The standalone capture engine's releases. */
const ENGINE_RELEASES_URL = 'https://github.com/kortix-ai/capture/releases/latest';

/**
 * How a computer joins: install an app, sign in with Kortix (the device
 * sign-in, RFC 8628: the browser opens `/capture/authorize` with a code), pick
 * this project. The device then appears on this page under the person.
 */
export function ConnectDeviceModal({
  open,
  onOpenChange,
  projectName,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectName: string;
}) {
  const t = useTranslations('capture.connect');
  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <ModalContent className="lg:max-w-lg">
        <ModalHeader>
          <ModalTitle>{t('title')}</ModalTitle>
          <ModalDescription>{t('description')}</ModalDescription>
        </ModalHeader>
        <ModalBody className="space-y-5">
          <section className="space-y-2">
            <p className="text-foreground text-sm font-medium">{t('desktopTitle')}</p>
            <p className="text-muted-foreground text-xs text-pretty">{t('desktopHint')}</p>
            <div className="flex flex-wrap gap-2">
              {DESKTOP_OS.map((os) => (
                <Button key={os} asChild variant="outline" size="sm" className="gap-1.5">
                  <Link
                    href={desktopDownloadUrl(os)}
                    target="_blank"
                    rel="noopener noreferrer"
                    prefetch={false}
                  >
                    <DownloadSimpleIcon className="size-3.5 shrink-0" />
                    {t(`os.${os}`)}
                  </Link>
                </Button>
              ))}
            </div>
          </section>
          <section className="flex flex-col items-start gap-2">
            <p className="text-foreground text-sm font-medium">{t('engineTitle')}</p>
            <p className="text-muted-foreground text-xs text-pretty">{t('engineHint')}</p>
            <Button asChild variant="outline" size="sm" className="gap-1.5">
              <a href={ENGINE_RELEASES_URL} target="_blank" rel="noopener noreferrer">
                {t('engineLink')}
                <ArrowUpRightIcon className="size-3 shrink-0" aria-hidden />
              </a>
            </Button>
          </section>
          <section className="space-y-2">
            <p className="text-foreground text-sm font-medium">{t('stepsTitle')}</p>
            <ol className="text-muted-foreground list-decimal space-y-1 pl-5 text-xs">
              <li>{t('step1')}</li>
              <li>{t('step2')}</li>
              <li>{t('step3', { project: projectName })}</li>
            </ol>
          </section>
        </ModalBody>
        <ModalFooter>
          <Button type="button" variant="outline-ghost" onClick={() => onOpenChange(false)}>
            {t('close')}
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
