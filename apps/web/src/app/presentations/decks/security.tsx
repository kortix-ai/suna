'use client';

/**
 * The security walkthrough.
 *
 * ── STRUCTURE ────────────────────────────────────────────────────────────
 * Four answers to one question, and nothing else. The deck says "four things"
 * on slide 2 and then runs exactly four chapters, with the spine on screen the
 * whole time so a viewer always knows where they are:
 *
 *   01 Isolation    a mistake cannot spread
 *   02 Credentials  the agent never holds the key
 *   03 The gate     nothing lands without a person
 *   04 The record   every action is written down
 *
 * One diagram per chapter, built step by step. One supporting slide per
 * chapter at most. If a fifth idea wants in, it belongs on `/security`, not
 * here — the point of this deck is that it is small enough to hold in your
 * head while someone talks.
 *
 * ── SOURCE OF TRUTH ──────────────────────────────────────────────────────
 * Copy comes from the accuracy-gated content modules, never retyped:
 *   features/marketing/security-page/content.ts
 *   features/marketing/connectors/content.ts
 * Their headers list every claim checked against shipped code, and the
 * corrections that must not be "restored". Read them before editing a line.
 *
 * ── FOUR CORRECTIONS TO THE SPOKEN DRAFT ─────────────────────────────────
 *  1. "a disposable microVM" — not true of the default provider. microVM is
 *     accurate for Platinum (Cloud Hypervisor) only.
 *  2. "scoped to a person or a group" — that model was retired
 *     (20260706_secrets_v2_identifier_model.sql). Scoping is per project, per
 *     agent grant, and connector-scoped.
 *  3. "the key never sits in the sandbox" — true of CONNECTOR credentials,
 *     false of a granted runtime secret. Slide 05 says so out loud.
 *  4. "I approve it, only now does it reach main" — merge is default-deny for
 *     agents, not human-only.
 */

import { Badge } from '@/components/ui/badge';
import { broker } from '@/features/marketing/connectors/content';
import { credentials, hero } from '@/features/marketing/security-page/content';
import type { ReactNode } from 'react';
import type { SlideDef } from '../engine/deck';
import {
  BrokerDiagram,
  ChangeRequestDiagram,
  IsolationDiagram,
  LedgerDiagram,
  PrincipalDiagram,
} from '../engine/diagram';
import { Dim, Panel, Rise, Shot, Slide, Spine } from '../engine/parts';

/** The whole deck, in four words. Nothing here is decoration — see the header. */
const CHAPTERS = ['Isolation', 'Credentials', 'The gate', 'The record'] as const;

const ANSWERS = [
  { title: 'Isolation', body: 'One session, one machine, one branch. A bad run costs you a box you were throwing away.' },
  { title: 'Credentials', body: 'Keys are resolved on our side of the wall. The machine the model drives never holds them.' },
  { title: 'The gate', body: 'Work reaches main through a change request. Merging is a separate power, refused by default.' },
  { title: 'The record', body: 'Every action, human or agent, is written down — on every plan.' },
] as const;

/**
 * A chapter slide: the spine, one short title, and the machine. No lead
 * paragraph — on a build slide the words that change are the diagram's caption,
 * and a second block of prose above it just competes with the narration.
 */
function Chapter({
  n,
  title,
  children,
}: {
  n: number;
  title: ReactNode;
  children: ReactNode;
}) {
  return (
    <Slide innerClassName="py-14 sm:py-16">
      <Rise i={0}>
        <Spine chapters={CHAPTERS} active={n} />
      </Rise>
      <Rise i={1}>
        <h2 className="text-foreground mt-6 max-w-3xl text-3xl font-medium tracking-tight text-balance">
          {title}
        </h2>
      </Rise>
      <Rise i={2}>
        <div className="mt-8">{children}</div>
      </Rise>
    </Slide>
  );
}

export function useSlides(): SlideDef[] {
  return [
    /* ── open ────────────────────────────────────────────────────────────── */
    {
      id: 'title',
      label: 'Security',
      notes:
        'If you are going to run a hundred agents inside your company, only one question really matters: what happens when one of them goes wrong?\n\nAn agent that can install anything, call anything and write anywhere is only safe if the walls are real. In Kortix those walls sit below the agent, in the platform, where a prompt cannot talk its way past them.\n\nLet me show you.',
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
              What happens when one of a hundred agents goes wrong?
            </p>
          </Rise>
        </Slide>
      ),
    },

    /* ── the map ─────────────────────────────────────────────────────────── */
    {
      id: 'map',
      label: 'Four answers',
      notes:
        'Four answers. Isolation, so a mistake cannot spread. Credentials the agent is never handed. A person in front of anything that lands. And a record of all of it.\n\nThat is the whole model. I am going to draw each one.',
      node: (
        <Slide>
          <Rise i={0}>
            <h2 className="text-foreground max-w-3xl text-3xl font-medium tracking-tight text-balance sm:text-4xl">
              Four answers. <Dim>None of them are the prompt.</Dim>
            </h2>
          </Rise>
          <Rise i={1}>
            <p className="text-muted-foreground mt-5 max-w-2xl text-base leading-relaxed">
              Guardrails written into an agent’s instructions are advice. These four sit in the
              platform underneath it, so they hold whatever the model decides to try.
            </p>
          </Rise>
          <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {ANSWERS.map((a, i) => (
              <Rise key={a.title} i={i + 2}>
                <Panel className="flex h-full flex-col p-6">
                  <span className="text-muted-foreground/45 font-mono text-xs tabular-nums">
                    {`0${i + 1}`}
                  </span>
                  <h3 className="text-foreground mt-5 text-lg font-medium tracking-tight">
                    {a.title}
                  </h3>
                  <p className="text-muted-foreground mt-2.5 text-sm leading-relaxed">{a.body}</p>
                </Panel>
              </Rise>
            ))}
          </div>
        </Slide>
      ),
    },

    /* ── 01 · isolation ──────────────────────────────────────────────────── */
    {
      id: 'isolation',
      label: '01 · Isolation',
      steps: 3,
      notes: [
        'One. Isolation.\n\nA project is a repo. main is the thing everyone in the company actually relies on.',
        'I start a session. Kortix cuts a branch and boots one machine for it — and that one-machine-per-session rule is a unique constraint in the database, not a convention two services agree to honour.\n\nThe agent in there can install packages, run code, break things.',
        'Someone starts a second session. Own branch, own machine. Nothing crosses.\n\nAnd this is the line worth sitting on: separating two of your own sessions is the same mechanism as separating two different customers. There is no weaker internal wall.',
        'The machine is not precious. A bad install goes away with it, and the box is destroyed at the end anyway.\n\nOnly what the session commits survives — as a change request. That is the only way anything gets back to main.',
      ],
      node: (step) => (
        <Chapter n={0} title="Nothing is shared, because nothing is shared.">
          <IsolationDiagram step={step} />
        </Chapter>
      ),
    },

    /* ── 02 · credentials ────────────────────────────────────────────────── */
    {
      id: 'credentials',
      label: '02 · Credentials',
      steps: 4,
      notes: [
        'Two. The agent never holds the key.\n\nA tool needs a real credential to do real work, so the honest question is not whether a machine ever holds one. It is which machine holds which key.\n\nA sandbox is a real Linux machine the model can run anything on — so the only credential in it is one Kortix token, scoped to the project.',
        'The agent wants to send an email. It calls a tool by name: connector, action, arguments. No URL, no host, no key. It cannot construct the request itself even if it wanted to.',
        'The call crosses to our side. Kortix checks this agent may use this connector, resolves the policy, and decrypts the credential here — outside the machine the model is driving.',
        'It attaches the credential to the outbound request. The API sees an ordinary authenticated call. The answer goes back to the agent. The credential stays behind.',
        'So watch what never crossed. API keys, OAuth tokens, refresh tokens, client secrets — none of them were ever in the box.\n\nWhich means turning a connector off takes effect on the next call, and there is nothing in the sandbox to rotate.',
      ],
      node: (step) => (
        <Chapter n={1} title={broker.title}>
          <BrokerDiagram step={step} />
        </Chapter>
      ),
    },

    /* ── 02 · the honest line ────────────────────────────────────────────── */
    {
      id: 'honesty',
      label: '02 · Credentials',
      notes:
        'And here is the slide most vendors leave out.\n\nA runtime secret you deliberately grant a session is a real environment value inside that session, readable by any command the agent runs. That is how a tool uses it.\n\nWe would rather say that than tell you it is invisible and have you disprove it in one command. The controls that matter are the two gates — the person’s role and the agent’s declared grant, intersected — and the fact that the machine is destroyed with it.',
      node: (
        <Chapter n={1} title="What we will not claim.">
          <Panel className="p-8 sm:p-10">
            <p className="text-muted-foreground font-mono text-[10px] tracking-widest uppercase">
              {credentials.rows[3].k}
            </p>
            {/* The page's own wording, unabridged — paraphrasing the one claim
                we deliberately refuse to make would defeat the point. */}
            <p className="text-foreground mt-6 max-w-3xl text-xl leading-relaxed">
              {credentials.rows[3].v}
            </p>
          </Panel>
        </Chapter>
      ),
    },

    /* ── 03 · the gate ───────────────────────────────────────────────────── */
    {
      id: 'gate',
      label: '03 · The gate',
      steps: 3,
      notes: [
        'Three. Nothing lands without you.\n\nThis is main — your live company.',
        'The agent did its work on its own branch. Every edit lands there, invisible to main and to every other session. It does not get to push any of this into your company.',
        'To keep anything, it commits and opens a change request pointed at main. That is the only door.\n\nAnd a change request is a diff. An agent rewriting its own prompt gets reviewed the same way a code change does, because it is one.',
        'I read it. I approve it. Now it reaches main.\n\nAnd to be precise, because a reviewer will push on this: merging is a capability of its own, refused to every agent unless an admin grants it. That grant lives in kortix.yaml — so an agent cannot widen its own reach without a change request somebody else approves.\n\nRun a thousand agents in parallel and every one funnels through this gate.',
      ],
      node: (step) => (
        <Chapter n={2} title="Opening a change request and merging it are different powers.">
          <ChangeRequestDiagram step={step} />
        </Chapter>
      ),
    },

    /* ── 03 · the same gate, per call ────────────────────────────────────── */
    {
      id: 'gate-shot',
      label: '03 · The gate',
      notes:
        'The same idea one level down, on a real connector. Google Drive, fifty-one tools, one answer each — allow, ask, or block.\n\nReads run. Uploading and sharing ask. Trashing a file is blocked outright, and no approval in the moment can lift a block.\n\nAnd when a call is gated the run does not fail, it holds. The agent is still mid-task when you answer, with the arguments in front of you.',
      node: (
        <Chapter
          n={2}
          title={
            <>
              Allow, ask, or block. <Dim>Every action, one answer.</Dim>
            </>
          }
        >
          <Shot
            src="/media/connectors/connector-permissions.webp"
            alt="The Permissions tab of the Google Drive connector in Kortix: a default rule, then every Drive tool set to Allow, Ask, Block or Default."
            url="kortix.com — Connectors → Permissions"
            imgClassName="max-h-[48vh] object-cover object-top"
          />
        </Chapter>
      ),
    },

    /* ── 04 · who may reach what ─────────────────────────────────────────── */
    {
      id: 'principals',
      label: '04 · The record',
      steps: 3,
      notes: [
        'Four. Everything is on the record — and the record starts with who was allowed to do what.\n\nA person acts through the roles you granted them, evaluated against the resource they are reaching for.',
        'An agent is a principal in exactly the same way. A service account is a first-class machine identity the account owns, not a human token wearing a hat.',
        'And here is the edge that does not exist. Most AI tools give the agent whatever the person who started it can reach. Kortix has no inheritance edge to walk up.',
        'So what a session can touch is the intersection: what the person may do, and what the agent was declared to be allowed. Never the union.\n\nAn agent is a principal, not a loophole.',
      ],
      node: (step) => (
        <Chapter n={3} title="An agent is a principal, not a loophole.">
          <PrincipalDiagram step={step} />
        </Chapter>
      ),
    },

    /* ── 04 · the ledger ─────────────────────────────────────────────────── */
    {
      id: 'ledger',
      label: '04 · The record',
      steps: 3,
      notes: [
        'And every action lands here. That send_email is a row — the gateway that resolved the credential is the same thing that writes it, so there is no path to a connected tool that skips the ledger.',
        'A blocked call is a row too. What did not happen is as much a part of the record as what did.',
        'Account actions land in the same place. Membership, roles, policies, tokens, groups.',
        'And the headline: recording is never the thing you pay for. Every plan writes this. The plan decides who may read, export or stream it — not whether it exists.\n\nIf a reviewer asks you to prove it, you do not tell them. You show them the log.',
      ],
      node: (step) => (
        <Chapter n={3} title="Recording is never the thing you pay for.">
          <LedgerDiagram step={step} />
        </Chapter>
      ),
    },

    /* ── close ───────────────────────────────────────────────────────────── */
    {
      id: 'close',
      label: 'Read the code',
      notes:
        'That is the whole model. Isolation, so a mistake cannot spread. Credentials the agent never holds. A human gate before anything ships. A full trail of everything.\n\nIt is built to survive a security review, not slip past one. On-prem, in your VPC, or fully isolated if that is what you need.\n\nAnd because it is open source, you do not have to take my word for any of it. Read the code.\n\nKortix. Your AGI management system.',
      node: (
        <Slide>
          <Rise i={0}>
            <h2 className="text-foreground max-w-4xl text-3xl leading-tight font-medium tracking-tight text-balance sm:text-5xl">
              Built to survive a security review, <Dim>not slip past one.</Dim>
            </h2>
          </Rise>
          <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {ANSWERS.map((a, i) => (
              <Rise key={a.title} i={i + 1}>
                <Panel className="flex flex-col gap-1.5 p-6">
                  <span className="text-muted-foreground/45 font-mono text-xs tabular-nums">
                    {`0${i + 1}`}
                  </span>
                  <span className="text-foreground mt-3 text-lg font-medium tracking-tight">
                    {a.title}
                  </span>
                </Panel>
              </Rise>
            ))}
          </div>
          <Rise i={5}>
            <p className="text-muted-foreground mt-12 max-w-2xl text-base leading-relaxed">
              On-prem, in your VPC, or fully isolated if that is what you need. And because it is
              open source, you do not have to take our word for any of it —{' '}
              <span className="text-foreground">read the code.</span>
            </p>
          </Rise>
        </Slide>
      ),
    },
  ];
}
