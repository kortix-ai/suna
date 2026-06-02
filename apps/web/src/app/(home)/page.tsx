'use client';

import { cn } from '@/lib/utils';
import { useState, useCallback, useEffect } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { motion, useScroll, useTransform } from 'framer-motion';
import {
  ArrowRight,
  Check,
  Copy,
  Github,
  Star,
  GitBranch,
  ShieldCheck,
  Box,
  KeyRound,
  ScrollText,
  Users,
  Server,
  Boxes,
  Cpu,
  BookOpen,
} from 'lucide-react';
import { BackgroundAALChecker } from '@/components/auth/background-aal-checker';
import { WallpaperBackground } from '@/components/ui/wallpaper-background';
import { Button } from '@/components/ui/button';
import { trackCtaSignup } from '@/lib/analytics/gtm';
import { useAuth } from '@/components/AuthProvider';
import { useGitHubStars } from '@/hooks/utils/use-github-stars';
import { Reveal } from '@/components/home/reveal';
import { StepMedia } from '@/components/home/step-media';
import { CodeWindow } from '@/components/home/code-window';

const DEMO_URL = '/contact';
const DOCS_URL = '/docs';
const GITHUB_URL = 'https://github.com/kortix-ai/suna';
// Default host used for SSR / first paint; replaced with the live frontend
// origin once mounted so the install command always matches the deployment.
const DEFAULT_INSTALL_HOST = 'kortix.com';
const SHOT = (f: string) => `/images/landing-showcase/platform/${f}`;
const favicon = (d: string) => `https://www.google.com/s2/favicons?domain=${d}&sz=128`;

// A recognizable slice of the 3,000+ connectors (favicons via Google's service).
const INTEGRATIONS = [
  'gmail.com', 'slack.com', 'discord.com', 'zoom.us', 'microsoft.com', 'telegram.org',
  'whatsapp.com', 'twilio.com', 'sendgrid.com', 'intercom.com', 'front.com', 'loom.com',
  'notion.so', 'airtable.com', 'asana.com', 'monday.com', 'clickup.com', 'trello.com',
  'atlassian.com', 'jira.com', 'miro.com', 'figma.com', 'canva.com', 'linear.app',
  'dropbox.com', 'box.com', 'drive.google.com', 'github.com', 'gitlab.com', 'vercel.com',
  'netlify.com', 'aws.amazon.com', 'cloud.google.com', 'cloudflare.com', 'docker.com',
  'sentry.io', 'datadoghq.com', 'postman.com', 'mongodb.com', 'supabase.com', 'snowflake.com',
  'salesforce.com', 'hubspot.com', 'pipedrive.com', 'zoho.com', 'apollo.io', 'zoominfo.com',
  'mailchimp.com', 'klaviyo.com', 'segment.com', 'mixpanel.com', 'amplitude.com',
  'stripe.com', 'paypal.com', 'quickbooks.intuit.com', 'xero.com', 'ramp.com', 'plaid.com',
  'zendesk.com', 'freshdesk.com', 'gorgias.com', 'workday.com', 'bamboohr.com', 'gusto.com',
  'rippling.com', 'deel.com', 'greenhouse.io', 'shopify.com', 'webflow.com', 'squarespace.com',
  'tableau.com', 'looker.com', 'getdbt.com', 'typeform.com', 'calendly.com', 'cal.com',
  'zapier.com', 'docusign.com', 'linkedin.com', 'x.com', 'youtube.com', 'reddit.com',
  'openai.com', 'anthropic.com', 'huggingface.co', 'perplexity.ai', 'elevenlabs.io',
];

// The A-to-Z walkthrough. Each step's `src` is a real screenshot today; drop a
// `.mp4`/`.webm`/`.gif` at the same path later and StepMedia swaps it in.
type Step = { n: string; id?: string; kicker: string; title: string; body: string; src: string; url: string };
const STEPS: Step[] = [
  {
    n: '01', id: 'product', kicker: 'Invite your team',
    title: 'Bring your whole team in',
    body: 'Add teammates by email and give each the right access — member, editor, or manager. Owners and account groups carry over automatically, so the whole company works in one place.',
    src: SHOT('02-team.png'), url: 'acme.kortix.app',
  },
  {
    n: '02', kicker: 'Connect your tools',
    title: 'Plug in the 3,000+ apps you already run on',
    body: 'Connect once — Gmail, Slack, Salesforce, GitHub, Stripe — and every agent can act in them. Credentials stay encrypted and scoped; the model only ever sees the tools, never your keys.',
    src: SHOT('03-connectors.png'), url: 'acme.kortix.app',
  },
  {
    n: '03', kicker: 'Build your agents',
    title: 'A specialist for every role',
    body: 'Each agent is a plain markdown file — its persona, its tools, the way it works. Spin up a support agent, a finance agent, a research agent. Edit them like code, or have an agent edit them for you.',
    src: SHOT('05-agents.png'), url: 'acme.kortix.app',
  },
  {
    n: '04', kicker: 'Teach it skills',
    title: 'Package how your company does a job — once',
    body: 'Skills are reusable know-how every agent shares: account research, contract review, campaign planning. Write a skill once and your whole workforce can run it, the same way, every time.',
    src: SHOT('04-skills.png'), url: 'acme.kortix.app',
  },
  {
    n: '05', kicker: 'Run it from anywhere',
    title: 'Meet your team where they already work',
    body: 'Add Kortix to Slack and your agent answers in the channels you invite it to. Put work on a schedule, fire it from a webhook, or kick it off from chat — every entry point routes to the right agent.',
    src: SHOT('06-channels.png'), url: 'acme.kortix.app',
  },
];

const DEV_POINTS: string[] = [
  'kortix.toml declares your triggers, channels, connectors, and computer — versioned from the first commit.',
  'Agents and skills are plain markdown files — edit and ship them like any codebase.',
  'Every change is a change request: review the diff, approve to keep it, or roll back instantly.',
  'Self-host on your own infra or run on Kortix cloud — bring your own models either way.',
];

const RUNS_ANYWHERE: { icon: typeof Server; title: string; desc: string }[] = [
  { icon: Server, title: 'Self-host', desc: 'A laptop, a VPS, your own VPC, or fully air-gapped — your perimeter.' },
  { icon: Boxes, title: 'Any engine', desc: 'An engine-agnostic runtime, built to stay pluggable over time.' },
  { icon: Cpu, title: 'Any provider', desc: 'Bring your own model keys or subscription, or use Kortix compute.' },
];

const ENTERPRISE: { icon: typeof Users; title: string; desc: string }[] = [
  { icon: Users, title: 'Roles & access', desc: 'Members, groups, and roles — every permission scoped to people and agents alike.' },
  { icon: ShieldCheck, title: 'Approval policies', desc: 'Guardrails on every action — require a human to approve anything risky or over-limit.' },
  { icon: Box, title: 'A computer per session', desc: 'Every session runs on its own secure, private computer. Nothing is shared between runs.' },
  { icon: KeyRound, title: 'Secrets vault', desc: 'Credentials encrypted at rest, injected at runtime, never exposed to the model or logs.' },
  { icon: ScrollText, title: 'Audit & approvals', desc: 'A complete, immutable trail of every action, decision, and human approval gate.' },
  { icon: Server, title: 'On-prem & VPC', desc: 'Deploy in your own cloud, VPC, or air-gapped. Your data never leaves your perimeter.' },
];

const DELIVERABLES: { src: string; label: string; sub: string }[] = [
  { src: '/images/landing-showcase/slides.png', label: 'A board deck', sub: 'finance-agent' },
  { src: '/images/landing-showcase/data.png', label: 'A live dashboard', sub: 'ops-agent' },
  { src: '/images/landing-showcase/research.png', label: 'A research brief', sub: 'analyst-agent' },
];

function Eyebrow({ children }: { children: React.ReactNode }) {
  return <span className="text-xs font-mono uppercase tracking-wider text-muted-foreground">{children}</span>;
}

const MARQUEE_PX_PER_SEC = 28;
function LogoMarquee({ items, reverse = false }: { items: string[]; reverse?: boolean }) {
  const duration = (items.length * 60) / MARQUEE_PX_PER_SEC;
  return (
    <div className="relative overflow-hidden [mask-image:linear-gradient(to_right,transparent,black_6%,black_94%,transparent)]">
      <motion.div className="flex w-max" animate={{ x: reverse ? ['-50%', '0%'] : ['0%', '-50%'] }} transition={{ duration, repeat: Infinity, ease: 'linear' }}>
        {[0, 1].map((copy) => (
          <div key={copy} className="flex shrink-0" aria-hidden={copy > 0}>
            {items.map((d, i) => (
              <span key={`${copy}-${d}-${i}`} className="mr-3 flex size-12 shrink-0 items-center justify-center rounded-2xl border border-border/60 bg-card">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={favicon(d)} alt="" width={22} height={22} loading="lazy" decoding="async" className="size-[22px] rounded-md" />
              </span>
            ))}
          </div>
        ))}
      </motion.div>
    </div>
  );
}

/** One chapter of the walkthrough: number + kicker, headline, narration, media. */
function TourStep({ step, index }: { step: Step; index: number }) {
  const shaded = index % 2 === 1;
  return (
    <section id={step.id} className={cn('scroll-mt-24 px-6 py-16 sm:py-24', shaded && 'border-y border-border/60 bg-muted/20')}>
      <div className="mx-auto max-w-5xl">
        <Reveal>
          <div className="mx-auto max-w-2xl text-center">
            <div className="text-xs font-mono uppercase tracking-wider text-muted-foreground">
              Step {step.n} <span className="text-foreground/30">·</span> {step.kicker}
            </div>
            <h2 className="mt-3 text-2xl font-medium leading-tight tracking-tight text-foreground sm:text-3xl md:text-4xl">{step.title}</h2>
            <p className="mt-4 text-base leading-relaxed text-muted-foreground">{step.body}</p>
          </div>
        </Reveal>
        <Reveal delay={0.1}>
          <div className="mt-10 sm:mt-12">
            <StepMedia src={step.src} alt={step.title} urlLabel={step.url} />
          </div>
        </Reveal>
      </div>
    </section>
  );
}

export default function Home() {
  const [showFloatingCta, setShowFloatingCta] = useState(false);
  const [copied, setCopied] = useState(false);
  const [installHost, setInstallHost] = useState(DEFAULT_INSTALL_HOST);
  const { user } = useAuth();
  const { formattedStars } = useGitHubStars('kortix-ai', 'kortix');

  // Derive the install command from the live frontend origin so it always
  // points at this deployment's own /install route (kortix.com, dev.kortix.com,
  // a self-hosted domain, …) rather than a hardcoded host.
  const installCmd = `curl -fsSL https://${installHost}/install | bash`;
  const installCmdShort = `curl -fsSL ${installHost}/install`;

  useEffect(() => {
    setInstallHost(window.location.host);
  }, []);

  useEffect(() => {
    const onScroll = () => setShowFloatingCta(window.scrollY > window.innerHeight);
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  const handleLaunch = useCallback(() => {
    trackCtaSignup();
    window.location.href = user ? '/projects' : '/auth';
  }, [user]);

  const copyInstall = useCallback(() => {
    navigator.clipboard.writeText(installCmd);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [installCmd]);

  // Scroll-linked hero fade + drawer that rises over it (legacy layout).
  const { scrollY } = useScroll();
  const heroOpacity = useTransform(scrollY, [0, 400], [1, 0]);
  const heroScale = useTransform(scrollY, [0, 400], [1, 0.96]);
  const drawerRadius = useTransform(scrollY, [200, 600], [28, 0]);

  return (
    <BackgroundAALChecker>
      <div className="relative bg-background">

        {/* ═══════════════ HERO — sticky, fades + scales on scroll ═══════════════ */}
        <div className="sticky top-0 z-0 h-dvh overflow-hidden">
          <WallpaperBackground wallpaperId="brandmark" />
          <motion.div className="relative z-[1] flex flex-col h-full" style={{ opacity: heroOpacity, scale: heroScale }}>
            <div className="flex-1 flex flex-col items-center justify-center px-6 pt-24 text-center pointer-events-none">
              <a
                href={GITHUB_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="pointer-events-auto mb-6 inline-flex items-center gap-2 rounded-full border border-border bg-background/70 px-3.5 py-1.5 text-xs text-muted-foreground backdrop-blur-sm transition-colors hover:border-foreground/20 hover:text-foreground"
              >
                <Star className="size-3 fill-current text-amber-500" />
                <span className="font-medium text-foreground">{formattedStars}</span> stars
                <span className="text-border">·</span>
                Open source on GitHub
              </a>
              <h1 className="text-4xl font-medium leading-[1.04] tracking-tight text-foreground sm:text-5xl md:text-6xl lg:text-7xl">
                The AI command center<br />
                <span className="text-muted-foreground">for your company</span>
              </h1>
              <p className="mt-5 max-w-xl text-base leading-relaxed text-muted-foreground sm:text-lg">
                One place to build, run, and govern your AI-native company.
              </p>
            </div>
            <div className="relative z-[1] pb-8 px-4 flex flex-col items-center gap-6">
              <div className="flex flex-col items-center gap-3 sm:flex-row">
                <Button size="lg" className="h-12 px-8 text-sm rounded-full transition-colors" onClick={handleLaunch}>
                  Launch Your Kortix<ArrowRight className="ml-1.5 size-3.5" />
                </Button>
                <Button asChild size="lg" variant="outline" className="h-12 rounded-full px-7 text-sm">
                  <Link href={DEMO_URL}>Request demo</Link>
                </Button>
              </div>
              <button
                onClick={copyInstall}
                className="group flex items-center gap-2.5 h-9 px-4 rounded-full bg-background/70 border border-border hover:bg-background/90 hover:border-foreground/20 transition-colors cursor-pointer animate-in fade-in slide-in-from-bottom-4 duration-700 delay-200 fill-mode-both backdrop-blur-sm"
              >
                <span className="font-mono text-[11px] text-muted-foreground select-none">$</span>
                <code className="text-[11px] font-mono text-foreground tracking-tight">{installCmd}</code>
                <div className="pl-2.5 border-l border-border">
                  {copied
                    ? <Check className="size-3 text-emerald-500" />
                    : <Copy className="size-3 text-muted-foreground group-hover:text-foreground transition-colors" />
                  }
                </div>
              </button>
              <motion.div
                className="mt-3"
                animate={{ y: [0, 6, 0] }}
                transition={{ duration: 2, repeat: Infinity, ease: 'easeInOut' }}
              >
                <div className="w-5 h-8 rounded-full border-2 border-muted-foreground/20 flex items-start justify-center p-1">
                  <motion.div
                    className="w-1 h-1.5 rounded-full bg-muted-foreground/40"
                    animate={{ y: [0, 8, 0] }}
                    transition={{ duration: 2, repeat: Infinity, ease: 'easeInOut' }}
                  />
                </div>
              </motion.div>
            </div>
          </motion.div>
        </div>

        {/* ═══════════════ DRAWER — rises over the hero, holds everything ═══════════════ */}
        <motion.div className="relative z-10 bg-background" style={{ borderTopLeftRadius: drawerRadius, borderTopRightRadius: drawerRadius }}>
          <div className="flex justify-center pt-5 pb-3">
            <div className="h-[3px] w-8 rounded-full bg-muted-foreground/40" />
          </div>

          {/* the command center — real product */}
          <section className="mx-auto max-w-5xl px-6 pt-4 pb-14 sm:pb-20">
            <StepMedia src={SHOT('01-command-center.png')} alt="The Kortix command center" priority />
          </section>

        {/* ═══════════════ INTEGRATIONS ═══════════════ */}
        <section className="border-y border-border/60 bg-muted/20 py-10">
          <p className="mb-7 text-center text-sm text-muted-foreground">
            Connects to the <span className="font-medium text-foreground">3,000+ apps</span> your company already runs on
          </p>
          <LogoMarquee items={INTEGRATIONS} />
        </section>

        {/* ═══════════════ WALKTHROUGH INTRO ═══════════════ */}
        <section className="mx-auto max-w-3xl px-6 pt-20 text-center sm:pt-28">
          <Reveal>
            <Eyebrow>How it works</Eyebrow>
            <h2 className="mt-3 text-3xl font-medium leading-tight tracking-tight text-foreground sm:text-4xl md:text-5xl">
              Set up your company, A to Z
            </h2>
            <p className="mt-4 text-base leading-relaxed text-muted-foreground sm:text-lg">
              Start with a project, then build it out — invite your team, connect your tools, and turn your real work into agents and skills. Here&apos;s the whole flow.
            </p>
          </Reveal>
        </section>

        {/* ═══════════════ THE TOUR ═══════════════ */}
        {STEPS.map((step, i) => (
          <TourStep key={step.n} step={step} index={i} />
        ))}

        {/* ═══════════════ COMPANY AS CODE (developers) ═══════════════ */}
        <section id="developers" className="scroll-mt-24 border-y border-border/60 bg-muted/20">
          <div className="mx-auto max-w-6xl px-6 py-16 sm:py-24">
            <Reveal>
              <div className="mx-auto mb-12 max-w-2xl text-center">
                <div className="text-xs font-mono uppercase tracking-wider text-muted-foreground">Step 06 <span className="text-foreground/30">·</span> It&apos;s all code</div>
                <h2 className="mt-3 text-2xl font-medium leading-tight tracking-tight text-foreground sm:text-3xl md:text-4xl">Your whole company, as code</h2>
                <p className="mt-4 text-base leading-relaxed text-muted-foreground">
                  One repo is the source of truth. Every agent, skill, trigger, and policy is a plain file — versioned in git, reviewed in a change request, deployed in one command. No black box.
                </p>
              </div>
            </Reveal>
            <div className="grid grid-cols-1 items-center gap-10 lg:grid-cols-2 lg:gap-14">
              <Reveal><CodeWindow /></Reveal>
              <Reveal delay={0.1}>
                <div>
                  <ul className="space-y-3.5">
                    {DEV_POINTS.map((x) => (
                      <li key={x} className="flex items-start gap-3 text-sm leading-relaxed text-muted-foreground">
                        <Check className="mt-0.5 size-4 shrink-0 text-foreground/70" />{x}
                      </li>
                    ))}
                  </ul>
                  <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer" className="group mt-7 flex items-center gap-3 rounded-2xl border border-border/60 bg-card p-4 transition-colors hover:border-foreground/30">
                    <span className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-border bg-muted/40"><Github className="size-5 text-foreground/80" /></span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5 text-sm font-semibold text-foreground"><Star className="size-3.5 fill-current text-amber-500" />{formattedStars} stars on GitHub</div>
                      <div className="mt-0.5 text-sm text-muted-foreground">A leading open AI workspace — star it, fork it, self-host it.</div>
                    </div>
                    <ArrowRight className="size-4 shrink-0 text-muted-foreground transition-all group-hover:translate-x-0.5 group-hover:text-foreground" />
                  </a>
                </div>
              </Reveal>
            </div>
            <Reveal delay={0.15}>
              <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-3">
                {RUNS_ANYWHERE.map(({ icon: Icon, title, desc }) => (
                  <div key={title} className="rounded-2xl border border-border/60 bg-card/40 p-5">
                    <div className="flex items-center gap-2.5"><Icon className="size-4 text-foreground/70" /><h3 className="text-sm font-semibold text-foreground">{title}</h3></div>
                    <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{desc}</p>
                  </div>
                ))}
              </div>
            </Reveal>
          </div>
        </section>

        {/* ═══════════════ THE RESULT — DELIVERABLES ═══════════════ */}
        <section className="mx-auto max-w-6xl px-6 py-16 sm:py-24">
          <Reveal>
            <div className="mx-auto mb-12 max-w-2xl text-center">
              <div className="text-xs font-mono uppercase tracking-wider text-muted-foreground">Step 07 <span className="text-foreground/30">·</span> Watch it work</div>
              <h2 className="mt-3 text-2xl font-medium leading-tight tracking-tight text-foreground sm:text-3xl md:text-4xl">Real work, done — not chat</h2>
              <p className="mt-4 text-base leading-relaxed text-muted-foreground">
                Ask in plain language and an agent plans the work, runs it on a real computer, and hands back a finished deliverable you can review.
              </p>
            </div>
          </Reveal>
          <Reveal delay={0.1}>
            <div className="grid grid-cols-1 gap-5 sm:grid-cols-3">
              {DELIVERABLES.map(({ src, label, sub }) => (
                <div key={label} className="overflow-hidden rounded-2xl border border-border bg-card/40">
                  <div className="relative aspect-[4/3] w-full bg-muted/30">
                    <Image src={src} alt={label} fill sizes="(max-width: 768px) 100vw, 33vw" className="object-cover object-top" />
                  </div>
                  <div className="flex items-center justify-between gap-2 px-4 py-3">
                    <span className="text-sm font-semibold text-foreground">{label}</span>
                    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground"><span className="size-1.5 rounded-full bg-emerald-500" />{sub}</span>
                  </div>
                </div>
              ))}
            </div>
          </Reveal>
        </section>

        {/* ═══════════════ ENTERPRISE & SECURITY ═══════════════ */}
        <section className="border-y border-border/60 bg-muted/20">
          <div className="mx-auto max-w-6xl px-6 py-16 sm:py-24">
            <Reveal>
              <div className="mb-12 max-w-2xl">
                <Eyebrow>Enterprise</Eyebrow>
                <h2 className="mt-3 text-2xl font-medium leading-tight tracking-tight text-foreground sm:text-3xl md:text-4xl">Secure enough to run the whole company</h2>
                <p className="mt-4 text-base leading-relaxed text-muted-foreground">Fine-grained control over who — and which agent — can do what. Built for the teams that take security seriously.</p>
              </div>
            </Reveal>
            <Reveal delay={0.1}>
              <div className="grid grid-cols-1 gap-px overflow-hidden rounded-2xl border border-border/60 bg-border/60 sm:grid-cols-2 lg:grid-cols-3">
                {ENTERPRISE.map(({ icon: Icon, title, desc }) => (
                  <div key={title} className="bg-card/40 p-6">
                    <span className="flex size-10 items-center justify-center rounded-xl border border-border bg-muted/40"><Icon className="size-5 text-foreground/80" /></span>
                    <h3 className="mt-4 text-base font-semibold text-foreground">{title}</h3>
                    <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{desc}</p>
                  </div>
                ))}
              </div>
            </Reveal>
            <Reveal delay={0.15}>
              <div className="mt-6 flex flex-wrap items-center gap-x-6 gap-y-2">
                <Link href={DEMO_URL} className="inline-flex items-center gap-1.5 text-sm font-medium text-foreground transition-all hover:gap-2.5">Request demo<ArrowRight className="size-4" /></Link>
                <Link href={DOCS_URL} className="inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground">Read the docs</Link>
              </div>
            </Reveal>
          </div>
        </section>

        {/* ═══════════════ CLOSING CTA ═══════════════ */}
        <section id="get-started" className="mx-auto max-w-5xl scroll-mt-24 px-6 py-24 text-center sm:py-32">
          <Reveal>
            <Eyebrow>Start free</Eyebrow>
            <h2 className="mx-auto mt-3 max-w-2xl text-3xl font-medium leading-tight tracking-tight text-foreground sm:text-4xl md:text-5xl">Your company&apos;s AI workforce</h2>
            <p className="mx-auto mt-4 max-w-xl text-base leading-relaxed text-muted-foreground sm:text-lg">
              Agents that do real work across your tools. Self-host it free — your infrastructure, your models — or run it fully managed on Kortix cloud.
            </p>
            <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
              <Button size="lg" className="h-12 rounded-full px-8 text-sm" onClick={handleLaunch}>Launch Your Kortix<ArrowRight className="ml-1.5 size-3.5" /></Button>
              <Button asChild size="lg" variant="outline" className="h-12 rounded-full px-7 text-sm"><Link href={DEMO_URL}>Request demo</Link></Button>
            </div>
            <div className="mt-6 flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-sm text-muted-foreground">
              <Link href={DOCS_URL} className="inline-flex items-center gap-1.5 transition-colors hover:text-foreground"><BookOpen className="size-4" />Read the docs</Link>
              <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 transition-colors hover:text-foreground"><Star className="size-3.5 fill-current text-amber-500" />{formattedStars} stars on GitHub</a>
            </div>
            <p className="mt-7 inline-flex items-center gap-2 text-xs text-muted-foreground"><GitBranch className="size-3.5" /> Open source · SSO · roles · on-prem · no lock-in</p>
          </Reveal>
        </section>

          <div className="h-20 sm:h-24" />
        </motion.div>

        {/* ═══════════════ FLOATING CTA BAR ═══════════════ */}
        <div className={cn('fixed bottom-6 left-1/2 z-50 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-border bg-background/95 px-1.5 py-1.5 backdrop-blur-md transition-[transform,opacity] duration-[600ms] ease-[cubic-bezier(0.32,0.72,0,1)] will-change-transform', showFloatingCta ? 'translate-y-0 opacity-100' : 'pointer-events-none translate-y-16 opacity-0')}>
          <button onClick={copyInstall} className="group hidden sm:flex items-center gap-2 h-8 px-3 rounded-full hover:bg-foreground/[0.08] transition-colors cursor-pointer">
            <span className="font-mono text-[11px] text-muted-foreground select-none">$</span>
            <code className="text-[11px] font-mono text-foreground tracking-tight">{installCmdShort}</code>
            {copied ? <Check className="size-3 text-emerald-500" /> : <Copy className="size-3 text-muted-foreground group-hover:text-foreground transition-colors" />}
          </button>
          <span className="hidden sm:block w-px h-5 bg-border" />
          <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer" className="flex items-center justify-center size-8 rounded-full hover:bg-foreground/[0.08] transition-colors">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="https://www.google.com/s2/favicons?domain=github.com&sz=128" alt="GitHub" width={16} height={16} className="size-4 rounded-sm dark:invert" />
          </a>
          <Button size="sm" className="px-5 text-xs rounded-full font-medium" onClick={handleLaunch}>Launch Your Kortix<ArrowRight className="ml-1.5 size-3" /></Button>
        </div>
      </div>
    </BackgroundAALChecker>
  );
}
