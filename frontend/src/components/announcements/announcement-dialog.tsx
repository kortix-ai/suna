'use client';

import * as React from 'react';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { VisuallyHidden } from '@radix-ui/react-visually-hidden';
import { useAnnouncementStore } from '@/stores/announcement-store';
import { announcementRegistry } from './registry';

export function AnnouncementDialog() {
  const { isOpen, currentAnnouncement, closeAnnouncement, showPendingAnnouncement } = useAnnouncementStore();

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
        className="sm:max-w-lg p-0 gap-0 overflow-hidden border-border/50"
        hideCloseButton
        aria-describedby={undefined}
      >
        <VisuallyHidden>
          <DialogTitle>Announcement</DialogTitle>
        </VisuallyHidden>
        <Component 
          onClose={closeAnnouncement} 
          {...(currentAnnouncement.props || {})} 
        />
      </DialogContent>
    </Dialog>
  );
}
