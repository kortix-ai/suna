'use client';

/**
 * Mechanism diagrams for the security walkthrough.
 *
 * These are drawn rather than screenshotted for three reasons: they theme
 * correctly, they stay sharp at any projection size, and — the reason they
 * exist at all — they can be *built*. Each diagram takes the deck's current
 * build step and lights up one more part of the machine, so the picture is
 * assembled while it is explained instead of landing all at once.
 *
 * ── The layout rule ──────────────────────────────────────────────────────
 * Nothing mounts or unmounts on a build step. Every node is in the DOM from
 * the first frame and starts *ghosted* (`GHOST` opacity); a step raises it to
 * full. If parts appeared instead, every press would reflow the diagram and
 * the viewer would lose the thread. The one exception is a travelling packet,
 * which is genuinely transient and mounts for its step only.
 *
 * ── Accuracy ────────────────────────────────────────────────────────────
 * Every label here traces to `features/marketing/security-page/content.ts` or
 * `features/marketing/connectors/content.ts`. In particular the broker diagram
 * shows the credential resolved on the Kortix side of the wall and never drawn
 * inside the sandbox, which is the one claim this deck rests on.
 */

import { cn } from '@/lib/utils';
import { AnimatePresence, m } from 'motion/react';
import { Fragment, type ReactNode } from 'react';

/* ── primitives ─────────────────────────────────────────────────────────── */

/** Opacity of a part that has not been reached by a build step yet. */
const GHOST = 0.12;
/** Connector rails stay readable at rest — see `Link`. */
const RAIL_IDLE = 0.45;
const EASE = [0.16, 1, 0.3, 1] as const;

type Tone = 'idle' | 'active' | 'ok' | 'warn' | 'danger';

const TONE_RING: Record<Tone, string> = {
  idle: 'border-border',
  active: 'border-foreground/40',
  ok: 'border-kortix-green/50',
  warn: 'border-kortix-orange/50',
  danger: 'border-kortix-red/50',
};

const TONE_TEXT: Record<Tone, string> = {
  idle: 'text-muted-foreground',
  active: 'text-foreground',
  ok: 'text-kortix-green',
  warn: 'text-kortix-orange',
  danger: 'text-kortix-red',
};

/** A build-aware wrapper: ghosted until `on`, then lit. Never changes layout. */
function Reveal({
  on,
  children,
  className,
  delay = 0,
}: {
  on: boolean;
  children: ReactNode;
  className?: string;
  delay?: number;
}) {
  return (
    <m.div
      animate={{ opacity: on ? 1 : GHOST, filter: on ? 'blur(0px)' : 'blur(1.5px)' }}
      transition={{ duration: 0.45, delay: on ? delay : 0, ease: EASE }}
      className={className}
    >
      {children}
    </m.div>
  );
}

/** The frame every diagram sits in — the marketing card, with a caption rail. */
export function Stage({
  children,
  caption,
  className,
}: {
  children: ReactNode;
  caption?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('border-border bg-card overflow-hidden rounded-sm border', className)}>
      <div className="p-5 sm:p-8">{children}</div>
      {caption ? (
        <p className="border-border text-muted-foreground min-h-[3.25rem] border-t px-5 py-4 text-sm leading-relaxed sm:px-8">
          {caption}
        </p>
      ) : null}
    </div>
  );
}

/** A node in the machine. */
export function Box({
  label,
  title,
  mono,
  tone = 'idle',
  dashed,
  on = true,
  children,
  className,
}: {
  label?: string;
  title?: ReactNode;
  mono?: ReactNode;
  tone?: Tone;
  dashed?: boolean;
  on?: boolean;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <Reveal on={on} className={cn('flex-1', className)}>
      <div
        className={cn(
          'bg-background flex h-full flex-col rounded-sm border p-4 transition-colors duration-300',
          dashed && 'border-dashed',
          TONE_RING[tone],
        )}
      >
        {label ? (
          <p className="text-muted-foreground/70 font-mono text-[10px] tracking-widest uppercase">
            {label}
          </p>
        ) : null}
        {title ? (
          <p className={cn('mt-2 text-sm leading-tight font-medium', TONE_TEXT[tone])}>{title}</p>
        ) : null}
        {mono ? (
          <p className="text-muted-foreground mt-2 font-mono text-[11px] break-all">{mono}</p>
        ) : null}
        {children}
      </div>
    </Reveal>
  );
}

/** A mono chip — a key, a token, a verdict. */
export function Chip({
  children,
  tone = 'idle',
  on = true,
  strike,
}: {
  children: ReactNode;
  tone?: Tone;
  on?: boolean;
  strike?: boolean;
}) {
  return (
    <m.span
      animate={{ opacity: on ? 1 : GHOST }}
      transition={{ duration: 0.4, ease: EASE }}
      className={cn(
        'inline-flex w-fit items-center gap-1.5 rounded-sm border px-2 py-1 font-mono text-[11px] transition-colors duration-300',
        TONE_RING[tone],
        TONE_TEXT[tone],
        strike && 'line-through opacity-60',
      )}
    >
      {children}
    </m.span>
  );
}

/**
 * A connector between two nodes. `on` lights the rail; `fire` sends one packet
 * along it, which is the thing that makes a call feel like it moves.
 */
export function Link({
  on = true,
  fire,
  label,
  back,
  className,
}: {
  on?: boolean;
  fire?: boolean;
  label?: ReactNode;
  /** Draw the arrowhead on the left — a response coming back. */
  back?: boolean;
  className?: string;
}) {
  return (
    <div className={cn('relative flex min-w-10 flex-col justify-center px-2 sm:px-3', className)}>
      {label ? (
        <m.span
          animate={{ opacity: on ? 1 : 0 }}
          transition={{ duration: 0.4, ease: EASE }}
          className="text-muted-foreground/80 mb-2 text-center font-mono text-[10px] leading-tight tracking-wider whitespace-nowrap"
        >
          {label}
        </m.span>
      ) : null}
      {/* The rail is the machine's wiring, so it never fully fades — what a
          step changes is whether traffic is flowing on it, not whether the
          wire exists. RAIL_IDLE keeps the shape of the system readable. */}
      <div className="relative flex h-3 items-center">
        <m.span
          animate={{ opacity: on ? 1 : RAIL_IDLE }}
          transition={{ duration: 0.4, ease: EASE }}
          className="bg-border h-px flex-1"
        />
        <m.svg
          animate={{ opacity: on ? 1 : RAIL_IDLE }}
          transition={{ duration: 0.4, ease: EASE }}
          viewBox="0 0 6 8"
          className={cn('text-border h-2 w-1.5 shrink-0', back && 'order-first rotate-180')}
          aria-hidden
        >
          <path d="M0 0 L6 4 L0 8 Z" fill="currentColor" />
        </m.svg>

        <AnimatePresence>
          {fire ? (
            <m.span
              initial={{ left: back ? '100%' : '0%', opacity: 0 }}
              animate={{ left: back ? '0%' : '100%', opacity: [0, 1, 1, 0] }}
              exit={{ opacity: 0 }}
              transition={{ duration: 1.1, ease: 'easeInOut', repeat: Infinity, repeatDelay: 0.35 }}
              className="bg-foreground absolute top-1/2 size-1.5 -translate-y-1/2 rounded-full"
            />
          ) : null}
        </AnimatePresence>
      </div>
    </div>
  );
}

/** The trust boundary — a dashed vertical rule with the wall named on it. */
export function Wall({ label = 'trust boundary', on = true }: { label?: string; on?: boolean }) {
  return (
    <Reveal on={on} className="relative flex w-14 shrink-0 items-center justify-center sm:w-20">
      <span aria-hidden className="border-border absolute inset-y-0 left-1/2 border-l border-dashed" />
      <span className="border-border bg-card text-muted-foreground relative rounded-sm border px-2 py-1 text-center font-mono text-[9px] leading-tight tracking-widest uppercase">
        {label}
      </span>
    </Reveal>
  );
}

/** A horizontal row of nodes and connectors. */
export function Row({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('flex items-stretch', className)}>{children}</div>;
}

/* ── 1 · isolation ──────────────────────────────────────────────────────────
   Steps: 0 repo · 1 session A · 2 session B + the wall · 3 destroyed + the one
   way back. Grounded in isolation.rows: one sandbox per session (a UNIQUE
   constraint, not a convention), one branch per session, disposable. */

export function IsolationDiagram({ step }: { step: number }) {
  const captions = [
    'A project is a repo. main is the only thing everyone shares.',
    'Starting a session cuts a branch and boots one machine for it. The database will not let a second session have that machine.',
    'A second session gets its own branch and its own machine. Nothing crosses between them — same project, same team, or another customer.',
    'The machine is disposable. A bad install goes away with it. Only what the session commits survives, and it survives as a change request.',
  ];

  return (
    <Stage caption={captions[Math.min(step, captions.length - 1)]}>
      <Row className="gap-0">
        <Box
          label="project"
          title="The repo"
          mono="main"
          tone={step >= 3 ? 'active' : 'idle'}
          className="max-w-[13rem]"
        >
          <div className="mt-3 flex flex-col gap-1.5">
            <Chip on tone="idle">agents · skills</Chip>
            <Chip on tone="idle">policies</Chip>
          </div>
        </Box>

        <Link on={step >= 1} label="cut a branch" fire={step === 1} />

        <div className="flex flex-1 flex-col gap-3">
          <Box
            label="session 9f4c2b7e"
            title="Its own machine"
            tone={step >= 3 ? 'danger' : step >= 1 ? 'active' : 'idle'}
            dashed
            on={step >= 1}
          >
            <div className="mt-3 flex flex-wrap gap-1.5">
              <Chip on={step >= 1}>branch/9f4c2b7e</Chip>
              <Chip on={step >= 1}>own filesystem</Chip>
              <Chip on={step >= 3} tone="danger">
                destroyed
              </Chip>
            </div>
          </Box>

          {/* the wall between two sessions of the same project */}
          <Reveal on={step >= 2} className="relative flex items-center justify-center py-1">
            <span aria-hidden className="border-border absolute inset-x-0 top-1/2 border-t border-dashed" />
            <span className="border-border bg-card text-muted-foreground relative rounded-sm border px-2.5 py-1 font-mono text-[10px] tracking-widest uppercase">
              no path between sessions
            </span>
          </Reveal>

          <Box
            label="session 36cd42b7"
            title="Its own machine"
            tone={step >= 2 ? 'active' : 'idle'}
            dashed
            on={step >= 2}
          >
            <div className="mt-3 flex flex-wrap gap-1.5">
              <Chip on={step >= 2}>branch/36cd42b7</Chip>
              <Chip on={step >= 2}>own filesystem</Chip>
            </div>
          </Box>
        </div>
      </Row>

      {/* the only way anything gets back */}
      <Reveal on={step >= 3} className="mt-5">
        <div className="border-border bg-background flex flex-wrap items-center gap-3 rounded-sm border border-dashed p-4">
          <span className="text-muted-foreground font-mono text-[10px] tracking-widest uppercase">
            the only way back
          </span>
          <Chip tone="active">commit</Chip>
          <Link on className="w-10 min-w-0" />
          <Chip tone="active">change request</Chip>
          <Link on className="w-10 min-w-0" />
          <Chip tone="ok">main</Chip>
        </div>
      </Reveal>
    </Stage>
  );
}

/* ── 2 · the credential broker ──────────────────────────────────────────────
   The centrepiece. Steps: 0 the shape · 1 the agent asks · 2 Kortix resolves ·
   3 the API answers · 4 what never crossed. Grounded in connectors/content.ts
   `broker`: the sandbox carries one KORTIX_CLI_TOKEN and zero third-party
   secrets; the credential is attached server-side at call time. */

export function BrokerDiagram({ step }: { step: number }) {
  const captions = [
    'A sandbox is a real Linux machine the model can run anything on. So the only credential in it is one Kortix token, scoped to the project.',
    'The agent calls a tool by name. It has no URL, no host and no key — it cannot construct the request itself.',
    'Kortix checks that this agent may use this connector, applies the policy, and decrypts the credential on its own side of the wall.',
    'The third-party API sees an ordinary authenticated request. The answer goes back to the agent. The credential stays behind.',
    'These four never cross into the machine the model is driving. Turning the connector off takes effect on the next call — with nothing in the sandbox to rotate.',
  ];

  return (
    <Stage caption={captions[Math.min(step, captions.length - 1)]}>
      <Row className="gap-0">
        <Box
          label="the sandbox"
          title="Agent"
          tone={step === 1 ? 'active' : 'idle'}
          dashed
          className="max-w-[15rem]"
        >
          <div className="mt-3 flex flex-col gap-1.5">
            <Chip tone={step >= 1 ? 'active' : 'idle'}>KORTIX_CLI_TOKEN</Chip>
            <span className="text-muted-foreground/70 text-[11px] leading-snug">
              …and no third-party secret at all
            </span>
          </div>
        </Box>

        <Link
          on={step >= 1}
          fire={step === 1}
          label={<>connector.call(&quot;gmail&quot;,&nbsp;&quot;send_email&quot;)</>}
        />

        <Wall label="sandbox boundary" />

        <Box
          label="kortix"
          title="Connector gateway"
          tone={step === 2 ? 'active' : 'idle'}
          className="max-w-[16rem]"
        >
          <div className="mt-3 flex flex-col gap-1.5">
            <Chip on={step >= 2} tone={step >= 2 ? 'ok' : 'idle'}>
              may this agent? ✓
            </Chip>
            <Chip on={step >= 2} tone={step >= 2 ? 'ok' : 'idle'}>
              policy resolved
            </Chip>
            <Chip on={step >= 2} tone={step >= 2 ? 'warn' : 'idle'}>
              decrypt credential
            </Chip>
          </div>
        </Box>

        <div className="flex flex-col justify-center">
          <Link
            on={step >= 3}
            fire={step === 3}
            label={<>Authorization: Bearer ••••</>}
          />
          <Link on={step >= 3} back label="response" className="mt-1" />
        </div>

        <Box
          label="third party"
          title="The API"
          mono="api.gmail.com"
          tone={step >= 3 ? 'active' : 'idle'}
          className="max-w-[12rem]"
        />
      </Row>

      {/* what the wall actually stops */}
      <Reveal on={step >= 4} className="mt-5">
        <div className="border-border bg-background flex flex-wrap items-center gap-x-3 gap-y-2 rounded-sm border p-4">
          <span className="text-muted-foreground font-mono text-[10px] tracking-widest uppercase">
            never crosses into the sandbox
          </span>
          {['API keys', 'OAuth access tokens', 'Refresh tokens', 'Client secrets'].map((k) => (
            <Chip key={k} on={step >= 4} tone="danger" strike>
              {k}
            </Chip>
          ))}
        </div>
      </Reveal>
    </Stage>
  );
}

/* ── 3 · the approval gate ──────────────────────────────────────────────────
   The beat people do not expect: the gate HOLDS the call, it does not fail it.
   Steps: 0 running · 1 held with its arguments · 2 the person answers · 3 the
   same call completes and the turn resumes. */

export function GateDiagram({ step }: { step: number }) {
  const captions = [
    'The agent is mid-task. It drafts the reply and reaches a call the policy gates.',
    'The call is held open — not failed. You see the action and the arguments it was about to use.',
    'You answer once, for this call, with these arguments. There is no session-wide grant a later call can hide behind.',
    'The same held call completes and the turn picks up where it stopped. A gate that errors out would just teach an agent to retry around it.',
  ];

  const states = [
    { k: 'running', v: 'drafting the reply', tone: 'active' as Tone },
    { k: 'waiting', v: 'held at send_email', tone: 'warn' as Tone },
    { k: 'approved', v: 'released by a person', tone: 'ok' as Tone },
    { k: 'running', v: 'turn resumes', tone: 'active' as Tone },
  ];

  return (
    <Stage caption={captions[Math.min(step, captions.length - 1)]}>
      <Row className="gap-0">
        {states.map((s, i) => (
          <Fragment key={s.k + i}>
            {i > 0 ? <Link on={step >= i} fire={step === i} /> : null}
            <Box
              label={`0${i}`}
              title={s.k}
              mono={s.v}
              tone={step >= i ? s.tone : 'idle'}
              on={step >= i}
            />
          </Fragment>
        ))}
      </Row>

      {/* the card the human actually sees */}
      <Reveal on={step >= 1} className="mt-5">
        <div
          className={cn(
            'border-border bg-background rounded-sm border p-5 transition-colors duration-300',
            step === 1 && 'border-kortix-orange/50',
            step >= 2 && 'border-kortix-green/50',
          )}
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="text-muted-foreground font-mono text-[10px] tracking-widest uppercase">
              approval requested
            </span>
            <Chip on={step >= 2} tone={step >= 2 ? 'ok' : 'idle'}>
              approved · marko
            </Chip>
          </div>
          <p className="text-foreground mt-4 font-mono text-sm">gmail.send_email</p>
          <div className="mt-3 flex flex-wrap gap-1.5">
            <Chip tone="idle">to: dana@northwind.com</Chip>
            <Chip tone="idle">subject: Q3 launch note</Chip>
          </div>
          <p className="text-muted-foreground mt-4 text-[13px] leading-relaxed">
            The rule matched the arguments, not just the tool name. A recipient outside the allowed
            domain is what held this call — “may the agent send email” was never the question.
          </p>
        </div>
      </Reveal>
    </Stage>
  );
}

/* ── 4 · how work lands ─────────────────────────────────────────────────────
   The git graph. Steps: 0 main · 1 the session's branch · 2 the change request
   · 3 a person merges — and merging is a capability of its own, refused to
   every agent unless an admin grants `project.cr.merge` (landing.steps). */

/** A commit on the graph. Declared at module scope on purpose — a component
    created inside the render would be a new type on every build step, so React
    would remount it and the animation would restart instead of continuing. */
function Dot({ on, tone = 'idle' }: { on: boolean; tone?: Tone }) {
  return (
    <m.span
      animate={{ opacity: on ? 1 : GHOST, scale: on ? 1 : 0.7 }}
      transition={{ duration: 0.4, ease: EASE }}
      className={cn(
        'size-2.5 shrink-0 rounded-full border-2 bg-current',
        tone === 'ok'
          ? 'border-kortix-green text-kortix-green'
          : 'border-foreground text-foreground',
      )}
    />
  );
}

export function ChangeRequestDiagram({ step }: { step: number }) {
  const captions = [
    'main is your live company. Everything anyone relies on is here.',
    'The session works on its own branch. Every edit it makes lands here and is invisible to main and to every other session.',
    'To keep anything, it commits and opens a change request pointed at main. That is the only door.',
    'A person reads the diff and merges. Merging is a separate capability, refused to every agent unless an admin grants it — and that grant is itself a change request someone else approves.',
  ];

  return (
    <Stage caption={captions[Math.min(step, captions.length - 1)]}>
      <div className="flex flex-col gap-8 py-2">
        {/* main */}
        <div className="flex items-center gap-3">
          <span className="text-muted-foreground w-24 shrink-0 font-mono text-[11px] tracking-widest uppercase">
            main
          </span>
          <div className="flex flex-1 items-center gap-3">
            <Dot on />
            <span className="bg-border h-px flex-1" />
            <Dot on />
            <span className="bg-border h-px flex-1" />
            <Dot on={step >= 3} tone="ok" />
            <Chip on={step >= 3} tone="ok">
              merged
            </Chip>
          </div>
        </div>

        {/* the session's branch, hanging off main */}
        <div className="flex items-center gap-3">
          <span className="text-muted-foreground w-24 shrink-0 font-mono text-[11px] tracking-widest uppercase">
            session
          </span>
          <div className="flex flex-1 items-center gap-3">
            <Reveal on={step >= 1} className="flex flex-1 items-center gap-3">
              <span className="text-muted-foreground/50 font-mono text-[10px]">branch/9f4c</span>
              <Dot on={step >= 1} />
              <span className="bg-border h-px flex-1" />
              <Dot on={step >= 1} />
              <span className="bg-border h-px flex-1" />
              <Dot on={step >= 1} />
            </Reveal>
            <Reveal on={step >= 2}>
              <div className="border-border bg-background rounded-sm border p-3">
                <p className="text-muted-foreground font-mono text-[10px] tracking-widest uppercase">
                  change request
                </p>
                <p className="text-foreground mt-1.5 font-mono text-xs">launch-note.md +64 −0</p>
              </div>
            </Reveal>
          </div>
        </div>

        {/* who is allowed to close the loop */}
        <Reveal on={step >= 3}>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="border-kortix-green/50 bg-background rounded-sm border p-4">
              <p className="text-muted-foreground font-mono text-[10px] tracking-widest uppercase">
                a person with project.gitops.merge
              </p>
              <p className="text-kortix-green mt-2 text-sm font-medium">may merge</p>
            </div>
            <div className="border-kortix-red/50 bg-background rounded-sm border p-4">
              <p className="text-muted-foreground font-mono text-[10px] tracking-widest uppercase">
                every agent, by default
              </p>
              <p className="text-kortix-red mt-2 text-sm font-medium">
                may not merge — project.cr.merge is default-deny
              </p>
            </div>
          </div>
        </Reveal>
      </div>
    </Stage>
  );
}

/* ── 5 · principals ─────────────────────────────────────────────────────────
   Why an agent is not a loophole. Steps: 0 the person's path · 1 the service
   account's own path · 2 the inheritance that does not exist · 3 the
   intersection a session actually gets (identity.agents, credentials.rows[1]). */

export function PrincipalDiagram({ step }: { step: number }) {
  const captions = [
    'A person acts through the roles they were granted, evaluated against the resource they are reaching for.',
    'A service account is a principal of its own. Policies attach to it directly, and its request is evaluated purely against those policies.',
    'What it never gets is the reach of whoever created it. There is no inheritance edge here to walk up.',
    'So what a session can actually touch is the intersection: what the person may do, and what the agent was declared to be allowed. Never the union.',
  ];

  return (
    <Stage caption={captions[Math.min(step, captions.length - 1)]}>
      <div className="flex flex-col gap-3">
        <Row className="gap-0">
          <Box label="principal" title="Person" mono="marko@kortix.com" tone="active" className="max-w-[13rem]" />
          <Link on label="evaluated against" fire={step === 0} />
          <Box label="policies" title="Their roles" tone={step >= 0 ? 'active' : 'idle'} className="max-w-[13rem]">
            <div className="mt-3 flex flex-wrap gap-1.5">
              <Chip>owner</Chip>
              <Chip>editor</Chip>
            </div>
          </Box>
          <Link on label="on a resource" />
          <Box label="resource" title="project · sandbox · trigger" tone="idle" className="max-w-[13rem]" />
        </Row>

        {/* the edge that does not exist */}
        <Reveal on={step >= 2} className="relative flex items-center justify-center py-1">
          <span aria-hidden className="border-kortix-red/40 absolute inset-x-0 top-1/2 border-t border-dashed" />
          <span className="border-kortix-red/50 bg-card text-kortix-red relative rounded-sm border px-2.5 py-1 font-mono text-[10px] tracking-widest uppercase line-through">
            inherits the person’s reach
          </span>
        </Reveal>

        <Row className="gap-0">
          <Box
            label="principal"
            title="Service account"
            mono="agent · support"
            tone={step >= 1 ? 'active' : 'idle'}
            on={step >= 1}
            className="max-w-[13rem]"
          />
          <Link on={step >= 1} label="evaluated against" fire={step === 1} />
          <Box
            label="policies"
            title="Its own policies"
            tone={step >= 1 ? 'active' : 'idle'}
            on={step >= 1}
            className="max-w-[13rem]"
          >
            <div className="mt-3 flex flex-wrap gap-1.5">
              <Chip on={step >= 1}>connectors: zendesk, gmail</Chip>
            </div>
          </Box>
          <Link on={step >= 1} label="on a resource" />
          <Box
            label="resource"
            title="project · sandbox · trigger"
            tone="idle"
            on={step >= 1}
            className="max-w-[13rem]"
          />
        </Row>
      </div>

      <Reveal on={step >= 3} className="mt-5">
        <div className="border-border bg-background flex flex-wrap items-center gap-3 rounded-sm border p-4">
          <span className="text-muted-foreground font-mono text-[10px] tracking-widest uppercase">
            what the session gets
          </span>
          <Chip tone="active">the person’s role</Chip>
          <span className="text-muted-foreground font-mono text-sm">∩</span>
          <Chip tone="active">the agent’s declared grant</Chip>
        </div>
      </Reveal>
    </Stage>
  );
}

/* ── 6 · the record ─────────────────────────────────────────────────────────
   The ledger writes itself as the earlier diagrams run: the gateway that
   resolves the credential is the same thing that writes the row, so there is
   no path to a connected tool that skips it (connectors/content.ts `audit`).
   Arguments are stored as a preview built by subtraction — never a raw value. */

const LEDGER = [
  { action: 'gmail.send_email', actor: 'agent · support', risk: 'write', outcome: 'approved', tone: 'ok' as Tone },
  { action: 'drive.trash_file', actor: 'agent · support', risk: 'destructive', outcome: 'blocked', tone: 'danger' as Tone },
  { action: 'iam.role.grant', actor: 'marko@kortix.com', risk: 'admin', outcome: 'ran', tone: 'active' as Tone },
  { action: 'cr.merge', actor: 'marko@kortix.com', risk: 'write', outcome: 'ran', tone: 'active' as Tone },
];

export function LedgerDiagram({ step }: { step: number }) {
  const captions = [
    'Every call an agent makes through a connector is a row. The gateway that resolves the credential is the thing that writes it.',
    'A denied call is a row too. What did not happen is as much a part of the record as what did.',
    'Account actions land in the same place — membership, roles, policies, tokens, groups.',
    'Recording is never the thing you pay for. Every plan writes this. The plan decides who may read, export, or stream it.',
  ];

  return (
    <Stage caption={captions[Math.min(step, captions.length - 1)]}>
      <div className="border-border overflow-hidden rounded-sm border">
        <div className="border-border text-muted-foreground grid grid-cols-12 gap-3 border-b px-4 py-2.5 font-mono text-[10px] tracking-widest uppercase">
          <span className="col-span-4">action</span>
          <span className="col-span-4">acted by</span>
          <span className="col-span-2">risk</span>
          <span className="col-span-2">outcome</span>
        </div>
        {LEDGER.map((r, i) => (
          <Reveal
            key={r.action}
            on={step >= i}
            delay={0.05}
            className={cn('border-border', i > 0 && 'border-t')}
          >
            <div className="grid grid-cols-12 items-center gap-3 px-4 py-3">
              <span className="text-foreground col-span-4 truncate font-mono text-xs">
                {r.action}
              </span>
              <span className="text-muted-foreground col-span-4 truncate text-xs">{r.actor}</span>
              <span className="text-muted-foreground col-span-2 font-mono text-[11px]">
                {r.risk}
              </span>
              <span className={cn('col-span-2 font-mono text-[11px]', TONE_TEXT[r.tone])}>
                {r.outcome}
              </span>
            </div>
          </Reveal>
        ))}
      </div>

      <Reveal on={step >= 3} className="mt-4">
        <div className="border-border bg-background flex flex-wrap items-center gap-3 rounded-sm border p-4">
          <span className="text-muted-foreground font-mono text-[10px] tracking-widest uppercase">
            arguments
          </span>
          <Chip tone="idle">preview built by subtraction</Chip>
          <Chip tone="danger" strike>
            the raw value
          </Chip>
          <span className="text-muted-foreground text-[13px]">
            so a credential cannot end up in the record.
          </span>
        </div>
      </Reveal>
    </Stage>
  );
}
