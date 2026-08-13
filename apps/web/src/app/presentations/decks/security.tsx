'use client';

/**
 * The security walkthrough — a diagram-led, build-by-build companion to
 * `/security`, made to be screen recorded.
 *
 * Most slides are a machine being drawn: `steps` says how many times → adds a
 * stage, and the diagram takes that step and lights up one more part. The
 * spoken script is an array indexed by the same step, so `N` always shows the
 * line for what is currently on screen.
 *
 * ── SOURCE OF TRUTH ──────────────────────────────────────────────────────
 * Copy comes from the pages' own accuracy-gated content modules rather than
 * being retyped:
 *   features/marketing/security-page/content.ts   (isolation, credentials,
 *                                                  identity, control, landing,
 *                                                  audit, posture)
 *   features/marketing/connectors/content.ts      (the broker before/after)
 * Those headers list every claim checked against shipped code, and the
 * corrections that must not be "restored". Read them before editing a line.
 *
 * ── FOUR CORRECTIONS TO THE SPOKEN DRAFT ─────────────────────────────────
 * The narration this deck was written from said four things the code does not
 * support. They are fixed here and must stay fixed:
 *  1. "a disposable microVM" — not true of the default provider. microVM is
 *     accurate for Platinum (Cloud Hypervisor) only.
 *  2. "the credential is scoped to a person or a group" — that model was
 *     retired (20260706_secrets_v2_identifier_model.sql). Scoping is per
 *     project, per agent grant, and connector-scoped.
 *  3. "the key never sits in the sandbox" — true of CONNECTOR credentials,
 *     false of a granted runtime secret. The honesty slide says so out loud.
 *  4. "I approve it, only now does it reach main" — merge is default-deny for
 *     agents, not human-only.
 */

import { Badge } from '@/components/ui/badge';
import { KortixAsterisk } from '@/components/ui/kortix-asterisk';
import { broker } from '@/features/marketing/connectors/content';
import { CodePanel } from '@/features/marketing/security-page/code-panel';
import {
  audit,
  control,
  credentials,
  hero,
  identity,
  isolation,
  landing,
  posture,
} from '@/features/marketing/security-page/content';
import { cn } from '@/lib/utils';
import type { ReactNode } from 'react';
import type { SlideDef } from '../engine/deck';
import {
  BrokerDiagram,
  ChangeRequestDiagram,
  GateDiagram,
  IsolationDiagram,
  LedgerDiagram,
  PrincipalDiagram,
} from '../engine/diagram';
import {
  Dim,
  Eyebrow,
  MiniCard,
  Mono,
  Panel,
  Rise,
  RowList,
  SectionHead,
  Shot,
  Slide,
  SpecStrip,
} from '../engine/parts';

/* ── local bits ─────────────────────────────────────────────────────────── */

/** The eyebrow every numbered chapter carries: `01 — Isolation`. */
function Chapter({ n, children }: { n: string; children: ReactNode }) {
  return (
    <span className="flex items-center gap-2.5">
      <span className="text-muted-foreground/45 font-mono tabular-nums">{n}</span>
      <span className="bg-border h-px w-6" aria-hidden />
      <span>{children}</span>
    </span>
  );
}

/**
 * A diagram slide: a tight header that never moves, and the machine below it.
 * The header is deliberately short — on a build slide the words that change are
 * the diagram's own caption, not the title.
 */
function DiagramSlide({
  eyebrow,
  title,
  children,
}: {
  eyebrow: ReactNode;
  title: ReactNode;
  children: ReactNode;
}) {
  return (
    <Slide innerClassName="py-14 sm:py-16">
      <Rise i={0}>
        <SectionHead eyebrow={eyebrow} title={title} className="max-w-3xl" />
      </Rise>
      <Rise i={1}>
        <div className="mt-8">{children}</div>
      </Rise>
    </Slide>
  );
}

/** One side of the before/after: a mono env block with a verdict under it. */
function EnvPanel({
  label,
  title,
  lines,
  body,
  tone,
  on,
}: {
  label: string;
  title: string;
  lines: readonly string[];
  body: string;
  tone: 'before' | 'after';
  on: boolean;
}) {
  return (
    <Panel
      className={cn(
        'flex h-full flex-col p-6 transition-opacity duration-500 sm:p-7',
        on ? 'opacity-100' : 'opacity-15',
      )}
    >
      <p className="text-muted-foreground font-mono text-[10px] tracking-widest uppercase">
        {label}
      </p>
      <h3 className="text-foreground mt-3 text-lg leading-tight font-medium">{title}</h3>
      <div className="border-border bg-background mt-5 flex flex-col gap-1.5 rounded-sm border p-4 font-mono text-[13px]">
        {lines.map((line) => (
          <span
            key={line}
            className={cn(
              'truncate',
              tone === 'before' ? 'text-muted-foreground/70 line-through' : 'text-foreground',
            )}
          >
            {line}
          </span>
        ))}
      </div>
      <p className="text-muted-foreground mt-5 text-sm leading-relaxed">{body}</p>
    </Panel>
  );
}

/* ── the deck ───────────────────────────────────────────────────────────── */

export function useSlides(): SlideDef[] {
  return [
    /* 01 ─ the question ─────────────────────────────────────────────────── */
    {
      id: 'title',
      label: 'Security',
      steps: 1,
      notes: [
        'If you are going to run a hundred agents inside your company, only one question really matters: what happens when one of them goes wrong?\n\nLet me show you exactly what Kortix does about that.',
        'An agent that can install anything, call anything and write anywhere is only safe if the walls are real. In Kortix those walls sit below the agent, in the platform, where a prompt cannot talk its way past them.\n\nFour facts, and the rest of this walkthrough is me proving each one on a diagram.',
      ],
      node: (step) => (
        <Slide>
          <Rise i={0}>
            <Badge variant="kortix" className="rounded">
              {hero.eyebrow}
            </Badge>
          </Rise>
          <Rise i={1}>
            <h1 className="text-foreground mt-6 max-w-4xl text-4xl font-medium tracking-tight text-balance sm:text-5xl lg:text-6xl">
              {hero.title}
            </h1>
          </Rise>
          <Rise i={2}>
            <p className="text-muted-foreground mt-6 max-w-2xl text-lg leading-relaxed">
              {hero.sub}
            </p>
          </Rise>
          <div
            className={cn(
              'transition-opacity duration-500',
              step >= 1 ? 'opacity-100' : 'opacity-0',
            )}
          >
            <SpecStrip specs={hero.specs} className="mt-12" />
          </div>
        </Slide>
      ),
    },

    /* 02 ─ the four answers ─────────────────────────────────────────────── */
    {
      id: 'answers',
      label: 'The four answers',
      steps: 3,
      notes: [
        'Four things, and I will draw each one.\n\nOne: isolation, so a mistake cannot spread.',
        'Two: credentials the agent is never handed.',
        'Three: a person in front of anything that lands.',
        'Four: a record of every action, human or agent.\n\nThat is the whole model. Everything after this is the mechanism.',
      ],
      node: (step) => (
        <Slide>
          <Rise i={0}>
            <SectionHead
              eyebrow="The model"
              title={
                <>
                  Four walls, and <Dim>none of them are the prompt.</Dim>
                </>
              }
              lead="Guardrails written into an agent's instructions are advice. These four sit in the platform underneath it, so they hold whatever the model decides to try."
            />
          </Rise>
          <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {[
              {
                n: '01',
                title: 'Isolation',
                body: 'One session, one machine of its own, one branch. A bad run costs you a sandbox you were going to throw away.',
              },
              {
                n: '02',
                title: 'Credentials',
                body: 'Connector keys are resolved on our side of the wall. The machine the model drives never holds them.',
              },
              {
                n: '03',
                title: 'A human gate',
                body: 'Work lands on main through a change request. Merging is a separate power, refused by default.',
              },
              {
                n: '04',
                title: 'The record',
                body: 'Every account action and every gated tool call is written down, on every plan.',
              },
            ].map((card, i) => (
              <div
                key={card.n}
                className={cn(
                  'transition-opacity duration-500',
                  step >= i ? 'opacity-100' : 'opacity-15',
                )}
              >
                <MiniCard label={card.n} title={card.title} body={card.body} className="h-full" />
              </div>
            ))}
          </div>
        </Slide>
      ),
    },

    /* 03 ─ isolation, drawn ─────────────────────────────────────────────── */
    {
      id: 'isolation',
      label: '01 · Isolation',
      steps: 3,
      notes: [
        'One. Isolation.\n\nStart with what a project is: a repo. main is the thing everyone in the company actually relies on.',
        'I start a session. Kortix cuts a branch named after it and boots one machine for it. That one-machine-per-session rule is a unique constraint in the database — not a convention two services agree to honour.\n\nThe agent in there can install packages, run code, break things, do whatever it needs.',
        'Someone else starts a second session. Own branch, own machine. Nothing crosses between them.\n\nAnd this is the part worth sitting on: separating two of your own sessions is the same mechanism as separating two different customers. There is no weaker internal wall.',
        'The machine is not precious. A bad install or a wiped directory goes away with it, and the box is destroyed at the end anyway.\n\nOnly what the session commits survives — and it survives as a change request. That is the only way anything gets back to main.',
      ],
      node: (step) => (
        <DiagramSlide
          eyebrow={<Chapter n="01">{isolation.eyebrow}</Chapter>}
          title={isolation.title}
        >
          <IsolationDiagram step={step} />
        </DiagramSlide>
      ),
    },

    /* 04 ─ isolation, the reviewer's four claims ────────────────────────── */
    {
      id: 'isolation-rows',
      label: '01 · Isolation',
      steps: 3,
      notes: [
        'The same four claims, the way I would state them to a reviewer. One sandbox per session, enforced in the database.',
        'And a wording note, because we get asked. On our own Platinum compute a sandbox is a Cloud Hypervisor microVM. Daytona and E2B are also supported. The provider is a deployment choice, and we will tell you which one you are on rather than blur them together.',
        'One branch per session. Every edit and commit that session makes lives there and nowhere else.',
        'And disposable by design. The machine is not something you have to clean up, because it does not survive.',
      ],
      node: (step) => (
        <Slide innerClassName="py-14 sm:py-16">
          <Rise i={0}>
            <SectionHead
              eyebrow={<Chapter n="01">{isolation.eyebrow}</Chapter>}
              title="Enforced in the database, not by convention."
              className="max-w-3xl"
            />
          </Rise>
          <Rise i={1}>
            <RowList rows={isolation.rows} upTo={step} className="mt-8" />
          </Rise>
        </Slide>
      ),
    },

    /* 05 ─ the credential broker, drawn ─────────────────────────────────── */
    {
      id: 'broker',
      label: '02 · Credentials',
      steps: 4,
      notes: [
        'Two. Secrets the agent is never handed.\n\nA tool needs a real credential to do real work, so the honest question is not whether a machine ever holds one. It is which machine holds which key.\n\nStart with the sandbox. A sandbox is a real Linux machine the model can run anything on — so the only credential in it is one Kortix token, scoped to the project.',
        'The agent wants to send an email. It calls a tool by name: connector, action, arguments. That is all it has. No URL, no host, no key — it cannot construct the request itself even if it wanted to.',
        'The call crosses to our side. Kortix checks that this agent may use this connector, resolves the policy, and decrypts the credential here — server-side, outside the machine the model is driving.',
        'It attaches the credential to the outbound request. The third-party API sees a completely ordinary authenticated call. The answer comes back to the agent. The credential stays behind.',
        'So watch what never crossed the line. API keys, OAuth access tokens, refresh tokens, client secrets. None of them were ever in the box.\n\nWhich also means turning a connector off takes effect on the next call, and there is nothing in the sandbox to rotate — because nothing in the sandbox was ever a secret of yours.',
      ],
      node: (step) => (
        <DiagramSlide
          eyebrow={<Chapter n="02">{broker.eyebrow}</Chapter>}
          title={broker.title}
        >
          <BrokerDiagram step={step} />
        </DiagramSlide>
      ),
    },

    /* 06 ─ before / after ───────────────────────────────────────────────── */
    {
      id: 'broker-before-after',
      label: '02 · Credentials',
      steps: 1,
      notes: [
        'To put that next to what you are probably running today. The usual way is a drawer of keys sitting in the environment the model reads from. Revoking one means rotating it everywhere it was ever copied, and any of them can end up in a log line.',
        'The Kortix way is one scoped token and nothing else. Scoped to one project, narrowed again by what that agent is allowed to touch.',
      ],
      node: (step) => (
        <Slide innerClassName="py-14 sm:py-16">
          <Rise i={0}>
            <SectionHead
              eyebrow={<Chapter n="02">{broker.eyebrow}</Chapter>}
              title={
                <>
                  A drawer of keys, <Dim>or one scoped token.</Dim>
                </>
              }
              className="max-w-3xl"
            />
          </Rise>
          <div className="mt-8 grid gap-4 lg:grid-cols-2">
            <Rise i={1}>
              <EnvPanel
                on
                tone="before"
                label={broker.before.label}
                title={broker.before.title}
                lines={broker.before.lines}
                body={broker.before.body}
              />
            </Rise>
            <Rise i={2}>
              <EnvPanel
                on={step >= 1}
                tone="after"
                label={broker.after.label}
                title={broker.after.title}
                lines={broker.after.lines}
                body={broker.after.body}
              />
            </Rise>
          </div>
        </Slide>
      ),
    },

    /* 07 ─ the real catalogue ───────────────────────────────────────────── */
    {
      id: 'connectors-shot',
      label: '02 · Credentials',
      notes:
        'And this is the real screen. Three thousand apps in a click, plus MCP, OpenAPI, GraphQL and raw HTTP for anything of your own.\n\nEvery one of them connects the same way, and every one of them goes through the broker you just watched. There is no second path to a connected tool that skips it — which matters in a minute, because the thing that resolves the credential is also the thing that writes the audit record.',
      node: (
        <Slide innerClassName="py-14 sm:py-16">
          <Rise i={0}>
            <SectionHead
              eyebrow="Connect once"
              title={
                <>
                  Every tool your company runs on. <Dim>None of the keys.</Dim>
                </>
              }
              className="max-w-3xl"
            />
          </Rise>
          <Rise i={1}>
            <Shot
              src="/media/connectors/connector-catalogue.webp"
              alt="The Kortix connector catalogue: Notion, Google Sheets, Linear, Google Drive, Salesforce, HubSpot, GitHub, Gmail and more, each one click from connected."
              url="kortix.com — Connectors → Add app"
              className="mt-8"
              imgClassName="max-h-[52vh] object-cover object-top"
            />
          </Rise>
        </Slide>
      ),
    },

    /* 08 ─ the honest limit ─────────────────────────────────────────────── */
    {
      id: 'honesty',
      label: '02 · Credentials',
      steps: 1,
      notes: [
        'Here is the slide most vendors leave out.\n\nWhat holds: connector credentials never enter the machine. Our own upstream provider keys are structurally excluded from every sandbox. A session gets only the intersection of the person’s role and the agent’s declared grant. And the audit record stores a preview built by subtraction, so a credential cannot land in the log.',
        'And here is what we will not claim. A runtime secret you deliberately grant a session is a real environment value inside that session, readable by any command the agent runs. That is how a tool uses it.\n\nWe would rather say that than tell you it is invisible and have you disprove it in one command. The controls that actually matter are the two gates, and the fact that the machine is destroyed with it.',
      ],
      node: (step) => (
        <Slide innerClassName="py-14 sm:py-16">
          <Rise i={0}>
            <SectionHead
              eyebrow={<Chapter n="02">Honesty</Chapter>}
              title="What we will not claim."
              lead="A security review is won by the sentence a vendor volunteers, not the one they defend. So here is ours."
              className="max-w-3xl"
            />
          </Rise>
          <div className="mt-8 grid gap-4 lg:grid-cols-2">
            <Rise i={1}>
              <Panel className="flex h-full flex-col p-6 sm:p-8">
                <p className="text-muted-foreground font-mono text-[10px] tracking-widest uppercase">
                  what holds
                </p>
                <ul className="mt-6 space-y-4">
                  {[
                    'Connector credentials are resolved server-side and never enter the machine.',
                    'Kortix’s own upstream provider keys are structurally excluded from every sandbox.',
                    'A session receives only the intersection of the person’s role and the agent’s declared grant.',
                    'The record stores a preview built by subtraction, so a credential cannot land in the log.',
                  ].map((item, i) => (
                    <li key={item} className="text-foreground flex gap-3 text-sm leading-relaxed">
                      <KortixAsterisk index={i} />
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>
              </Panel>
            </Rise>
            <Rise i={2}>
              <Panel
                className={cn(
                  'flex h-full flex-col p-6 transition-opacity duration-500 sm:p-8',
                  step >= 1 ? 'opacity-100' : 'opacity-15',
                )}
              >
                <p className="text-muted-foreground font-mono text-[10px] tracking-widest uppercase">
                  {credentials.rows[3].k}
                </p>
                {/* The page's own wording, unabridged — paraphrasing the one
                    claim we deliberately refuse to make would defeat the point. */}
                <p className="text-foreground mt-6 text-lg leading-relaxed">
                  {credentials.rows[3].v}
                </p>
              </Panel>
            </Rise>
          </div>
        </Slide>
      ),
    },

    /* 09 ─ the approval gate, drawn ─────────────────────────────────────── */
    {
      id: 'gate',
      label: '03 · Control',
      steps: 3,
      notes: [
        'Three. Deciding what needs a human before it happens.\n\nThe agent is mid-task. It has drafted the reply and it reaches a call the policy gates.',
        'The call is held. Not failed — held. And you see the action with the arguments it was about to use.\n\nThat distinction is the whole design. A gate that errors out just teaches an agent to retry around it.',
        'You answer once, for this call, with these arguments. There is no session-wide "allow always" that a later call with different arguments can hide behind — that shortcut was removed at the enforcement point, not just from the UI.',
        'And the same held call completes. The agent is still mid-task, so it picks up exactly where it stopped.',
      ],
      node: (step) => (
        <DiagramSlide
          eyebrow={<Chapter n="03">{control.eyebrow}</Chapter>}
          title="An approval stops the run. It does not fail it."
        >
          <GateDiagram step={step} />
        </DiagramSlide>
      ),
    },

    /* 10 ─ the policy itself ────────────────────────────────────────────── */
    {
      id: 'policy',
      label: '03 · Control',
      steps: 1,
      notes: [
        'And the rule behind that gate is not a setting buried in an admin panel. It is a block in kortix.yaml, versioned with everything else.\n\nThree actions: always run, require approval, block. A rule matches a glob over fully-qualified tool paths, so one line covers a single call or a whole connector.',
        'The part people do not expect is the conditions. "May the agent send email" is rarely the real question. A condition matches the arguments, so the rule becomes "only to these addresses" — and an argument the rule cannot evaluate fails closed.\n\nOne thing to set deliberately: a project with no policy block keeps the permissive legacy default. Set default mode to risk and reads run while writes and destructive calls stop for a person.',
      ],
      node: (step) => (
        <Slide innerClassName="py-14 sm:py-16">
          <Rise i={0}>
            <SectionHead
              eyebrow={<Chapter n="03">{control.eyebrow}</Chapter>}
              title={control.title}
              className="max-w-3xl"
            />
          </Rise>
          <div className="mt-8 grid gap-4 lg:grid-cols-12">
            <Rise i={1} className="lg:col-span-6">
              <CodePanel title={control.yaml.title} lines={control.yaml.lines} lang="yaml" />
            </Rise>
            <div className="grid gap-4 sm:grid-cols-2 lg:col-span-6">
              {control.notes.map((note, i) => (
                <div
                  key={note.id}
                  className={cn(
                    'transition-opacity duration-500',
                    step >= 1 || i === 0 ? 'opacity-100' : 'opacity-15',
                  )}
                >
                  <Panel className="flex h-full flex-col p-5">
                    <p className="text-foreground font-mono text-[11px] tracking-widest uppercase">
                      {note.k}
                    </p>
                    <p className="text-muted-foreground mt-3 text-sm leading-relaxed">{note.v}</p>
                  </Panel>
                </div>
              ))}
            </div>
          </div>
        </Slide>
      ),
    },

    /* 11 ─ the real permissions screen ──────────────────────────────────── */
    {
      id: 'permissions-shot',
      label: '03 · Control',
      notes:
        'Here it is on a real connector. Google Drive, fifty-one tools, one answer each.\n\nReads run. Uploading and sharing ask. Updating a shared drive and trashing a file are blocked outright — and no approval in the moment can lift a block.',
      node: (
        <Slide innerClassName="py-14 sm:py-16">
          <Rise i={0}>
            <SectionHead
              eyebrow={<Chapter n="03">{control.eyebrow}</Chapter>}
              title={
                <>
                  Allow, ask, or block. <Dim>Every action, one answer.</Dim>
                </>
              }
              className="max-w-3xl"
            />
          </Rise>
          <Rise i={1}>
            <Shot
              src="/media/connectors/connector-permissions.webp"
              alt="The Permissions tab of the Google Drive connector in Kortix: a default rule, then every Drive tool set to Allow, Ask, Block or Default."
              url="kortix.com — Connectors → Permissions"
              className="mt-8"
              imgClassName="max-h-[52vh] object-cover object-top"
            />
          </Rise>
        </Slide>
      ),
    },

    /* 12 ─ how work lands, drawn ────────────────────────────────────────── */
    {
      id: 'change-request',
      label: '04 · How work lands',
      steps: 3,
      notes: [
        'Four. Nothing lands without you.\n\nThis is main — your live company. Everything anyone actually relies on is here.',
        'The agent did its work on its own branch. Every edit it made lands there, invisible to main and to every other session. It does not get to push any of this into your company.',
        'To keep anything, it commits and opens a change request pointed at main. That is the only door.\n\nAnd a change request is a diff. An agent rewriting its own prompt gets reviewed the same way a code change does, because it is one.',
        'I read it. I approve it. Now it reaches main.\n\nAnd to be precise, because this is the bit a reviewer will push on: merging is a capability of its own, refused to every agent unless an admin grants it. That grant lives in kortix.yaml — so an agent cannot widen its own reach without a change request somebody else approves.\n\nRun a thousand agents in parallel and every one of them funnels through this same gate.',
      ],
      node: (step) => (
        <DiagramSlide
          eyebrow={<Chapter n="04">{landing.eyebrow}</Chapter>}
          title={landing.title}
        >
          <ChangeRequestDiagram step={step} />
        </DiagramSlide>
      ),
    },

    /* 13 ─ principals, drawn ────────────────────────────────────────────── */
    {
      id: 'principals',
      label: '05 · Identity',
      steps: 3,
      notes: [
        'Permissions are per resource, for people and for agents.\n\nA person acts through the roles you granted them, evaluated against the resource they are reaching for. Nothing surprising.',
        'An agent is a principal in exactly the same way. A service account is a first-class machine identity the account owns — not a human token wearing a hat. Policies attach to it directly.',
        'And here is the edge that does not exist. Most AI tools give the agent whatever the person who started it can reach. Kortix has no inheritance edge to walk up. A service account request is evaluated purely against its own policies.',
        'So what a session can actually touch is the intersection: what the person may do, and what the agent was declared to be allowed. Never the union.\n\nAn agent is a principal, not a loophole.',
      ],
      node: (step) => (
        <DiagramSlide
          eyebrow={<Chapter n="05">{identity.eyebrow}</Chapter>}
          title={identity.title}
        >
          <PrincipalDiagram step={step} />
        </DiagramSlide>
      ),
    },

    /* 14 ─ the record, drawn ────────────────────────────────────────────── */
    {
      id: 'ledger',
      label: '06 · Audit',
      steps: 3,
      notes: [
        'And everything is on the record.\n\nThat send_email you watched get held and approved is a row. The gateway that resolved the credential is the same thing that writes it, so there is no path to a connected tool that skips the ledger.',
        'The blocked call is a row too. What did not happen is as much a part of the record as what did — with who denied it, or which rule did.',
        'Account actions land in the same place. Membership, roles, policies, tokens, groups, IAM changes.',
        'And the headline: recording is never the thing you pay for. Every plan writes this. The plan decides who may read, export, or stream it — not whether it exists.\n\nPull it as CSV or JSONL, or have every event posted to your own SIEM over a webhook signed with HMAC. If a reviewer asks you to prove it, you do not tell them. You show them the log.',
      ],
      node: (step) => (
        <DiagramSlide eyebrow={<Chapter n="06">{audit.eyebrow}</Chapter>} title={audit.title}>
          <LedgerDiagram step={step} />
        </DiagramSlide>
      ),
    },

    /* 15 ─ posture ──────────────────────────────────────────────────────── */
    {
      id: 'posture',
      label: '07 · Posture',
      steps: 1,
      notes: [
        'Run it where your policy says it has to run. Managed cloud, a stack inside your own network, or a single-tenant deployment in your VPC. Air-gapped and other fully isolated topologies we scope with you rather than sell you self-served.',
        'And here is where we actually stand. SOC 2 Type One and Type Two are in progress — not certified, in progress. GDPR is a posture we operate.\n\nWe do not hold ISO 27001 or HIPAA and we do not imply that we do. When a report lands, this line changes that day and not before.',
      ],
      node: (step) => (
        <Slide innerClassName="py-14 sm:py-16">
          <Rise i={0}>
            <SectionHead
              eyebrow={<Chapter n="07">{posture.eyebrow}</Chapter>}
              title={posture.title}
              className="max-w-3xl"
            />
          </Rise>
          <div className="mt-8 grid gap-4 sm:grid-cols-3">
            {posture.deployments.map((item, i) => (
              <Rise key={item.id} i={i + 1}>
                <MiniCard title={item.k} body={item.v} className="h-full" />
              </Rise>
            ))}
          </div>
          <div
            className={cn(
              'transition-opacity duration-500',
              step >= 1 ? 'opacity-100' : 'opacity-15',
            )}
          >
            <Panel className="mt-4 p-6 sm:p-8">
              <p className="text-muted-foreground font-mono text-[10px] tracking-widest uppercase">
                {posture.compliance.label}
              </p>
              <dl className="mt-6 grid gap-4 sm:grid-cols-3">
                {posture.compliance.items.map((item) => (
                  <div
                    key={item.k}
                    className="border-border flex items-baseline justify-between gap-4 border-t pt-4"
                  >
                    <dt className="text-foreground text-sm font-medium">{item.k}</dt>
                    <dd className="text-muted-foreground shrink-0 font-mono text-[11px] tracking-wider uppercase">
                      {item.v}
                    </dd>
                  </div>
                ))}
              </dl>
              <p className="text-muted-foreground border-border mt-6 border-t pt-6 text-sm leading-relaxed">
                {posture.compliance.note}
              </p>
            </Panel>
          </div>
        </Slide>
      ),
    },

    /* 16 ─ close ────────────────────────────────────────────────────────── */
    {
      id: 'close',
      label: 'Read the code',
      steps: 1,
      notes: [
        'That is the whole model. Isolation, so a mistake cannot spread. Credentials the agent never holds. A human gate before anything ships. A full trail of everything.',
        'It is built to survive a security review, not slip past one. On-prem, in your VPC, or fully isolated if that is what you need.\n\nAnd because it is open source, you do not have to take my word for any of this. Read the code.\n\nKortix. Your AGI management system.',
      ],
      node: (step) => (
        <Slide>
          <Rise i={0}>
            <Eyebrow>The whole model</Eyebrow>
          </Rise>
          <Rise i={1}>
            <h2 className="text-foreground mt-5 max-w-4xl text-3xl leading-tight font-medium tracking-tight text-balance sm:text-5xl">
              Built to survive a security review, <Dim>not slip past one.</Dim>
            </h2>
          </Rise>
          <Rise i={2}>
            <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {[
                ['Isolation', 'so a mistake cannot spread'],
                ['Credentials', 'the agent never holds'],
                ['A human gate', 'before anything ships'],
                ['A full trail', 'of everything, on every plan'],
              ].map(([k, v], i) => (
                <Panel key={k} className="flex flex-col gap-1.5 p-6">
                  <span className="text-muted-foreground/45 font-mono text-xs tabular-nums">
                    {String(i + 1).padStart(2, '0')}
                  </span>
                  <span className="text-foreground mt-3 text-lg font-medium tracking-tight">
                    {k}
                  </span>
                  <span className="text-muted-foreground text-sm leading-relaxed">{v}</span>
                </Panel>
              ))}
            </div>
          </Rise>
          <div
            className={cn(
              'transition-opacity duration-500',
              step >= 1 ? 'opacity-100' : 'opacity-0',
            )}
          >
            <p className="text-muted-foreground mt-10 max-w-2xl text-base leading-relaxed">
              On-prem, in your VPC, or fully isolated if that is what you need. And because it is
              open source, you do not have to take our word for any of it —{' '}
              <span className="text-foreground">read the code.</span>
            </p>
            <p className="text-muted-foreground mt-8 font-mono text-xs tracking-wider uppercase">
              <Mono>kortix.com/security</Mono> · Your AGI management system
            </p>
          </div>
        </Slide>
      ),
    },
  ];
}
