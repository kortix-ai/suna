'use client';

import { useState } from 'react';

import { useTranslations } from '../../i18n';
import { AgentMark } from '../../internal/components/agent-mark';
import { AvatarGroup, AvatarGroupCount } from '../../primitives/avatar';
import { Button } from '../../primitives/button';
import { FadedScrollArea } from '../../primitives/faded-scroll-area';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '../../primitives/hover-card';
import { UserAvatar } from '../../primitives/user-avatar';
import { participantLabel } from '../../session/participants/session-participants';
import { agentLabel, type spaceRoster } from './space-timeline';

type Roster = ReturnType<typeof spaceRoster>;

/** Faces before the rest collapse into "+N": two people, three agents. */
const PEOPLE_SHOWN = 2;
const AGENTS_SHOWN = 3;

/**
 * Who is in the channel, in its header: the people's faces, a hairline, the
 * agents' tiles. People and agents never mix, so a glance tells them apart.
 * Hover, or a click, opens the session header's people card
 * (`SessionParticipantStack`): People, then Agents, each a label, a count and
 * plain rows. Its one action, "View all members", opens the Members tab.
 */
export function SpaceRosterButton({ roster, onViewAll }: { roster: Roster; onViewAll: () => void }) {
  const t = useTranslations('spaces.view');
  const [open, setOpen] = useState(false);
  const { people, agents } = roster;
  const morePeople = people.length - PEOPLE_SHOWN;
  const moreAgents = agents.length - AGENTS_SHOWN;
  const label = t('roster', {
    people: t('rosterPeople', { count: people.length }),
    agents: t('rosterAgents', { count: agents.length }),
  });

  return (
    <HoverCard open={open} onOpenChange={setOpen} openDelay={300} closeDelay={100}>
      <HoverCardTrigger asChild>
        <button
          type="button"
          aria-label={label}
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          className="hover:bg-hover focus-visible:ring-ring data-[state=open]:bg-hover flex h-8 shrink-0 cursor-pointer items-center gap-2 rounded-md border px-1.5 outline-none focus-visible:ring-2"
        >
          {people.length > 0 ? (
            <AvatarGroup className="-space-x-1">
              {people.slice(0, PEOPLE_SHOWN).map((person) => (
                <UserAvatar
                  key={person.id}
                  email={person.email ?? ''}
                  name={participantLabel(person)}
                  avatarUrl={person.avatarUrl}
                  size="xs"
                  ring
                />
              ))}
              {morePeople > 0 ? (
                <AvatarGroupCount className="h-5 w-auto min-w-5 rounded-full px-1 text-xs tabular-nums">
                  +{morePeople}
                </AvatarGroupCount>
              ) : null}
            </AvatarGroup>
          ) : null}
          {people.length > 0 && agents.length > 0 ? <span aria-hidden className="bg-border h-4 w-px shrink-0" /> : null}
          {agents.length > 0 ? (
            <span className="flex -space-x-1">
              {agents.slice(0, AGENTS_SHOWN).map((agent) => (
                // 18px tile: the people's `xs` faces and the `+N` chip are `h-5`.
                <AgentMark key={agent} slug={agent} size={14} tile={18} className="ring-background ring-2" />
              ))}
              {moreAgents > 0 ? (
                <span className="bg-muted text-muted-foreground ring-background flex h-5 min-w-5 items-center justify-center rounded-sm px-1 text-xs font-medium tabular-nums ring-2">
                  +{moreAgents}
                </span>
              ) : null}
            </span>
          ) : null}
        </button>
      </HoverCardTrigger>
      {/* The session header's card: a label and count per group, then rows in a
          capped scroll area. Not animated, like that card. */}
      <HoverCardContent
        side="bottom"
        align="end"
        sideOffset={6}
        animated={false}
        className="w-72 overflow-hidden p-0"
        onEscapeKeyDown={() => setOpen(false)}
      >
        <FadedScrollArea fadeColor="from-popover" fadeSize="6" className="max-h-80 overscroll-contain">
          {people.length > 0 ? (
            <RosterGroup title={t('rosterTitlePeople')} count={people.length}>
              {people.map((person) => (
                <li key={person.id} className="text-foreground flex min-h-9 items-center gap-2.5 px-2 py-1 text-sm">
                  <UserAvatar
                    email={person.email ?? ''}
                    name={participantLabel(person)}
                    avatarUrl={person.avatarUrl}
                    size="md"
                  />
                  {/* Name and email read as one block: tight leading, no gap. */}
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate leading-tight">{participantLabel(person)}</span>
                    {person.email ? (
                      <span className="text-muted-foreground truncate text-xs leading-tight">{person.email}</span>
                    ) : null}
                  </span>
                </li>
              ))}
            </RosterGroup>
          ) : null}
          {agents.length > 0 ? (
            <RosterGroup title={t('rosterTitleAgents')} count={agents.length}>
              {agents.map((agent) => (
                <li key={agent} className="text-foreground flex min-h-9 items-center gap-2.5 px-2 py-1 text-sm">
                  <AgentMark slug={agent} size={21} />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate leading-tight">{agentLabel(agent)}</span>
                    <span className="text-muted-foreground truncate text-xs leading-tight tabular-nums">
                      {t('agentThreads', { count: roster.agentThreads[agent] ?? 0 })}
                    </span>
                  </span>
                </li>
              ))}
            </RosterGroup>
          ) : null}
        </FadedScrollArea>
        <div className="border-t p-1">
          <Button
            variant="ghost"
            size="sm"
            className="w-full justify-start font-normal"
            onClick={() => {
              setOpen(false);
              onViewAll();
            }}
          >
            {t('viewAllMembers')}
          </Button>
        </div>
      </HoverCardContent>
    </HoverCard>
  );
}

/** "People 6", then the rows: the session card's header line, once per group. */
function RosterGroup({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  return (
    <section>
      <div className="text-muted-foreground flex items-center justify-between px-3.5 pt-2.5 pb-1 text-xs">
        <span>{title}</span>
        <span className="tabular-nums">{count}</span>
      </div>
      {/* Plain rows, no hover highlight: nothing in a row is clickable. */}
      <ul className="p-1 pt-0">{children}</ul>
    </section>
  );
}
