'use client';

import { cn } from '@/lib/utils';
import { useState, useCallback, useEffect } from 'react';
import { BackgroundAALChecker } from '@/components/auth/background-aal-checker';
import { WallpaperBackground } from '@/components/ui/wallpaper-background';
import { ArrowRight, Check, Copy, Globe, Smartphone, Bot, Sparkles, Terminal, Zap, RefreshCw, Brain, GitFork, Blocks } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { trackCtaSignup } from '@/lib/analytics/gtm';
import { motion, useScroll, useTransform } from 'framer-motion';
import { useAuth } from '@/components/AuthProvider';
import { Reveal } from '@/components/home/reveal';

const INSTALL_CMD = 'curl -fsSL https://kortix.com/install | bash';

/* ─── Google Favicon helper ─── */
const favicon = (domain: string) =>
  `https://www.google.com/s2/favicons?domain=${domain}&sz=128`;

/* ─── Integration pill ─── */
function IntegrationPill({ domain, icon, name }: { domain?: string; icon?: React.ReactNode; name: string }) {
  return (
    <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-border bg-card/60 hover:bg-muted/50 transition-colors">
      {domain ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={favicon(domain)} alt={name} width={16} height={16} className="size-4 shrink-0 rounded-sm" />
      ) : (
        <div className="size-4 shrink-0">{icon}</div>
      )}
      <span className="text-[13px] font-medium text-foreground">{name}</span>
    </div>
  );
}

/* ─── Config card (for agents/skills/commands/triggers) ─── */
function ConfigCard({ icon, title, desc }: { icon: React.ReactNode; title: string; desc: string }) {
  return (
    <div className="flex items-start gap-3 p-4 rounded-xl border border-border bg-card/40">
      <div className="mt-0.5 flex items-center justify-center size-8 rounded-lg bg-foreground/[0.06] border border-foreground/[0.1] shrink-0">
        {icon}
      </div>
      <div>
        <span className="text-sm font-medium text-foreground">{title}</span>
        <p className="text-[13px] text-muted-foreground mt-1 leading-relaxed">{desc}</p>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════ */

export default function Home() {
  const [copied, setCopied] = useState(false);
  const [showFloatingCta, setShowFloatingCta] = useState(false);
  const { user } = useAuth();

  const { scrollY } = useScroll();
  const drawerRadius = useTransform(scrollY, [200, 600], [24, 0]);
  const heroOpacity = useTransform(scrollY, [0, 400], [1, 0]);
  const heroScale = useTransform(scrollY, [0, 400], [1, 0.95]);

  useEffect(() => {
    const onScroll = () => setShowFloatingCta(window.scrollY > window.innerHeight);
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(INSTALL_CMD);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, []);

  const handleLaunch = useCallback(() => {
    trackCtaSignup();
    if (!user) {
      window.location.href = '/auth';
      return;
    }
    window.location.href = '/instances';
  }, [user]);

  return (
    <BackgroundAALChecker>
      <div className="relative bg-background">

        {/* ═══════════════ HERO ═══════════════ */}
        <div className="sticky top-0 h-dvh overflow-hidden z-0">
          <WallpaperBackground wallpaperId="brandmark" />
          <motion.div
            className="relative z-[1] flex flex-col h-full"
            style={{ opacity: heroOpacity, scale: heroScale }}
          >
            <div className="flex-1 flex items-center justify-center pt-40 pointer-events-none">
              <h1 className="text-4xl sm:text-5xl md:text-6xl font-medium tracking-tight text-foreground text-center">
                The Autonomous Company<br />
                <span className="text-muted-foreground">Operating System</span>
              </h1>
            </div>
            <div className="relative z-[1] pb-8 px-4 flex flex-col items-center gap-6">
              <Button
                size="lg"
                className="h-12 px-8 text-sm rounded-full transition-colors"
                onClick={handleLaunch}
              >
                Launch Your Kortix<ArrowRight className="ml-1.5 size-3.5" />
              </Button>
              <button
                onClick={handleCopy}
                className="group flex items-center gap-2.5 h-9 px-4 rounded-full bg-background/70 border border-border hover:bg-background/90 hover:border-foreground/20 transition-colors cursor-pointer animate-in fade-in slide-in-from-bottom-4 duration-700 delay-200 fill-mode-both backdrop-blur-sm"
              >
                <span className="font-mono text-[11px] text-muted-foreground select-none">$</span>
                <code className="text-[11px] font-mono text-foreground tracking-tight">{INSTALL_CMD}</code>
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

        {/* ═══════════════ DRAWER ═══════════════ */}
        <motion.div
          className="relative z-10 bg-background"
          style={{ borderTopLeftRadius: drawerRadius, borderTopRightRadius: drawerRadius }}
        >
          {/* Handle */}
          <div className="flex justify-center pt-5 pb-3">
            <div className="w-8 h-[3px] rounded-full bg-muted-foreground/40" />
          </div>

          {/* ── Launch Video (commented out temporarily) ──
          <Reveal>
          <section className="max-w-5xl mx-auto px-6 pt-8 pb-10 sm:pb-14">
            <div className="rounded-xl overflow-hidden border border-border/50 bg-card/20 shadow-sm">
              <div className="relative aspect-video bg-black">
                <iframe
                  src="https://www.youtube.com/embed/Eu5mYMavctM"
                  title="Kortix launch video"
                  allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                  allowFullScreen
                  className="absolute inset-0 w-full h-full"
                />
              </div>
            </div>
          </section>
          </Reveal>
          */}

        {/* ═══════════════ WHAT IS KORTIX ═══════════════ */}
        <section className="max-w-3xl mx-auto px-6 py-10 sm:py-14">
          <Reveal>
          <p className="text-2xl sm:text-3xl md:text-4xl font-medium text-foreground leading-snug tracking-tight">
            Maximum entropy. Full context. Let the agents run free.
          </p>
          </Reveal>
          <Reveal delay={0.1}>
          <p className="mt-3 text-base sm:text-lg text-muted-foreground leading-relaxed max-w-2xl">
            The best results come from giving a language model everything — full context, every secret, every integration, every piece of institutional knowledge — and letting it operate freely. For that, it needs a proper machine. A real computer running 24/7 where all the context is stored, all the credentials live, all the work accumulates, and all the other agents work alongside it.
          </p>
          </Reveal>
          <Reveal delay={0.15}>
          <p className="mt-3 text-base sm:text-lg text-muted-foreground leading-relaxed max-w-2xl">
            A Kortix <em>is</em> a company. One shared machine where every agent sees the same filesystem, the same databases, the same history. Context isn&apos;t siloed per tool or per session — it&apos;s shared across the entire system, compounding over time. Coding agents operating inside a full Linux environment are the optimal harness for all knowledge work — not just engineering, but sales, finance, ops, legal, support, and everything in between. We&apos;re building this as our own internal operating system to run our own companies, and open-sourcing the whole thing.
          </p>
          </Reveal>
        </section>

        {/* ═══════════════ THE SYSTEM ═══════════════ */}
        <section className="max-w-3xl mx-auto px-6 py-10 sm:py-14">
          <Reveal>
          <h2 className="text-2xl sm:text-3xl font-medium tracking-tight text-foreground mb-2">
            The system
          </h2>
          </Reveal>
          <Reveal delay={0.1}>
          <p className="text-sm text-muted-foreground leading-relaxed max-w-2xl mb-2">
            Everything runs inside one shared Linux Ubuntu machine. Agents have bash, a real filesystem, package managers, databases, and the entire software ecosystem — plus full access to every credential, file, and piece of context in the system. One machine, total openness, maximum results.
          </p>
          </Reveal>
          <Reveal delay={0.15}>
          <div className="flex flex-col gap-4 mt-6">
            {[
              { icon: <Bot className="size-4" />, title: 'Agents', desc: 'Markdown files with their own identity, permissions, tools, and triggers. A support agent, a bookkeeper, a recruiter, a sales rep — each a specialist operating inside the same machine.' },
              { icon: <Sparkles className="size-4" />, title: 'Skills', desc: 'Reusable knowledge packs that teach agents how to do real work — coding, browser automation, deep research, legal writing, spreadsheets, data analysis, and more. 60+ built-in, and writing new ones is just writing code.' },
              { icon: <RefreshCw className="size-4" />, title: 'Autowork', desc: 'The autonomous execution loop. An agent works until the task is done, self-verifies, and only stops when it can prove the result is correct.' },
              { icon: <Zap className="size-4" />, title: 'Triggers', desc: 'Time-driven or event-driven. Cron schedules and webhooks with prompt, command, or HTTP actions. Git-versionable config. Morning briefings, recurring jobs, real-time reactions.' },
              { icon: <Brain className="size-4" />, title: 'Memory', desc: 'Persistent, filesystem-based, and shared across all agents. Every decision, preference, and context is retained on the same machine. The longer the system runs, the smarter the whole company gets.' },
              { icon: <GitFork className="size-4" />, title: 'Orchestration', desc: 'One agent delegates to many. Projects, background sessions, parallel sub-agents. A primary orchestrator decomposes work and tracks it to completion — like departments in a company.' },
              { icon: <Blocks className="size-4" />, title: 'Open standards', desc: (<>Runs on <a href="https://opencode.ai" target="_blank" rel="noopener noreferrer" className="text-foreground font-medium underline underline-offset-2 decoration-foreground/30 hover:decoration-foreground transition-colors">OpenCode</a> — an open foundation for agent skills, tools, and commands.</>) },
            ].map(({ icon, title, desc }) => (
              <div key={title} className="flex items-start gap-3">
                <div className="mt-0.5 flex items-center justify-center size-7 rounded-lg bg-foreground/[0.06] border border-foreground/[0.1] text-foreground/80 shrink-0">
                  {icon}
                </div>
                <div>
                  <span className="text-sm font-semibold text-foreground">{title}</span>
                  <p className="text-sm text-muted-foreground leading-relaxed mt-1">{desc}</p>
                </div>
              </div>
            ))}
          </div>
          </Reveal>
        </section>

        {/* ═══════════════ HOW IT WORKS ═══════════════ */}
        <section className="max-w-3xl mx-auto px-6 py-10 sm:py-14">
          <Reveal>
          <h2 className="text-2xl sm:text-3xl font-medium tracking-tight text-foreground mb-2">
            How it works
          </h2>
          </Reveal>
          <Reveal delay={0.1}>
          <p className="text-base text-muted-foreground leading-relaxed max-w-2xl mb-8">
            Connect your tools. Configure your agents. Deploy them. An entire company&apos;s knowledge work — automated inside one machine.
          </p>
          </Reveal>

          <div className="flex flex-col gap-10">
            {/* Step 1 — Connect Everything */}
            <Reveal>
            <div>
              <div className="flex items-center gap-3 mb-2">
                <span className="text-[13px] font-mono text-muted-foreground">/01</span>
                <span className="text-sm font-semibold text-foreground">Connect everything</span>
              </div>
              <p className="text-sm text-muted-foreground leading-relaxed mb-4 max-w-xl">
                Every tool your company uses — OAuth apps, MCP servers, REST APIs, CLI tools, environment variables. If it has an interface, Kortix connects to it. 3,000+ integrations available, and custom ones are trivial to add.
              </p>
              <div className="flex flex-wrap gap-2">
                <IntegrationPill domain="gmail.com" name="Gmail" />
                <IntegrationPill domain="slack.com" name="Slack" />
                <IntegrationPill domain="github.com" name="GitHub" />
                <IntegrationPill domain="stripe.com" name="Stripe" />
                <IntegrationPill domain="notion.so" name="Notion" />
                <IntegrationPill domain="hubspot.com" name="HubSpot" />
                <IntegrationPill domain="drive.google.com" name="Drive" />
              </div>
              <p className="mt-3 text-[11px] text-muted-foreground">
                3,000+ via OAuth · MCP · REST · CLI · env vars
              </p>
            </div>
            </Reveal>

            {/* Step 2 — Configure Your System */}
            <Reveal>
            <div>
              <div className="flex items-center gap-3 mb-2">
                <span className="text-[13px] font-mono text-muted-foreground">/02</span>
                <span className="text-sm font-semibold text-foreground">Configure your system</span>
              </div>
              <p className="text-sm text-muted-foreground leading-relaxed mb-4 max-w-xl">
                Define agents for every function — engineering, sales, finance, ops, legal, support. Each agent is a markdown file with its own identity, permissions, skills, and activation rules. Because they run inside a full Linux environment, anything you can script, they can do. Compose them into an autonomous workforce.
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <ConfigCard
                  icon={<Bot className="size-4 text-foreground" />}
                  title="Agents"
                  desc="Markdown files that define autonomous workers — identity, permissions, tools, triggers. Each one a specialist."
                />
                <ConfigCard
                  icon={<Sparkles className="size-4 text-foreground" />}
                  title="Skills"
                  desc="Knowledge packs that teach agents what to do — coding, research, browser automation, legal writing, spreadsheets. 60+ built-in."
                />
                <ConfigCard
                  icon={<Terminal className="size-4 text-foreground" />}
                  title="Commands"
                  desc="Slash commands that trigger structured workflows. /autowork and /onboarding — your playbooks, automated."
                />
                <ConfigCard
                  icon={<Zap className="size-4 text-foreground" />}
                  title="Triggers"
                  desc="Cron schedules and webhooks defined in agent frontmatter. Morning briefings, event-driven reactions, recurring jobs."
                />
              </div>
            </div>
            </Reveal>

            {/* Step 3 — Deploy & Check In */}
            <Reveal>
            <div>
              <div className="flex items-center gap-3 mb-2">
                <span className="text-[13px] font-mono text-muted-foreground">/03</span>
                <span className="text-sm font-semibold text-foreground">Deploy and check in</span>
              </div>
              <p className="text-sm text-muted-foreground leading-relaxed mb-4 max-w-xl">
                Your agents run 24/7. Triggers fire them on schedule. Autowork keeps them going until the job is verified done. You check in from the dashboard, your phone, or your team&apos;s messaging platform — whenever you want.
              </p>
              <div className="flex flex-wrap gap-2">
                <IntegrationPill icon={<Globe className="size-4 text-foreground" />} name="Web" />
                <IntegrationPill icon={<Smartphone className="size-4 text-foreground" />} name="iOS / Android" />
                <IntegrationPill domain="slack.com" name="Slack" />
                <IntegrationPill domain="teams.microsoft.com" name="MS Teams" />
                <IntegrationPill domain="telegram.org" name="Telegram" />
                <IntegrationPill domain="discord.com" name="Discord" />
              </div>
            </div>
            </Reveal>
          </div>
        </section>

        {/* Bottom spacing for floating CTA clearance */}
        <div className="h-24 sm:h-28" />

        </motion.div>

        {/* ═══════════════ FLOATING CTA BAR ═══════════════ */}
        <div
           className={cn('fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-1.5 px-1.5 py-1.5 rounded-full border border-border bg-background/95 backdrop-blur-md will-change-transform transition-[transform,opacity] duration-[600ms] ease-[cubic-bezier(0.32,0.72,0,1)]',
            showFloatingCta ? 'translate-y-0 opacity-100' : 'translate-y-16 opacity-0 pointer-events-none'
          )}
        >
          <button
            onClick={handleCopy}
            className="group hidden sm:flex items-center gap-2 h-8 px-3 rounded-full hover:bg-foreground/[0.08] transition-colors cursor-pointer"
          >
            <span className="font-mono text-[11px] text-muted-foreground select-none">$</span>
            <code className="text-[11px] font-mono text-foreground tracking-tight">curl -fsSL kortix.com/install</code>
            {copied
              ? <Check className="size-3 text-emerald-500" />
              : <Copy className="size-3 text-muted-foreground group-hover:text-foreground transition-colors" />
            }
          </button>
          <span className="hidden sm:block w-px h-5 bg-border" />
          <a
            href="https://github.com/kortix-ai/suna"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center justify-center size-8 rounded-full hover:bg-foreground/[0.08] transition-colors"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="https://www.google.com/s2/favicons?domain=github.com&sz=128" alt="GitHub" width={16} height={16} className="size-4 rounded-sm dark:invert" />
          </a>
          <Button
            size="sm"
            className="px-5 text-xs rounded-full font-medium"
            onClick={handleLaunch}
          >
            Launch Your Kortix<ArrowRight className="ml-1.5 size-3" />
          </Button>
        </div>
      </div>
    </BackgroundAALChecker>
  );
}
