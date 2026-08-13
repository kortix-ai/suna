'use client';

/**
 * /presentation/security — the guided security walkthrough.
 *
 * A tap-through companion to `/security`, built for screen recording: one idea
 * per slide, the spoken script attached to each slide as `notes` (press `N`),
 * and the same visual vocabulary as the marketing site.
 *
 * ── SOURCE OF TRUTH ──────────────────────────────────────────────────────
 * Copy is read from the pages' own accuracy-gated content modules rather than
 * retyped here:
 *   features/marketing/security-page/content.ts   (isolation, credentials,
 *                                                  identity, control, landing,
 *                                                  audit, posture)
 *   features/marketing/connectors/content.ts      (the broker before/after)
 * Those headers list every claim that was checked against shipped code, and the
 * corrections that must not be "restored". Read them before editing a line.
 *
 * ── FOUR CORRECTIONS THIS DECK MAKES TO THE SPOKEN DRAFT ─────────────────
 * The narration this deck was written from said four things the code does not
 * support. They are fixed here, and must stay fixed:
 *  1. "a disposable microVM" — NOT true of the default provider. microVM is
 *     accurate for Platinum (Cloud Hypervisor) only. The deck says "its own
 *     sandbox" and names microVM only where it holds.
 *  2. "the credential is scoped to a person or a group" — that model was
 *     retired (migration 20260706_secrets_v2_identifier_model.sql). Scoping is
 *     per project, per agent grant, and connector-scoped.
 *  3. "the key never sits in the sandbox" — true of CONNECTOR credentials,
 *     false of a granted runtime secret, which is a real environment value in
 *     the session. Slide 08 says so out loud rather than letting the broad
 *     claim stand.
 *  4. "I approve it, only now does it reach main" — merge is default-deny for
 *     agents, not human-only; an admin can grant `project.cr.merge`. The
 *     stronger, true claim is the one on slide 11.
 */

import { Badge } from '@/components/ui/badge';
import { KortixAsterisk } from '@/components/ui/kortix-asterisk';
import { BoundaryDiagram } from '@/features/marketing/security-page/boundary-diagram';
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
import { broker } from '@/features/marketing/connectors/content';
import { CredentialFlow } from '@/features/marketing/security-page/credential-flow';
import { PermissionMatrix } from '@/features/marketing/security-page/permission-matrix';
import { cn } from '@/lib/utils';
import type { ReactNode } from 'react';
import type { SlideDef } from './deck';
import {
  Dim,
  Eyebrow,
  Lead,
  MiniCard,
  Mono,
  Panel,
  Rise,
  RowList,
  SectionHead,
  Shot,
  Slide,
  SpecStrip,
  Steps,
} from './parts';

/* ── local bits ─────────────────────────────────────────────────────────── */

/** The eyebrow every numbered chapter carries: `01 · Isolation`. */
function Chapter({ n, children }: { n: string; children: ReactNode }) {
  return (
    <span className="flex items-center gap-2.5">
      <span className="text-muted-foreground/45 font-mono tabular-nums">{n}</span>
      <span className="bg-border h-px w-6" aria-hidden />
      <span>{children}</span>
    </span>
  );
}

/** One side of the before/after: a mono env block with a verdict under it. */
function EnvPanel({
  label,
  title,
  lines,
  body,
  tone,
}: {
  label: string;
  title: string;
  lines: readonly string[];
  body: string;
  tone: 'before' | 'after';
}) {
  return (
    <Panel className="flex h-full flex-col p-6 sm:p-7">
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
      notes:
        'If you are going to run a hundred agents inside your company, only one question really matters: what happens when one of them goes wrong?\n\nLet me show you exactly what Kortix does about that. An agent that can install anything, call anything and write anywhere is only safe if the walls are real — and in Kortix those walls sit below the agent, in the platform, where a prompt cannot talk its way past them.',
      node: (
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
          <Rise i={3}>
            <SpecStrip specs={hero.specs} className="mt-12" />
          </Rise>
        </Slide>
      ),
    },

    /* 02 ─ the four answers ─────────────────────────────────────────────── */
    {
      id: 'answers',
      label: 'The four answers',
      notes:
        'Four things, and I will show you each one on a real screen.\n\nOne: isolation, so a mistake cannot spread. Two: credentials the agent is never handed. Three: a person in front of anything that lands. Four: a record of every action, human or agent.\n\nThat is the whole model. Everything after this slide is just the detail.',
      node: (
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
              <Rise key={card.n} i={i + 1}>
                <MiniCard label={card.n} title={card.title} body={card.body} className="h-full" />
              </Rise>
            ))}
          </div>
        </Slide>
      ),
    },

    /* 03 ─ isolation: the boundary ──────────────────────────────────────── */
    {
      id: 'isolation-boundary',
      label: '01 · Isolation',
      notes:
        'One. Isolation.\n\nEvery session runs in its own sandbox — its own machine, on its own branch. I start a session and it boots a fresh isolated environment. The agent in there can install packages, run code, break things, do whatever it needs.\n\nAnd it cannot see or touch any other session, or your live systems. Only what it commits ever leaves this box. When it is done, the box is destroyed. So the damage of a bad run is one sandbox you were going to throw away anyway.',
      node: (
        <Slide>
          <Rise i={0}>
            <SectionHead
              eyebrow={<Chapter n="01">{isolation.eyebrow}</Chapter>}
              title={isolation.title}
              lead={isolation.sub}
            />
          </Rise>
          <Rise i={1}>
            <div className="mt-10">
              <BoundaryDiagram />
            </div>
          </Rise>
        </Slide>
      ),
    },

    /* 04 ─ isolation: the mechanism ─────────────────────────────────────── */
    {
      id: 'isolation-rows',
      label: '01 · Isolation',
      notes:
        'And this is the part a reviewer will actually test. One sandbox per session is not a convention two services agree to honour — it is a unique constraint in the database. Two sessions cannot end up on the same machine.\n\nOne note on wording, because we get asked. On our own Platinum compute a sandbox is a Cloud Hypervisor microVM. Daytona and E2B are also supported. The provider is a deployment choice, and we will tell you which one you are on rather than blur them together.\n\nSeparating two of your own sessions is the same mechanism as separating two different customers.',
      node: (
        <Slide>
          <Rise i={0}>
            <SectionHead
              eyebrow={<Chapter n="01">{isolation.eyebrow}</Chapter>}
              title="Enforced in the database, not by convention."
              lead="The four claims underneath the diagram, stated the way we would state them to a security reviewer."
            />
          </Rise>
          <Rise i={1}>
            <RowList rows={isolation.rows} className="mt-9" />
          </Rise>
        </Slide>
      ),
    },

    /* 05 ─ credentials: the path ────────────────────────────────────────── */
    {
      id: 'credentials-flow',
      label: '02 · Credentials',
      notes:
        'Two. Secrets the agent is never handed.\n\nA tool needs a real credential to do real work, so the honest question is not whether a machine ever holds one. It is which machine holds which key, who decided that, and what never gets in at all.\n\nHere is the whole path. Stored, encrypted with a key derived per project. Granted — and note there are two gates, not one. Delivered into the session at boot, by name, on tmpfs at mode six hundred. Used from the environment, not pasted into the prompt. Shredded on shutdown, and the machine is destroyed with it.',
      node: (
        <Slide>
          <Rise i={0}>
            <SectionHead
              eyebrow={<Chapter n="02">{credentials.eyebrow}</Chapter>}
              title={credentials.title}
              lead={credentials.sub}
            />
          </Rise>
          <Rise i={1}>
            <div className="mt-10">
              <CredentialFlow />
            </div>
          </Rise>
          <Rise i={2}>
            <RowList rows={[credentials.rows[1]]} className="mt-4" />
          </Rise>
        </Slide>
      ),
    },

    /* 06 ─ credentials: the broker ──────────────────────────────────────── */
    {
      id: 'credentials-broker',
      label: '02 · Credentials',
      notes:
        'Now here is a connector — Slack, a CRM, whatever you run on. The credential lives here, encrypted with a per-project key, and stored apart from the values a sandbox is ever allowed to read.\n\nWhen the agent makes a call, it names the connector and the action. It has no URL, no host, no key. Kortix resolves the credential server-side and attaches it to the outbound request. The third-party API sees a normal authenticated request. The credential stays behind.\n\nSo the usual drawer of keys in the agent environment is gone. The sandbox carries exactly one scoped Kortix token. Nothing in there needs rotating, because nothing in there was ever a secret of yours.',
      node: (
        <Slide>
          <Rise i={0}>
            <SectionHead
              eyebrow={<Chapter n="02">{broker.eyebrow}</Chapter>}
              title={broker.title}
              lead={broker.sub}
            />
          </Rise>
          <div className="mt-10 grid gap-4 lg:grid-cols-2">
            <Rise i={1}>
              <EnvPanel
                tone="before"
                label={broker.before.label}
                title={broker.before.title}
                lines={broker.before.lines}
                body={broker.before.body}
              />
            </Rise>
            <Rise i={2}>
              <EnvPanel
                tone="after"
                label={broker.after.label}
                title={broker.after.title}
                lines={broker.after.lines}
                body={broker.after.body}
              />
            </Rise>
          </div>
          <Rise i={3}>
            <Panel className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-2 px-6 py-4">
              <span className="text-muted-foreground font-mono text-[10px] tracking-widest uppercase">
                {broker.neverLabel}
              </span>
              <span className="flex flex-wrap items-center gap-x-5 gap-y-2">
                {broker.never.map((item, i) => (
                  <span key={item} className="text-foreground flex items-center gap-2 text-sm">
                    <KortixAsterisk index={i} />
                    {item}
                  </span>
                ))}
              </span>
            </Panel>
          </Rise>
        </Slide>
      ),
    },

    /* 07 ─ connectors: the real screen ──────────────────────────────────── */
    {
      id: 'connectors-shot',
      label: '02 · Credentials',
      notes:
        'This is the real screen. Three thousand apps in a click, plus MCP, OpenAPI, GraphQL and raw HTTP for anything of your own.\n\nEvery one of them connects the same way, and every one of them goes through the same broker. There is no second path to a connected tool that skips it — which matters in a moment when I show you the audit trail, because the thing that resolves the credential is also the thing that writes the record.',
      node: (
        <Slide innerClassName="py-16 sm:py-20">
          <Rise i={0}>
            <SectionHead
              eyebrow="Connect once"
              title={
                <>
                  Every tool your company runs on. <Dim>None of the keys.</Dim>
                </>
              }
              lead="A connector belongs to the project, not to a laptop or a login. Add it once and every session that project starts can reach it — with no second setup and no key passed around in a DM."
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

    /* 08 ─ credentials: the honest limit ────────────────────────────────── */
    {
      id: 'credentials-honest',
      label: '02 · Credentials',
      notes:
        'And here is the slide most vendors do not put in the deck.\n\nConnector keys never enter the machine — that claim holds, and so does the one about our own upstream provider keys, which no sandbox is allowed to hold.\n\nBut a runtime secret you deliberately grant a session is a real environment value inside that session, readable by any command the agent runs. That is how a tool uses it. We would rather say so than tell you it is invisible and have you disprove it in one command.\n\nThe controls that actually matter are the two gates — the person’s role and the agent’s declared grant, intersected — and the fact that the machine is destroyed with it.',
      node: (
        <Slide>
          <Rise i={0}>
            <SectionHead
              eyebrow={<Chapter n="02">Honesty</Chapter>}
              title="What we will not claim."
              lead="A security review is won by the sentence a vendor volunteers, not the one they defend. So here is ours."
            />
          </Rise>
          <div className="mt-10 grid gap-4 lg:grid-cols-2">
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
              <Panel className="flex h-full flex-col p-6 sm:p-8">
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

    /* 09 ─ control: the policy ──────────────────────────────────────────── */
    {
      id: 'control-policy',
      label: '03 · Control',
      notes:
        'Three. Deciding what needs a human before it happens.\n\nApproval is not a setting buried in an admin panel. It is a block in kortix.yaml, versioned with everything else. Three actions: always run, require approval, block.\n\nThe part people do not expect is the conditions. "May the agent send email" is rarely the question. A condition matches the arguments, so the rule becomes "only to these addresses". An argument the rule cannot evaluate fails closed.\n\nOne thing to set deliberately: a project with no policy block keeps the permissive legacy default. Set default mode to risk and reads run while writes and destructive calls stop for a person.',
      node: (
        <Slide>
          <Rise i={0}>
            <SectionHead
              eyebrow={<Chapter n="03">{control.eyebrow}</Chapter>}
              title={control.title}
              lead={control.sub}
            />
          </Rise>
          <div className="mt-10 grid gap-4 lg:grid-cols-12">
            <Rise i={1} className="lg:col-span-6">
              <CodePanel title={control.yaml.title} lines={control.yaml.lines} lang="yaml" />
            </Rise>
            <div className="grid gap-4 sm:grid-cols-2 lg:col-span-6">
              {control.notes.map((note, i) => (
                <Rise key={note.id} i={i + 2}>
                  <Panel className="flex h-full flex-col p-5">
                    <p className="text-foreground font-mono text-[11px] tracking-widest uppercase">
                      {note.k}
                    </p>
                    <p className="text-muted-foreground mt-3 text-sm leading-relaxed">{note.v}</p>
                  </Panel>
                </Rise>
              ))}
            </div>
          </div>
        </Slide>
      ),
    },

    /* 10 ─ control: the real screen ─────────────────────────────────────── */
    {
      id: 'control-shot',
      label: '03 · Control',
      notes:
        'Here it is on a real connector. Google Drive, fifty-one tools, one answer each — allow, ask, block, or fall through to the project default.\n\nReads run. Uploading and sharing ask. Updating a shared drive and trashing a file are blocked outright, and no approval in the moment can lift that.\n\nAnd when a call is gated, the run does not fail — it holds. The agent is still mid-task when you answer, with the arguments in front of you, and it picks up exactly where it stopped. A gate that errors out just teaches an agent to retry around it.',
      node: (
        <Slide innerClassName="py-16 sm:py-20">
          <Rise i={0}>
            <SectionHead
              eyebrow={<Chapter n="03">{control.eyebrow}</Chapter>}
              title={
                <>
                  Allow, ask, or block. <Dim>Every action, one answer.</Dim>
                </>
              }
              lead="An approval stops the run, it does not fail it. The call is held open with its arguments in front of you, and the same call completes when you approve."
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

    /* 11 ─ how work lands ───────────────────────────────────────────────── */
    {
      id: 'change-request',
      label: '04 · How work lands',
      notes:
        'Four. Nothing lands without you.\n\nThe agent did its work on its branch. It does not get to push that into your live company. It commits and opens a change request pointed at main — that is the only door.\n\nA change request is a diff. An agent rewriting its own prompt gets reviewed the same way a code change does, because it is one. I read it. I approve it. Only then does it reach main.\n\nAnd to be precise, because this matters in a review: merging is a capability of its own, refused to every agent unless an admin grants it. That grant lives in kortix.yaml — so an agent cannot widen its own reach without a change request somebody else approves. Run a thousand agents in parallel and every one of them funnels through this same gate.',
      node: (
        <Slide>
          <Rise i={0}>
            <SectionHead
              eyebrow={<Chapter n="04">{landing.eyebrow}</Chapter>}
              title={landing.title}
              lead={landing.sub}
            />
          </Rise>
          <Rise i={1}>
            <Steps steps={landing.steps} className="mt-10" />
          </Rise>
          <Rise i={2}>
            <Lead className="mt-6 max-w-3xl">
              Your company self-improves one reviewed change at a time — and a change you do not
              approve simply never happens.
            </Lead>
          </Rise>
        </Slide>
      ),
    },

    /* 12 ─ identity ─────────────────────────────────────────────────────── */
    {
      id: 'identity',
      label: '05 · Identity',
      notes:
        'Permissions are per resource, for people and for agents, so each one only reaches what you granted.\n\nMost AI tools give the agent whatever the person who started it can reach. Kortix does not. A service account is a first-class machine identity the account owns — not a human token wearing a hat. Policies attach to it directly, and a request it makes is evaluated purely against its own policies. It never inherits the reach of whoever created it.\n\nSo an agent is a principal, not a loophole.',
      node: (
        <Slide>
          <Rise i={0}>
            <SectionHead
              eyebrow={<Chapter n="05">{identity.eyebrow}</Chapter>}
              title={identity.title}
              lead={identity.sub}
            />
          </Rise>
          <Rise i={1}>
            <div className="mt-10">
              <PermissionMatrix />
            </div>
          </Rise>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            {[identity.agents, identity.scoping].map((card, i) => (
              <Rise key={card.title} i={i + 2}>
                <MiniCard title={card.title} body={card.body} className="h-full" />
              </Rise>
            ))}
          </div>
        </Slide>
      ),
    },

    /* 13 ─ audit ────────────────────────────────────────────────────────── */
    {
      id: 'audit',
      label: '06 · Audit',
      notes:
        'And everything is on the record. Every action, human or agent — who did what, when, and what changed.\n\nThe important detail is this: recording is never the thing you pay for. Every account action and every gated tool call is captured on every plan. The plan decides who may read, export, or stream that record — not whether it exists.\n\nPull it as CSV or JSONL, or have every event posted to your own SIEM over a webhook signed with HMAC. And configuration is files, so who changed which agent, which skill and which policy is git history you already know how to read.\n\nIf a reviewer asks you to prove it, you do not tell them. You show them the log.',
      node: (
        <Slide>
          <Rise i={0}>
            <SectionHead
              eyebrow={<Chapter n="06">{audit.eyebrow}</Chapter>}
              title={audit.title}
              lead={audit.sub}
            />
          </Rise>
          <Rise i={1}>
            <RowList rows={audit.rows} className="mt-9" />
          </Rise>
        </Slide>
      ),
    },

    /* 14 ─ posture ──────────────────────────────────────────────────────── */
    {
      id: 'posture',
      label: '07 · Posture',
      notes:
        'Run it where your policy says it has to run. Managed cloud, a stack inside your own network, or a single-tenant deployment in your VPC. Air-gapped and other fully isolated topologies we scope with you rather than sell you self-served.\n\nAnd here is where we actually stand. SOC 2 Type One and Type Two are in progress — not certified, in progress. GDPR is a posture we operate. We do not hold ISO 27001 or HIPAA and we do not imply that we do. When a report lands, this line changes that day and not before.',
      node: (
        <Slide>
          <Rise i={0}>
            <SectionHead
              eyebrow={<Chapter n="07">{posture.eyebrow}</Chapter>}
              title={posture.title}
              lead={posture.sub}
            />
          </Rise>
          <div className="mt-10 grid gap-4 sm:grid-cols-3">
            {posture.deployments.map((item, i) => (
              <Rise key={item.id} i={i + 1}>
                <MiniCard title={item.k} body={item.v} className="h-full" />
              </Rise>
            ))}
          </div>
          <Rise i={4}>
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
          </Rise>
        </Slide>
      ),
    },

    /* 15 ─ close ────────────────────────────────────────────────────────── */
    {
      id: 'close',
      label: 'Read the code',
      notes:
        'That is the whole model. Isolation, so a mistake cannot spread. Credentials the agent never holds. A human gate before anything ships. A full trail of everything.\n\nIt is built to survive a security review, not slip past one. On-prem, in your VPC, or fully isolated if that is what you need.\n\nAnd because it is open source, you do not have to take my word for any of this. Read the code.\n\nKortix. Your AGI management system.',
      node: (
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
          <Rise i={3}>
            <p className="text-muted-foreground mt-10 max-w-2xl text-base leading-relaxed">
              On-prem, in your VPC, or fully isolated if that is what you need. And because it is
              open source, you do not have to take our word for any of it —{' '}
              <span className="text-foreground">read the code.</span>
            </p>
          </Rise>
          <Rise i={4}>
            <p className="text-muted-foreground mt-8 font-mono text-xs tracking-wider uppercase">
              <Mono>kortix.com/security</Mono> · Your AGI management system
            </p>
          </Rise>
        </Slide>
      ),
    },
  ];
}
