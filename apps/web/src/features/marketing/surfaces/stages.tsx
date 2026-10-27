import { CaretRightIcon } from '@phosphor-icons/react/dist/ssr';

import { SessionWindow } from '../landing-hero/session-window';
import { channelContent } from './channel-content';
import { SlackWindow, TeamsWindow } from './chat';
import { PhoneFrame, TerminalFrame } from './frames';
import { Stage } from './stage';

/*
 * One stage per surface page. Every one shows the same piece of work, a
 * session that fixes a billing webhook and proves it with a test, so a reader
 * who moves between the pages sees one company working on five surfaces.
 * Synthetic data only.
 */

const PROMPT = 'Fix the billing webhook retry and prove it with a test';
const RESULT = 'A 4xx no longer retries, and the billing suite passes: 3 pass, 0 fail.';

/** The landing hero's band, as is: the live session window on the card
 *  surface (`SessionWindow`, Paper HVM-0), with one line under it. */
export function DesktopStage() {
  return (
    <div className="bg-card relative flex flex-col items-center gap-7 overflow-hidden px-4 py-7 lg:gap-10 lg:px-0 lg:pt-17 lg:pb-10">
      <div className="relative w-full max-w-304">
        <SessionWindow />
      </div>
      <p className="text-foreground px-4 text-center text-base font-medium text-balance">
        ⌘⇧Space opens it over any app.{' '}
        <span className="text-muted-foreground">A badge on the Dock counts the work you have not read.</span>
      </p>
    </div>
  );
}

/** The desktop stage's band with the phone in its place: the whole phone,
 *  centred on the card surface, with one line under it. */
export function MobileStage() {
  return (
    <div className="bg-card relative flex flex-col items-center gap-7 overflow-hidden px-4 py-7 lg:gap-10 lg:pt-17 lg:pb-10">
      <PhoneFrame title="Billing webhook retry">
        <div className="bg-secondary text-foreground ml-auto max-w-[85%] rounded-lg px-3 py-2 text-sm">{PROMPT}</div>
        <span className="text-muted-foreground flex items-center gap-1 text-xs">
          Completed 5 steps
          <CaretRightIcon aria-hidden className="size-3" />
        </span>
        <p className="text-foreground text-sm text-pretty">{RESULT}</p>
      </PhoneFrame>
      <p className="text-foreground px-4 text-center text-base font-medium text-balance">
        Chat with any session as it streams.{' '}
        <span className="text-muted-foreground">Dictate instead of typing.</span>
      </p>
    </div>
  );
}

export function CliStage() {
  return (
    <Stage
      device={
        <TerminalFrame
          title="~/acme-co"
          lines={[
            { kind: 'cmd', text: 'curl -fsSL https://kortix.com/install | bash' },
            { kind: 'gap' },
            { kind: 'cmd', text: 'kortix login' },
            { kind: 'cmd', text: 'kortix init' },
            { kind: 'cmd', text: 'kortix ship' },
            { kind: 'gap' },
            { kind: 'cmd', text: `kortix chat --prompt "${PROMPT}"` },
            { kind: 'out', text: 'Working · 5 steps' },
            { kind: 'out', text: RESULT },
            { kind: 'gap' },
            { kind: 'cmd', text: 'kortix cr list' },
          ]}
        />
      }
    />
  );
}

/** The hero window: Slack laid out as Slack, with the page's own thread. */
export function SlackStage() {
  return <Stage device={<SlackWindow messages={channelContent('slack').window} />} />;
}

/** The hero window: Teams laid out as Teams, with the page's own thread. */
export function TeamsStage() {
  return <Stage device={<TeamsWindow messages={channelContent('teams').window} />} />;
}
