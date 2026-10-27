'use client';

import type { ProjectSpace } from '@kortix/sdk';
import {
  useChannelsOnboarding,
  useMarkChannelsOnboarding,
  useProjectMemoryLayer,
  useProjectSpaceMembers,
} from '@kortix/sdk/react';
import { CircleIcon } from '@phosphor-icons/react';
import { useState } from 'react';

import { useTranslations } from '../../i18n';
import { Close } from '../../icons/close';
import { SolidCheckIcon } from '../../internal/icons/solid-check-icon';
import { cn } from '../../lib/utils';
import { Button } from '../../primitives/button';
import Hint from '../../primitives/hint';
import { useUiPathname, useUiRouter, useUiSearchParams } from '../../providers/ui-provider';
import { MEMORY_REMEMBER_PARAM } from '../memory/memory-view';
import { CreateChannelDialog } from './create-channel-dialog';
import { AddChannelMembersDialog, useInviteToProject, useProjectPeople } from './space-members';

const dismissKey = (spaceId: string) => `kortix:channel-setup-dismissed:${spaceId}`;

function readDismissed(spaceId: string): boolean {
  try {
    return window.localStorage.getItem(dismissKey(spaceId)) === '1';
  } catch {
    return false;
  }
}

type Step = { key: string; label: string; hint?: string; done: boolean; onClick: () => void };

/**
 * A channel's one setup block, top of its Chat: only the steps the viewer can
 * take, each checked off from real state. Add agents (creator or manager): the
 * channel has an agent. Invite members (whoever may add people or invite to the
 * project): the channel has a second person. Remember something: the channel's
 * memory has a page. `#general` adds Create a channel. It hides when every step
 * is done or the viewer dismisses it: in `#general` through the server's
 * `get_started.dismissed` mark, elsewhere per channel in this browser.
 */
export function ChannelSetup({
  projectId,
  space,
  onOpenMembers,
}: {
  projectId: string;
  space: ProjectSpace;
  /** For a viewer who may add no one: the Members tab. */
  onOpenMembers: () => void;
}) {
  const t = useTranslations('spaces.view.setup');
  const tStart = useTranslations('spaces.onboarding.getStarted');
  const router = useUiRouter();
  const pathname = useUiPathname();
  const searchParams = useUiSearchParams();
  const general = space.is_default === true;
  const members = useProjectSpaceMembers(projectId, space.space_id);
  const people = useProjectPeople(projectId, general ? undefined : space);
  const layer = useProjectMemoryLayer(projectId, space.space_id);
  const onboarding = useChannelsOnboarding(projectId, { enabled: general });
  const mark = useMarkChannelsOnboarding(projectId);
  const invite = useInviteToProject(projectId);
  const [dismissed, setDismissed] = useState(() => (general ? false : readDismissed(space.space_id)));
  const [picking, setPicking] = useState(false);
  const [creating, setCreating] = useState(false);

  const canAdd = members.data?.can_add === true;
  const editable = space.can_edit !== false;
  const place = `#${space.slug ?? space.name}`;

  const openRemember = () => {
    const params = new URLSearchParams(searchParams.toString());
    params.delete('thread');
    params.set('tab', 'memory');
    params.set(MEMORY_REMEMBER_PARAM, '1');
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  };
  // People not in the channel yet are picked; with nobody left (and always in #general), invite by email.
  const openInvite = () => {
    if (!general && canAdd && people.available.length > 0) setPicking(true);
    else if (invite.canInvite) invite.invite();
    else onOpenMembers();
  };

  const state = onboarding.data?.get_started;
  const loading = members.isLoading || layer.isLoading || (general && onboarding.isLoading);
  const steps: Step[] = [];
  if (editable) {
    steps.push({ key: 'agents', label: t('addAgents'), hint: t('addAgentsHint'), done: (space.agents?.length ?? 0) > 0, onClick: () => setPicking(true) });
  }
  if (general ? invite.canInvite : canAdd || invite.canInvite) {
    steps.push({ key: 'invite', label: t('invite'), hint: t('inviteHint'), done: (members.data?.members.length ?? 0) > 1, onClick: openInvite });
  }
  // Memory off (no layer) or read-only: no step.
  if (layer.data && layer.data.can_write !== false) {
    const pages = Object.values(layer.data.counts).reduce((sum, count) => sum + count, 0);
    steps.push({ key: 'remember', label: t('remember'), hint: t('rememberHint'), done: pages > 0 || state?.remember === true, onClick: openRemember });
  }
  if (general && state) {
    steps.push({ key: 'channel', label: tStart('channel'), done: state.create_channel, onClick: () => setCreating(true) });
  }

  const hidden = loading || dismissed || (general && state?.visible === false) || steps.every((step) => step.done);

  const dismiss = () => {
    setDismissed(true);
    if (general) {
      mark.mutate('get_started.dismissed');
      return;
    }
    try {
      window.localStorage.setItem(dismissKey(space.space_id), '1');
    } catch {
      // Storage blocked: dismissed for this visit only.
    }
  };

  return (
    <>
      {hidden ? null : (
        <section aria-label={t('label', { name: place })} className="shrink-0 px-5 pt-4">
          <div className="bg-popover max-w-xl rounded-md border">
            <div className="flex items-center justify-between gap-2 py-1.5 pr-1.5 pl-4">
              <h2 className="truncate text-sm font-medium">{t('label', { name: place })}</h2>
              <Hint label={tStart('dismiss')} side="bottom">
                <Button variant="ghost" size="icon-sm" aria-label={tStart('dismiss')} className="text-muted-foreground" onClick={dismiss}>
                  <Close className="size-4" />
                </Button>
              </Hint>
            </div>
            <ul className="flex flex-col px-1.5 pb-1.5">
              {steps.map((step) => (
                <li key={step.key}>
                  <StepButton step={step} doneLabel={tStart('done')} />
                </li>
              ))}
            </ul>
          </div>
        </section>
      )}
      {editable || canAdd ? <AddChannelMembersDialog projectId={projectId} space={space} open={picking} onOpenChange={setPicking} /> : null}
      {general ? <CreateChannelDialog projectId={projectId} open={creating} onOpenChange={setCreating} /> : null}
      {invite.dialog}
    </>
  );
}

/** One step: a done check (or an open circle), the step and its hint; the whole row is its action. */
function StepButton({ step, doneLabel }: { step: Step; doneLabel: string }) {
  return (
    <button
      type="button"
      onClick={step.onClick}
      className={cn(
        'hover:bg-hover focus-visible:ring-ring flex h-8 w-full items-center gap-2.5 rounded-sm px-2.5 text-left text-sm transition-colors duration-(--duration-fast) outline-none focus-visible:ring-2',
        step.done ? 'text-muted-foreground' : 'text-foreground',
      )}
    >
      {step.done ? (
        <SolidCheckIcon aria-hidden className="text-kortix-green size-4 shrink-0" />
      ) : (
        <CircleIcon aria-hidden className="text-muted-foreground size-4 shrink-0" />
      )}
      <span className="shrink-0">{step.label}</span>
      {step.hint ? <span className="text-muted-foreground min-w-0 flex-1 truncate text-xs">{step.hint}</span> : <span className="flex-1" />}
      {step.done ? <span className="sr-only">{doneLabel}</span> : null}
    </button>
  );
}
