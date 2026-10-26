import { KortixLogo } from '@/components/sidebar/kortix-logo';
import { cn } from '@kortix/ui';
import { MicrosoftTeams } from '@kortix/ui/internal/icons/microsoft-teams';
import { Slack } from '@kortix/ui/internal/icons/slack';
import {
  BellIcon,
  CalendarBlankIcon,
  CaretDownIcon,
  ChatCircleIcon,
  CheckIcon,
  HashIcon,
  PaperPlaneRightIcon,
  PlusIcon,
  StopIcon,
  UsersThreeIcon,
} from '@phosphor-icons/react/dist/ssr';
import type { ReactNode } from 'react';

/*
 * The chat pieces of the channel pages (/slack, /teams): a message, the cards
 * Kortix posts into a thread, and the two app windows. Drawn in tokens, so they
 * follow the visitor's theme; the layout follows each app, the colour does not
 * (the page spends no decorative colour). Synthetic people and data only.
 */

export type ChatAction = { label: string; primary?: boolean };

/** What Kortix posts under a message: live steps, or a card that asks. */
export type ChatCard =
  | { kind: 'steps'; title: string; steps: readonly { label: string; done: boolean }[]; stop?: boolean }
  | { kind: 'ask'; title: string; detail: string; actions: readonly ChatAction[]; feedback?: string };

export type ChatMessage = {
  from: 'you' | 'kortix';
  name: string;
  time: string;
  text: string;
  card?: ChatCard;
};

function Avatar({ from, name }: { from: ChatMessage['from']; name: string }) {
  return from === 'kortix' ? (
    <span className="bg-foreground text-background flex size-8 shrink-0 items-center justify-center rounded-md">
      <KortixLogo size={14} variant="symbol" />
    </span>
  ) : (
    <span className="bg-muted text-foreground flex size-8 shrink-0 items-center justify-center rounded-md text-xs font-medium">
      {name.slice(0, 1)}
    </span>
  );
}

/** The card Kortix posts: steps with a Stop button, or a question with its actions. */
export function ThreadCard({ card }: { card: ChatCard }) {
  if (card.kind === 'steps') {
    return (
      <div className="flex max-w-md flex-col gap-2.5 rounded-md border px-4 py-3">
        <span className="text-muted-foreground text-xs">{card.title}</span>
        <ul className="flex flex-col gap-1.5">
          {card.steps.map((step) => (
            <li key={step.label} className="flex items-center gap-2 text-xs">
              {step.done ? (
                <CheckIcon aria-hidden className="text-foreground size-3.5 shrink-0" />
              ) : (
                <span aria-hidden className="border-muted-foreground size-3.5 shrink-0 rounded-full border border-dashed" />
              )}
              <span className={cn('truncate font-mono', step.done ? 'text-foreground' : 'text-muted-foreground')}>
                {step.label}
              </span>
            </li>
          ))}
        </ul>
        {card.stop ? (
          <span className="text-foreground inline-flex w-fit items-center gap-1.5 rounded-sm border px-2.5 py-1 text-xs font-medium">
            <StopIcon aria-hidden weight="fill" className="size-3" />
            Stop
          </span>
        ) : null}
      </div>
    );
  }
  return (
    <div className="flex max-w-md flex-col gap-3 rounded-md border px-4 py-3">
      <div className="flex flex-col gap-0.5">
        <span className="text-foreground text-sm font-medium">{card.title}</span>
        <span className="text-muted-foreground text-xs">{card.detail}</span>
      </div>
      {card.feedback ? (
        <span className="text-muted-foreground rounded-sm border px-2.5 py-1.5 text-xs">{card.feedback}</span>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {card.actions.map((action) => (
          <span
            key={action.label}
            className={cn(
              'rounded-sm px-3 py-1 text-xs font-medium',
              action.primary ? 'bg-foreground text-background' : 'text-foreground border',
            )}
          >
            {action.label}
          </span>
        ))}
      </div>
    </div>
  );
}

/** One message, Slack-style: avatar, name, an App tag on Kortix, time, text, card. */
export function Message({ message }: { message: ChatMessage }) {
  return (
    <li className="flex gap-3">
      <Avatar from={message.from} name={message.name} />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex items-baseline gap-2">
          <span className="text-foreground text-sm font-medium">{message.name}</span>
          {message.from === 'kortix' ? (
            <span className="bg-muted text-muted-foreground rounded-xs px-1 text-xs">App</span>
          ) : null}
          <span className="text-muted-foreground text-xs">{message.time}</span>
        </div>
        <p className="text-foreground text-sm text-pretty">{message.text}</p>
        {message.card ? (
          <div className="pt-1.5">
            <ThreadCard card={message.card} />
          </div>
        ) : null}
      </div>
    </li>
  );
}

/** A thread on its own, for the section tiles: a white card on the tile. */
export function ThreadCardStack({ channel, messages }: { channel: string; messages: readonly ChatMessage[] }) {
  return (
    <div className="bg-background flex w-full max-w-lg flex-col gap-4 rounded-lg border p-5">
      <span className="text-muted-foreground text-xs font-medium">{channel}</span>
      <ul className="flex flex-col gap-4">
        {messages.map((message, i) => (
          <Message key={i} message={message} />
        ))}
      </ul>
    </div>
  );
}

function SidebarRow({ children, active }: { children: ReactNode; active?: boolean }) {
  return (
    <li
      className={cn(
        'flex items-center gap-2 rounded-sm px-2 py-1 text-sm',
        active ? 'bg-muted text-foreground font-medium' : 'text-muted-foreground',
      )}
    >
      {children}
    </li>
  );
}

/**
 * Slack, laid out as Slack is: the workspace and its channels on the left,
 * the channel header, the thread and the composer on the right. Taller than the
 * stage and open at the foot, so it runs off the band's bottom edge.
 */
export function SlackWindow({ messages }: { messages: readonly ChatMessage[] }) {
  return (
    <div className="bg-background w-full max-w-5xl overflow-hidden rounded-t-lg border border-b-0">
      <div className="grid h-[24rem] grid-cols-1 sm:h-[30rem] md:grid-cols-[13rem_1fr]">
        <aside className="bg-card hidden flex-col gap-5 border-r px-3 py-4 md:flex">
          <span className="text-foreground flex items-center gap-1.5 px-2 text-sm font-medium">
            Acme
            <CaretDownIcon aria-hidden className="size-3" />
          </span>
          <div className="flex flex-col gap-1">
            <span className="text-muted-foreground px-2 text-xs">Channels</span>
            <ul className="flex flex-col">
              <SidebarRow># general</SidebarRow>
              <SidebarRow active># billing</SidebarRow>
              <SidebarRow># eng</SidebarRow>
              <SidebarRow># support</SidebarRow>
            </ul>
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-muted-foreground px-2 text-xs">Apps</span>
            <ul className="flex flex-col">
              <SidebarRow>
                <span className="bg-foreground text-background flex size-4 items-center justify-center rounded-xs">
                  <KortixLogo size={9} variant="symbol" />
                </span>
                Kortix
              </SidebarRow>
            </ul>
          </div>
        </aside>
        <div className="flex min-h-0 flex-col">
          <div className="flex items-center justify-between border-b px-5 py-3">
            <span className="text-foreground flex items-center gap-1.5 text-sm font-medium">
              <HashIcon aria-hidden className="size-3.5" />
              billing
            </span>
            <span className="text-muted-foreground flex items-center gap-1.5 text-xs">
              <Slack className="size-3.5" />
              Thread
            </span>
          </div>
          <ul className="flex min-h-0 flex-1 flex-col gap-5 overflow-hidden px-5 py-5">
            {messages.map((message, i) => (
              <Message key={i} message={message} />
            ))}
          </ul>
          <div className="px-5 pb-5">
            <div className="text-muted-foreground flex items-center justify-between rounded-md border px-3 py-2.5 text-sm">
              Reply…
              <PaperPlaneRightIcon aria-hidden className="size-4" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function RailItem({ icon, label, active }: { icon: ReactNode; label: string; active?: boolean }) {
  return (
    <li
      className={cn(
        'flex flex-col items-center gap-1 py-2 text-xs',
        active ? 'text-foreground' : 'text-muted-foreground',
      )}
    >
      {icon}
      {label}
    </li>
  );
}

/**
 * Microsoft Teams, laid out as Teams is: the app rail, the team and its
 * channels, then the channel's posts with the reply under the post. Kortix
 * answers with one live card, then the approval card.
 */
export function TeamsWindow({ messages }: { messages: readonly ChatMessage[] }) {
  const [post, ...replies] = messages;
  return (
    <div className="bg-background w-full max-w-5xl overflow-hidden rounded-t-lg border border-b-0">
      <div className="grid h-[24rem] grid-cols-1 sm:h-[30rem] md:grid-cols-[4.5rem_12rem_1fr]">
        <ul className="bg-card hidden flex-col border-r pt-2 md:flex">
          <RailItem icon={<BellIcon aria-hidden className="size-5" />} label="Activity" />
          <RailItem icon={<ChatCircleIcon aria-hidden className="size-5" />} label="Chat" />
          <RailItem icon={<UsersThreeIcon aria-hidden weight="fill" className="size-5" />} label="Teams" active />
          <RailItem icon={<CalendarBlankIcon aria-hidden className="size-5" />} label="Calendar" />
        </ul>
        <aside className="hidden flex-col gap-3 border-r px-3 py-4 md:flex">
          <span className="text-foreground px-2 text-sm font-medium">Teams</span>
          <ul className="flex flex-col">
            <SidebarRow>
              <span className="bg-muted text-foreground flex size-5 items-center justify-center rounded-xs text-xs">B</span>
              Billing
            </SidebarRow>
            <SidebarRow active>General</SidebarRow>
            <SidebarRow>Incidents</SidebarRow>
          </ul>
        </aside>
        <div className="flex min-h-0 flex-col">
          <div className="flex items-center gap-5 border-b px-5 py-3">
            <span className="text-foreground text-sm font-medium">General</span>
            <span className="text-foreground border-foreground -mb-3 border-b-2 pb-2.5 text-xs">Posts</span>
            <span className="text-muted-foreground -mb-3 pb-2.5 text-xs">Files</span>
            <span className="text-muted-foreground ml-auto flex items-center gap-1.5 text-xs">
              <MicrosoftTeams className="size-3.5" />
            </span>
          </div>
          <div className="bg-card min-h-0 flex-1 overflow-hidden px-5 py-5">
            {post ? (
              <div className="bg-background flex flex-col rounded-md border">
                <ul className="px-4 py-4">
                  <Message message={post} />
                </ul>
                <ul className="flex flex-col gap-4 border-t px-4 py-4">
                  {replies.map((message, i) => (
                    <Message key={i} message={message} />
                  ))}
                </ul>
                <div className="text-muted-foreground flex items-center gap-2 border-t px-4 py-2.5 text-xs">
                  <PlusIcon aria-hidden className="size-3.5" />
                  Reply
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
