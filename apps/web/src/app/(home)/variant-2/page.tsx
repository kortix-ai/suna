'use client';

import { cn } from '@/lib/utils';
import { useEffect, useState, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import { BackgroundAALChecker } from '@/components/auth/background-aal-checker';
import { ArrowRight, Check, Copy, Globe, Smartphone, Bot, Sparkles, Terminal, Zap } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { trackCtaSignup } from '@/lib/analytics/gtm';
import { motion, useScroll, useTransform, useSpring } from 'framer-motion';
import { Reveal } from '@/components/home/reveal';
import { GithubButton } from '@/components/home/github-button';
import Image from 'next/image';
import dynamic from 'next/dynamic';

const KortixBoxScene = dynamic(() => import('@/components/landing/KortixBoxScene'), {
  ssr: false,
  loading: () => <div className="animate-pulse bg-foreground/5 w-full h-full rounded-full blur-3xl opacity-20" />
});

const INSTALL_CMD = 'curl -fsSL https://kortix.com/install | bash';

// ─── Reusable Components ────────────────────────────────

export default function Variant2Home() {
  const router = useRouter();
  const { user, isLoading } = useAuth();
  const [copied, setCopied] = useState(false);
  const [isMachineOn, setIsMachineOn] = useState(false);

  const heroRef = useRef<HTMLDivElement>(null);
  const sceneProgressRef = useRef(0);
  const { scrollYProgress: heroProgress } = useScroll({
    target: heroRef,
    offset: ['start start', 'end start'],
  });

  const smoothProgress = useSpring(heroProgress, { damping: 20, stiffness: 100 });

  useEffect(() => {
    const unsub = smoothProgress.on('change', (v) => {
      sceneProgressRef.current = v;
    });
    return unsub;
  }, [smoothProgress]);

  const heroOpacity = useTransform(heroProgress, [0, 0.5], [1, 0]);
  const heroScale = useTransform(heroProgress, [0, 0.5], [1, 0.9]);
  const sceneOpacity = useTransform(heroProgress, [0, 0.4, 0.8], [1, 1, 0]);

  useEffect(() => {
    if (!isLoading && user) {
      router.replace('/dashboard');
    }
  }, [user, isLoading, router]);

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
      <div className="relative bg-background text-foreground selection:bg-foreground/20">

        {/* 3D Scene — fixed, fades via CSS opacity */}
        <motion.div
          className="fixed inset-0 z-10 pointer-events-none"
          style={{ opacity: sceneOpacity }}
        >
          <KortixBoxScene
            scrollProgressRef={sceneProgressRef}
            isOn={isMachineOn}
            setIsOn={setIsMachineOn}
          />
        </motion.div>

        {/* ═══════════════ HERO ═══════════════ */}
        <div ref={heroRef} className="relative h-[250vh]">
          <motion.section
            className="sticky top-0 h-screen flex flex-col items-center justify-between px-6 z-20 pb-32 pt-32"
            style={{ opacity: heroOpacity, scale: heroScale }}
          >
            {/* Top Content: Headline */}
            <motion.div
              initial={{ opacity: 0, y: 40, filter: 'blur(10px)' }}
              animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
              transition={{ duration: 1.2, ease: [0.16, 1, 0.3, 1] }}
              className="text-center max-w-4xl mx-auto relative z-30 mt-12"
            >
              <h1 className="text-5xl sm:text-7xl md:text-8xl font-medium tracking-tighter leading-[0.9] pb-4 bg-gradient-to-b from-foreground to-foreground/30 text-transparent bg-clip-text">
                The AI Computer.
              </h1>
            </motion.div>

            {/* Bottom Content: CTA */}
            <motion.div
              initial={{ opacity: 0, y: 40, filter: 'blur(10px)' }}
              animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
              transition={{ duration: 1.2, delay: 0.2, ease: [0.16, 1, 0.3, 1] }}
              className="text-center w-full max-w-md mx-auto relative z-30 flex flex-col items-center gap-6 mb-12"
            >
              <Button
                size="lg"
                className="h-14 px-10 text-base rounded-full transition-colors"
                onClick={handleLaunch}
              >
                Launch Kortix<ArrowRight className="ml-2 size-4" />
              </Button>

              <div className="flex flex-col items-center gap-3 w-full">
                <span className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground font-medium">
                  -- or self-host
                </span>
                <button
                  onClick={handleCopy}
                  className="group flex items-center justify-between w-full max-w-sm h-10 px-4 rounded-lg bg-foreground/[0.03] border border-foreground/[0.08] hover:bg-foreground/[0.06] hover:border-foreground/[0.12] transition-colors cursor-pointer backdrop-blur-md"
                >
                  <div className="flex items-center gap-3 overflow-hidden">
                    <span className="font-mono text-xs text-muted-foreground select-none">$</span>
                    <code className="text-xs font-mono text-foreground tracking-tight group-hover:text-foreground transition-colors truncate">{INSTALL_CMD}</code>
                  </div>
                  <div className="pl-3 border-l border-foreground/[0.08] shrink-0">
                    {copied
                      ? <Check className="size-3.5 text-emerald-500" />
                      : <Copy className="size-3.5 text-muted-foreground group-hover:text-muted-foreground transition-colors" />}
                  </div>
                </button>
              </div>
            </motion.div>

            <motion.div
              className="absolute bottom-8 left-1/2 -translate-x-1/2 flex flex-col items-center gap-3 z-30"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 1, duration: 1 }}
            >
              <span className="text-[10px] uppercase tracking-widest text-muted-foreground">Scroll to explore</span>
              <div className="w-px h-8 bg-gradient-to-b from-muted-foreground/30 to-transparent" />
            </motion.div>
          </motion.section>
        </div>

        {/* ═══════════════ CONTENT — below the hero ═══════════════ */}
        <div className="relative z-20 bg-background">

          {/* ── Intro ── */}
          <div className="max-w-3xl mx-auto px-6 pt-24 sm:pt-32 pb-10 sm:pb-14">
            <Reveal>
              <p className="text-2xl sm:text-3xl md:text-4xl font-medium text-foreground leading-snug tracking-tight">
                One machine. All your tools. Agents that run themselves.
              </p>
            </Reveal>
            <Reveal delay={0.1}>
              <p className="mt-4 text-base sm:text-lg text-muted-foreground leading-relaxed max-w-2xl">
                A Kortix is a cloud computer where AI agents do the actual work of running a company. You connect your tools, define your agents, set their schedules and triggers — and the machine operates whether you&apos;re there or not. Persistent memory that compounds. A workforce that never stops.
              </p>
            </Reveal>
          </div>

          {/* ── Showcase ── */}
          <div className="border-t border-border/30 py-10 sm:py-14 overflow-hidden">
            <div className="max-w-3xl mx-auto px-6 mb-8">
              <Reveal>
                <h2 className="text-2xl sm:text-3xl font-medium tracking-tight text-foreground">
                  Real outputs. <span className="text-muted-foreground">Not suggestions.</span>
                </h2>
              </Reveal>
              <Reveal delay={0.1}>
                <p className="mt-2 text-base text-muted-foreground leading-relaxed max-w-xl">
                  Give an agent a goal. It plans, executes, self-verifies, and delivers a finished result. That&apos;s autowork.
                </p>
              </Reveal>
            </div>
            <div className="flex gap-5 px-6 overflow-x-auto pb-4" style={{ scrollbarWidth: 'none' }}>
              {[
                { src: '/showcase/data/dashboard.png', width: 1386, height: 836, label: 'Company Performance Dashboard', prompt: '"Analyse all sales data and build me a dashboard"' },
                { src: '/showcase/presentation/slide1.png', width: 1512, height: 756, label: 'Research Presentation', prompt: '"Create a deck on neural networks for the team"' },
                { src: '/showcase/presentation/slide2.png', width: 1512, height: 756, label: 'Slide with Diagrams', prompt: '"Add a technical deep-dive slide"' },
                { src: '/showcase/image/mockup-board.png', width: 874, height: 1312, label: 'Brand Identity Mockup', prompt: '"Design a logo and brand kit for Luxy"' },
              ].map(({ src, width, height, label, prompt }) => (
                <Reveal key={src} className="flex-none w-[320px] sm:w-[380px]">
                  <div className="rounded-xl overflow-hidden border border-border/40 bg-card/20">
                    <div className="bg-muted/10 border-b border-border/20 px-3 py-2 flex items-center gap-2">
                      <div className="flex gap-1">
                        <div className="size-1.5 rounded-full bg-muted-foreground/15" />
                        <div className="size-1.5 rounded-full bg-muted-foreground/15" />
                        <div className="size-1.5 rounded-full bg-muted-foreground/15" />
                      </div>
                      <span className="text-[0.5625rem] font-mono text-muted-foreground ml-1">output</span>
                    </div>
                    <div className="relative overflow-hidden" style={{ aspectRatio: `${width}/${height}` }}>
                      <Image src={src} alt={label} width={width} height={height} className="w-full h-full object-cover" />
                    </div>
                  </div>
                  <div className="mt-2.5 px-0.5">
                    <div className="text-sm font-medium text-foreground tracking-tight">{label}</div>
                    <div className="mt-1 text-[10px] text-muted-foreground font-mono">{prompt}</div>
                  </div>
                </Reveal>
              ))}
              <div className="flex-none w-6" />
            </div>
          </div>

          {/* ── The system + terminal mockup ── */}
          <div className="border-t border-border/30">
            <div className="max-w-7xl mx-auto px-6 py-10 sm:py-14 grid lg:grid-cols-2 gap-16 lg:gap-24 items-center">
              <div>
                <Reveal>
                  <h2 className="text-2xl sm:text-3xl font-medium tracking-tight text-foreground mb-2">
                    The system
                  </h2>
                </Reveal>
                <Reveal delay={0.1}>
                  <p className="text-base text-muted-foreground leading-relaxed mb-8">
                    Kortix runs on <a href="https://opencode.ai" target="_blank" rel="noopener noreferrer" className="hover:text-foreground/80 transition-colors">OpenCode</a>, an open foundation for building knowledge work agents, with the Kortix cognitive architecture layered on top. Everything is just files.
                  </p>
                </Reveal>
                <Reveal delay={0.2}>
                  <div className="flex flex-col gap-4">
                    {[
                      ['Agents', 'Markdown files with identity, permissions, tools, and triggers. Each one a specialist.'],
                      ['Skills', '60+ knowledge packs — coding, browser automation, deep research, legal writing, spreadsheets.'],
                      ['Autowork', 'Autonomous execution loop. Works until done, self-verifies, only stops when correct.'],
                      ['Triggers', 'Cron schedules and webhooks in agent frontmatter. The machine works while you sleep.'],
                      ['Memory', 'Persistent, filesystem-based, semantic-searchable. The longer it runs, the smarter it gets.'],
                    ].map(([title, desc]) => (
                      <div key={title} className="flex items-start gap-3">
                        <div className="mt-[7px] size-1 rounded-full bg-foreground/25 shrink-0" />
                        <div>
                          <span className="text-sm font-medium text-foreground">{title}</span>
                          <span className="text-sm text-muted-foreground"> — {desc}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </Reveal>
              </div>

              <Reveal delay={0.15}>
                <div className="rounded-2xl overflow-hidden border border-border/40 bg-card/20 font-mono text-[11px]">
                  <div className="bg-muted/10 border-b border-border/30 px-4 py-3 flex items-center gap-2.5">
                    <div className="flex gap-1.5">
                      <div className="size-2.5 rounded-full bg-muted-foreground/15" />
                      <div className="size-2.5 rounded-full bg-muted-foreground/15" />
                      <div className="size-2.5 rounded-full bg-muted-foreground/15" />
                    </div>
                    <span className="text-[10px] font-mono text-muted-foreground ml-1">kortix — session</span>
                  </div>
                  <div className="p-5 space-y-5">
                    <div className="space-y-1">
                      <div className="text-muted-foreground text-[0.5625rem] uppercase tracking-widest">You</div>
                      <div className="text-foreground leading-relaxed">
                        Research our top 3 competitors, summarise their pricing, and send a Slack report to #strategy.
                      </div>
                    </div>
                    <div className="space-y-2 pl-3 border-l border-border/25">
                      <div className="text-muted-foreground text-[0.5625rem] uppercase tracking-widest mb-3">Kortix</div>
                      {[
                        { done: true, text: 'Browsing competitor sites via Chromium...' },
                        { done: true, text: 'Extracting pricing pages (3 sites)...' },
                        { done: true, text: 'Writing analysis to /workspace/research/competitors.md' },
                        { done: true, text: 'Formatting Slack message...' },
                        { done: false, text: 'Sending to #strategy via Slack OAuth...' },
                      ].map(({ done, text }, i) => (
                        <div key={i} className="flex items-start gap-2.5">
                          <div className={cn('mt-[3px] size-1.5 rounded-full shrink-0', done ? 'bg-foreground/20' : 'bg-foreground/50 animate-pulse')} />
                          <span className={done ? 'text-muted-foreground line-through decoration-muted-foreground/25' : 'text-foreground'}>
                            {text}
                          </span>
                        </div>
                      ))}
                    </div>
                    <div className="pt-1 border-t border-border/20 text-foreground leading-relaxed">
                      Done. Report delivered. Saved to workspace for future reference.
                    </div>
                    <div className="flex items-center gap-1.5">
                      <span className="text-foreground">$</span>
                      <span className="w-1.5 h-3.5 bg-muted-foreground/25 animate-pulse inline-block" />
                    </div>
                  </div>
                </div>
              </Reveal>
            </div>
          </div>

          {/* ── Always on + agent status table ── */}
          <div className="border-t border-border/30">
            <div className="max-w-7xl mx-auto px-6 py-10 sm:py-14 grid lg:grid-cols-2 gap-16 lg:gap-24 items-center">
              <Reveal>
                <div className="rounded-2xl overflow-hidden border border-border/40 bg-card/20 font-mono">
                  <div className="bg-muted/10 border-b border-border/30 px-4 py-3 flex items-center justify-between">
                    <div className="flex gap-1.5">
                      <div className="size-2.5 rounded-full bg-muted-foreground/15" />
                      <div className="size-2.5 rounded-full bg-muted-foreground/15" />
                      <div className="size-2.5 rounded-full bg-muted-foreground/15" />
                    </div>
                    <span className="text-[10px] font-mono text-muted-foreground uppercase tracking-widest">root@kortix ~ kortix status</span>
                    <div className="size-2.5 opacity-0" />
                  </div>
                  <div className="p-5 space-y-1 text-[11px]">
                    <div className="grid grid-cols-12 gap-2 text-[0.5625rem] text-muted-foreground uppercase tracking-widest pb-2 border-b border-border/20 mb-3">
                      <div className="col-span-5">Agent</div>
                      <div className="col-span-3">Uptime</div>
                      <div className="col-span-4">Last action</div>
                    </div>
                    {[
                      { name: 'support-agent', uptime: '14d 02:11', last: 'Replied to 3 tickets', running: true },
                      { name: 'bookkeeping', uptime: '14d 02:10', last: 'Reconciled March invoices', running: true },
                      { name: 'recruiter', uptime: '6d 14:45', last: 'Screened 12 applicants', running: true },
                      { name: 'data-pipeline', uptime: '3d 08:20', last: 'Refreshed dashboard data', running: true },
                      { name: 'cron-weekly', uptime: '—', last: 'Next run: Monday 08:00', running: false },
                    ].map(({ name, uptime, last, running }) => (
                      <div key={name} className="grid grid-cols-12 gap-2 py-1.5 items-center">
                        <div className="col-span-5 flex items-center gap-2">
                          <div className={cn('size-1.5 rounded-full shrink-0', running ? 'bg-foreground/40 animate-pulse' : 'bg-muted-foreground/20')} />
                          <span className={running ? 'text-foreground' : 'text-muted-foreground'}>{name}</span>
                        </div>
                        <div className="col-span-3 text-muted-foreground">{uptime}</div>
                        <div className="col-span-4 text-muted-foreground truncate">{last}</div>
                      </div>
                    ))}
                    <div className="flex items-center gap-1.5 pt-3 border-t border-border/20 mt-2">
                      <span className="text-foreground">$</span>
                      <span className="w-1.5 h-3.5 bg-muted-foreground/25 animate-pulse inline-block" />
                    </div>
                  </div>
                </div>
              </Reveal>

              <div>
                <Reveal>
                  <h2 className="text-2xl sm:text-3xl font-medium tracking-tight text-foreground mb-2">
                    Deploy and check in
                  </h2>
                </Reveal>
                <Reveal delay={0.1}>
                  <p className="text-base text-muted-foreground leading-relaxed mb-8">
                    Your agents run 24/7. Triggers fire them on schedule. Autowork keeps them going until the job is verified done. You check in from anywhere — whenever you want.
                  </p>
                </Reveal>
                <Reveal delay={0.2}>
                  <div className="flex flex-col gap-4">
                    {[
                      ['Cron triggers', 'Schedule any agent at any interval — hourly, daily, weekly'],
                      ['Event webhooks', 'React to external events the moment they happen'],
                      ['Orchestration', 'One agent delegates to many. Parallel sub-agents, background sessions.'],
                      ['Channels', 'Talk to agents from Slack, Telegram, Discord, web, or mobile'],
                    ].map(([title, desc]) => (
                      <div key={title} className="flex items-start gap-3">
                        <div className="mt-[7px] size-1 rounded-full bg-foreground/25 shrink-0" />
                        <div>
                          <span className="text-sm font-medium text-foreground">{title}</span>
                          <span className="text-sm text-muted-foreground"> — {desc}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </Reveal>
              </div>
            </div>
          </div>

          {/* ── Ownership + filesystem tree ── */}
          <div className="border-t border-border/30">
            <div className="max-w-3xl mx-auto px-6 py-10 sm:py-14">
              <Reveal>
                <h2 className="text-2xl sm:text-3xl font-medium tracking-tight text-foreground mb-2">
                  Everything is files
                </h2>
              </Reveal>
              <Reveal delay={0.1}>
                <p className="text-base text-muted-foreground leading-relaxed mb-10 max-w-2xl">
                  Agents, skills, memory, credentials, browser profiles — all on the filesystem you own. Human-readable, git-trackable, SSH-accessible.
                </p>
              </Reveal>

              <div className="grid sm:grid-cols-2 gap-8">
                <Reveal delay={0.15}>
                  <div className="rounded-2xl border border-border/40 bg-card/20 overflow-hidden">
                    <div className="px-5 py-4 border-b border-border/25">
                      <div className="text-[10px] uppercase tracking-widest text-muted-foreground font-medium">Connected</div>
                    </div>
                    <div className="p-4 flex flex-col gap-2">
                      {[
                        { name: 'Gmail', tag: 'OAuth' },
                        { name: 'Slack', tag: 'OAuth' },
                        { name: 'GitHub', tag: 'CLI + API' },
                        { name: 'Notion', tag: 'MCP' },
                        { name: 'Stripe', tag: 'API' },
                        { name: 'Linear', tag: 'MCP' },
                      ].map(({ name, tag }) => (
                        <div key={name} className="flex items-center justify-between py-1.5">
                          <span className="text-sm text-foreground font-medium">{name}</span>
                          <span className="text-[0.5625rem] font-mono uppercase tracking-widest text-muted-foreground bg-muted/20 px-2 py-0.5 rounded-md">{tag}</span>
                        </div>
                      ))}
                      <div className="pt-2 text-[10px] text-muted-foreground text-center border-t border-border/20">
                        3,000+ via OAuth · MCP · REST · CLI · env vars
                      </div>
                    </div>
                  </div>
                </Reveal>

                <Reveal delay={0.25}>
                  <div className="rounded-2xl border border-border/40 bg-card/20 overflow-hidden font-mono text-[11px]">
                    <div className="px-5 py-4 border-b border-border/25">
                      <div className="text-[10px] uppercase tracking-widest text-muted-foreground font-medium">~/workspace</div>
                    </div>
                    <div className="p-4 flex flex-col gap-0.5">
                      {[
                        { d: 0, n: '.opencode/', f: false },
                        { d: 1, n: 'agents/', f: false },
                        { d: 1, n: 'skills/', f: false },
                        { d: 1, n: 'storage/memory.db', f: true },
                        { d: 0, n: '.secrets/', f: false },
                        { d: 0, n: '.browser-profile/', f: false },
                        { d: 0, n: 'projects/', f: false },
                      ].map(({ d, n, f }, i) => (
                        <div
                          key={i}
                          className="flex items-center gap-2 py-1 px-1 rounded hover:bg-muted/15 transition-colors"
                          style={{ paddingLeft: `${d * 1.25 + 0.25}rem` }}
                        >
                          <span className="text-muted-foreground text-[10px]">{f ? '·' : '▸'}</span>
                          <span className="text-foreground">{n}</span>
                        </div>
                      ))}
                      <div className="mt-2 pt-2 border-t border-border/20 text-muted-foreground pl-1">
                        SSH · git-trackable · grep-searchable
                      </div>
                    </div>
                  </div>
                </Reveal>
              </div>
            </div>
          </div>

          {/* ── CTA ── */}
          <Reveal>
            <section className="max-w-3xl mx-auto px-6 py-14 sm:py-16 border-t border-border/30 flex flex-col items-center gap-4">
              <div className="flex items-center gap-3">
                <Button
                  size="lg"
                  className="h-11 px-7 text-sm rounded-full"
                  onClick={handleLaunch}
                >
                  Get Started<ArrowRight className="ml-1.5 size-3.5" />
                </Button>
                <GithubButton size="lg" className="h-11" />
              </div>
              <button
                onClick={handleCopy}
                className="group inline-flex items-center gap-2.5 h-9 px-4 rounded-lg bg-foreground/[0.03] border border-foreground/[0.08] hover:bg-foreground/[0.06] hover:border-foreground/[0.12] transition-colors cursor-pointer"
              >
                <span className="font-mono text-[11px] text-muted-foreground select-none">$</span>
                <code className="text-[11px] font-mono text-foreground tracking-tight">{INSTALL_CMD}</code>
                <div className="pl-2.5 border-l border-foreground/[0.08]">
                  {copied
                    ? <Check className="size-3 text-emerald-500" />
                    : <Copy className="size-3 text-muted-foreground group-hover:text-muted-foreground transition-colors" />
                  }
                </div>
              </button>
            </section>
          </Reveal>

        </div>
      </div>
    </BackgroundAALChecker>
  );
}
