'use client';

import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { useAnnouncementStore } from '@/stores/announcement-store';
import { VisuallyHidden } from '@radix-ui/react-visually-hidden';
import { useTranslations } from '@/i18n/use-translations';
import * as React from 'react';
import { announcementRegistry } from './registry';

export function AnnouncementDialog() {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const { isOpen, currentAnnouncement, closeAnnouncement, showPendingAnnouncement } =
    useAnnouncementStore();

  React.useEffect(() => {
    const timer = setTimeout(() => {
      showPendingAnnouncement();
    }, 1000);
    return () => clearTimeout(timer);
  }, [showPendingAnnouncement]);

  if (!currentAnnouncement) return null;

  const Component = announcementRegistry[currentAnnouncement.component];

  if (!Component) {
    console.warn(`Unknown announcement component: ${currentAnnouncement.component}`);
    return null;
  }

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && closeAnnouncement()}>
      <DialogContent
        className="border-border/50 gap-0 overflow-hidden p-0 sm:max-w-lg"
        hideCloseButton
        aria-describedby={undefined}
      >
        <VisuallyHidden>
          <DialogTitle>{tI18nComplete.raw('text028cd1c88345')}</DialogTitle>
        </VisuallyHidden>
        <Component onClose={closeAnnouncement} {...(currentAnnouncement.props || {})} />
      </DialogContent>
    </Dialog>
  );
}
