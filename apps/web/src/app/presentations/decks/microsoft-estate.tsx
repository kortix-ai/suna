'use client';

/**
 * Kortix on a Microsoft estate — three slides for a company whose group has
 * approved Microsoft Copilot for "agentic AI" and little else.
 *
 * ── STRUCTURE — three slides, nothing else ───────────────────────────────
 *   01 Kortix        who we are, in one line and three facts
 *   02 Microsoft     runs alongside Copilot, on the estate they already have
 *   03 The delta     what one assistant per person cannot be
 *
 * Logo-led, minimal text. If a fourth slide wants in, it belongs in the
 * `security` or `platform` deck — link those instead.
 *
 * ── NO PROSPECT NAMES OR LOGOS IN THE REPO ───────────────────────────────
 * This tree is public. The prospect's name and logo come from the link:
 *   /presentations/microsoft-estate?for=<name>&logo=<https url of their logo>
 * Nothing prospect-specific is committed.
 *
 * ── CLAIMS CHECKED AGAINST CODE ──────────────────────────────────────────
 *  1. "Copilot seat" means GITHUB Copilot — `kortix providers login
 *     github-copilot` (apps/cli/src/commands/providers.ts). A Microsoft 365
 *     Copilot licence is not a model credential. The slide says GitHub Copilot.
 *  2. Azure OpenAI is a catalog provider (`azure` in packages/llm-catalog).
 *  3. SSO is SAML 2.0 only; SCIM 2.0 is built against Microsoft Entra.
 *  4. Microsoft Teams is code-complete and off by default (operator switch +
 *     one tenant-admin consent). Never "one click".
 *  5. "The leading open-source alternative" is the sanctioned superlative
 *     (comms §7, rests on the star count). No other superlative.
 *  6. Competitor facts: Claude Cowork = Anthropic models only, Anthropic cloud
 *     or the customer's Bedrock / Google Cloud / Microsoft Foundry account.
 *     ChatGPT Work = OpenAI cloud, no self-host. Nothing about concurrency.
 */

import { KortixLogo } from '@/components/ui/kortix-logo';
import { Badge } from '@/components/ui/badge';
import { ChatGPT } from '@/features/icon/icons/chat-gpt';
import { Claude } from '@/features/icon/icons/claude';
import { Github } from '@/features/icon/icons/github';
import { MicrosoftTeams } from '@/features/icon/icons/microsoft-teams';
import { Slack } from '@/features/icon/icons/slack';
import { cn } from '@/lib/utils';
import { useSearchParams } from 'next/navigation';
import { Suspense, type ReactNode } from 'react';
import type { SlideDef } from '../engine/deck';
import { Dim, Eyebrow, Panel, Rise, Slide } from '../engine/parts';

/* ── marks ───────────────────────────────────────────────────────────────── */

/** The four squares. Monochrome on purpose — the deck is black, white and one accent. */
function MicrosoftMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 23 23" className={cn('size-5', className)} aria-hidden>
      <rect x="1" y="1" width="10" height="10" fill="currentColor" />
      <rect x="12" y="1" width="10" height="10" fill="currentColor" />
      <rect x="1" y="12" width="10" height="10" fill="currentColor" />
      <rect x="12" y="12" width="10" height="10" fill="currentColor" />
    </svg>
  );
}

/** A public monochrome SVG painted in the current text colour, so it follows the theme. */
function MaskMark({ src, className }: { src: string; className?: string }) {
  const mask = `url(${src})`;
  return (
    <span
      aria-hidden
      className={cn('inline-block size-5 bg-current', className)}
      style={{
        maskImage: mask,
        WebkitMaskImage: mask,
        maskRepeat: 'no-repeat',
        WebkitMaskRepeat: 'no-repeat',
        maskSize: 'contain',
        WebkitMaskSize: 'contain',
        maskPosition: 'center',
        WebkitMaskPosition: 'center',
      }}
    />
  );
}

const AzureMark = ({ className }: { className?: string }) => (
  <MaskMark src="/provider-icons/azure.svg" className={className} />
);
const CopilotMark = ({ className }: { className?: string }) => (
  <MaskMark src="/provider-icons/github-copilot.svg" className={className} />
);

/* ── prospect from the link ──────────────────────────────────────────────── */

function ProspectInner({ children }: { children: (p: { name: string; logo?: string }) => ReactNode }) {
  const params = useSearchParams();
  const name = params.get('for')?.trim() || 'your company';
  const logo = params.get('logo')?.trim() || undefined;
  return <>{children({ name, logo })}</>;
}

/** Reads `?for=` and `?logo=` so the link carries the prospect and the repo does not. */
function Prospect({ children }: { children: (p: { name: string; logo?: string }) => ReactNode }) {
  return (
    <Suspense fallback={<>{children({ name: 'your company' })}</>}>
      <ProspectInner>{children}</ProspectInner>
    </Suspense>
  );
}

/** Kortix × prospect — the pairing that heads every slide. */
function Pairing({ className }: { className?: string }) {
  return (
    <Prospect>
      {({ name, logo }) => (
        <div className={cn('flex items-center gap-4', className)}>
          <KortixLogo variant="brandmark" size={22} />
          <span className="text-muted-foreground/50 text-xl">×</span>
          {logo ? (
            // eslint-disable-next-line @next/next/no-img-element -- prospect logo comes from the link, not the repo
            <img src={logo} alt={name} className="h-9 w-auto max-w-[220px] object-contain" />
          ) : (
            <span className="text-foreground text-lg font-medium tracking-tight">{name}</span>
          )}
        </div>
      )}
    </Prospect>
  );
}

/* ── tiles ───────────────────────────────────────────────────────────────── */

function LogoTile({
  icon,
  title,
  body,
  i,
}: {
  icon: ReactNode;
  title: ReactNode;
  body: ReactNode;
  i: number;
}) {
  return (
    <Rise i={i}>
      <Panel className="flex h-full flex-col gap-4 p-6">
        <div className="text-foreground flex size-10 items-center justify-center rounded-sm border border-border bg-background [&>*]:size-5">
          {icon}
        </div>
        <div>
          <h3 className="text-foreground text-lg font-medium tracking-tight">{title}</h3>
          <p className="text-muted-foreground mt-1.5 text-[15px] leading-relaxed">{body}</p>
        </div>
      </Panel>
    </Rise>
  );
}

function Fact({ value, label, i }: { value: ReactNode; label: ReactNode; i: number }) {
  return (
    <Rise i={i}>
      <Panel className="flex h-full flex-col gap-1 p-6">
        <div className="text-foreground text-2xl font-medium tracking-tight sm:text-3xl">{value}</div>
        <div className="text-muted-foreground font-mono text-xs tracking-wider uppercase">{label}</div>
      </Panel>
    </Rise>
  );
}

/* ── slide 03: the strip of single-player products ───────────────────────── */

const SINGLE_PLAYER = [
  { id: 'cowork', icon: <Claude />, name: 'Claude Cowork', note: 'Anthropic models only' },
  { id: 'chatgpt-work', icon: <ChatGPT />, name: 'ChatGPT Work', note: 'OpenAI cloud only' },
  { id: 'copilot', icon: <MicrosoftMark />, name: 'Microsoft Copilot', note: 'Inside Microsoft 365' },
] as const;

const DELTA = [
  {
    id: 'multiplayer',
    icon: <Slack />,
    title: 'Multiplayer',
    body: 'Shared agents, skills and company memory in one repo. Teach it once; every session knows it.',
  },
  {
    id: 'real-work',
    icon: <Github />,
    title: 'Real work, not chat',
    body: 'Agents run on real cloud computers and return finished deliverables — and take real actions in your tools.',
  },
  {
    id: 'yours',
    icon: <KortixLogo variant="icon" size={20} />,
    title: 'Yours',
    body: 'Any model. Your infrastructure. Every action on the record. Open source — no lock-in.',
  },
] as const;

/* ── deck ────────────────────────────────────────────────────────────────── */

export function useSlides(): SlideDef[] {
  return [
    /* ── 01 · Kortix ─────────────────────────────────────────────────────── */
    {
      id: 'kortix',
      label: '01 · Kortix',
      notes:
        'Kortix is the open-source AI Management System. Your agents, their skills, your company memory and your connectors live in one git repo you own, and the agents do their work on real cloud computers.\n\nTwenty thousand plus stars on GitHub. Open source: self-host it or use the cloud. And Microsoft is an investor.',
      node: (
        <Slide>
          <Rise i={0}>
            <Pairing />
          </Rise>
          <Rise i={1}>
            <h1 className="text-foreground mt-10 max-w-4xl text-4xl font-medium tracking-tight text-balance sm:text-5xl lg:text-6xl">
              The open-source <Dim>AI Management System.</Dim>
            </h1>
          </Rise>
          <Rise i={2}>
            <p className="text-muted-foreground mt-6 max-w-2xl text-lg leading-relaxed">
              Your agents, skills, memory and connectors in one repo you own. Agents work on real
              cloud computers and return finished work.
            </p>
          </Rise>
          <div className="mt-10 grid gap-4 sm:grid-cols-3">
            <Fact i={3} value="20,000+" label="GitHub stars" />
            <Fact i={4} value="Open source" label="Self-host or Kortix Cloud" />
            <Fact
              i={5}
              value={
                <span className="flex items-center gap-3">
                  <MicrosoftMark className="size-6" /> Microsoft
                </span>
              }
              label="Investor in Kortix"
            />
          </div>
        </Slide>
      ),
    },

    /* ── 02 · Microsoft ──────────────────────────────────────────────────── */
    {
      id: 'microsoft',
      label: '02 · Microsoft & Copilot',
      notes:
        'Keep Copilot. Kortix runs alongside it, on the Microsoft estate you already have.\n\nA person signs in with the GitHub Copilot seat they already hold and that seat pays for the model — no second model bill. Or Azure OpenAI with your own keys. Identity is Entra: SAML single sign-on and SCIM directory sync. And a message in a Teams thread starts a session; the answer lands in the same thread.\n\nNothing is replaced. Nothing is duplicated.',
      node: (
        <Slide innerClassName="py-14 sm:py-16">
          <Rise i={0}>
            <div className="flex flex-wrap items-center justify-between gap-4">
              <Eyebrow>Interoperability</Eyebrow>
              <Badge variant="kortix" className="rounded">
                <MicrosoftMark className="mr-1.5 size-3" /> Microsoft is a Kortix investor
              </Badge>
            </div>
          </Rise>
          <Rise i={1}>
            <h2 className="text-foreground mt-4 max-w-3xl text-3xl font-medium tracking-tight text-balance sm:text-4xl">
              Runs alongside Copilot, <Dim>on the Microsoft estate you already have.</Dim>
            </h2>
          </Rise>
          <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <LogoTile
              i={2}
              icon={<CopilotMark />}
              title="GitHub Copilot"
              body="Sign in with the seat you already hold. It pays for the model — no second bill."
            />
            <LogoTile
              i={3}
              icon={<AzureMark />}
              title="Azure OpenAI"
              body="Or route through Azure on your own subscription, with your own keys."
            />
            <LogoTile
              i={4}
              icon={<MicrosoftMark />}
              title="Microsoft Entra"
              body="SAML 2.0 single sign-on and SCIM directory sync."
            />
            <LogoTile
              i={5}
              icon={<MicrosoftTeams />}
              title="Microsoft Teams"
              body="A message in a thread starts a session. The answer lands in the same thread."
            />
          </div>
          <Rise i={6}>
            <p className="text-muted-foreground mt-8 text-base">
              Nothing is replaced. Nothing is duplicated.{' '}
              <span className="text-foreground">Kortix is the layer on top.</span>
            </p>
          </Rise>
        </Slide>
      ),
    },

    /* ── 03 · The delta ──────────────────────────────────────────────────── */
    {
      id: 'delta',
      label: '03 · What Kortix adds',
      notes:
        'Kortix is the leading open-source alternative to Claude Cowork and ChatGPT Work — and it is built to work with Copilot, not against it.\n\nAll three of those are single-player: one assistant per person, in the vendor’s cloud, on the vendor’s models. Kortix is multiplayer: shared agents, skills and memory for the whole company. It does real work on real cloud computers and returns finished deliverables. And it is yours — any model, your infrastructure, every action on the record, open source, no lock-in.',
      node: (
        <Slide innerClassName="py-14 sm:py-16">
          <Rise i={0}>
            <Eyebrow>What Kortix adds</Eyebrow>
          </Rise>
          <Rise i={1}>
            <h2 className="text-foreground mt-4 max-w-4xl text-3xl font-medium tracking-tight text-balance sm:text-4xl">
              The leading open-source alternative to Claude Cowork and ChatGPT Work —{' '}
              <Dim>built to work with Copilot.</Dim>
            </h2>
          </Rise>
          <Rise i={2}>
            <Panel className="mt-8 grid overflow-hidden sm:grid-cols-4">
              {SINGLE_PLAYER.map((p, i) => (
                <div
                  key={p.id}
                  className={cn(
                    'border-border flex items-center gap-3 px-5 py-4',
                    i > 0 && 'border-t sm:border-t-0 sm:border-l',
                  )}
                >
                  <span className="text-foreground [&>*]:size-5">{p.icon}</span>
                  <span className="flex flex-col">
                    <span className="text-foreground text-sm font-medium">{p.name}</span>
                    <span className="text-muted-foreground text-xs">{p.note}</span>
                  </span>
                </div>
              ))}
              <div className="border-border flex items-center px-5 py-4 border-t sm:border-t-0 sm:border-l">
                <span className="text-muted-foreground font-mono text-[11px] tracking-wider uppercase">
                  One assistant per person, in the vendor’s cloud
                </span>
              </div>
            </Panel>
          </Rise>
          <div className="mt-6 grid gap-4 sm:grid-cols-3">
            {DELTA.map((d, i) => (
              <LogoTile key={d.id} i={i + 3} icon={d.icon} title={d.title} body={d.body} />
            ))}
          </div>
          <Rise i={6}>
            <div className="mt-8 flex items-center gap-4">
              <Pairing />
              <span className="text-muted-foreground text-base">
                Interoperable with Copilot. Owned by you.
              </span>
            </div>
          </Rise>
        </Slide>
      ),
    },
  ];
}
