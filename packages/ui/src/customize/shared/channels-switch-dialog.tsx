'use client';

import { useTranslations } from '../../i18n';
import { Button } from '../../primitives/button';
import Loading from '../../primitives/loading';
import { Modal, ModalContent, ModalDescription, ModalFooter, ModalHeader, ModalTitle } from '../../primitives/modal';

/**
 * The confirm step of the project's Channels switch (`chat`):
 * what turning it on or off changes for everyone in the project. Every
 * project has a Drive, so channels always get their folders. Every surface that flips the flag asks through this dialog.
 */
export function ChannelsSwitchDialog({
  open,
  onOpenChange,
  turningOn,
  projectName,
  pending = false,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The switch's target: on, or off. */
  turningOn: boolean;
  projectName: string;
  pending?: boolean;
  onConfirm: () => void;
}) {
  const t = useTranslations('settings.featureFlags.channelsSwitch');
  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        if (pending) return;
        onOpenChange(next);
      }}
    >
      <ModalContent className="lg:max-w-md">
        <ModalHeader>
          <ModalTitle>{turningOn ? t('onTitle', { project: projectName }) : t('offTitle')}</ModalTitle>
          <ModalDescription>{turningOn ? t('onBody') : t('offBody')}</ModalDescription>
        </ModalHeader>
        <ModalFooter className="sm:justify-between">
          <Button type="button" variant="outline-ghost" disabled={pending} onClick={() => onOpenChange(false)}>
            {t('cancel')}
          </Button>
          <Button
            type="button"
            disabled={pending}
            aria-busy={pending || undefined}
            onClick={onConfirm}
          >
            {pending ? <Loading className="size-4 shrink-0" /> : null}
            {turningOn ? t('turnOn') : t('turnOff')}
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
