'use client';

import { CliDemo } from '@/components/home/cli-demo';
import { Reveal } from '@/components/home/reveal';
import { Badge } from '@/components/ui/badge';
import { CodeBlockCode } from '@/components/ui/code-block';
import { KortixAsterisk } from '@/components/ui/kortix-asterisk';
import { Button } from '@/components/ui/marketing/button';
import KortixGrid from '@/components/ui/marketing/gridder';
import { KortixLetterField } from '@/components/ui/marketing/kortix-letter-field';
import { Icon } from '@/features/icon/icon';
import { useCopy } from '@/hooks/use-copy';
import { cn } from '@/lib/utils';
import {
  ArrowRight,
  Boxes,
  Check,
  Copy,
  Cpu,
  FileCode2,
  GitBranch,
  GitPullRequest,
  KeyRound,
  Plug,
  Server,
  Terminal as TerminalIcon,
  Workflow,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { AiOutlineCheck } from 'react-icons/ai';
import { HiArrowRight } from 'react-icons/hi';

const GITHUB_URL = 'https://github.com/kortix-ai/suna';
const DOCS_URL = '/docs';
const DEFAULT_INSTALL_HOST = 'kortix.com';
const fav = (d: string) => `https://www.google.com/s2/favicons?domain=${d}&sz=128`;

const C = {
  c: 'text-muted-foreground/70',
  s: 'text-emerald-600 dark:text-emerald-400',
  f: 'text-foreground',
};

function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-muted-foreground font-mono text-xs tracking-wider uppercase">
      {children}
    </span>
  );
}

function CodeWindowFrame({
  tab,
  children,
  className,
}: {
  tab?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className="border-border bg-card overflow-hidden rounded border">
      {tab && (
        <div className="border-border bg-card flex items-center gap-1 border-b p-2">
          <span className="bg-foreground text-background rounded px-3 py-0.5 text-sm font-medium">
            {tab}
          </span>
        </div>
      )}
      <div className={cn('min-h-[260px] overflow-x-auto px-5 py-4 font-mono text-sm', className)}>
        {children}
      </div>
    </div>
  );
}

function Terminal({ title, children }: { title?: string; children: React.ReactNode }) {
  return <CodeWindowFrame tab={title}>{children}</CodeWindowFrame>;
}

function Line({
  children = <>&nbsp;</>,
  className,
}: {
  children?: React.ReactNode;
  className?: string;
}) {
  return <div className={cn('flex leading-relaxed whitespace-pre', className)}>{children}</div>;
}

function Done({ children }: { children: React.ReactNode }) {
  return (
    <Line className="items-center justify-start gap-2">
      <span className={C.s}>
        <AiOutlineCheck className="size-3" />
      </span>
      <span className={C.f}>{children}</span>
    </Line>
  );
}

function Working({ children }: { children: React.ReactNode }) {
  return (
    <Line className="items-center justify-start gap-2">
      <span className={C.s}>
        <KortixAsterisk parentClass="animate-spin mt-0 size-3" index={0} variant="solid" />
      </span>
      <span className={C.f}>{children}</span>
    </Line>
  );
}

const PROMPT = <span className={cn(C.c, 'select-none')}>$ </span>;

function Cmd({ children }: { children: React.ReactNode }) {
  return (
    <Line>
      <span className={C.c}>{children}</span>
    </Line>
  );
}

function CodeFile({ name, code, language }: { name: string; code: string; language: string }) {
  const tab = name.split('/').pop() ?? name;
  return (
    <CodeWindowFrame tab={tab} className="px-0">
      <CodeBlockCode
        code={code.trim()}
        language={language}
        className="p-0 text-sm *:p-0 [&_pre]:!rounded-none [&_pre]:!bg-transparent [&_pre]:p-0 [&_span]:p-0"
      />
    </CodeWindowFrame>
  );
}

const MENTAL_MODEL = [
  {
    icon: Boxes,
    title: 'Agents are sandboxes',
    desc: 'Every agent runs in its own disposable cloud VM, on its own git branch. Spin up thousands in parallel — nothing is shared between runs.',
  },
  {
    icon: FileCode2,
    title: 'Work is code',
    desc: 'Agents, skills, triggers, connectors and policies are plain files in one repo. Diff them, review them in a change request, roll them back.',
  },
  {
    icon: Server,
    title: 'You own the stack',
    desc: 'Open and source-available. Self-host the exact same stack, bring your own runtime and model keys. No black box, no lock-in.',
  },
];

const CLI_GROUPS: { label: string; icon: typeof TerminalIcon; cmds: [string, string][] }[] = [
  {
    label: 'Scaffold & ship',
    icon: TerminalIcon,
    cmds: [
      ['kortix init', 'Scaffold kortix.toml + .kortix/'],
      ['kortix ship', 'Commit, push, link & go live'],
      ['kortix validate', 'Type-check your manifest'],
    ],
  },
  {
    label: 'Run & talk',
    icon: Workflow,
    cmds: [
      ['kortix sessions', 'Spawn & manage sandbox sessions'],
      ['kortix chat', "Talk to a session's agent"],
      ['kortix files', 'Browse the repo, diffs & branches'],
    ],
  },
  {
    label: 'Automate',
    icon: GitBranch,
    cmds: [
      ['kortix triggers', 'Cron & webhook automations'],
      ['kortix channels', 'Connect Slack & chat surfaces'],
    ],
  },
  {
    label: 'Connect',
    icon: Plug,
    cmds: [
      ['kortix connectors', 'Wire up 3,000+ tools'],
      ['kortix secrets', 'Manage encrypted secrets'],
      ['kortix env', 'Pull / push as dotenv'],
    ],
  },
  {
    label: 'Review',
    icon: GitPullRequest,
    cmds: [
      ['kortix cr', 'Open, review & merge change requests'],
      ['kortix access', 'Invite, grant & revoke access'],
    ],
  },
  {
    label: 'Operate',
    icon: KeyRound,
    cmds: [
      ['kortix self-host', 'Run your own Kortix cloud'],
      ['kortix hosts use', 'Switch cloud ↔ local'],
      ['kortix providers', 'Bring your own model keys'],
    ],
  },
];

const RUNS_ANYWHERE = [
  {
    icon: Server,
    title: 'Self-host anywhere',
    desc: 'A laptop, a VPS, your own VPC, or fully air-gapped — the exact same stack as Kortix cloud.',
  },
  {
    icon: Cpu,
    title: 'Any runtime',
    desc: 'An open runtime today, pluggable by design. The sandbox is yours to read and replace.',
  },
  {
    icon: KeyRound,
    title: 'Any model',
    desc: 'Bring your own keys — Anthropic, OpenAI, or local models — or run on Kortix compute.',
  },
];

const TOML = `kortix_version = 1

[project]
name = "acme"

# the OpenCode runtime config dir
[opencode]
config_dir = ".kortix/opencode"

# a trigger runs itself, on a schedule
[[triggers]]
slug = "daily-digest"
type = "cron"
agent = "research"
cron = "0 0 9 * * 1-5"
prompt = "Summarize yesterday across Slack & Linear"

# connect a tool's API as agent tools
[[connectors]]
slug = "stripe"
provider = "http"
base_url = "https://api.stripe.com"

# answer where your team works
[[channels]]
platform = "slack"
agent = "support"`;

const AGENT_MD = `---
description: Acme's support agent. Resolves tickets end to end.
mode: primary
model: anthropic/claude-opus-4-8
tools:
  lookup_order: true
---

You are Acme's support agent. Resolve customer tickets
end to end, with full product and order context.

Issue refunds under $500 on your own. Anything higher
goes to a human for approval.`;

function Step({
  n,
  title,
  body,
  children,
  flip = false,
}: {
  n: string;
  title: string;
  body: string;
  children: React.ReactNode;
  flip?: boolean;
}) {
  const { copied, copy } = useCopy();
  const [installHost, setInstallHost] = useState(DEFAULT_INSTALL_HOST);
  const installCmd = `curl -fsSL https://${installHost}/install | bash`;

  const badgeClass =
    'border-border bg-card text-foreground flex size-9 shrink-0 items-center justify-center rounded border font-mono text-sm font-medium ';

  return (
    <div className="relative mx-auto flex w-full max-w-[calc(70rem+9rem)] items-start gap-6">
      <div className="bg-border absolute top-0 left-4 hidden h-dvh w-px rounded-full lg:flex" />
      <span className="hidden lg:flex">
        <span className={cn('sticky top-40 z-10 shrink-0', badgeClass)}>{n}</span>
      </span>
      <div className="grid w-full max-w-6xl min-w-0 flex-1 grid-cols-1 items-start gap-8 lg:grid-cols-2 lg:gap-14">
        <Reveal className={cn(flip && 'min-h-0 flex-1 grow space-y-5 lg:order-2')}>
          <div className="flex items-center gap-3.5 lg:hidden">
            <span className={cn(badgeClass)}>{n}</span>
          </div>
          <h3 className="text-foreground text-2xl font-medium tracking-tight sm:text-3xl">
            {title}
          </h3>
          <p className="text-muted-foreground mt-4 max-w-md text-base leading-relaxed">{body}</p>
          {n === '01' && (
            <div className="bg-card mt-5 flex items-center justify-between gap-4 rounded-sm border p-3 px-5">
              <div className="flex gap-3">
                <span className="text-foreground font-mono text-sm">$ </span>
                <span className="text-foreground font-mono text-sm select-all">{installCmd}</span>
              </div>
              <Button size="icon-sm" variant="ghost" onClick={() => copy(installCmd)}>
                {copied ? <Check className="text-primary size-4" /> : <Copy className="size-4" />}
              </Button>
            </div>
          )}
        </Reveal>
        <Reveal delay={0.1} className={cn('min-w-0', flip && 'lg:order-1')}>
          {children}
        </Reveal>
      </div>
    </div>
  );
}

const KORTIX_TOML = `name = "acme-ops"

[sandbox]
image = ".kortix/Dockerfile"

[[agents]]
name   = "support-triage"
model  = "anthropic/claude-opus-4-8"
skills = ["ticket-triage", "kortix-memory"]

[[triggers]]
type     = "cron"
schedule = "0 8 * * *"
agent    = "support-triage"

[connectors]
slack  = true
linear = true`;

const REPO_TREE: [string, number, 'dir' | 'file' | 'accent'][] = [
  ['acme-ops', 0, 'dir'],
  ['kortix.toml', 1, 'accent'],
  ['.kortix', 1, 'dir'],
  ['opencode', 2, 'dir'],
  ['agents', 3, 'dir'],
  ['support-triage.md', 4, 'file'],
  ['skills', 3, 'dir'],
  ['ticket-triage', 4, 'dir'],
  ['tools', 3, 'dir'],
  ['web_search.ts', 4, 'file'],
  ['Dockerfile', 2, 'file'],
];

const CONNECTOR_APPS: [string, string][] = [
  ['slack.com', 'Slack'],
  ['github.com', 'GitHub'],
  ['salesforce.com', 'Salesforce'],
  ['notion.so', 'Notion'],
  ['stripe.com', 'Stripe'],
  ['linear.app', 'Linear'],
];

const CONNECTOR_PROTOCOLS = ['App', 'MCP', 'OpenAPI', 'GraphQL', 'HTTP'] as const;

function FlowLine({ label }: { label?: string }) {
  return (
    <div className="flex flex-col items-center py-1">
      <div className="bg-border/70 h-3 w-px" aria-hidden />
      {label ? (
        <span className="text-muted-foreground py-1 text-center text-[10px] leading-snug sm:text-[11px]">
          {label}
        </span>
      ) : null}
      <div className="bg-border/70 h-3 w-px" aria-hidden />
    </div>
  );
}

function ConnectorsRequestPath() {
  return (
    <div className="border-border bg-card overflow-hidden rounded-sm border">
      <div className="border-border/60 bg-background/30 flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b px-4 py-2.5">
        <span className="text-muted-foreground font-mono text-xs">connectors · request path</span>
        <div className="flex flex-wrap gap-1">
          {CONNECTOR_PROTOCOLS.map((protocol) => (
            <Badge key={protocol} variant={protocol === 'App' ? 'highlight' : 'outline'} size="sm">
              {protocol}
            </Badge>
          ))}
        </div>
      </div>

      <div className="text-foreground px-4 py-6 font-mono text-xs sm:text-sm">
        <div className="border-border/60 bg-background/60 flex items-center gap-2.5 rounded-sm border border-dashed px-3 py-2.5">
          <Boxes className="text-muted-foreground/70 size-4 shrink-0" />
          <span className="font-medium">sandbox</span>
          <span className="text-muted-foreground ml-auto text-[11px]">agent runtime</span>
        </div>

        <FlowLine label="only a scoped token leaves the box" />

        <div className="flex justify-center pb-1">
          <span className="border-border bg-background/70 text-muted-foreground inline-flex items-center gap-1.5 rounded-sm border px-2.5 py-1 font-mono text-[10px] sm:text-[11px]">
            <KeyRound className="size-3 shrink-0" />
            KORTIX_TOKEN
          </span>
        </div>

        <FlowLine />

        <div className="border-border bg-card ring-border/40 flex items-center gap-2.5 rounded-sm border px-3 py-3 ring-1">
          <Server className="text-foreground size-4 shrink-0" />
          <span className="font-medium">Kortix Executor</span>
          <span className="text-muted-foreground ml-auto text-[10px] sm:text-[11px]">
            connect proxy · gateway
          </span>
        </div>

        <FlowLine />

        <div className="flex flex-wrap items-center justify-center gap-1.5 pt-0.5">
          {CONNECTOR_APPS.map(([domain, name]) => (
            <div
              key={name}
              className="border-border/50 bg-background/70 flex items-center gap-1.5 rounded-sm border px-2 py-1"
            >
              <img
                src={fav(domain)}
                alt={name}
                width={14}
                height={14}
                loading="lazy"
                className="size-3.5 shrink-0"
              />
              <span className="text-foreground text-[11px] font-medium">{name}</span>
            </div>
          ))}
        </div>
        <p className="text-muted-foreground/70 mt-2.5 text-center text-[10px] sm:text-[11px]">
          + 3,000 more via Pipedream
        </p>
      </div>
    </div>
  );
}

function HeroWorkspace() {
  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[0.9fr_1.1fr]">
      <div className="border-card bg-background overflow-hidden rounded-[calc(var(--radius)+2px)] border-4">
        <div className="border-border/60 bg-muted/30 text-muted-foreground flex items-center gap-2 border-b px-4 py-2.5 font-mono text-xs">
          <GitBranch className="size-3.5" /> the repo is the product
        </div>
        <div className="text-foreground px-4 py-3 font-mono text-sm">
          {REPO_TREE.map(([name, depth, kind], i) => (
            <div
              key={i}
              className="flex items-center gap-2 py-0.5"
              style={{ paddingLeft: `${depth * 14}px` }}
            >
              {kind === 'dir' ? (
                <Boxes className="text-muted-foreground/60 size-3.5 shrink-0" />
              ) : (
                <FileCode2
                  className={cn(
                    'size-3.5 shrink-0',
                    kind === 'accent' ? 'text-kortix-green' : 'text-muted-foreground/60',
                  )}
                />
              )}
              <span
                className={cn(
                  'tracking-normal',
                  kind === 'accent'
                    ? 'text-foreground font-medium'
                    : kind === 'dir'
                      ? 'text-foreground/80'
                      : 'text-muted-foreground',
                )}
              >
                {name}
                {kind === 'dir' ? '/' : ''}
              </span>
            </div>
          ))}
        </div>
      </div>

      <div className="border-card bg-background overflow-hidden rounded-[calc(var(--radius)+2px)] border-4">
        <div className="border-border/60 bg-muted/30 flex items-center gap-2 border-b px-4 py-2.5">
          <span className="bg-foreground text-background rounded px-2.5 py-0.5 font-mono text-xs font-medium">
            kortix.toml
          </span>
          <span className="text-muted-foreground font-mono text-xs">declare it once</span>
        </div>
        <div className="text-foreground overflow-x-auto text-sm">
          <CodeBlockCode
            code={KORTIX_TOML}
            language="toml"
            className="[&_pre]:rounded-none [&_pre]:px-0"
          />
        </div>
      </div>
    </div>
  );
}

export default function DevelopersPage() {
  const { copied, copy } = useCopy();
  const [installHost, setInstallHost] = useState(DEFAULT_INSTALL_HOST);
  const tHardcodedUi = useTranslations('hardcodedUi');
  const tHome = useCallback(
    (key: string) => tHardcodedUi.raw(`appHomePage.${key}`),
    [tHardcodedUi],
  );

  const installCmd = `curl -fsSL https://${installHost}/install | bash`;

  useEffect(() => {
    setInstallHost(window.location.host);
  }, []);

  return (
    <div className="bg-background relative w-full">
      <section
        id="hero"
        className="relative w-full max-w-none overflow-hidden pt-32 pb-12 sm:pt-36"
      >
        <div className="absolute inset-0 z-0 mask-y-to-95%">
          <KortixLetterField seed={3382} />
        </div>
        <div className="relative z-10 mx-auto max-w-6xl px-6 lg:px-0">
          <section className="w-full">
            <h1 className="text-foreground mt-5 text-4xl leading-[1.1] font-medium tracking-tight md:text-5xl">
              One kortix.toml. One Git repo.
              <br />
              <span className="text-muted-foreground">Your entire AI workforce, as code.</span>
            </h1>
            <p className="text-muted-foreground mt-6 max-w-xl text-lg leading-relaxed">
              Agents, skills, tools, connectors, schedules — all just files in a repo. Edit them in
              your IDE, run them locally, ship to the cloud with one command. Open source,
              self-hostable, yours.
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <div className="bg-card flex items-center gap-4 rounded-sm border p-3 px-5">
                <div className="flex gap-3">
                  <span className="text-foreground font-mono text-sm">$ </span>
                  <span className="text-foreground font-mono text-sm select-all">{installCmd}</span>
                </div>
                <Button size="icon-sm" variant="ghost" onClick={() => copy(installCmd)}>
                  {copied ? <Check className="text-primary size-4" /> : <Copy className="size-4" />}
                </Button>
              </div>
              <Button
                size="xl"
                variant="secondary"
                className="ring-ring/15 p-3 px-5 ring-2"
                asChild
              >
                <Link href={DOCS_URL}>
                  Read the docs <HiArrowRight className="size-4" />
                </Link>
              </Button>
            </div>
          </section>

          <div className="relative z-10 mt-12 sm:mt-14">
            <Reveal>
              <HeroWorkspace />
            </Reveal>
          </div>

          <div id="demo" className="relative z-10 mt-6 h-full w-full scroll-mt-24 sm:mt-8">
            <CliDemo />
          </div>
        </div>
      </section>

      <section className="mx-auto flex max-w-6xl flex-col gap-10 px-6 py-16 sm:gap-12 sm:py-24 lg:px-0">
        <Reveal>
          <div className="mb-8 max-w-2xl">
            <Eyebrow>The thesis</Eyebrow>
            <h2 className="text-foreground mt-3 text-2xl leading-tight font-medium tracking-tight sm:text-3xl md:text-4xl">
              The coding-agent loop, for real work
            </h2>
            <p className="text-muted-foreground mt-4 text-base leading-relaxed">
              Describe intent, an agent edits files, you review the diff. Kortix runs that same loop
              for support, ops, and research.
            </p>
          </div>
        </Reveal>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          {MENTAL_MODEL.map(({ icon: Icon, title, desc }, i) => (
            <Reveal key={title} delay={i * 0.08}>
              <div className="border-border bg-card flex h-full w-full flex-col justify-between space-y-8 rounded-sm border p-4 transition">
                <span className="border-border bg-background text-foreground flex size-10 items-center justify-center rounded-lg border">
                  <Icon className="text-foreground size-5 shrink-0" />
                </span>
                <div className="flex flex-col gap-0.5">
                  <p className="text-foreground text-base transition">{title}</p>
                  <p className="text-muted-foreground text-sm text-balance transition">{desc}</p>
                </div>
              </div>
            </Reveal>
          ))}
        </div>
      </section>

      <section className="flex flex-col gap-10 px-6 py-16 sm:gap-12 sm:py-24 lg:px-0">
        <div className="mx-auto w-full max-w-6xl">
          <Reveal>
            <div className="mb-8 max-w-2xl">
              <Eyebrow>The loop</Eyebrow>
              <h2 className="text-muted-foreground mt-3 text-2xl leading-tight font-medium tracking-tight sm:text-3xl md:text-4xl">
                From <span className="text-foreground font-mono">curl</span> to production
              </h2>
              <p className="text-muted-foreground mt-4 text-base leading-relaxed">
                One repo, one config, one command. The whole path, top to bottom.
              </p>
            </div>
          </Reveal>
        </div>

        <div className="flex flex-col gap-20 sm:gap-24">
          <Step
            n="01"
            title="Install & scaffold"
            body="One line installs the CLI. kortix init scaffolds kortix.toml and .kortix/, wired to your coding agent."
          >
            <Terminal title="init">
              <Cmd>kortix init</Cmd>
              <Done>kortix.toml</Done>
              <Done>.kortix/opencode/</Done>
            </Terminal>
          </Step>

          <Step
            n="02"
            title="Build it locally, like code"
            body="An agent is markdown — a persona, its model, and its tools. Skills are folders it loads on demand. Edit them by hand, or describe what you want and let your coding agent write them."
            flip
          >
            <CodeFile
              name=".kortix/opencode/agents/support.md"
              code={AGENT_MD}
              language="markdown"
            />
          </Step>

          <Step
            n="03"
            title="Declare the project in one manifest"
            body="kortix.toml holds secrets, sandbox images, triggers, connectors, and channels. Versioned from the first commit."
          >
            <CodeFile name="kortix.toml" code={TOML} language="toml" />
          </Step>

          <Step
            n="04"
            title="Ship it"
            body="kortix ship commits, pushes, builds the sandbox, and prompts for missing secrets. Triggers and channels go live immediately — no separate infra to stand up."
            flip
          >
            <Terminal title="kortix ship">
              <Cmd>kortix ship</Cmd>
              <Done>
                committed &amp; pushed to <span className={C.f}>main</span>
              </Done>
              <Done>secrets synced · sandbox built</Done>
              <Working>live — triggers &amp; channels running</Working>
            </Terminal>
          </Step>

          <Step
            n="05"
            title="It runs as a fleet of sandboxes"
            body="Every session is its own VM on its own branch, booting the runtime and your repo. Spawn thousands in parallel — zero interference. A change request is the only way work reaches main, so everything is reviewable and reversible."
          >
            <Terminal>
              <Line>
                <span className="text-foreground">main</span>
                <span className="text-muted-foreground/50"> ──────●────────●────────●────▶</span>
              </Line>
              <Line>
                <span className="text-muted-foreground/50"> ├─ </span>
                <span className="text-foreground">session 1f3a</span>
                <span className="text-muted-foreground/50"> sandbox ─╮</span>
              </Line>
              <Line>
                <span className="text-muted-foreground/50"> ├─ </span>
                <span className="text-foreground">session 9b22</span>
                <span className="text-muted-foreground/50"> sandbox ─┤ change</span>
              </Line>
              <Line>
                <span className="text-muted-foreground/50"> ├─ </span>
                <span className="text-foreground">session 4e07</span>
                <span className="text-muted-foreground/50"> sandbox ─┤ requests</span>
              </Line>
              <Line>
                <span className="text-muted-foreground/50"> └─ </span>
                <span className="text-foreground">… ×1000</span>
                <span className="text-muted-foreground/50"> sandboxes ─╯</span>
              </Line>
              <Line>&nbsp;</Line>
              <Line>
                <span className="text-muted-foreground/50"> review → merge → main</span>
              </Line>
            </Terminal>
          </Step>

          <Step
            n="06"
            title="Bring your own runtime & model"
            body="Sessions run on an open runtime. Bring your own keys — Anthropic, OpenAI, local — or use Kortix compute. Nothing about the runtime is hidden."
            flip
          >
            <Terminal>
              <Line>
                {PROMPT}
                <span className="text-foreground">kortix providers login anthropic</span>
              </Line>
              <Done>
                using your own key <span className="text-muted-foreground/60">(byo)</span>
              </Done>
              <Line>&nbsp;</Line>
              <Line>
                <span className="text-muted-foreground/50"># or point at any runtime / model</span>
              </Line>
              <Line>
                {PROMPT}
                <span className="text-foreground">kortix providers set --model opus-4.8</span>
              </Line>
              <Line>
                {PROMPT}
                <span className="text-foreground">kortix providers set --model gpt-5</span>
              </Line>
            </Terminal>
          </Step>
        </div>
      </section>

      <section className="mx-auto flex max-w-6xl flex-col gap-10 px-6 py-16 sm:gap-12 sm:py-24 lg:px-0">
        <Reveal>
          <div className="mb-8 max-w-2xl">
            <Eyebrow>One CLI</Eyebrow>
            <h2 className="text-foreground mt-3 text-2xl leading-tight font-medium tracking-tight sm:text-3xl md:text-4xl">
              The whole lifecycle, one CLI
            </h2>
            <p className="text-muted-foreground mt-4 text-base leading-relaxed">
              Scaffold, ship, run, automate, connect and review — one CLI does it all. The same
              binary is pre-authenticated inside every sandbox, so agents drive Kortix with the
              exact commands you do.
            </p>
          </div>
        </Reveal>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {CLI_GROUPS.map(({ label, icon: Icon, cmds }, i) => (
            <Reveal key={label} delay={(i % 3) * 0.06}>
              <div className="group border-border bg-card hover:bg-background flex h-full flex-col rounded-sm border p-5 transition-colors">
                <div className="flex items-center gap-3">
                  <span className="border-border bg-background text-foreground flex size-10 items-center justify-center rounded-lg border">
                    <Icon className="text-foreground size-4" />
                  </span>
                  <h3 className="text-foreground text-sm font-semibold">{label}</h3>
                </div>
                <div className="mt-4 flex flex-col gap-0.5">
                  {cmds.map(([cmd, desc]) => (
                    <div
                      key={cmd}
                      className="hover:bg-muted/60 -mx-2 rounded-md px-2 py-1.5 transition-colors"
                    >
                      <code className="font-mono text-sm">
                        <span className="text-muted-foreground/40 select-none">$ </span>
                        <span className="text-foreground">{cmd}</span>
                      </code>
                      <p className="text-muted-foreground mt-0.5 text-xs leading-relaxed">{desc}</p>
                    </div>
                  ))}
                </div>
              </div>
            </Reveal>
          ))}
        </div>
        <Reveal delay={0.1}>
          <div>
            <Link
              href={`${DOCS_URL}/reference/cli`}
              className="group text-foreground inline-flex items-center gap-1.5 text-sm font-medium"
            >
              Full CLI reference
              <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
            </Link>
          </div>
        </Reveal>
      </section>

      {/* Scalability */}
      <section className="mx-auto flex max-w-6xl flex-col gap-10 px-6 py-16 sm:gap-12 sm:py-24 lg:px-0">
        <div className="grid grid-cols-1 items-center gap-10 lg:grid-cols-2 lg:gap-16">
          <Reveal>
            <Eyebrow>Scale</Eyebrow>
            <h2 className="text-foreground mt-3 text-2xl leading-tight font-medium tracking-tight sm:text-3xl md:text-4xl">
              1 session = 1 sandbox = 1 branch
            </h2>
            <p className="text-muted-foreground mt-4 max-w-md text-base leading-relaxed">
              Every session runs in its own isolated sandbox — real, isolated compute — on its own
              Git branch off main. Spin up millions in parallel; nothing collides.
            </p>
            <ul className="mt-6 max-w-md space-y-2.5">
              {[
                'Anything worth keeping comes back as a change request — and merges into main',
                'Main is always the source of truth: every agent action is auditable Git history',
                'It’s all Git under the hood — branch, diff, review, merge',
                'The same Kortix CLI runs inside every sandbox — so running locally and in the cloud is identical',
                'Isolated compute per session; one runaway agent can’t touch another',
              ].map((b, i) => (
                <li
                  key={b}
                  className="text-muted-foreground flex gap-2.5 text-[15px] leading-relaxed"
                >
                  <KortixAsterisk index={i} />
                  <span>{b}</span>
                </li>
              ))}
            </ul>
          </Reveal>
          <Reveal delay={0.1}>
            <CodeWindowFrame tab="git log --graph">
              <Line>
                <span className={C.s}>*</span>
                <span className={C.f}>{'  c7e2  CR #84 merged'}</span>
                <span className={C.c}>{'   (main)'}</span>
              </Line>
              <Line>
                <span className={C.c}>{'|\\'}</span>
              </Line>
              <Line>
                <span className={C.c}>{'| *  s_7f2a  '}</span>
                <span className={C.f}>triage 14 tickets</span>
              </Line>
              <Line>
                <span className={C.c}>{'| *  s_3c1d  '}</span>
                <span className={C.f}>build board deck</span>
              </Line>
              <Line>
                <span className={C.c}>{'| *  s_9a04  '}</span>
                <span className={C.f}>draft outreach</span>
              </Line>
              <Line>
                <span className={C.c}>{'|/'}</span>
              </Line>
              <Line>
                <span className={C.s}>*</span>
                <span className={C.f}>{'  a1f3  baseline'}</span>
                <span className={C.c}>{'   (main)'}</span>
              </Line>
              <Line>&nbsp;</Line>
              <Line>
                <span className={C.c}>… millions of branches, one source of truth</span>
              </Line>
            </CodeWindowFrame>
          </Reveal>
        </div>
      </section>

      {/* Connectors */}
      <section className="mx-auto flex max-w-6xl flex-col gap-10 px-6 py-16 sm:gap-12 sm:py-24 lg:px-0">
        <div className="grid grid-cols-1 items-center gap-10 lg:grid-cols-2 lg:gap-16">
          <Reveal className="lg:order-2">
            <Eyebrow>Connectors</Eyebrow>
            <h2 className="text-foreground mt-3 text-2xl leading-tight font-medium tracking-tight sm:text-3xl md:text-4xl">
              Every tool, behind one interface
            </h2>
            <p className="text-muted-foreground mt-4 max-w-md text-base leading-relaxed">
              Kortix connectors put 3,000+ apps — plus any MCP, OpenAPI, GraphQL or raw HTTP
              endpoint — behind a single Executor interface your agents call like any other tool.
            </p>
            <ul className="mt-6 max-w-md space-y-2.5">
              {[
                '3,000+ one-click apps via Pipedream — OAuth handled for you',
                'Or bring any MCP, OpenAPI, GraphQL or HTTP endpoint — same interface',
                'Credentials live server-side and never reach the sandbox',
                'Agents hold one scoped Kortix token; connect once, shared org-wide, self-healing',
              ].map((b, i) => (
                <li
                  key={b}
                  className="text-muted-foreground flex gap-2.5 text-[15px] leading-relaxed"
                >
                  <KortixAsterisk index={i} />
                  <span>{b}</span>
                </li>
              ))}
            </ul>
          </Reveal>
          <Reveal delay={0.1} className="lg:order-1">
            <ConnectorsRequestPath />
          </Reveal>
        </div>
      </section>

      <section className="mx-auto flex max-w-6xl flex-col gap-10 px-6 py-16 sm:gap-12 sm:py-24 lg:px-0">
        <Reveal>
          <div className="mb-2 max-w-2xl">
            <Eyebrow>It&apos;s all code</Eyebrow>
            <h2 className="text-foreground mt-3 text-2xl leading-tight font-medium tracking-tight sm:text-3xl md:text-4xl">
              A platform that improves itself
            </h2>
            <p className="text-muted-foreground mt-4 text-base leading-relaxed">
              Because everything is code in a repo, the system can read its own blueprint, extend
              itself, and stay healthy as it grows. 100% extensible, controllable, self-hostable —
              nothing is a black box.
            </p>
          </div>
        </Reveal>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {[
            {
              icon: FileCode2,
              title: 'Everything is files',
              body: 'Agents, skills, tools, connectors and schedules live in the repo. Edit in your IDE, in the web UI, or let an agent edit them.',
            },
            {
              icon: Workflow,
              title: 'Agents edit themselves',
              body: 'Describe a change and an agent ships it — referencing what already exists, reusing patterns, opening a PR you review.',
            },
            {
              icon: GitPullRequest,
              title: 'Skills, git-backed and invisible',
              body: 'Non-devs publish skills as markdown; Kortix handles the branch, PR and merge behind the scenes. Versioned, reviewable, auditable.',
            },
            {
              icon: Plug,
              title: 'Self-healing integrations',
              body: 'When a token expires or a service blips, Kortix refreshes it or asks you to reconnect in plain language — never a cryptic error.',
            },
            {
              icon: Cpu,
              title: 'Quality gates built in',
              body: 'Type checks, lint, docs validation and dedup run before anything merges, so a fast-moving, agent-written codebase stays coherent.',
            },
            {
              icon: TerminalIcon,
              title: 'Every feature is a conversation',
              body: 'The UI is a reference, not a requirement. Anything you can do in a menu, you can do with a message.',
            },
          ].map((f) => (
            <Reveal key={f.title}>
              <div className="border-border bg-card flex h-full flex-col rounded-sm border p-6">
                <span className="border-border bg-background text-foreground flex size-10 items-center justify-center rounded-lg border">
                  <f.icon className="size-5" />
                </span>
                <h3 className="text-foreground mt-4 text-base font-medium tracking-tight">
                  {f.title}
                </h3>
                <p className="text-muted-foreground mt-2 text-sm leading-relaxed">{f.body}</p>
              </div>
            </Reveal>
          ))}
        </div>
      </section>

      <section id="cta" className="relative mx-auto max-w-6xl px-6 py-16 sm:py-24 lg:px-0">
        <Reveal>
          <div className="border-border bg-card relative overflow-hidden rounded-sm border text-center">
            <div className="flex grid-cols-12 flex-col-reverse gap-2 md:grid">
              <div className="col-span-4 flex flex-col items-start justify-start space-y-4 p-6 *:text-left">
                <div className="space-y-2">
                  <Badge variant="update" className="rounded">
                    Start building
                  </Badge>
                  <h2 className="text-foreground text-2xl leading-tight font-medium tracking-tight sm:text-3xl">
                    Ship your first internal agent
                  </h2>

                  <span className="text-muted-foreground text-sm leading-relaxed">
                    Install the CLI, run{' '}
                    <span className="text-foreground font-mono text-sm">kortix init</span>, and
                    deploy the agent you already use.
                  </span>
                </div>

                <div className="mt-auto grid w-full grid-cols-1 gap-2 sm:grid-cols-2">
                  <Button size="lg" asChild className="w-full">
                    <Link href={DOCS_URL}>
                      Read the docs
                      <HiArrowRight className="size-4" />
                    </Link>
                  </Button>
                  <Button asChild size="lg" className="w-full" variant="accent">
                    <Link href={GITHUB_URL}>
                      Star on GitHub
                      <Icon.Github />
                    </Link>
                  </Button>
                </div>
              </div>
              <div className="col-span-8 mask-y-from-90% mask-x-from-90%">
                <KortixGrid count={58} seed={4228} />
              </div>
            </div>
          </div>
        </Reveal>
      </section>

      <div className="h-24 sm:h-28" />
    </div>
  );
}
