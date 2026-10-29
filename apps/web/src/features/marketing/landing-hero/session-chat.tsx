'use client';
import { useTranslations } from '@/i18n/use-translations';

import { BrandGlyph } from '@/features/marketing/kit/brand-glyph';
import { cn } from '@kortix/ui';
import { Button } from '@kortix/ui/button';
import Loading from '@kortix/ui/loading';
import { Switch } from '@kortix/ui/switch';
import {
  CalendarDotsIcon,
  CheckIcon,
  ClockIcon,
  FilesIcon,
  MagnifyingGlassIcon,
  PencilSimpleIcon,
  PlugIcon,
  ReadCvLogoIcon,
  ShieldCheckIcon,
  ShieldWarningIcon,
  UsersIcon,
  type Icon,
} from '@phosphor-icons/react';
import { useReducedMotion } from 'motion/react';
import { useEffect, useRef, useState, type ReactNode } from 'react';

import { AppBoard, Composer, HeaderTools } from './session-window';
import { useBeats } from './use-beats';

/**
 * Workspace mode of the hero walkthrough: one Arcadia session chat that runs
 * through all four steps. Step N opens on the conversation as step N − 1 left
 * it, then plays its own beats: the goal typed and worked on, HubSpot
 * connected and a write approved inline, a schedule created and its first
 * unattended run, the session shared and a teammate writing in it.
 *
 * Drawn from the product's session parts: the chain of tool steps
 * (turn/activity-step.tsx), the approval prompt
 * (prompts/session-permission-prompt.tsx), the trigger tool
 * (tool/tools/triggers-tool.tsx) and the participant stack
 * (participants/session-participants.tsx). Synthetic fixture: people are
 * "Member N", never named.
 */

const TITLE = 'Quiet deals follow-up';

/** Each step's beats, ms from the moment it plays, in order. */
const SCRIPT = [
  { type: 300, send: 1900, reply: 2500, skill: 3100, read: 3700, search: 4300, found: 4900 },
  {
    call: 300,
    connect: 900,
    click: 2000,
    connected: 2800,
    deals: 3400,
    ask: 4000,
    allow: 5200,
    done: 5700,
    summary: 6200,
  },
  {
    type: 300,
    send: 1300,
    create: 1900,
    card: 2400,
    reply: 2900,
    later: 3800,
    started: 4300,
    run: 4900,
    ran: 5500,
    report: 6100,
  },
  { press: 300, shared: 1900, joined: 2500, member: 3100, update: 3900, reply: 4700 },
] as const;

const KEYS = SCRIPT.map((s) => Object.keys(s));
const TIMES = SCRIPT.map((s) => Object.values(s) as number[]);

/** Text typed into the composer by the steps that send a prompt. */
const DRAFT: (string | null)[] = [
  'Find the HubSpot deals that went quiet this week and draft a follow-up for each owner.',
  null,
  'Do this every weekday at 08:00.',
  null,
];

const CHAR_MS = 16;
const ENTER =
  'animate-in fade-in slide-in-from-bottom-1 duration-slow ease-out motion-reduce:animate-none';

type At = (key: string) => boolean;

export function SessionChat({ step, play }: { step: number; play: boolean }) {
  return (
    <AppBoard framed={false} session={TITLE}>
      <Chat key={step} step={step} play={play} />
    </AppBoard>
  );
}

function Chat({ step, play }: { step: number; play: boolean }) {
  const tMarketing = useTranslations('hardcodedUi.i18nComplete');

  const landed = useBeats(play, TIMES[step]);
  const reduced = Boolean(useReducedMotion());
  const scroller = useRef<HTMLDivElement>(null);
  const settled = useRef(false);

  /** Earlier steps show whole; the playing step shows the beats that landed. */
  const at =
    (s: number): At =>
    (key) =>
      s < step || (s === step && KEYS[s].includes(key) && KEYS[s].indexOf(key) < landed);
  const enter = (s: number) => (s === step ? ENTER : undefined);
  const now = at(step);

  // The thread follows the newest line, like the app. The first frame jumps.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    el.scrollTo({
      top: el.scrollHeight,
      behavior: settled.current && !reduced ? 'smooth' : 'auto',
    });
    settled.current = true;
  }, [landed, reduced]);

  const draft = DRAFT[step];
  const typing = draft && now('type') && !now('send') ? draft : null;
  const sharing = step === 3 && now('press') && !now('shared');
  const shared = at(3)('shared');

  return (
    <section
      aria-label={tMarketing('text6959b4159575')}
      className="bg-background relative flex flex-1 flex-col overflow-hidden"
    >
      <header className="flex h-14 shrink-0 items-center justify-between pr-5 pl-6">
        <span className="text-sm">{TITLE}</span>
        <div className="flex items-center gap-2">
          {shared ? <Participants className={enter(3)} /> : null}
          <HeaderTools sharing={sharing} />
        </div>
      </header>
      {sharing ? <SharePanel /> : null}

      <div
        ref={scroller}
        className="min-h-0 flex-1 overflow-hidden [mask-image:linear-gradient(to_bottom,transparent,black_2rem)]"
      >
        <div className="mx-auto flex w-152 flex-col gap-4 pt-6 pb-48">
          <Goal at={at(0)} enter={enter(0)} />
          {step >= 1 ? <Connect at={at(1)} enter={enter(1)} /> : null}
          {step >= 2 ? <Automate at={at(2)} enter={enter(2)} /> : null}
          {step >= 3 ? <Share at={at(3)} enter={enter(3)} /> : null}
        </div>
      </div>

      {typing ? <Typing key={step} text={typing} /> : <Composer text="" />}
    </section>
  );
}

/** The composer while a prompt is typed into it, one character at a time. */
function Typing({ text }: { text: string }) {
  const [n, setN] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setN((c) => Math.min(c + 1, text.length)), CHAR_MS);
    return () => clearInterval(id);
  }, [text]);
  return <Composer text={text.slice(0, n)} />;
}

/* ── Step 1: Describe your goal ─────────────────────────────────────────── */

function Goal({ at, enter }: { at: At; enter?: string }) {
  const tMarketing = useTranslations('hardcodedUi.i18nComplete');

  return (
    <>
      {at('send') ? <Prompt className={enter}>{DRAFT[0]}</Prompt> : null}
      {at('reply') ? (
        <Reply className={cn('pt-3', enter)}>{tMarketing('textb442d509019c')}</Reply>
      ) : null}
      {at('skill') ? (
        <Chain>
          <StepRow
            className={enter}
            icon={FilesIcon}
            verb="Loaded skill"
            object="sales-follow-up"
          />
          {at('read') ? (
            <StepRow
              className={enter}
              icon={ReadCvLogoIcon}
              verb="Read"
              object="memory/sales/tone.md"
            />
          ) : null}
          {at('search') ? (
            <StepRow
              className={enter}
              icon={MagnifyingGlassIcon}
              verb={at('found') ? 'Searched' : 'Searching'}
              object="follow-up templates"
              result={at('found') ? '3 results' : undefined}
              running={!at('found')}
            />
          ) : null}
        </Chain>
      ) : null}
    </>
  );
}

/* ── Step 2: Connect your tools ─────────────────────────────────────────── */

function Connect({ at, enter }: { at: At; enter?: string }) {
  const tMarketing = useTranslations('hardcodedUi.i18nComplete');

  return (
    <>
      {at('call') ? (
        <Chain>
          <StepRow
            className={enter}
            icon={PlugIcon}
            verb={at('deals') ? 'Searched deals' : 'Calling'}
            object="hubspot.search_deals"
            result={at('deals') ? '7 deals' : undefined}
            running={!at('deals')}
          />
        </Chain>
      ) : null}
      {at('connect') ? (
        <ConnectCard
          className={enter}
          state={at('connected') ? 'connected' : at('click') ? 'connecting' : 'idle'}
        />
      ) : null}
      {at('ask') ? (
        <ApprovalCard
          className={enter}
          state={at('done') ? 'allowed' : at('allow') ? 'allowing' : 'ask'}
        />
      ) : null}
      {at('done') ? (
        <Chain>
          <StepRow
            className={enter}
            icon={PencilSimpleIcon}
            verb="Created tasks"
            object="hubspot.create_task"
            result="7 tasks"
          />
        </Chain>
      ) : null}
      {at('summary') ? <Reply className={enter}>{tMarketing('text3677cb6d7d0e')}</Reply> : null}
    </>
  );
}

function ConnectCard({
  state,
  className,
}: {
  state: 'idle' | 'connecting' | 'connected';
  className?: string;
}) {
  const tMarketing = useTranslations('hardcodedUi.i18nComplete');

  return (
    <div className={cn('bg-card flex items-center gap-3 rounded-lg border px-4 py-3', className)}>
      <span className="bg-background flex size-9 items-center justify-center rounded-md border">
        <BrandGlyph slug="hubspot" />
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="text-sm font-medium">{tMarketing('text5f5f6ddd5dbf')}</span>
        <span className="text-muted-foreground text-xs">
          {state === 'connected' ? tMarketing('text2e2c3d4fb3f5') : tMarketing('textf668c1eac45f')}
        </span>
      </span>
      {state === 'idle' ? (
        <Button size="xs" className="ml-auto" tabIndex={-1}>
          {tMarketing('text1a2303ede074')}
        </Button>
      ) : (
        <span
          key={state}
          className={cn('text-muted-foreground ml-auto flex items-center gap-1.5 text-xs', ENTER)}
        >
          {state === 'connecting' ? (
            <Loading className="size-3" />
          ) : (
            <span aria-hidden className="bg-kortix-green size-1.5 rounded-full" />
          )}
          {state === 'connecting' ? 'Connecting' : 'Connected'}
        </span>
      )}
    </div>
  );
}

/**
 * The inline permission prompt: the call, then Deny / Allow once / Allow for
 * session. Answered, it stays in the thread as the record of who allowed what.
 */
function ApprovalCard({
  state,
  className,
}: {
  state: 'ask' | 'allowing' | 'allowed';
  className?: string;
}) {
  const tMarketing = useTranslations('hardcodedUi.i18nComplete');

  const allowed = state === 'allowed';
  return (
    <div className={cn('bg-popover overflow-hidden rounded-md border', className)}>
      <div className="flex items-center gap-2 border-b px-3 py-2">
        {allowed ? (
          <ShieldCheckIcon className="text-kortix-green size-4" aria-hidden />
        ) : (
          <ShieldWarningIcon className="text-kortix-orange size-4" aria-hidden />
        )}
        <span className="text-xs font-medium">
          {allowed ? tMarketing('texta04bce7e92b4') : tMarketing('text9928dd82f38f')}
        </span>
        <span className="text-muted-foreground text-xs">
          {allowed ? tMarketing('texta423f5bc1b99') : tMarketing('text4a86400223cc')}
        </span>
      </div>
      <div className="flex items-center gap-3 px-3 py-2.5">
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="font-mono text-xs">{tMarketing('text622bdac4d5b2')}</span>
          <span className="text-muted-foreground text-xs">{tMarketing('textdcb9b0684259')}</span>
        </span>
        {allowed ? null : (
          <>
            <Button size="xs" variant="ghost" tabIndex={-1}>
              {tMarketing('text05a2d7332eb9')}
            </Button>
            <Button size="xs" variant="outline" tabIndex={-1}>
              {tMarketing('text168511d24d9e')}
            </Button>
            <Button size="xs" tabIndex={-1}>
              {state === 'allowing' ? <Loading className="size-3" /> : null}
              {tMarketing('textec9f8a9109ec')}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

/* ── Step 3: Automate work 24/7 ─────────────────────────────────────────── */

function Automate({ at, enter }: { at: At; enter?: string }) {
  const tMarketing = useTranslations('hardcodedUi.i18nComplete');

  return (
    <>
      {at('send') ? <Prompt className={cn('mt-3', enter)}>{DRAFT[2]}</Prompt> : null}
      {at('create') ? (
        <Chain>
          <StepRow
            className={cn('mt-3', enter)}
            icon={CalendarDotsIcon}
            verb={at('card') ? 'Created trigger' : 'Creating trigger'}
            object="quiet-deals"
            running={!at('card')}
          />
        </Chain>
      ) : null}
      {at('card') ? <TriggerCard className={enter} /> : null}
      {at('reply') ? <Reply className={enter}>{tMarketing('text03f02a504991')}</Reply> : null}
      {at('later') ? <Divider className={enter}>{tMarketing('text7ec9b6226b38')}</Divider> : null}
      {at('started') ? (
        <Prompt
          className={enter}
          above={
            <span className="text-muted-foreground flex h-6 items-center gap-1.5 rounded-md border px-2 text-xs">
              <ClockIcon className="size-3.5" aria-hidden />
              {tMarketing('textc6ea096aec0c')}
              <span className="text-foreground">{tMarketing('text1a9d4ff40228')}</span>
            </span>
          }
        >
          {tMarketing('textd44914710143')}
        </Prompt>
      ) : null}
      {at('run') ? (
        <Chain>
          <StepRow
            className={cn('mt-3', enter)}
            icon={PlugIcon}
            verb="Searched deals"
            object="hubspot.search_deals"
            result="4 deals"
          />
          <StepRow
            className={enter}
            icon={PencilSimpleIcon}
            verb={at('ran') ? 'Created tasks' : 'Creating tasks'}
            object="hubspot.create_task"
            result={at('ran') ? '4 tasks' : undefined}
            running={!at('ran')}
          />
        </Chain>
      ) : null}
      {at('report') ? <Reply className={enter}>{tMarketing('text1283f8047db5')}</Reply> : null}
    </>
  );
}

function TriggerCard({ className }: { className?: string }) {
  const tMarketing = useTranslations('hardcodedUi.i18nComplete');

  return (
    <div className={cn('bg-card divide-y rounded-lg border', className)}>
      <div className="flex items-center gap-3 px-4 py-3">
        <span className="bg-muted text-muted-foreground flex size-8 items-center justify-center rounded-md">
          <ClockIcon className="size-4" aria-hidden />
        </span>
        <span className="flex flex-col">
          <span className="text-sm font-medium">{TITLE}</span>
          <span className="text-muted-foreground text-xs">{tMarketing('text914233b97ca1')}</span>
        </span>
        <span className="text-muted-foreground ml-auto font-mono text-xs">0 8 * * 1-5</span>
        <Switch checked aria-label={tMarketing('textfb8d3b01db07')} tabIndex={-1} />
      </div>
      <p className="text-muted-foreground px-4 py-2 text-xs">{tMarketing('text3591d25578ce')}</p>
    </div>
  );
}

/* ── Step 4: Share with your team ───────────────────────────────────────── */

const PEOPLE = ['M1', 'M2', 'M3'];

function Share({ at, enter }: { at: At; enter?: string }) {
  const tMarketing = useTranslations('hardcodedUi.i18nComplete');

  return (
    <>
      {at('shared') ? <Divider className={enter}>{tMarketing('text54504b6c40af')}</Divider> : null}
      {at('joined') ? <Divider className={enter}>{tMarketing('text2a828efad849')}</Divider> : null}
      {at('member') ? (
        <Prompt
          className={enter}
          above={
            <span className="text-muted-foreground flex items-center gap-1.5 text-xs font-medium">
              <Initials label="M2" />
              {tMarketing('text682761f025aa')}
            </span>
          }
        >
          {tMarketing('textf984dc613fd8')}
        </Prompt>
      ) : null}
      {at('update') ? (
        <Chain>
          <StepRow
            className={cn('mt-3', enter)}
            icon={PlugIcon}
            verb={at('reply') ? 'Updated deals' : 'Updating deals'}
            object="hubspot.update_deal"
            result={at('reply') ? '2 deals' : undefined}
            running={!at('reply')}
          />
        </Chain>
      ) : null}
      {at('reply') ? <Reply className={enter}>{tMarketing('texted18f67bfab0')}</Reply> : null}
    </>
  );
}

function Initials({ label }: { label: string }) {
  return (
    <span className="bg-foreground text-background ring-background flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-medium ring-2">
      {label}
    </span>
  );
}

/** The header's participant stack: overlapping initials. */
function Participants({ className }: { className?: string }) {
  const tMarketing = useTranslations('hardcodedUi.i18nComplete');

  return (
    <span
      role="img"
      aria-label={tMarketing('textc2b0576b422f')}
      className={cn('flex -space-x-1', className)}
    >
      {PEOPLE.map((p) => (
        <Initials key={p} label={p} />
      ))}
    </span>
  );
}

/** The Share control's panel: the Sales group picked. Opens with no motion, like every popover. */
function SharePanel() {
  const tMarketing = useTranslations('hardcodedUi.i18nComplete');

  return (
    <div className="bg-popover absolute top-13 right-5 z-10 flex w-80 flex-col gap-3 rounded-xl border p-4 shadow-lg">
      <div className="flex flex-col gap-0.5">
        <p className="text-sm font-medium">{tMarketing('textbc9424d3f527')}</p>
        <p className="text-muted-foreground text-xs">{tMarketing('text5afaa091082e')}</p>
      </div>
      <div className="bg-muted flex items-center gap-2.5 rounded-lg px-2 py-1.5">
        <span className="bg-background text-muted-foreground flex size-6 items-center justify-center rounded-md">
          <UsersIcon className="size-3.5" aria-hidden />
        </span>
        <span className="flex-1 text-sm">
          {tMarketing('text8de4e0ea7370')}
          <span className="text-muted-foreground text-xs">{tMarketing('textc0711810e523')}</span>
        </span>
        <CheckIcon className="size-4" aria-hidden />
      </div>
      <Button size="sm" className="self-end" tabIndex={-1}>
        {tMarketing('text29887a5ff984')}
      </Button>
    </div>
  );
}

/* ── Thread parts ───────────────────────────────────────────────────────── */

/** A sent prompt, right-aligned; `above` is its author or its source. */
function Prompt({
  above,
  children,
  className,
}: {
  above?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col items-end gap-1.5', className)}>
      {above}
      <p className="bg-secondary max-w-122 rounded-lg px-4 py-3 text-sm leading-relaxed">
        {children}
      </p>
    </div>
  );
}

function Reply({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cn('text-sm leading-relaxed', className)}>{children}</p>;
}

/** A centred hairline label: a time jump or a change to who is in the session. */
function Divider({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn('text-muted-foreground flex items-center gap-3 py-1 text-xs', className)}>
      <span className="bg-border h-px flex-1" />
      {children}
      <span className="bg-border h-px flex-1" />
    </div>
  );
}

/** A run of tool steps on one rail through their icons. */
function Chain({ children }: { children: ReactNode }) {
  return (
    <ol className="relative flex flex-col gap-2.5">
      <span aria-hidden className="bg-border absolute top-2 bottom-2 left-2 w-px" />
      {children}
    </ol>
  );
}

function StepRow({
  icon: Glyph,
  verb,
  object,
  result,
  running,
  className,
}: {
  icon: Icon;
  verb: string;
  object: string;
  result?: string;
  running?: boolean;
  className?: string;
}) {
  return (
    <li
      className={cn('relative flex min-w-0 items-center gap-3 text-sm leading-normal', className)}
    >
      <span className="bg-background text-muted-foreground flex size-4 flex-none items-center justify-center">
        {running ? <Loading className="size-3.5" /> : <Glyph className="size-4" aria-hidden />}
      </span>
      <span className="flex-none">{verb}</span>
      <span className="text-muted-foreground min-w-0 truncate font-mono">{object}</span>
      {result ? (
        <span className="text-muted-foreground ml-auto flex-none text-xs">{result}</span>
      ) : null}
    </li>
  );
}
