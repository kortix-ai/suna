'use client';

import { cn } from '@/lib/utils';
import { useState, useCallback, useEffect, useRef } from 'react';
import Link from 'next/link';
import { BackgroundAALChecker } from '@/components/auth/background-aal-checker';
import { WallpaperBackground } from '@/components/ui/wallpaper-background';
import {
  ArrowRight,
  Check,
  Github,
  Bot,
  Sparkles,
  Plug,
  MessageSquare,
  Zap,
  Brain,
  Plus,
  FileText,
  GitBranch,
  GitPullRequest,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { trackCtaSignup } from '@/lib/analytics/gtm';
import { motion, AnimatePresence, useScroll, useMotionValueEvent } from 'framer-motion';
import { useAuth } from '@/components/AuthProvider';
import { Reveal } from '@/components/home/reveal';

const DEMO_URL = '/enterprise';
const GITHUB_URL = 'https://github.com/kortix-ai/suna';
const favicon = (d: string) => `https://www.google.com/s2/favicons?domain=${d}&sz=128`;

type Mode = 'business' | 'technical';

/* ─── White product window — layered on top of the off-white drawer ─── */
function MockShell({ bar, sidebar, children }: { bar: React.ReactNode; sidebar: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-border bg-background overflow-hidden shadow-2xl w-full">
      <div className="h-10 border-b border-border/60 flex items-center gap-2 px-4 bg-muted/40">
        <div className="flex gap-1.5">
          <div className="size-2.5 rounded-full bg-muted-foreground/15" />
          <div className="size-2.5 rounded-full bg-muted-foreground/15" />
          <div className="size-2.5 rounded-full bg-muted-foreground/15" />
        </div>
        <div className="mx-auto text-[11px] font-mono text-muted-foreground flex items-center gap-1.5">{bar}</div>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-[180px_1fr]">
        <aside className="hidden sm:flex flex-col gap-0.5 p-3 border-r border-border/60 bg-muted/30">{sidebar}</aside>
        <div className="p-5 sm:p-6 flex flex-col min-h-[420px]">{children}</div>
      </div>
    </div>
  );
}

/* ─── Business sidebar (app nav) ─── */
const APP_NAV = [
  { id: 'chat', icon: <MessageSquare className="size-4" />, label: 'Chat' },
  { id: 'agents', icon: <Bot className="size-4" />, label: 'Agents' },
  { id: 'skills', icon: <Sparkles className="size-4" />, label: 'Skills' },
  { id: 'integrations', icon: <Plug className="size-4" />, label: 'Integrations' },
  { id: 'automations', icon: <Zap className="size-4" />, label: 'Automations' },
  { id: 'memory', icon: <Brain className="size-4" />, label: 'Memory' },
];
function BusinessSidebar({ active }: { active: string }) {
  return (
    <>
      <div className="flex items-center gap-2 h-9 px-3 rounded-lg bg-foreground text-background text-[13px] font-medium mb-1"><Plus className="size-4" /> New session</div>
      {APP_NAV.map((n) => (
        <div key={n.id} className={cn('flex items-center gap-2.5 h-9 px-3 rounded-lg text-[13px] transition-colors', n.id === active ? 'bg-foreground/[0.07] text-foreground font-medium' : 'text-muted-foreground')}>
          {n.icon}{n.label}
        </div>
      ))}
    </>
  );
}

/* ─── Technical sidebar (file tree) ─── */
const TREE = [
  { d: 0, n: 'kortix.toml', f: true },
  { d: 0, n: '.opencode/', f: false },
  { d: 1, n: 'agents/', f: false },
  { d: 2, n: 'support.md', f: true },
  { d: 1, n: 'skills/', f: false },
  { d: 1, n: 'commands/', f: false },
  { d: 0, n: 'memory/', f: false },
  { d: 0, n: '.secrets/', f: false },
  { d: 0, n: 'PERSIST/', f: false },
];
function TechnicalSidebar({ active }: { active: string }) {
  return (
    <div className="font-mono text-[11px]">
      <div className="px-2 py-1.5 text-[10px] uppercase tracking-widest text-muted-foreground">acme-co</div>
      {TREE.map((t, i) => (
        <div key={i} className={cn('flex items-center gap-1.5 py-1 px-2 rounded transition-colors', t.n === active ? 'bg-foreground/[0.07] text-foreground' : 'text-muted-foreground')} style={{ paddingLeft: `${t.d * 0.85 + 0.5}rem` }}>
          <span className="text-[10px] opacity-60">{t.f ? '·' : '▸'}</span>{t.n}
        </div>
      ))}
    </div>
  );
}

/* ─── Business panels ─── */
function ChatPanel() {
  const steps = ['Pulled Q3 metrics from the data warehouse', 'Drafted 12 slides from your board template', 'Charted revenue, burn, and pipeline'];
  return (
    <>
      <div className="text-[11px] font-mono text-muted-foreground mb-4">Sessions / Q3 board deck</div>
      <div className="self-end max-w-[80%] rounded-2xl rounded-br-sm bg-foreground text-background text-[13px] px-4 py-2.5 mb-5">Build the Q3 board deck from our metrics.</div>
      <div className="flex items-center gap-2 mb-3">
        <span className="flex items-center justify-center size-6 rounded-md bg-muted/60 border border-border"><Bot className="size-3.5" /></span>
        <span className="text-[13px] font-medium text-foreground">finance-agent</span><span className="text-[11px] text-muted-foreground">working…</span>
      </div>
      <div className="space-y-2 pl-1">
        {steps.map((s) => (<div key={s} className="flex items-start gap-2.5 text-[13px]"><span className="mt-[3px] size-1.5 rounded-full shrink-0 bg-emerald-500" /><span className="text-muted-foreground line-through decoration-muted-foreground/30">{s}</span></div>))}
        <div className="flex items-start gap-2.5 text-[13px]"><span className="mt-[3px] size-1.5 rounded-full shrink-0 bg-foreground/40 animate-pulse" /><span className="text-foreground">Formatting &amp; final review</span></div>
      </div>
      <div className="mt-auto pt-5 flex items-center gap-2"><span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border bg-muted/40 text-[12px] text-foreground"><Check className="size-3.5 text-emerald-500" /> Q3-board-deck.pptx</span><span className="text-[12px] text-muted-foreground">ready in 4 min</span></div>
    </>
  );
}
function AgentsPanel() {
  const agents = [['finance-agent', 'Reconciled March invoices', true], ['support-agent', 'Resolved 3 tickets', true], ['sdr-agent', 'Enriched 40 leads', true], ['recruiter', 'Screened 12 candidates', true], ['ops-agent', 'Next run: Mon 08:00', false]] as const;
  return (
    <>
      <div className="text-[11px] font-mono text-muted-foreground mb-4">Agents · 5 deployed</div>
      <div className="space-y-2">
        {agents.map(([name, last, running]) => (
          <div key={name} className="flex items-center gap-3 rounded-2xl border border-border bg-muted/30 px-4 py-3">
            <span className="flex items-center justify-center size-7 rounded-lg bg-background border border-border"><Bot className="size-3.5" /></span>
            <div className="min-w-0"><div className="text-[13px] font-medium text-foreground">{name}</div><div className="text-[12px] text-muted-foreground truncate">{last}</div></div>
            <span className={cn('ml-auto inline-flex items-center gap-1.5 text-[11px]', running ? 'text-emerald-600 dark:text-emerald-500' : 'text-muted-foreground')}><span className={cn('size-1.5 rounded-full', running ? 'bg-emerald-500 animate-pulse' : 'bg-muted-foreground/30')} />{running ? 'running' : 'scheduled'}</span>
          </div>
        ))}
      </div>
    </>
  );
}
function SkillsPanel() {
  const libs = [['Finance', ['Invoice reconciliation', 'Board reporting', 'Scenario models']], ['Legal', ['Contract review', 'Clause library', 'Cited research']]] as const;
  return (
    <>
      <div className="text-[11px] font-mono text-muted-foreground mb-4">Skills · 4 libraries</div>
      <div className="grid grid-cols-2 gap-3">
        {libs.map(([name, skills]) => (
          <div key={name} className="rounded-2xl border border-border bg-muted/30 p-4">
            <div className="flex items-center gap-2 mb-2.5"><Sparkles className="size-3.5 text-foreground/70" /><span className="text-[13px] font-semibold text-foreground">{name}</span></div>
            <ul className="space-y-1.5">{skills.map((s) => (<li key={s} className="flex items-center gap-2 text-[12px] text-muted-foreground"><FileText className="size-3 shrink-0" />{s}</li>))}</ul>
          </div>
        ))}
      </div>
      <div className="mt-auto pt-4 text-[12px] text-muted-foreground">Teach a skill once — every agent can use it.</div>
    </>
  );
}
function IntegrationsPanel() {
  const tools = [['gmail.com', 'Gmail'], ['slack.com', 'Slack'], ['github.com', 'GitHub'], ['stripe.com', 'Stripe'], ['notion.so', 'Notion'], ['hubspot.com', 'HubSpot'], ['linear.app', 'Linear'], ['drive.google.com', 'Drive'], ['salesforce.com', 'Salesforce']] as const;
  return (
    <>
      <div className="text-[11px] font-mono text-muted-foreground mb-4">Integrations · 3,000+ available</div>
      <div className="grid grid-cols-3 gap-2.5">
        {tools.map(([d, name]) => (
          <div key={name} className="flex items-center gap-2 rounded-2xl border border-border bg-muted/30 px-3 py-2.5">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={favicon(d)} alt={name} width={16} height={16} className="size-4 rounded-sm shrink-0" /><span className="text-[12px] text-foreground truncate">{name}</span><span className="ml-auto size-1.5 rounded-full bg-emerald-500 shrink-0" />
          </div>
        ))}
      </div>
      <div className="mt-auto pt-4 text-[12px] text-muted-foreground">Connect once — shared securely across the org.</div>
    </>
  );
}
function AutomationsPanel() {
  const autos = [['Morning briefing', 'Every day · 08:00', true], ['New lead → enrich & route', 'Webhook · HubSpot', true], ['#support message → triage', 'Channel · Slack', true], ['Weekly board report', 'Every Mon · 07:00', false]] as const;
  return (
    <>
      <div className="text-[11px] font-mono text-muted-foreground mb-4">Automations · 3 active</div>
      <div className="space-y-2">
        {autos.map(([name, when, on]) => (
          <div key={name} className="flex items-center gap-3 rounded-2xl border border-border bg-muted/30 px-4 py-3">
            <span className="flex items-center justify-center size-7 rounded-lg bg-background border border-border"><Zap className="size-3.5" /></span>
            <div className="min-w-0"><div className="text-[13px] font-medium text-foreground">{name}</div><div className="text-[12px] text-muted-foreground truncate">{when}</div></div>
            <span className={cn('ml-auto flex items-center w-9 h-5 rounded-full p-0.5 transition-colors', on ? 'bg-emerald-500/90 justify-end' : 'bg-muted-foreground/20 justify-start')}><span className="size-4 rounded-full bg-white shadow" /></span>
          </div>
        ))}
      </div>
    </>
  );
}
function MemoryPanel() {
  const mem = [['company/overview.md', 'Who we are, how we work'], ['customers/acme.md', 'Account context & history'], ['playbooks/refunds.md', 'Approved refund policy'], ['finance/close-process.md', 'Month-end checklist']] as const;
  return (
    <>
      <div className="text-[11px] font-mono text-muted-foreground mb-4">Memory · company brain</div>
      <div className="space-y-1.5 font-mono">
        {mem.map(([file, note]) => (<div key={file} className="flex items-center gap-3 rounded-lg hover:bg-muted/40 px-3 py-2"><FileText className="size-3.5 text-muted-foreground shrink-0" /><span className="text-[12px] text-foreground">{file}</span><span className="ml-auto text-[11px] text-muted-foreground truncate hidden sm:block">{note}</span></div>))}
      </div>
      <div className="mt-auto pt-4 text-[12px] text-muted-foreground">Grows with every session — the longer it runs, the smarter it gets.</div>
    </>
  );
}

/* ─── Technical panels ─── */
function TermLine({ children, c }: { children: React.ReactNode; c?: string }) {
  return <div className={cn('leading-relaxed', c)}>{children}</div>;
}
function InitPanel() {
  return (
    <div className="font-mono text-[12px]">
      <TermLine c="text-muted-foreground">$ kortix init acme-co</TermLine>
      <TermLine c="text-emerald-500">✓ kortix.toml</TermLine>
      <TermLine c="text-emerald-500">✓ .opencode/ — agents · skills · commands</TermLine>
      <TermLine c="text-emerald-500">✓ memory/ · /PERSIST</TermLine>
      <TermLine c="text-emerald-500">✓ git repo initialized</TermLine>
      <div className="mt-3 text-foreground">Your whole company is now a repo.</div>
      <div className="mt-3 flex items-center gap-1.5"><span className="text-foreground">$</span><span className="w-1.5 h-3.5 bg-muted-foreground/30 animate-pulse inline-block" /></div>
    </div>
  );
}
function TomlPanel() {
  return (
    <div className="font-mono text-[12px] leading-relaxed">
      <div className="text-muted-foreground">[project]</div>
      <div className="text-foreground">name = <span className="text-emerald-500">&quot;acme-co&quot;</span></div>
      <div className="mt-2 text-muted-foreground">[[triggers.cron]]</div>
      <div className="text-foreground">agent = <span className="text-emerald-500">&quot;briefing&quot;</span></div>
      <div className="text-foreground">schedule = <span className="text-emerald-500">&quot;0 8 * * *&quot;</span></div>
      <div className="mt-2 text-muted-foreground">[[channels]]</div>
      <div className="text-foreground">type = <span className="text-emerald-500">&quot;slack&quot;</span> · agent = <span className="text-emerald-500">&quot;support&quot;</span></div>
      <div className="mt-2 text-muted-foreground">[connectors]</div>
      <div className="text-foreground">required = [<span className="text-emerald-500">&quot;gmail&quot;</span>, <span className="text-emerald-500">&quot;stripe&quot;</span>, <span className="text-emerald-500">&quot;slack&quot;</span>]</div>
      <div className="mt-auto pt-4 text-[11px] text-muted-foreground not-italic">Triggers, channels, connectors — all declared, all versioned.</div>
    </div>
  );
}
function OpencodePanel() {
  return (
    <div className="font-mono text-[12px] leading-relaxed">
      <div className="text-muted-foreground">.opencode/agents/support.md</div>
      <div className="mt-2 text-muted-foreground">---</div>
      <div className="text-foreground">name: <span className="text-emerald-500">support</span></div>
      <div className="text-foreground">model: <span className="text-emerald-500">claude</span></div>
      <div className="text-foreground">skills: [<span className="text-emerald-500">refund-policy</span>, <span className="text-emerald-500">ticket-triage</span>]</div>
      <div className="text-muted-foreground">---</div>
      <div className="mt-2 text-foreground">You are the support agent for Acme. Resolve</div>
      <div className="text-foreground">tickets with full product context, and escalate</div>
      <div className="text-foreground">anything over $500 for human approval.</div>
      <div className="mt-auto pt-4 text-[11px] text-muted-foreground">Agents and skills are just files — edit, diff, ship.</div>
    </div>
  );
}
function DeployPanel() {
  return (
    <div className="font-mono text-[12px]">
      <TermLine c="text-muted-foreground">$ kortix deploy</TermLine>
      <TermLine c="text-emerald-500">✓ Pushed to main</TermLine>
      <TermLine c="text-emerald-500">✓ Sandbox snapshot booted</TermLine>
      <TermLine c="text-emerald-500">✓ Triggers scheduled · channels live</TermLine>
      <div className="mt-3 flex items-center gap-2 text-foreground"><span className="size-1.5 rounded-full bg-emerald-500 animate-pulse" /> acme-co is running 24/7</div>
      <div className="mt-3 flex items-center gap-1.5"><span className="text-foreground">$</span><span className="w-1.5 h-3.5 bg-muted-foreground/30 animate-pulse inline-block" /></div>
    </div>
  );
}
function PrPanel() {
  return (
    <div className="font-mono text-[12px]">
      <div className="flex items-center gap-2 mb-3"><GitPullRequest className="size-3.5 text-emerald-500" /><span className="text-foreground">support-agent → main</span><span className="ml-auto text-[10px] uppercase tracking-widest text-muted-foreground">review</span></div>
      <div className="text-muted-foreground mb-1.5">skills/refund-policy.md</div>
      <div className="rounded-2xl bg-muted/40 border border-border/60 p-3 space-y-0.5 leading-relaxed">
        <div className="text-emerald-500">+ When a charge is under $50 and within 30 days,</div>
        <div className="text-emerald-500">+ issue the refund via Stripe and reply with</div>
        <div className="text-emerald-500">+ template `refund-approved`.</div>
      </div>
      <div className="mt-3 flex items-center gap-2"><span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-foreground text-background text-[10px] font-medium"><Check className="size-3" />Approve &amp; merge</span><span className="text-muted-foreground">main self-improves ↑</span></div>
      <div className="mt-auto pt-4 text-[11px] text-muted-foreground">Agents commit what they learn — a human approves.</div>
    </div>
  );
}

type Chapter = { id: string; nav: string; tab: string; eyebrow: string; title: string; desc: string; bullets: string[]; panel: React.ReactNode };

const BUSINESS: Chapter[] = [
  {
    id: 'chat', nav: 'chat', tab: 'Chat', eyebrow: 'Chat & sessions', title: 'Talk to your company’s AI.',
    desc: 'Ask in plain language and watch an agent do the real work across your tools — then pick up the finished result.',
    bullets: ['Plain-language requests, real deliverables', 'Watch every step happen, live', 'Pick up the finished file when it’s done'],
    panel: <ChatPanel />,
  },
  {
    id: 'agents', nav: 'agents', tab: 'Agents', eyebrow: 'Agents', title: 'A specialist for every role.',
    desc: 'Stand up an agent for each function — finance, support, sales, ops. Each its own worker, all in one place.',
    bullets: ['One agent per role or team', 'Run dozens at once, in parallel', 'Its own tools, access, and triggers'],
    panel: <AgentsPanel />,
  },
  {
    id: 'skills', nav: 'skills', tab: 'Skills', eyebrow: 'Skills', title: 'Reusable know-how.',
    desc: 'Package the way your company does a job into a skill. Build a library by department, and every agent can use it.',
    bullets: ['Teach a task once, reuse it forever', 'Libraries by department', 'Shared across every agent'],
    panel: <SkillsPanel />,
  },
  {
    id: 'integrations', nav: 'integrations', tab: 'Integrations', eyebrow: 'Integrations', title: 'Connected to everything.',
    desc: 'Connect your stack once and agents work where your team already does — no copy-paste, no swivel-chair.',
    bullets: ['3,000+ tools out of the box', 'OAuth, MCP, REST, Pipedream', 'Connect once, shared org-wide'],
    panel: <IntegrationsPanel />,
  },
  {
    id: 'automations', nav: 'automations', tab: 'Automations', eyebrow: 'Automations', title: 'Work that runs itself.',
    desc: 'Put work on a schedule, a webhook, or a Slack message. The routine stuff just happens, around the clock.',
    bullets: ['Schedules, webhooks, and chat triggers', 'Runs 24/7, hands-off', 'Every run leaves a trail'],
    panel: <AutomationsPanel />,
  },
  {
    id: 'memory', nav: 'memory', tab: 'Memory', eyebrow: 'Memory', title: 'A brain that compounds.',
    desc: 'Every session, decision, and preference is remembered and shared — so the whole company keeps getting sharper.',
    bullets: ['Context that carries across sessions', 'One shared company brain', 'Smarter the longer it runs'],
    panel: <MemoryPanel />,
  },
];

const TECHNICAL: Chapter[] = [
  {
    id: 'init', nav: '', tab: 'Init', eyebrow: 'kortix init', title: 'It starts with one command.',
    desc: 'kortix init scaffolds your whole company as a git repo — config, agents, skills, and memory, versioned from day one.',
    bullets: ['Scaffolds config, agents, skills, memory', 'Versioned from the first commit', 'Local dev is the cloud runtime'],
    panel: <InitPanel />,
  },
  {
    id: 'toml', nav: 'kortix.toml', tab: 'Config', eyebrow: 'kortix.toml', title: 'Everything, declared in code.',
    desc: 'One file defines triggers, channels, connectors, and the sandbox — reviewable, diffable, reproducible from a clean clone.',
    bullets: ['Triggers, channels, connectors in one file', 'Reviewable, diffable changes', 'Reproducible from a clean clone'],
    panel: <TomlPanel />,
  },
  {
    id: 'opencode', nav: 'support.md', tab: '.opencode', eyebrow: '.opencode', title: 'Agents are just files.',
    desc: 'Agents, skills, and commands live as markdown and config under .opencode — edit and ship them like any codebase.',
    bullets: ['Agents and skills as markdown', 'Edit and ship like any codebase', 'Scoped tools and models per agent'],
    panel: <OpencodePanel />,
  },
  {
    id: 'deploy', nav: '', tab: 'Deploy', eyebrow: 'kortix deploy', title: 'One command to go live.',
    desc: 'Deploy boots an isolated sandbox per session and runs your company in the cloud — or self-host it anywhere.',
    bullets: ['One command to go live', 'An isolated sandbox per session', 'Self-host or Kortix cloud'],
    panel: <DeployPanel />,
  },
  {
    id: 'pr', nav: '', tab: 'Self-improve', eyebrow: 'Self-improving main', title: 'It improves itself.',
    desc: 'Sessions run on their own git worktree. What’s worth keeping is committed and PR’d to main — and a human approves.',
    bullets: ['Each session on its own worktree', 'Improvements open a PR to main', 'A human approves every change'],
    panel: <PrPanel />,
  },
];

/* ─── Scroll-through tour — pinned off-white drawer, white frame always visible ─── */
function ProductTour({ mode, setMode }: { mode: Mode; setMode: (m: Mode) => void }) {
  const chapters = mode === 'business' ? BUSINESS : TECHNICAL;
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const sectionRef = useRef<HTMLDivElement | null>(null);
  const { scrollYProgress } = useScroll({ target: sectionRef, offset: ['start start', 'end end'] });

  useMotionValueEvent(scrollYProgress, 'change', (v) => {
    setActive(Math.min(chapters.length - 1, Math.max(0, Math.floor(v * chapters.length))));
  });

  const selectMode = (m: Mode) => {
    if (m === mode) return;
    setMode(m);
    setActive(0);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (rootRef.current) window.scrollTo({ top: rootRef.current.getBoundingClientRect().top + window.scrollY - 12, behavior: 'smooth' });
    }));
  };

  const goTo = (i: number) => {
    const el = sectionRef.current;
    if (!el) return;
    const top = el.getBoundingClientRect().top + window.scrollY;
    const range = el.offsetHeight - window.innerHeight;
    const frac = Math.min(1, Math.max(0, (i + 0.5) / chapters.length));
    window.scrollTo({ top: top + frac * range, behavior: 'smooth' });
  };

  const shellFor = (c: Chapter) => ({
    bar: mode === 'business' ? <>acme-co · Kortix</> : <><GitBranch className="size-3" /> acme-co — main</>,
    sidebar: mode === 'business' ? <BusinessSidebar active={c.nav} /> : <TechnicalSidebar active={c.nav} />,
  });

  const c = chapters[active];
  const Switcher = (
    <div className="inline-flex items-center p-1 rounded-full border border-border bg-background">
      {(['business', 'technical'] as Mode[]).map((m) => (
        <button key={m} onClick={() => selectMode(m)} className={cn('h-9 px-5 rounded-full text-[13px] font-medium capitalize transition-colors cursor-pointer', mode === m ? 'bg-foreground text-background' : 'text-muted-foreground hover:text-foreground')}>{m}</button>
      ))}
    </div>
  );

  return (
    <div ref={rootRef} className="scroll-mt-24">
      {/* DESKTOP — pinned off-white box, white frame visible top/bottom/left/right */}
      <div ref={sectionRef} style={{ height: `${chapters.length * 105 + 40}vh` }} className="relative hidden lg:block">
        <div className="sticky top-[116px] h-[calc(100dvh-148px)]">
          <div className="h-full w-full rounded-[32px] bg-muted border border-border/60 overflow-hidden flex flex-col">
            {/* header */}
            <div className="flex items-center justify-between gap-6 px-10 xl:px-16 pt-7 pb-3 shrink-0">
              <span className="text-[11px] font-mono uppercase tracking-wider text-muted-foreground">The product · {mode}</span>
              {Switcher}
            </div>
            {/* body: left description (rich) + stepper, right bigger white mock */}
            <div className="flex-1 min-h-0 grid grid-cols-[0.85fr_1.15fr] gap-10 xl:gap-16 px-10 xl:px-16 pb-9 items-center">
              <div className="flex flex-col">
                <AnimatePresence mode="wait">
                  <motion.div key={`d-${mode}-${active}`} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }} transition={{ duration: 0.55, ease: 'easeInOut' }}>
                    <span className="text-[11px] font-mono uppercase tracking-wider text-muted-foreground">{`0${active + 1} / 0${chapters.length} · ${c.eyebrow}`}</span>
                    <h3 className="mt-3 text-3xl xl:text-4xl font-medium tracking-tight text-foreground leading-[1.1]">{c.title}</h3>
                    <p className="mt-4 text-base text-muted-foreground leading-relaxed max-w-md">{c.desc}</p>
                    <ul className="mt-5 space-y-2.5">
                      {c.bullets.map((b) => (
                        <li key={b} className="flex items-start gap-2.5 text-sm text-muted-foreground"><Check className="size-4 mt-0.5 text-foreground/60 shrink-0" />{b}</li>
                      ))}
                    </ul>
                  </motion.div>
                </AnimatePresence>
                {/* clickable stepper */}
                <div className="mt-9 flex flex-wrap gap-2">
                  {chapters.map((ch, i) => (
                    <button key={ch.id} onClick={() => goTo(i)} className={cn('inline-flex items-center gap-1.5 h-8 px-3 rounded-full text-[12px] font-medium transition-colors cursor-pointer', i === active ? 'bg-foreground text-background' : 'border border-border text-muted-foreground hover:text-foreground hover:border-foreground/30')}>
                      <span className="font-mono opacity-60">{`0${i + 1}`}</span>{ch.tab}
                    </button>
                  ))}
                </div>
              </div>
              <div className="flex items-center">
                <AnimatePresence mode="wait">
                  <motion.div key={`m-${mode}-${active}`} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }} transition={{ duration: 0.55, ease: 'easeInOut' }} className="w-full">
                    <MockShell {...shellFor(c)}>{c.panel}</MockShell>
                  </motion.div>
                </AnimatePresence>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* MOBILE — stacked off-white drawer */}
      <div className="lg:hidden rounded-[24px] bg-muted border border-border/60 px-5 pt-5 pb-12">
        <div className="flex justify-center mb-8">{Switcher}</div>
        <div className="space-y-12">
          {chapters.map((ch, i) => (
            <div key={ch.id}>
              <span className="text-[11px] font-mono uppercase tracking-wider text-muted-foreground">{`0${i + 1} · ${ch.eyebrow}`}</span>
              <h3 className="mt-2 text-2xl font-medium tracking-tight text-foreground leading-tight">{ch.title}</h3>
              <p className="mt-2 text-sm text-muted-foreground leading-relaxed">{ch.desc}</p>
              <div className="mt-5"><MockShell {...shellFor(ch)}>{ch.panel}</MockShell></div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════ */

export default function Home() {
  const [showFloatingCta, setShowFloatingCta] = useState(false);
  const [mode, setMode] = useState<Mode>('business');
  const { user } = useAuth();

  useEffect(() => {
    const onScroll = () => setShowFloatingCta(window.scrollY > window.innerHeight);
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  const handleLaunch = useCallback(() => {
    trackCtaSignup();
    window.location.href = user ? '/projects' : '/auth';
  }, [user]);

  return (
    <BackgroundAALChecker>
      <div className="relative bg-background">

        {/* ═══════════════ HERO ═══════════════ */}
        <section className="relative min-h-[92vh] flex flex-col items-center justify-center px-6 text-center overflow-hidden">
          <div className="absolute inset-0 z-0"><WallpaperBackground wallpaperId="brandmark" /></div>
          <div className="relative z-10 flex flex-col items-center">
            <h1 className="text-5xl sm:text-6xl md:text-7xl font-medium tracking-tight text-foreground leading-[1.02]">
              The AI command center<br /><span className="text-muted-foreground">for your company</span>
            </h1>
            <p className="mt-6 text-base sm:text-lg text-muted-foreground leading-relaxed max-w-2xl">
              Run your company on AI. Every agent, trigger, integration, and memory your teams need — in one place you control.
            </p>
            <div className="mt-9 flex flex-col sm:flex-row items-center gap-3">
              <Button size="lg" className="h-12 px-8 text-sm rounded-full" onClick={handleLaunch}>Get started<ArrowRight className="ml-1.5 size-3.5" /></Button>
              <Button asChild size="lg" variant="outline" className="h-12 px-7 text-sm rounded-full"><Link href={DEMO_URL}>Request demo</Link></Button>
            </div>
            <p className="mt-7 text-[12px] text-muted-foreground">3,000+ integrations · SSO, RBAC &amp; on-prem · Open &amp; self-hostable</p>
          </div>
          <div className="absolute bottom-10 left-1/2 -translate-x-1/2 z-10">
            <motion.div animate={{ y: [0, 6, 0] }} transition={{ duration: 2, repeat: Infinity, ease: 'easeInOut' }}>
              <div className="w-5 h-8 rounded-full border-2 border-muted-foreground/20 flex items-start justify-center p-1"><motion.div className="w-1 h-1.5 rounded-full bg-muted-foreground/40" animate={{ y: [0, 8, 0] }} transition={{ duration: 2, repeat: Infinity, ease: 'easeInOut' }} /></div>
            </motion.div>
          </div>
        </section>

        {/* ═══════════════ PRODUCT SHOWCASE — full-width drawer, white inset frame ═══════════════ */}
        <div className="px-2 sm:px-3 pt-6 sm:pt-10 pb-2 sm:pb-3">
          <ProductTour mode={mode} setMode={setMode} />
        </div>

        {/* ═══════════════ ROLLOUT ═══════════════ */}
        <section className="max-w-6xl mx-auto px-6 py-16 sm:py-24">
          <Reveal>
            <div className="max-w-2xl mb-10"><Eyebrow>Rollout</Eyebrow><h2 className="mt-3 text-2xl sm:text-3xl md:text-4xl font-medium tracking-tight text-foreground leading-tight">Live across your company in weeks.</h2></div>
          </Reveal>
          <Reveal delay={0.1}>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-px rounded-2xl overflow-hidden border border-border/60 bg-border/60">
              {[
                { n: '01', t: 'Set up your workspace', d: 'Create a project and invite your teams, with roles and access from day one.' },
                { n: '02', t: 'Connect everything', d: 'Plug in the 3,000+ tools you already run, ready for agents to use.' },
                { n: '03', t: 'Build your agents', d: 'Turn your real processes into agents and skills that work the way you do.' },
                { n: '04', t: 'Roll out by department', d: 'Go team by team — sales, finance, ops, support — and scale what works.' },
              ].map(({ n, t, d }) => (
                <div key={n} className="bg-card/40 p-6"><div className="text-[11px] font-mono text-muted-foreground">/{n}</div><h3 className="mt-2 text-base font-semibold text-foreground">{t}</h3><p className="mt-1.5 text-[13px] text-muted-foreground leading-relaxed">{d}</p></div>
              ))}
            </div>
          </Reveal>
        </section>

        {/* ═══════════════ ENTERPRISE + OPEN ═══════════════ */}
        <section className="max-w-6xl mx-auto px-6 py-16 sm:py-24">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-10 lg:gap-16">
            <Reveal>
              <div>
                <Eyebrow>Enterprise</Eyebrow>
                <h2 className="mt-3 text-2xl sm:text-3xl font-medium tracking-tight text-foreground leading-tight">Built for how big companies run.</h2>
                <ul className="mt-5 space-y-2.5">{['Members, groups, and roles that match your org', 'Permissions and scoping for people and agents', 'Secrets held securely, injected at runtime', 'On-prem, VPC, or air-gapped — your data stays yours', 'Full audit trail and human approval gates'].map((x) => (<li key={x} className="flex items-start gap-2.5 text-sm text-muted-foreground"><Check className="size-4 mt-0.5 text-foreground/70 shrink-0" />{x}</li>))}</ul>
              </div>
            </Reveal>
            <Reveal delay={0.1}>
              <div>
                <Eyebrow>Open &amp; yours</Eyebrow>
                <h2 className="mt-3 text-2xl sm:text-3xl font-medium tracking-tight text-foreground leading-tight">Own it. Extend it. Make it yours.</h2>
                <ul className="mt-5 space-y-2.5">{['Open and self-hostable — no black box', 'Bring your own models, or use our cloud', 'Agencies and builders ship solutions on top', 'No lock-in — your agents and data go where you go'].map((x) => (<li key={x} className="flex items-start gap-2.5 text-sm text-muted-foreground"><Check className="size-4 mt-0.5 text-foreground/70 shrink-0" />{x}</li>))}</ul>
                <Link href="/technology" className="mt-6 inline-flex items-center gap-1.5 text-sm font-medium text-foreground hover:gap-2.5 transition-all">Technical team? See how it works<ArrowRight className="size-4" /></Link>
              </div>
            </Reveal>
          </div>
        </section>

        {/* ═══════════════ FINAL CTA ═══════════════ */}
        <section className="max-w-5xl mx-auto px-6 py-20 sm:py-28 text-center">
          <Reveal>
            <Eyebrow>Get started</Eyebrow>
            <h2 className="mt-3 text-3xl sm:text-4xl md:text-5xl font-medium tracking-tight text-foreground leading-tight">Give your company a workforce.</h2>
            <p className="mt-4 text-base sm:text-lg text-muted-foreground max-w-xl mx-auto">Free to self-host. Managed cloud from $20 / seat + usage. Spin up your first agent today — or have us map it to your workflows in a live demo.</p>
          </Reveal>
          <Reveal delay={0.1}>
            <div className="mt-8 flex flex-col sm:flex-row items-center justify-center gap-3">
              <Button size="lg" className="h-12 px-8 text-sm rounded-full" onClick={handleLaunch}>Get started<ArrowRight className="ml-1.5 size-3.5" /></Button>
              <Button asChild size="lg" variant="outline" className="h-12 px-7 text-sm rounded-full"><Link href={DEMO_URL}>Request demo</Link></Button>
              <Button asChild size="lg" variant="ghost" className="h-12 px-7 text-sm rounded-full"><Link href="/pricing">See pricing</Link></Button>
            </div>
          </Reveal>
        </section>

        <div className="h-24 sm:h-28" />

        {/* ═══════════════ FLOATING CTA BAR ═══════════════ */}
        <div className={cn('fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-1.5 px-1.5 py-1.5 rounded-full border border-border bg-background/95 backdrop-blur-md will-change-transform transition-[transform,opacity] duration-[600ms] ease-[cubic-bezier(0.32,0.72,0,1)]', showFloatingCta ? 'translate-y-0 opacity-100' : 'translate-y-16 opacity-0 pointer-events-none')}>
          <Link href="/technology" className="hidden sm:flex items-center h-8 px-3 rounded-full text-[13px] font-medium text-muted-foreground hover:text-foreground transition-colors">Technical</Link>
          <span className="hidden sm:block w-px h-5 bg-border" />
          <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer" className="flex items-center justify-center size-8 rounded-full hover:bg-foreground/[0.08] transition-colors"><Github className="size-4" /></a>
          <Button size="sm" className="px-5 text-xs rounded-full font-medium" onClick={handleLaunch}>Get started<ArrowRight className="ml-1.5 size-3" /></Button>
        </div>
      </div>
    </BackgroundAALChecker>
  );
}

function Eyebrow({ children }: { children: React.ReactNode }) {
  return <span className="text-[11px] font-mono uppercase tracking-wider text-muted-foreground">{children}</span>;
}
