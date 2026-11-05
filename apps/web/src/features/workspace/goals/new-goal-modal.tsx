'use client';

import { useTranslations } from '@/i18n/use-translations';
import { FadedScrollArea } from '@kortix/ui/faded-scroll-area';
import { Modal, ModalContent, ModalDescription, ModalHeader, ModalTitle } from '@kortix/ui/modal';
import { useState } from 'react';
import { GoalStarter } from './goal-starter';

/**
 * "New goal": the project home's composer and the role templates, the same
 * as the empty Goals page. A start in flight holds the modal open; the
 * started goal closes it and opens its page.
 */
export function NewGoalModal({
  projectId,
  open,
  onOpenChange,
}: {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations('goals');
  const [pending, setPending] = useState(false);
  // Each open starts unlocked, whatever the last one left.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setPending(false);
  }

  return (
    <Modal open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
      <ModalContent
        variant="base"
        // A start in flight holds the modal open: no close control that does nothing.
        showCloseButton={!pending}
        className="flex max-h-[min(88svh,56rem)] flex-col lg:max-w-4xl"
      >
        <ModalHeader className="pr-14">
          <ModalTitle>{t('galleryTitle')}</ModalTitle>
          <ModalDescription className="text-pretty">{t('galleryDescription')}</ModalDescription>
        </ModalHeader>
        {/* The cards go on below the fold: the bottom edge fades while more is left to scroll. */}
        <FadedScrollArea
          fadeColor="from-background"
          fadeSize="8"
          rootClassName="flex-1"
          className="px-5 pt-5 pb-5"
        >
          <GoalStarter
            projectId={projectId}
            autoFocus
            onPendingChange={setPending}
            onStarted={() => {
              setPending(false);
              onOpenChange(false);
            }}
          />
        </FadedScrollArea>
      </ModalContent>
    </Modal>
  );
}
