'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import {
  ArrowRight,
  Check,
  Copy,
  Terminal as TerminalIcon,
  FileCode2,
  Boxes,
  GitPullRequest,
  Workflow,
  Plug,
  KeyRound,
  Server,
  Cpu,
  GitBranch,
} from 'lucide-react';
import { CodeBlockCode } from '@/components/ui/code-block';
import { useGitHubStars } from '@/hooks/utils/use-github-stars';
import { cn } from '@/lib/utils';
import { RepoBrowser } from '@/components/home/developers/repo-browser';

const GITHUB_URL = 'https://github.com/kortix-ai/suna';
const DOCS_URL = '/docs';
const DEFAULT_INSTALL_HOST = 'kortix.com';

/* ── small building blocks ───────────────────────────────────────────────── */

function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-2 font-mono text-xs uppercase tracking-[0.18em] text-muted-foreground">
      <span className="h-px w-5 bg-border" />
      {children}
    </span>
  );
}

/**
 * Content is visible by default; the entrance animation is pure enhancement
 * that plays on scroll-in. If the observer never fires, nothing is ever hidden.
 */
function Reveal({ children, className, delay = 0 }: { children: React.ReactNode; className?: string; delay?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [play, setPlay] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([e]) => { if (e.isIntersecting) { setPlay(true); io.disconnect(); } },
      { threshold: 0.12, rootMargin: '0px 0px -40px 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return (
    <div
      ref={ref}
      className={cn(play && 'animate-in fade-in slide-in-from-bottom-3 fill-mode-both', className)}
      style={play ? { animationDuration: '650ms', animationDelay: `${delay * 1000}ms` } : undefined}
    >
      {children}
    </div>
  );
}

/* A calm, monochrome terminal frame. No fake traffic lights. */
function Terminal({ title = 'terminal', children }: { title?: string; children: React.ReactNode }) {
  return (
    <div className="overflow-hidden rounded-2xl border border-border/70 bg-card shadow-[0_20px_50px_-30px_rgba(0,0,0,0.4)]">
      <div className="flex h-9 items-center gap-2 border-b border-border/60 bg-muted/30 px-3.5">
        <TerminalIcon className="size-3.5 text-muted-foreground/70" />
        <span className="font-mono text-xs text-muted-foreground">{title}</span>
      </div>
      <div className="overflow-x-auto px-4 py-3.5 font-mono text-xs leading-relaxed sm:text-sm">{children}</div>
    </div>
  );
}

function Line({ children = <>&nbsp;</> }: { children?: React.ReactNode }) {
  return <div className="whitespace-pre">{children}</div>;
}
/** A completed step line: monochrome check + muted text. */
function Done({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 whitespace-pre text-muted-foreground">
      <Check className="size-3.5 shrink-0 text-foreground/70" />
      {children}
    </div>
  );
}
const PROMPT = <span className="select-none text-muted-foreground/50">$ </span>;

/** An emphasized single command — the hero of a terminal block. */
function Cmd({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-2 whitespace-pre">
      <span className="select-none text-base text-muted-foreground/40 sm:text-lg">$</span>
      <span className="text-base font-medium tracking-tight text-foreground sm:text-lg">{children}</span>
    </div>
  );
}

/* A labelled code file — real Shiki highlighting, the same the product uses. */
function CodeFile({ name, code, language }: { name: string; code: string; language: string }) {
  return (
    <div>
      <div className="mb-2 flex items-center gap-1.5 font-mono text-xs text-muted-foreground">
        <FileCode2 className="size-3.5" />
        {name}
      </div>
      <CodeBlockCode
        code={code.trim()}
        language={language}
        className="rounded-2xl border border-border/60 text-sm shadow-[0_20px_50px_-30px_rgba(0,0,0,0.4)]"
      />
    </div>
  );
}

/* ── content data ────────────────────────────────────────────────────────── */

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
  { icon: Server, title: 'Self-host anywhere', desc: 'A laptop, a VPS, your own VPC, or fully air-gapped — the exact same stack as Kortix cloud.' },
  { icon: Cpu, title: 'Any runtime', desc: 'An open runtime today, pluggable by design. The sandbox is yours to read and replace.' },
  { icon: KeyRound, title: 'Any model', desc: 'Bring your own keys — Anthropic, OpenAI, or local models — or run on Kortix compute.' },
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

/* ── one numbered step of the build → ship loop ──────────────────────────── */

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
  return (
    <div className="grid grid-cols-1 items-center gap-8 lg:grid-cols-2 lg:gap-14">
      <Reveal className={cn(flip && 'lg:order-2')}>
        <div className="flex items-center gap-3.5">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-full border border-border bg-card font-mono text-sm font-medium text-foreground">{n}</span>
          <span className="h-px flex-1 bg-gradient-to-r from-border to-transparent" />
        </div>
        <h3 className="mt-5 text-2xl font-medium tracking-tight text-foreground sm:text-3xl">{title}</h3>
        <p className="mt-4 max-w-md text-base leading-relaxed text-muted-foreground">{body}</p>
      </Reveal>
      <Reveal delay={0.1} className={cn('min-w-0', flip && 'lg:order-1')}>
        {children}
      </Reveal>
    </div>
  );
}

/* ── page ────────────────────────────────────────────────────────────────── */

export default function DevelopersPage() {
  const [copied, setCopied] = useState(false);
  const [installHost, setInstallHost] = useState(DEFAULT_INSTALL_HOST);
  const { formattedStars } = useGitHubStars('kortix-ai', 'kortix');

  const installCmd = `curl -fsSL https://${installHost}/install | bash`;

  useEffect(() => {
    setInstallHost(window.location.host);
  }, []);

  const copyInstall = useCallback(() => {
    navigator.clipboard.writeText(installCmd);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [installCmd]);

  const InstallPill = (
    <button
      onClick={copyInstall}
      className="group inline-flex h-10 w-fit max-w-full items-center gap-2.5 overflow-hidden rounded-full border border-border bg-background/70 px-4 backdrop-blur-sm transition-colors hover:border-foreground/20"
    >
      <span className="shrink-0 select-none font-mono text-xs text-muted-foreground">$</span>
      <code className="overflow-x-auto whitespace-nowrap font-mono text-xs tracking-tight text-foreground [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">{installCmd}</code>
      <span className="shrink-0 border-l border-border pl-2.5">
        {copied ? <Check className="size-3.5 text-foreground" /> : <Copy className="size-3.5 text-muted-foreground transition-colors group-hover:text-foreground" />}
      </span>
    </button>
  );

  const GitHubLink = (
    <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground">
      <svg viewBox="0 0 24 24" className="size-4" fill="currentColor" aria-hidden="true">
        <path d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0 1 12 6.844a9.59 9.59 0 0 1 2.504.337c1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.02 10.02 0 0 0 22 12.017C22 6.484 17.522 2 12 2z" />
      </svg>
      <span className="font-medium tabular-nums">{formattedStars}</span>
      <span>stars</span>
    </a>
  );

  return (
    <div className="relative bg-background">
      {/* ═══════════════ HERO ═══════════════ */}
      <section className="relative overflow-hidden border-b border-border/60">
        <div className="pointer-events-none absolute inset-x-0 top-0 h-[460px] bg-gradient-to-b from-muted/50 to-transparent" />
        <div className="pointer-events-none absolute inset-0 opacity-[0.35] [background-image:radial-gradient(var(--border)_1px,transparent_1px)] [background-size:24px_24px] [mask-image:radial-gradient(ellipse_60%_45%_at_50%_0%,black,transparent)]" />

        <div className="relative mx-auto max-w-5xl px-6 pt-32 sm:pt-40">
          <div className="mx-auto max-w-3xl text-center">
            <div className="flex justify-center"><Eyebrow>Developers</Eyebrow></div>
            <h1 className="mt-5 text-[2.7rem] font-medium leading-[1.03] tracking-tight text-foreground sm:text-6xl md:text-[4.25rem]">
              Your company,<br />
              <span className="text-muted-foreground">as a git repo.</span>
            </h1>
            <p className="mx-auto mt-6 max-w-xl text-base leading-relaxed text-muted-foreground sm:text-lg">
              Coding agents changed how we build software. Kortix brings the same loop to all
              knowledge work — every agent, skill and automation is a file in one repo you own.
              Build it locally, ship it with one command, run it as a fleet of cloud sandboxes.
            </p>
            <div className="mt-8 flex flex-col items-center gap-5">
              {InstallPill}
              <div className="flex flex-wrap items-center justify-center gap-x-5 gap-y-2">
                <Link href={DOCS_URL} className="text-sm font-medium text-foreground transition-colors hover:text-muted-foreground">Read the docs →</Link>
                <span className="h-3.5 w-px bg-border" />
                {GitHubLink}
              </div>
            </div>
          </div>

          {/* the product, immediately — the real file viewer over a real repo */}
          <Reveal delay={0.1} className="relative mt-16 pb-24">
            <div className="pointer-events-none absolute inset-x-12 top-6 -z-10 h-40 rounded-full bg-foreground/[0.06] blur-[100px]" />
            <RepoBrowser />
            <p className="mt-3 text-center text-xs text-muted-foreground/70">
              The same file viewer you get in the product — pointed at a real Kortix project.
            </p>
          </Reveal>
        </div>
      </section>

      {/* ═══════════════ THESIS ═══════════════ */}
      <section className="mx-auto max-w-6xl px-6 py-20 sm:py-28">
        <Reveal>
          <div className="mx-auto max-w-2xl text-center">
            <Eyebrow>The thesis</Eyebrow>
            <h2 className="mt-3 text-3xl font-medium leading-tight tracking-tight text-foreground sm:text-4xl">
              The coding-agent paradigm, for all work
            </h2>
            <p className="mt-4 text-base leading-relaxed text-muted-foreground sm:text-lg">
              Claude Code, Codex and Cursor changed how we build software: describe intent, an agent edits
              files, you review the diff. Kortix applies that exact loop to the rest of the company — every
              agent is a coding-agent runtime in an isolated sandbox, pointed at research, ops, support and
              finance instead of a codebase.
            </p>
          </div>
        </Reveal>
        <div className="mt-14 grid grid-cols-1 gap-4 sm:grid-cols-3">
          {MENTAL_MODEL.map(({ icon: Icon, title, desc }, i) => (
            <Reveal key={title} delay={i * 0.08}>
              <div className="h-full rounded-2xl border border-border/60 bg-card/40 p-6">
                <span className="flex size-10 items-center justify-center rounded-xl border border-border bg-muted/40"><Icon className="size-5 text-foreground/80" /></span>
                <h3 className="mt-4 text-base font-semibold text-foreground">{title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{desc}</p>
              </div>
            </Reveal>
          ))}
        </div>
      </section>

      {/* ═══════════════ THE LOOP ═══════════════ */}
      <section className="border-y border-border/60 bg-muted/20">
        <div className="mx-auto max-w-6xl px-6 py-20 sm:py-28">
          <Reveal>
            <div className="mx-auto mb-16 max-w-2xl text-center">
              <Eyebrow>The loop</Eyebrow>
              <h2 className="mt-3 text-3xl font-medium leading-tight tracking-tight text-foreground sm:text-4xl">
                From <span className="font-mono text-[0.85em] text-muted-foreground">curl</span> to production
              </h2>
              <p className="mt-4 text-base leading-relaxed text-muted-foreground sm:text-lg">
                One repo, one config, one command. Here is the whole developer loop, top to bottom.
              </p>
            </div>
          </Reveal>

          <div className="flex flex-col gap-20 sm:gap-24">
            <Step
              n="01"
              title="Install & scaffold"
              body="One line installs the CLI. kortix init scaffolds your project — a kortix.toml manifest and a .kortix/ runtime — wired into the coding agent you already use."
            >
              <Terminal>
                <Cmd>kortix init</Cmd>
                <div className="mt-2.5 space-y-1">
                  <Done><span className="text-foreground">kortix.toml</span></Done>
                  <Done><span className="text-foreground">.kortix/opencode/</span></Done>
                </div>
              </Terminal>
            </Step>

            <Step
              n="02"
              title="Build it locally, like code"
              body="Open Claude Code, Codex, Cursor or opencode and build. An agent is markdown — a description, its model, and the tools it can use. Skills are folders it loads on demand. Edit them by hand, or describe what you want and let your coding agent write them."
              flip
            >
              <CodeFile name=".kortix/opencode/agents/support.md" code={AGENT_MD} language="markdown" />
            </Step>

            <Step
              n="03"
              title="Declare the whole company in one manifest"
              body="kortix.toml is the source of truth for everything operational: env and secrets, sandbox images, cron and webhook triggers, 3,000+ connectors, Slack channels, even deployable apps. Versioned from the first commit."
            >
              <CodeFile name="kortix.toml" code={TOML} language="toml" />
            </Step>

            <Step
              n="04"
              title="Ship it"
              body="kortix ship commits, pushes, creates the cloud project, links your repo, and prompts for any missing secrets. Triggers, webhooks and channels go live immediately — no separate infra to stand up."
              flip
            >
              <Terminal>
                <Cmd>kortix ship</Cmd>
                <div className="mt-2.5 space-y-1">
                  <Done>committed &amp; pushed to <span className="text-foreground">main</span></Done>
                  <Done>secrets synced · sandbox built</Done>
                  <Line>
                    <span className="inline-flex items-center gap-2 pt-0.5 text-foreground">
                      <span className="size-1.5 animate-pulse rounded-full bg-primary" />
                      live — triggers &amp; channels running
                    </span>
                  </Line>
                </div>
              </Terminal>
            </Step>

            <Step
              n="05"
              title="It runs as a fleet of sandboxes"
              body="Every session is its own isolated VM on its own git branch, booting the runtime and your repo. Spawn thousands of agents in parallel — zero interference. Agents commit their work, and a change request is the only way it reaches main, so everything is reviewable and reversible."
            >
              <Terminal title="sessions">
                <Line><span className="text-foreground">main</span><span className="text-muted-foreground/50">  ──────●────────●────────●────▶</span></Line>
                <Line><span className="text-muted-foreground/50"> ├─ </span><span className="text-foreground">session 1f3a</span><span className="text-muted-foreground/50">  sandbox ─╮</span></Line>
                <Line><span className="text-muted-foreground/50"> ├─ </span><span className="text-foreground">session 9b22</span><span className="text-muted-foreground/50">  sandbox ─┤  change</span></Line>
                <Line><span className="text-muted-foreground/50"> ├─ </span><span className="text-foreground">session 4e07</span><span className="text-muted-foreground/50">  sandbox ─┤  requests</span></Line>
                <Line><span className="text-muted-foreground/50"> └─ </span><span className="text-foreground">… ×1000</span><span className="text-muted-foreground/50">      sandboxes ─╯</span></Line>
                <Line>&nbsp;</Line>
                <Line><span className="text-muted-foreground/50">           review → merge → main</span></Line>
              </Terminal>
            </Step>

            <Step
              n="06"
              title="Bring your own runtime & model"
              body="Sessions run on an open runtime, pluggable by design. Bring your own model keys — Anthropic, OpenAI, local — or use Kortix compute. Nothing about the runtime is hidden."
              flip
            >
              <Terminal>
                <Line>{PROMPT}<span className="text-foreground">kortix providers login anthropic</span></Line>
                <Done>using your own key <span className="text-muted-foreground/60">(byo)</span></Done>
                <Line>&nbsp;</Line>
                <Line><span className="text-muted-foreground/50"># or point at any runtime / model</span></Line>
                <Line>{PROMPT}<span className="text-foreground">kortix providers set --model opus-4.8</span></Line>
                <Line>{PROMPT}<span className="text-foreground">kortix providers set --model gpt-5</span></Line>
              </Terminal>
            </Step>
          </div>
        </div>
      </section>

      {/* ═══════════════ THE CLI ═══════════════ */}
      <section className="mx-auto max-w-6xl px-6 py-20 sm:py-28">
        <Reveal>
          <div className="mx-auto mb-14 max-w-2xl text-center">
            <Eyebrow>One CLI</Eyebrow>
            <h2 className="mt-3 text-3xl font-medium leading-tight tracking-tight text-foreground sm:text-4xl">
              The whole lifecycle, from your terminal
            </h2>
            <p className="mt-4 text-base leading-relaxed text-muted-foreground sm:text-lg">
              Scaffold, ship, run, automate, connect and review — one CLI does it all. The same binary is
              pre-authenticated inside every sandbox, so agents drive Kortix with the exact commands you do.
            </p>
          </div>
        </Reveal>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {CLI_GROUPS.map(({ label, icon: Icon, cmds }, i) => (
            <Reveal key={label} delay={(i % 3) * 0.06}>
              <div className="h-full rounded-2xl border border-border/60 bg-card/40 p-5">
                <div className="flex items-center gap-2.5">
                  <Icon className="size-4 text-foreground/70" />
                  <h3 className="text-sm font-semibold text-foreground">{label}</h3>
                </div>
                <div className="mt-4 space-y-2.5">
                  {cmds.map(([cmd, desc]) => (
                    <div key={cmd}>
                      <code className="font-mono text-sm text-foreground">{cmd}</code>
                      <p className="text-xs leading-relaxed text-muted-foreground">{desc}</p>
                    </div>
                  ))}
                </div>
              </div>
            </Reveal>
          ))}
        </div>
        <Reveal delay={0.1}>
          <div className="mt-8 text-center">
            <Link href={`${DOCS_URL}/reference/cli`} className="group inline-flex items-center gap-1.5 text-sm font-medium text-foreground">
              Full CLI reference<ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
            </Link>
          </div>
        </Reveal>
      </section>

      {/* ═══════════════ OPEN & SELF-HOST ═══════════════ */}
      <section className="border-y border-border/60 bg-muted/20">
        <div className="mx-auto max-w-6xl px-6 py-20 sm:py-28">
          <Reveal>
            <div className="mx-auto mb-12 max-w-2xl text-center">
              <Eyebrow>Open &amp; yours</Eyebrow>
              <h2 className="mt-3 text-3xl font-medium leading-tight tracking-tight text-foreground sm:text-4xl">Yours to run, anywhere</h2>
              <p className="mt-4 text-base leading-relaxed text-muted-foreground sm:text-lg">
                Kortix is source-available — read it, fork it, audit every line. Self-host the exact same
                stack on a laptop, a VPS, your VPC, or fully air-gapped.
              </p>
            </div>
          </Reveal>

          <Reveal delay={0.05}>
            <a
              href={GITHUB_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="group mx-auto flex max-w-2xl items-center gap-4 rounded-2xl border border-border/60 bg-card p-5 transition-colors hover:border-foreground/30"
            >
              <span className="flex size-11 shrink-0 items-center justify-center rounded-xl border border-border bg-muted/40">
                <svg viewBox="0 0 24 24" className="size-5 text-foreground/80" fill="currentColor" aria-hidden="true">
                  <path d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0 1 12 6.844a9.59 9.59 0 0 1 2.504.337c1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.02 10.02 0 0 0 22 12.017C22 6.484 17.522 2 12 2z" />
                </svg>
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold text-foreground">kortix-ai/suna · <span className="tabular-nums">{formattedStars}</span> stars</div>
                <div className="mt-0.5 text-sm text-muted-foreground">A leading open AI workspace — star it, fork it, self-host it.</div>
              </div>
              <ArrowRight className="size-4 shrink-0 text-muted-foreground transition-all group-hover:translate-x-0.5 group-hover:text-foreground" />
            </a>
          </Reveal>

          <div className="mx-auto mt-6 grid max-w-4xl grid-cols-1 gap-3 sm:grid-cols-3">
            {RUNS_ANYWHERE.map(({ icon: Icon, title, desc }, i) => (
              <Reveal key={title} delay={i * 0.06}>
                <div className="h-full rounded-2xl border border-border/60 bg-card/40 p-5">
                  <div className="flex items-center gap-2.5"><Icon className="size-4 text-foreground/70" /><h3 className="text-sm font-semibold text-foreground">{title}</h3></div>
                  <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{desc}</p>
                </div>
              </Reveal>
            ))}
          </div>

          <Reveal delay={0.1}>
            <div className="mx-auto mt-6 max-w-2xl">
              <Terminal>
                <Cmd>kortix self-host start</Cmd>
                <div className="mt-2.5">
                  <Done>your own Kortix cloud, from Docker images</Done>
                </div>
              </Terminal>
            </div>
          </Reveal>
        </div>
      </section>

      {/* ═══════════════ CLOSING CTA ═══════════════ */}
      <section>
        <div className="mx-auto max-w-3xl px-6 py-24 text-center sm:py-32">
          <Reveal>
            <Eyebrow>Start building</Eyebrow>
            <h2 className="mx-auto mt-3 max-w-2xl text-3xl font-medium leading-tight tracking-tight text-foreground sm:text-4xl md:text-5xl">
              Ship your first agent in minutes
            </h2>
            <p className="mx-auto mt-4 max-w-xl text-base leading-relaxed text-muted-foreground sm:text-lg">
              Install the CLI, run <span className="font-mono text-sm text-foreground">kortix init</span>, and build your company like a codebase.
            </p>
            <div className="mt-8 flex flex-col items-center justify-center gap-4">
              {InstallPill}
              <div className="flex items-center gap-5">
                <Link href={DOCS_URL} className="text-sm font-medium text-foreground transition-colors hover:text-muted-foreground">Read the docs →</Link>
                <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer" className="text-sm text-muted-foreground transition-colors hover:text-foreground">Star on GitHub</a>
              </div>
            </div>
            <p className="mt-8 inline-flex items-center gap-2 text-xs text-muted-foreground">
              <GitBranch className="size-3.5" /> Open · source-available · bring your own models
            </p>
          </Reveal>
        </div>
      </section>
    </div>
  );
}
