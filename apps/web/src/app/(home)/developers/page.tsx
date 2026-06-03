'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import {
  ArrowRight,
  Check,
  Copy,
  Terminal,
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
import { CodeWindow } from '@/components/home/code-window';
import { useGitHubStars } from '@/hooks/utils/use-github-stars';
import { cn } from '@/lib/utils';

const GITHUB_URL = 'https://github.com/kortix-ai/suna';
const DOCS_URL = '/docs';
const DEFAULT_INSTALL_HOST = 'kortix.com';

/* ── Syntax tokens (match CodeWindow) ── */
const T = {
  c: 'text-muted-foreground/60', // comment
  s: 'text-emerald-600 dark:text-emerald-400', // string / value
  k: 'text-foreground', // key / command
  a: 'text-sky-600 dark:text-sky-400', // accent (flags / sections)
  ok: 'text-emerald-500',
};

// Dark-terminal palette for the hero centerpiece.
const D = {
  c: 'text-zinc-500', // comment / prompt
  s: 'text-emerald-400', // string / value
  k: 'text-zinc-100', // command
  a: 'text-sky-400', // accent
  ok: 'text-emerald-400',
};

function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-2 text-xs font-mono uppercase tracking-[0.18em] text-muted-foreground">
      <span className="h-px w-5 bg-border" />
      {children}
    </span>
  );
}

/**
 * Robust scroll reveal. Content is VISIBLE by default — the entrance animation
 * is pure enhancement that plays when the block scrolls into view. If the
 * observer never fires (off-screen, screenshot, no-JS) the content still shows,
 * so the page can never render as a blank void.
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

/* ── A macOS-ish window frame for terminals and files ── */
function Win({ title, children, className }: { title?: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={cn('overflow-hidden rounded-2xl border border-border/80 bg-card shadow-[0_20px_50px_-24px_rgba(0,0,0,0.35)] ring-1 ring-black/[0.03]', className)}>
      <div className="flex items-center gap-2 border-b border-border/60 bg-muted/40 px-4 py-2.5">
        <span className="flex gap-1.5">
          <span className="size-2.5 rounded-full bg-[#ff5f57]/80" />
          <span className="size-2.5 rounded-full bg-[#febc2e]/80" />
          <span className="size-2.5 rounded-full bg-[#28c840]/80" />
        </span>
        {title && <span className="ml-1.5 font-mono text-xs text-muted-foreground">{title}</span>}
      </div>
      <div className="overflow-x-auto px-5 py-4 font-mono text-[12.5px] leading-relaxed sm:text-[13px]">{children}</div>
    </div>
  );
}

function L({ children = <>&nbsp;</> }: { children?: React.ReactNode }) {
  return <div className="whitespace-pre">{children}</div>;
}

/* ─────────────────────────── content data ─────────────────────────── */

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
    desc: 'Open source and self-hostable. Bring your own runtime and model keys. No black box, no lock-in — read every line.',
  },
];

const CLI_GROUPS: { label: string; icon: typeof Terminal; cmds: [string, string][] }[] = [
  {
    label: 'Scaffold & ship',
    icon: Terminal,
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
      ['kortix chat', 'Talk to a session’s agent'],
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
  { icon: Server, title: 'Self-host anywhere', desc: 'A laptop, a VPS, your own VPC, or fully air-gapped. The exact same stack as Kortix cloud.' },
  { icon: Cpu, title: 'Any runtime', desc: 'OpenCode runtime today, pluggable by design — Codex and cloud runtimes are on the roadmap.' },
  { icon: KeyRound, title: 'Any model', desc: 'Bring your own keys — Anthropic, OpenAI, or local models — or run on Kortix compute.' },
];

/* ── one numbered step of the build → ship loop ── */
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
          <span className="flex size-10 shrink-0 items-center justify-center rounded-full border border-border bg-card font-mono text-sm font-medium text-foreground shadow-sm">{n}</span>
          <span className="h-px flex-1 bg-gradient-to-r from-border to-transparent" />
        </div>
        <h3 className="mt-5 text-2xl font-medium tracking-tight text-foreground sm:text-3xl">{title}</h3>
        <p className="mt-4 max-w-md text-base leading-relaxed text-muted-foreground">{body}</p>
      </Reveal>
      <Reveal delay={0.1} className={cn(flip && 'lg:order-1')}>
        {children}
      </Reveal>
    </div>
  );
}

/* ─────────────────────────────── page ─────────────────────────────── */

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
      className="group inline-flex h-10 w-fit max-w-full items-center gap-2.5 overflow-hidden rounded-full border border-border bg-background/70 px-4 backdrop-blur-sm transition-colors hover:border-foreground/20 cursor-pointer"
    >
      <span className="shrink-0 select-none font-mono text-[11px] text-muted-foreground">$</span>
      <code className="overflow-x-auto whitespace-nowrap font-mono text-[11px] tracking-tight text-foreground [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">{installCmd}</code>
      <span className="shrink-0 border-l border-border pl-2.5">
        {copied ? <Check className="size-3.5 text-emerald-500" /> : <Copy className="size-3.5 text-muted-foreground transition-colors group-hover:text-foreground" />}
      </span>
    </button>
  );

  return (
    <div className="relative bg-background">
      {/* ═══════════════ HERO ═══════════════ */}
      <section className="relative overflow-hidden border-b border-border/60">
        {/* layered backdrop: top wash · faint dot-grid · soft glow behind the terminal */}
        <div className="pointer-events-none absolute inset-x-0 top-0 h-[420px] bg-gradient-to-b from-muted/50 to-transparent" />
        <div className="pointer-events-none absolute inset-0 opacity-[0.35] [background-image:radial-gradient(var(--border)_1px,transparent_1px)] [background-size:24px_24px] [mask-image:radial-gradient(ellipse_70%_55%_at_70%_30%,black,transparent)]" />
        <div className="pointer-events-none absolute right-[-10%] top-[12%] hidden size-[520px] rounded-full bg-foreground/[0.05] blur-[120px] lg:block" />

        <div className="relative mx-auto max-w-6xl px-6 pt-32 pb-20 sm:pt-40 sm:pb-28">
          <div className="grid grid-cols-1 items-center gap-12 lg:grid-cols-[1fr_1.1fr] lg:gap-14">
            <div>
              <Eyebrow>Developers</Eyebrow>
              <h1 className="mt-5 text-[2.7rem] font-medium leading-[1.02] tracking-tight text-foreground sm:text-6xl md:text-[4.25rem]">
                Your company,<br />
                <span className="text-muted-foreground">as a git repo.</span>
              </h1>
              <p className="mt-6 max-w-xl text-base leading-relaxed text-muted-foreground sm:text-lg">
                Coding agents transformed how we build software. Kortix brings the same paradigm to
                knowledge work — every agent, skill and automation is a file in one repo you own.
                Build it locally, ship it with one command, run it as a fleet of cloud sandboxes.
              </p>
              <div className="mt-8 flex flex-col items-start gap-5">
                {InstallPill}
                <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
                  <Link href={DOCS_URL} className="whitespace-nowrap text-sm font-medium text-foreground transition-colors hover:text-muted-foreground">Read the docs →</Link>
                  <span className="h-3.5 w-px bg-border" />
                  <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground">
                    <svg viewBox="0 0 24 24" className="size-4" fill="currentColor" aria-hidden="true">
                      <path d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0 1 12 6.844a9.59 9.59 0 0 1 2.504.337c1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.02 10.02 0 0 0 22 12.017C22 6.484 17.522 2 12 2z" />
                    </svg>
                    <span className="font-medium tabular-nums">{formattedStars}</span>
                    <span>stars</span>
                  </a>
                </div>
              </div>
            </div>

            <Reveal delay={0.1}>
              <div className="relative">
                <div className="overflow-hidden rounded-2xl border border-white/10 bg-zinc-950 shadow-[0_40px_90px_-30px_rgba(0,0,0,0.55)] ring-1 ring-black/40">
                  <div className="flex items-center gap-2 border-b border-white/[0.08] bg-white/[0.03] px-4 py-3">
                    <span className="flex gap-1.5">
                      <span className="size-3 rounded-full bg-[#ff5f57]" />
                      <span className="size-3 rounded-full bg-[#febc2e]" />
                      <span className="size-3 rounded-full bg-[#28c840]" />
                    </span>
                    <span className="ml-2 font-mono text-xs text-zinc-500">acme — kortix</span>
                  </div>
                  <div className="px-5 py-5 font-mono text-[12.5px] leading-[1.85] text-zinc-300 sm:text-[13px]">
                    <L><span className={D.c}>$</span> <span className={D.k}>curl -fsSL kortix.com/install | bash</span></L>
                    <L><span className={D.c}>$</span> <span className={D.k}>kortix init</span> <span className={D.s}>acme</span></L>
                    <L><span className={D.ok}>✓</span> <span className="text-zinc-400">created</span> <span className={D.s}>kortix.toml</span></L>
                    <L><span className={D.ok}>✓</span> <span className="text-zinc-400">created</span> <span className={D.s}>.kortix/opencode/</span></L>
                    <L><span className={D.ok}>✓</span> <span className="text-zinc-400">wired</span> <span className={D.a}>claude</span> <span className={D.c}>·</span> <span className={D.a}>codex</span> <span className={D.c}>·</span> <span className={D.a}>cursor</span></L>
                    <L />
                    <L><span className={D.c}>$</span> <span className={D.k}>kortix ship</span></L>
                    <L><span className={D.ok}>✓</span> <span className="text-zinc-400">pushed to</span> <span className={D.s}>main</span> <span className={D.c}>·</span> <span className="text-zinc-400">sandbox snapshot built</span></L>
                    <L><span className="inline-flex items-center gap-2 text-zinc-100"><span className="size-1.5 animate-pulse rounded-full bg-emerald-400 shadow-[0_0_8px] shadow-emerald-400/60" />acme is live — triggers &amp; channels running</span></L>
                    <L><span className={D.c}>$</span> <span className="ml-0.5 inline-block h-3.5 w-2 translate-y-[3px] animate-pulse bg-zinc-400" /></L>
                  </div>
                </div>
              </div>
            </Reveal>
          </div>
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
              agent is a coding-agent runtime in an isolated sandbox, just pointed at research, ops, support
              and finance instead of a codebase.
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
              body="One line installs the CLI. kortix init scaffolds a project — a kortix.toml manifest and a .kortix/ runtime — and wires Kortix into the coding agent you already use. Start from the general-knowledge-worker template with 60+ ready-made skills, or from minimal."
            >
              <Win title="terminal">
                <L><span className={T.c}>$</span> <span className={T.k}>kortix init</span> <span className={T.s}>acme</span> <span className={T.a}>--template general-knowledge-worker</span></L>
                <L><span className={T.ok}>✓</span> <span className={T.s}>kortix.toml</span></L>
                <L><span className={T.ok}>✓</span> <span className={T.s}>.kortix/opencode/agents/</span></L>
                <L><span className={T.ok}>✓</span> <span className={T.s}>.kortix/opencode/skills/</span> <span className={T.c}>60+ skills</span></L>
                <L><span className={T.ok}>✓</span> <span className={T.s}>.kortix/opencode/tools/</span></L>
                <L><span className={T.ok}>✓</span> wired <span className={T.c}>.claude/ · AGENTS.md · .cursor/</span></L>
              </Win>
            </Step>

            <Step
              n="02"
              title="Build it locally, like code"
              body="Open Claude Code, Codex, Cursor or opencode and build. Agents and skills are markdown — a persona, its model, its skills and tools. Edit them by hand, or just describe what you want and let your coding agent write them. It is a coding framework for knowledge work."
              flip
            >
              <Win title=".kortix/opencode/agents/support.md">
                <L><span className={T.c}>---</span></L>
                <L><span className={T.k}>name</span><span className={T.c}>:</span> <span className={T.s}>support</span></L>
                <L><span className={T.k}>model</span><span className={T.c}>:</span> <span className={T.s}>claude-opus-4-8</span></L>
                <L><span className={T.k}>skills</span><span className={T.c}>:</span> [<span className={T.s}>refund-policy</span>, <span className={T.s}>ticket-triage</span>]</L>
                <L><span className={T.k}>tools</span><span className={T.c}>:</span> [<span className={T.s}>gmail</span>, <span className={T.s}>stripe</span>, <span className={T.s}>slack</span>]</L>
                <L><span className={T.c}>---</span></L>
                <L />
                <L><span className="text-foreground">{`You are Acme's support agent. Resolve tickets`}</span></L>
                <L><span className="text-foreground">with full product context. Anything over</span></L>
                <L><span className="text-foreground">$500 → human approval.</span></L>
              </Win>
            </Step>

            <Step
              n="03"
              title="Declare the whole company in one manifest"
              body="kortix.toml is the source of truth for everything operational: env and secrets, sandbox images, cron and webhook triggers, 3,000+ connectors, Slack channels, even deployable apps. Versioned from the first commit."
            >
              <Win title="kortix.toml">
                <L><span className={T.c}>[project]</span></L>
                <L><span className={T.k}>name</span> = <span className={T.s}>{`"Acme AGI"`}</span></L>
                <L />
                <L><span className={T.c}>[[triggers]]</span> <span className={T.c}># runs itself, on a schedule</span></L>
                <L><span className={T.k}>type</span> = <span className={T.s}>{`"cron"`}</span></L>
                <L><span className={T.k}>cron</span> = <span className={T.s}>{`"0 0 9 * * 1-5"`}</span></L>
                <L><span className={T.k}>prompt</span> = <span className={T.s}>{`"Summarize yesterday across Slack & Linear"`}</span></L>
                <L />
                <L><span className={T.c}>[[connectors]]</span> <span className={T.c}># 3,000+ tools as agent tools</span></L>
                <L><span className={T.k}>provider</span> = <span className={T.s}>{`"pipedream"`}</span> · <span className={T.k}>app</span> = <span className={T.s}>{`"slack"`}</span></L>
                <L />
                <L><span className={T.c}>[[channels]]</span> <span className={T.c}># answer where your team works</span></L>
                <L><span className={T.k}>platform</span> = <span className={T.s}>{`"slack"`}</span> · <span className={T.k}>agent</span> = <span className={T.s}>{`"support"`}</span></L>
              </Win>
            </Step>

            <Step
              n="04"
              title="Ship it"
              body="kortix ship commits, pushes, creates the cloud project, links your repo (GitHub or managed), and prompts for any missing secrets. Triggers, webhooks and channels go live immediately — no separate infra to stand up."
              flip
            >
              <Win title="terminal">
                <L><span className={T.c}>$</span> <span className={T.k}>kortix ship</span></L>
                <L><span className={T.ok}>✓</span> committed &amp; pushed to <span className={T.s}>main</span></L>
                <L><span className={T.ok}>✓</span> linked <span className={T.s}>github.com/acme/agi</span></L>
                <L><span className={T.ok}>✓</span> secrets synced <span className={T.c}>(3)</span></L>
                <L><span className={T.ok}>✓</span> sandbox snapshot built</L>
                <L />
                <L><span className="inline-flex items-center gap-2 text-foreground"><span className="size-1.5 animate-pulse rounded-full bg-emerald-500" />live — triggers scheduled · channels connected</span></L>
              </Win>
            </Step>

            <Step
              n="05"
              title="It runs as a fleet of sandboxes"
              body="Every session is its own isolated VM on its own git branch, booting the runtime and your repo. Spawn hundreds of thousands of agents in parallel — zero interference. Agents commit and push their work, and a change request is the only way it reaches main, so everything is reviewable and reversible."
            >
              <Win title="sessions">
                <L><span className={T.k}>main</span> <span className={T.c}>──────●────────●────────●────▶</span></L>
                <L><span className={T.c}> ├─</span> <span className={T.a}>session 1f3a</span> <span className={T.c}>sandbox ─╮</span></L>
                <L><span className={T.c}> ├─</span> <span className={T.a}>session 9b22</span> <span className={T.c}>sandbox ─┤</span> <span className={T.s}>change</span></L>
                <L><span className={T.c}> ├─</span> <span className={T.a}>session 4e07</span> <span className={T.c}>sandbox ─┤</span> <span className={T.s}>requests</span></L>
                <L><span className={T.c}> └─</span> <span className={T.a}>… ×1000</span> <span className={T.c}>&nbsp;&nbsp;sandboxes ─╯</span></L>
                <L />
                <L><span className={T.c}>          review → merge → main</span></L>
              </Win>
            </Step>

            <Step
              n="06"
              title="Bring your own runtime & model"
              body="Sessions run on the open-source OpenCode runtime today, pluggable by design — Codex and cloud runtimes are on the roadmap. Bring your own model keys (Anthropic, OpenAI, local) or use Kortix compute. Nothing about the runtime is hidden."
              flip
            >
              <Win title="terminal">
                <L><span className={T.c}>$</span> <span className={T.k}>kortix providers login</span> <span className={T.s}>anthropic</span></L>
                <L><span className={T.ok}>✓</span> using your own key <span className={T.c}>(byo)</span></L>
                <L />
                <L><span className={T.c}># or point at any runtime / model</span></L>
                <L><span className={T.c}>$</span> <span className={T.k}>kortix providers set</span> <span className={T.a}>--model</span> <span className={T.s}>opus-4.8</span></L>
                <L><span className={T.c}>$</span> <span className={T.k}>kortix providers set</span> <span className={T.a}>--model</span> <span className={T.s}>gpt-5</span></L>
              </Win>
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
                      <code className="font-mono text-[12.5px] text-foreground">{cmd}</code>
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
            <Link href={`${DOCS_URL}/reference/cli`} className="inline-flex items-center gap-1.5 text-sm font-medium text-foreground transition-all hover:gap-2.5">
              Full CLI reference<ArrowRight className="size-4" />
            </Link>
          </div>
        </Reveal>
      </section>

      {/* ═══════════════ COMPANY AS CODE ═══════════════ */}
      <section className="border-y border-border/60 bg-muted/20">
        <div className="mx-auto max-w-6xl px-6 py-20 sm:py-28">
          <Reveal>
            <div className="mx-auto mb-14 max-w-2xl text-center">
              <Eyebrow>Company as code</Eyebrow>
              <h2 className="mt-3 text-3xl font-medium leading-tight tracking-tight text-foreground sm:text-4xl">No black box</h2>
              <p className="mt-4 text-base leading-relaxed text-muted-foreground sm:text-lg">
                One repo is the source of truth. Every agent, skill, trigger and policy is a plain file —
                versioned in git, reviewed in a change request, deployed in one command, and portable between
                cloud and self-host.
              </p>
            </div>
          </Reveal>
          <div className="grid grid-cols-1 items-center gap-8 lg:grid-cols-2 lg:gap-14">
            <Reveal>
              <Win title="acme/">
                <L><span className={T.k}>acme/</span></L>
                <L><span className={T.c}>├─</span> <span className={T.s}>kortix.toml</span> <span className={T.c}># the company, declared</span></L>
                <L><span className={T.c}>├─</span> <span className={T.k}>.kortix/</span></L>
                <L><span className={T.c}>│  ├─</span> <span className={T.s}>Dockerfile</span> <span className={T.c}># the computer</span></L>
                <L><span className={T.c}>│  └─</span> <span className={T.k}>opencode/</span></L>
                <L><span className={T.c}>│     ├─</span> <span className={T.s}>agents/</span> <span className={T.c}>support.md · research.md</span></L>
                <L><span className={T.c}>│     ├─</span> <span className={T.s}>skills/</span> <span className={T.c}>refund-policy/ · deep-research/</span></L>
                <L><span className={T.c}>│     ├─</span> <span className={T.s}>tools/</span></L>
                <L><span className={T.c}>│     └─</span> <span className={T.s}>memory/</span> <span className={T.c}># the company brain</span></L>
                <L><span className={T.c}>└─</span> <span className={T.s}>README.md</span></L>
              </Win>
            </Reveal>
            <Reveal delay={0.1}>
              <CodeWindow />
            </Reveal>
          </div>
        </div>
      </section>

      {/* ═══════════════ OPEN SOURCE & SELF-HOST ═══════════════ */}
      <section className="mx-auto max-w-6xl px-6 py-20 sm:py-28">
        <Reveal>
          <div className="mx-auto mb-12 max-w-2xl text-center">
            <Eyebrow>Open source</Eyebrow>
            <h2 className="mt-3 text-3xl font-medium leading-tight tracking-tight text-foreground sm:text-4xl">Yours to run, anywhere</h2>
            <p className="mt-4 text-base leading-relaxed text-muted-foreground sm:text-lg">
              Kortix is open source — read it, fork it, audit every line.
              Self-host the exact same stack on a laptop, a VPS, your VPC, or fully air-gapped.
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

        <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-3">
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
            <Win title="terminal">
              <L><span className={T.c}>$</span> <span className={T.k}>kortix self-host start</span> <span className={T.c}># your own Kortix cloud</span></L>
              <L><span className={T.c}>$</span> <span className={T.k}>kortix hosts use</span> <span className={T.s}>local</span> <span className={T.c}>↔</span> <span className={T.k}>kortix hosts use</span> <span className={T.s}>cloud</span></L>
            </Win>
          </div>
        </Reveal>
      </section>

      {/* ═══════════════ CLOSING CTA ═══════════════ */}
      <section className="border-t border-border/60">
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
              <GitBranch className="size-3.5" /> Open source · self-hostable · bring your own models
            </p>
          </Reveal>
        </div>
      </section>
    </div>
  );
}
