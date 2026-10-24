'use client';

import {
  useChannelsOnboarding,
  useMarkChannelsOnboarding,
  useProjectSpaceGeneralNotice,
  useVisibleAgents,
} from '@kortix/sdk/react';
import { ChatCircleIcon, CircleIcon, HashIcon, SunDimIcon } from '@phosphor-icons/react';
import { useState } from 'react';

import { useTranslations } from '../../i18n';
import { Close } from '../../icons/close';
import { AgentMark } from '../../internal/components/agent-mark';
import { SolidCheckIcon } from '../../internal/icons/solid-check-icon';
import { cn } from '../../lib/utils';
import { uiRoutes } from '../../lib/routes';
import { Button } from '../../primitives/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '../../primitives/dropdown-menu';
import Hint from '../../primitives/hint';
import { Modal, ModalBody, ModalContent, ModalDescription, ModalFooter, ModalHeader, ModalTitle } from '../../primitives/modal';
import { useUiPathname, useUiRouter, useUiSearchParams } from '../../providers/ui-provider';
import { MEMORY_REMEMBER_PARAM } from '../memory/memory-view';
import { CreateChannelDialog } from './create-channel-dialog';
import { agentLabel } from './space-timeline';

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

/**
 * The top of `#general`'s Chat: the "turned on again" line while the server
 * reports one, and the member's "Get started" block until its 3 rows are done
 * or it is dismissed.
 */
export function GeneralChatHead({ projectId, place }: { projectId: string; place: string }) {
  const t = useTranslations('spaces.onboarding');
  const notice = useProjectSpaceGeneralNotice(projectId);
  return (
    <>
      {notice.data ? <p className="text-muted-foreground shrink-0 px-5 pt-3 text-xs">{t('reenabled')}</p> : null}
      <GetStarted projectId={projectId} place={place} />
    </>
  );
}

function GetStarted({ projectId, place }: { projectId: string; place: string }) {
  const t = useTranslations('spaces.onboarding.getStarted');
  const router = useUiRouter();
  const pathname = useUiPathname();
  const searchParams = useUiSearchParams();
  const onboarding = useChannelsOnboarding(projectId);
  const mark = useMarkChannelsOnboarding(projectId);
  const agents = useVisibleAgents({ projectId });
  const [dismissed, setDismissed] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const state = onboarding.data?.get_started;
  if (!state?.visible || dismissed) return null;

  // The Memory tab, with the Remember bar focused.
  const openRemember = () => {
    const params = new URLSearchParams(searchParams.toString());
    params.delete('thread');
    params.set('tab', 'memory');
    params.set(MEMORY_REMEMBER_PARAM, '1');
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  };

  return (
    <section aria-label={t('title')} className="shrink-0 px-5 pt-4">
      <div className="bg-popover rounded-md border">
        <div className="flex items-center justify-between gap-2 py-1.5 pr-1.5 pl-4">
          <h2 className="text-sm font-medium">{t('title')}</h2>
          <Hint label={t('dismiss')} side="bottom">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t('dismiss')}
              className="text-muted-foreground"
              onClick={() => {
                setDismissed(true);
                mark.mutate('get_started.dismissed');
              }}
            >
              <Close className="size-4" />
            </Button>
          </Hint>
        </div>
        <ul className="flex flex-col px-1.5 pb-1.5">
          <Row done={state.create_channel} label={t('channel')} onClick={() => setCreateOpen(true)} />
          <Row done={state.remember} label={t('remember', { place })} onClick={openRemember} />
          <li>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <RowButton done={state.open_dm} label={t('dm')} />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-64">
                <DropdownMenuLabel className="text-muted-foreground text-xs font-normal">{t('pickAgent')}</DropdownMenuLabel>
                {agents.length === 0 ? (
                  <p className="text-muted-foreground px-2 py-1.5 text-xs">{t('noAgents')}</p>
                ) : (
                  agents.map((agent) => {
                    const name = agentLabel(agent.name);
                    return (
                      <DropdownMenuItem key={agent.name} onClick={() => router.push(uiRoutes().dm(projectId, agent.name))}>
                        <AgentMark slug={agent.name} size={14} />
                        <span className="truncate">{name}</span>
                      </DropdownMenuItem>
                    );
                  })
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </li>
        </ul>
      </div>
      <CreateChannelDialog projectId={projectId} open={createOpen} onOpenChange={setCreateOpen} />
    </section>
  );
}

function Row({ done, label, onClick }: { done: boolean; label: string; onClick: () => void }) {
  return (
    <li>
      <RowButton done={done} label={label} onClick={onClick} />
    </li>
  );
}

/** One "Get started" row: a done check (or an open circle) and the step, the whole row its action. */
function RowButton({
  done,
  label,
  ...props
}: { done: boolean; label: string } & Omit<React.ComponentProps<'button'>, 'children'>) {
  const t = useTranslations('spaces.onboarding.getStarted');
  return (
    <button
      type="button"
      {...props}
      className={cn(
        'hover:bg-hover focus-visible:ring-ring flex h-8 w-full items-center gap-2.5 rounded-sm px-2.5 text-left text-sm outline-none focus-visible:ring-2',
        done ? 'text-muted-foreground' : 'text-foreground',
      )}
    >
      {done ? (
        <SolidCheckIcon aria-hidden className="text-kortix-green size-4" />
      ) : (
        <CircleIcon aria-hidden className="text-muted-foreground size-4 shrink-0" />
      )}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {done ? <span className="sr-only">{t('done')}</span> : null}
    </button>
  );
}
