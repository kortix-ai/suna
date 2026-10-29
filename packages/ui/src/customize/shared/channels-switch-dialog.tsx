'use client';

import { useId, useState } from 'react';

import { useTranslations } from '../../i18n';
import { Button } from '../../primitives/button';
import { Checkbox } from '../../primitives/checkbox';
import Loading from '../../primitives/loading';
import { Modal, ModalBody, ModalContent, ModalDescription, ModalFooter, ModalHeader, ModalTitle } from '../../primitives/modal';

/**
 * The confirm step of the project's Channels switch (`project_channels`):
 * what turning it on or off changes for everyone in the project. Turning it
 * on while Drive is off offers to turn Drive on too (channels get Files).
 * Every surface that flips the flag asks through this dialog.
 */
export function ChannelsSwitchDialog({
  open,
  onOpenChange,
  turningOn,
  projectName,
  driveOff,
  pending = false,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The switch's target: on, or off. */
  turningOn: boolean;
  projectName: string;
  /** Drive is off and the viewer could turn it on: offer it beside Channels. */
  driveOff: boolean;
  pending?: boolean;
  /** `alsoDrive`: turn Drive on too. */
  onConfirm: (alsoDrive: boolean) => void;
}) {
  const t = useTranslations('settings.featureFlags.channelsSwitch');
  const id = useId();
  const [alsoDrive, setAlsoDrive] = useState(false);
  const offerDrive = turningOn && driveOff;
  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        if (pending) return;
        if (!next) setAlsoDrive(false);
        onOpenChange(next);
      }}
    >
      <ModalContent className="lg:max-w-md">
        <ModalHeader>
          <ModalTitle>{turningOn ? t('onTitle', { project: projectName }) : t('offTitle')}</ModalTitle>
          <ModalDescription>{turningOn ? t('onBody') : t('offBody')}</ModalDescription>
        </ModalHeader>
        {offerDrive ? (
          <ModalBody>
            <div className="flex items-center gap-2.5">
              <Checkbox id={`${id}-drive`} checked={alsoDrive} onCheckedChange={(value) => setAlsoDrive(value === true)} />
              <label htmlFor={`${id}-drive`} className="text-sm">
                {t('drive')}
              </label>
            </div>
          </ModalBody>
        ) : null}
        <ModalFooter className="sm:justify-between">
          <Button type="button" variant="outline-ghost" disabled={pending} onClick={() => onOpenChange(false)}>
            {t('cancel')}
          </Button>
          <Button
            type="button"
            disabled={pending}
            aria-busy={pending || undefined}
            onClick={() => {
              onConfirm(offerDrive && alsoDrive);
              setAlsoDrive(false);
            }}
          >
            {pending ? <Loading className="size-4 shrink-0" /> : null}
            {turningOn ? t('turnOn') : t('turnOff')}
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
