'use client';

import { useChannelsOnboarding, useMarkChannelsOnboarding, useProjectSpaceGeneralNotice } from '@kortix/sdk/react';
import { ChatCircleIcon, HashIcon, SunDimIcon } from '@phosphor-icons/react';
import { useState } from 'react';

import { useTranslations } from '../../i18n';
import { Button } from '../../primitives/button';
import { Modal, ModalBody, ModalContent, ModalDescription, ModalFooter, ModalHeader, ModalTitle } from '../../primitives/modal';

/**
 * The member intro, once per member and project: the first channel or DM page
 * after Channels was turned on. Any close ("Got it", Escape, outside) records
 * `channels_intro`, so it never comes back. Turning Channels on again records
 * it for every member, so a second switch shows nothing.
 */
export function ChannelsIntro({ projectId }: { projectId: string }) {
  const t = useTranslations('spaces.onboarding.intro');
  const onboarding = useChannelsOnboarding(projectId);
  const mark = useMarkChannelsOnboarding(projectId);
  const [closed, setClosed] = useState(false);
  const open = !closed && onboarding.data?.intro_seen === false;
  const close = () => {
    setClosed(true);
    mark.mutate('channels_intro');
  };
  const lines: { icon: typeof HashIcon; text: string }[] = [
    { icon: HashIcon, text: t('channels') },
    { icon: ChatCircleIcon, text: t('threads') },
    { icon: SunDimIcon, text: t('memory') },
  ];
  return (
    <Modal open={open} onOpenChange={(next) => !next && close()}>
      <ModalContent className="lg:max-w-md">
        <ModalHeader>
          <ModalTitle>{t('title')}</ModalTitle>
          <ModalDescription className="sr-only">{t('title')}</ModalDescription>
        </ModalHeader>
        <ModalBody>
          <ul className="flex flex-col gap-3">
            {lines.map(({ icon: Glyph, text }) => (
              <li key={text} className="flex items-start gap-3 text-sm">
                <Glyph aria-hidden className="text-muted-foreground mt-0.5 size-4 shrink-0" />
                <span>{text}</span>
              </li>
            ))}
          </ul>
        </ModalBody>
        <ModalFooter>
          <Button autoFocus onClick={close}>
            {t('gotIt')}
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}

/** The top of `#general`'s Chat: the "turned on again" line while the server reports one. */
export function GeneralChatHead({ projectId }: { projectId: string }) {
  const t = useTranslations('spaces.onboarding');
  const notice = useProjectSpaceGeneralNotice(projectId);
  return notice.data ? <p className="text-muted-foreground shrink-0 px-5 pt-3 text-xs">{t('reenabled')}</p> : null;
}
