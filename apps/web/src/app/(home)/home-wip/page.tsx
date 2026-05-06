'use client';

import { cn } from '@/lib/utils';
import { useState, useCallback, useEffect } from 'react';
import Link from 'next/link';
import { BackgroundAALChecker } from '@/components/auth/background-aal-checker';
import { WallpaperBackground } from '@/components/ui/wallpaper-background';
import {
  ArrowRight,
  Check,
  Copy,
  Globe,
  Folder,
  Cloud,
  FileSpreadsheet,
  FileText,
  Presentation,
  Image as ImageIcon,
  Search,
  GitFork,
  ShieldCheck,
  Server,
  Github,
  Play,
  Layers,
  Workflow,
  Sparkles,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';
import { trackCtaSignup } from '@/lib/analytics/gtm';
import { motion, useScroll, useTransform } from 'framer-motion';
import { useAuth } from '@/components/AuthProvider';
import { Reveal } from '@/components/home/reveal';

const INSTALL_CMD = 'curl -fsSL https://kortix.com/install | bash';

/* ─── Google Favicon helper ─── */
const favicon = (domain: string) =>
  `https://www.google.com/s2/favicons?domain=${domain}&sz=128`;

/* ───────────────────────────────────────────────────────────────
   PLACEHOLDER MEDIA SLOTS
   Renders a labeled box telling Marko exactly what to drop in.
   Replace `src` (or swap to <video>/<img>) once recordings/screens are ready.
   ─────────────────────────────────────────────────────────────── */
function MediaPlaceholder({
  label,
  hint,
  aspect = 'aspect-video',
  src,
  alt,
  kind = 'video',
}: {
  label: string;
  hint: string;
  aspect?: string;
  src?: string;
  alt?: string;
  kind?: 'video' | 'image';
}) {
  if (src && kind === 'image') {
    return (
      <div
        className={cn(
          'relative w-full overflow-hidden rounded-2xl border border-border bg-card',
          aspect,
        )}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={src}
          alt={alt ?? label}
          className="absolute inset-0 w-full h-full object-cover"
        />
      </div>
    );
  }
  return (
    <div
      className={cn(
        'relative w-full overflow-hidden rounded-2xl border-2 border-dashed border-foreground/15 bg-foreground/[0.02] flex flex-col items-center justify-center text-center px-6',
        aspect,
      )}
    >
      <div className="absolute top-3 left-3 inline-flex items-center gap-1.5 px-2 py-1 rounded-full bg-foreground/5 border border-foreground/10">
        {kind === 'video' ? <Play className="size-3" /> : <ImageIcon className="size-3" />}
        <span className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
          {kind === 'video' ? 'record' : 'screenshot'}
        </span>
      </div>
      <span className="text-sm font-semibold text-foreground">{label}</span>
      <span className="mt-1 text-xs text-muted-foreground max-w-md">{hint}</span>
    </div>
  );
}

/* ─── Integration pill ─── */
function IntegrationPill({
  domain,
  icon,
  name,
}: {
  domain?: string;
  icon?: React.ReactNode;
  name: string;
}) {
  return (
    <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-border bg-card/60 hover:bg-muted/50 transition-colors">
      {domain ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={favicon(domain)}
          alt={name}
          width={16}
          height={16}
          className="size-4 shrink-0 rounded-sm"
        />
      ) : (
        <div className="size-4 shrink-0">{icon}</div>
      )}
      <span className="text-[13px] font-medium text-foreground">{name}</span>
    </div>
  );
}

/* ─── Deliverable card (gallery) ─── */
function DeliverableCard({
  icon,
  title,
  desc,
  src,
}: {
  icon: React.ReactNode;
  title: string;
  desc: string;
  src: string;
}) {
  return (
    <div className="group relative rounded-2xl border border-border bg-card/40 overflow-hidden">
      <div className="relative aspect-[16/10] overflow-hidden bg-muted/30">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={src}
          alt={title}
          className="absolute inset-0 w-full h-full object-cover transition-transform duration-700 group-hover:scale-[1.02]"
        />
      </div>
      <div className="p-5">
        <div className="flex items-center gap-2 mb-1.5">
          <div className="flex items-center justify-center size-6 rounded-md bg-foreground/[0.06] border border-foreground/10 text-foreground/80">
            {icon}
          </div>
          <span className="text-sm font-semibold text-foreground">{title}</span>
        </div>
        <p className="text-[13px] text-muted-foreground leading-relaxed">{desc}</p>
      </div>
    </div>
  );
}

/* ─── Where-it-runs column ─── */
function RuntimeColumn({
  icon,
  title,
  desc,
  pills,
}: {
  icon: React.ReactNode;
  title: string;
  desc: string;
  pills: React.ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-border bg-card/40 p-6 flex flex-col">
      <div className="flex items-center justify-center size-10 rounded-xl bg-foreground/[0.06] border border-foreground/10 text-foreground mb-4">
        {icon}
      </div>
      <h3 className="text-base font-semibold text-foreground">{title}</h3>
      <p className="mt-1.5 text-sm text-muted-foreground leading-relaxed">{desc}</p>
      <div className="mt-4 flex flex-wrap gap-2">{pills}</div>
    </div>
  );
}

/* ─── Numbered use case ─── */
function UseCase({
  n,
  title,
  desc,
  src,
}: {
  n: string;
  title: string;
  desc: string;
  src?: string;
}) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-12 gap-6 md:gap-10 items-center">
      <div className="md:col-span-5">
        <div className="text-[11px] font-mono text-muted-foreground mb-2">{n}</div>
        <h3 className="text-xl sm:text-2xl font-medium tracking-tight text-foreground">{title}</h3>
        <p className="mt-2.5 text-sm text-muted-foreground leading-relaxed">{desc}</p>
      </div>
      <div className="md:col-span-7">
        <MediaPlaceholder
          label={`Demo: ${title}`}
          hint="Screen recording or screenshot of Suna performing this workflow end-to-end."
          src={src}
          kind={src ? 'image' : 'video'}
        />
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════ */

export default function HomeWip() {
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
    window.location.href = '/dashboard';
  }, [user]);

  return (
    <BackgroundAALChecker>
      <div className="relative bg-background">

        {/* ═══════════════ HERO (sticky, brandmark wallpaper) ═══════════════ */}
        <div className="sticky top-0 h-dvh overflow-hidden z-0">
          <WallpaperBackground wallpaperId="brandmark" />
          <motion.div
            className="relative z-[1] flex flex-col h-full"
            style={{ opacity: heroOpacity, scale: heroScale }}
          >
            <div className="flex-1 flex flex-col items-center justify-center pt-32 px-6 pointer-events-none">
              <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-border bg-background/60 backdrop-blur-sm text-[11px] font-medium text-muted-foreground mb-6 pointer-events-auto">
                <span className="size-1.5 rounded-full bg-emerald-500" />
                Open source · Self-hostable · MIT-licensed core
              </div>
              <h1 className="text-4xl sm:text-5xl md:text-6xl font-medium tracking-tight text-foreground text-center leading-[1.05]">
                The open<br />
                <span className="text-muted-foreground">AI workspace</span>
              </h1>
              <p className="mt-6 text-base sm:text-lg text-muted-foreground leading-relaxed max-w-2xl text-center">
                Hand off your most time-consuming work. Suna runs across your local files, cloud tools, and the browser, and ships back finished deliverables — spreadsheets, decks, docs, PDFs.
              </p>
            </div>
            <div className="relative z-[1] pb-8 px-4 flex flex-col items-center gap-6">
              <Button
                size="lg"
                className="h-12 px-8 text-sm rounded-full transition-colors"
                onClick={handleLaunch}
              >
                Get Started Free
                <ArrowRight className="ml-1.5 size-3.5" />
              </Button>
              <button
                onClick={handleCopy}
                className="group flex items-center gap-2.5 h-9 px-4 rounded-full bg-background/70 border border-border hover:bg-background/90 hover:border-foreground/20 transition-colors cursor-pointer animate-in fade-in slide-in-from-bottom-4 duration-700 delay-200 fill-mode-both backdrop-blur-sm"
              >
                <span className="font-mono text-[11px] text-muted-foreground select-none">$</span>
                <code className="text-[11px] font-mono text-foreground tracking-tight">{INSTALL_CMD}</code>
                <div className="pl-2.5 border-l border-border">
                  {copied ? (
                    <Check className="size-3 text-emerald-500" />
                  ) : (
                    <Copy className="size-3 text-muted-foreground group-hover:text-foreground transition-colors" />
                  )}
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

          {/* ═══════════════ HERO VIDEO ═══════════════ */}
          <Reveal>
            <section className="max-w-5xl mx-auto px-6 pt-8 pb-10 sm:pb-14">
              <MediaPlaceholder
                label="HERO VIDEO — 60–90s product loom"
                hint="One prompt → Suna spawns parallel tasks → finished deck/sheet/doc returned. Or swap in YouTube embed Eu5mYMavctM."
                aspect="aspect-video"
                kind="video"
              />
            </section>
          </Reveal>

          {/* ═══════════════ DELIVERABLES GALLERY ═══════════════ */}
          <section className="max-w-6xl mx-auto px-6 py-12 sm:py-16">
            <Reveal>
              <div className="max-w-2xl mb-10">
                <span className="text-[11px] font-mono uppercase tracking-wider text-muted-foreground">
                  /01 · Deliverables
                </span>
                <h2 className="mt-3 text-2xl sm:text-3xl md:text-4xl font-medium tracking-tight text-foreground leading-tight">
                  This is what comes back.
                </h2>
                <p className="mt-3 text-base text-muted-foreground leading-relaxed max-w-xl">
                  Not transcripts. Not chats. Finished work — the artifact you would have built yourself, returned ready to send.
                </p>
              </div>
            </Reveal>

            <Reveal delay={0.1}>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
                <DeliverableCard
                  icon={<Presentation className="size-3.5" />}
                  title="Slide decks"
                  desc="Pitch decks, board decks, weekly readouts — assembled from your sources, formatted to your brand."
                  src="/images/landing-showcase/slides.png"
                />
                <DeliverableCard
                  icon={<FileSpreadsheet className="size-3.5" />}
                  title="Spreadsheets"
                  desc="Models, dashboards, comp sets, scraped lists. Cleaned, structured, ready to filter."
                  src="/images/landing-showcase/data.png"
                />
                <DeliverableCard
                  icon={<FileText className="size-3.5" />}
                  title="Documents & PDFs"
                  desc="Reports, briefs, contracts, memos. Drafted from primary sources, cited and ready to ship."
                  src="/images/landing-showcase/docs.png"
                />
                <DeliverableCard
                  icon={<Search className="size-3.5" />}
                  title="Research syntheses"
                  desc="Read-through across dozens of sources, returned as a structured summary you can act on."
                  src="/images/landing-showcase/research.png"
                />
                <DeliverableCard
                  icon={<ImageIcon className="size-3.5" />}
                  title="Images & creative"
                  desc="On-brand visuals, diagrams, social cards, marketing assets — generated and edited in-flow."
                  src="/images/landing-showcase/images.png"
                />
                <div className="rounded-2xl border border-dashed border-border bg-card/20 p-6 flex flex-col justify-between min-h-[260px]">
                  <div className="flex items-center gap-2">
                    <div className="flex items-center justify-center size-6 rounded-md bg-foreground/[0.06] border border-foreground/10">
                      <Sparkles className="size-3.5" />
                    </div>
                    <span className="text-sm font-semibold text-foreground">…and anything else</span>
                  </div>
                  <p className="text-[13px] text-muted-foreground leading-relaxed">
                    Suna runs in a full Linux environment with internet, browser, and your tools — so the deliverable is whatever the work needs.
                  </p>
                  <Link href="/templates" className="inline-flex items-center gap-1.5 text-xs font-medium text-foreground hover:gap-2 transition-all">
                    Explore templates <ArrowRight className="size-3" />
                  </Link>
                </div>
              </div>
            </Reveal>
          </section>

          {/* ═══════════════ WHERE IT RUNS ═══════════════ */}
          <section className="max-w-6xl mx-auto px-6 py-12 sm:py-16 border-t border-border/50">
            <Reveal>
              <div className="max-w-2xl mb-10">
                <span className="text-[11px] font-mono uppercase tracking-wider text-muted-foreground">
                  /02 · Where it works
                </span>
                <h2 className="mt-3 text-2xl sm:text-3xl md:text-4xl font-medium tracking-tight text-foreground leading-tight">
                  Suna meets work where it lives.
                </h2>
                <p className="mt-3 text-base text-muted-foreground leading-relaxed max-w-xl">
                  Most agents pick one surface. Suna unifies all three — your local files and apps, your cloud stack, and the open web.
                </p>
              </div>
            </Reveal>

            <Reveal delay={0.1}>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
                <RuntimeColumn
                  icon={<Folder className="size-5" />}
                  title="Local files & apps"
                  desc="Suna reads, writes, and reorganizes the folders, drives, and apps on the machine you're already using."
                  pills={
                    <>
                      <IntegrationPill icon={<Folder className="size-4 text-foreground" />} name="Filesystem" />
                      <IntegrationPill domain="apple.com" name="macOS" />
                      <IntegrationPill domain="microsoft.com" name="Windows" />
                    </>
                  }
                />
                <RuntimeColumn
                  icon={<Cloud className="size-5" />}
                  title="Cloud tools"
                  desc="3,000+ integrations via OAuth, MCP, REST, and CLI. The tools your team already runs on."
                  pills={
                    <>
                      <IntegrationPill domain="gmail.com" name="Gmail" />
                      <IntegrationPill domain="slack.com" name="Slack" />
                      <IntegrationPill domain="notion.so" name="Notion" />
                      <IntegrationPill domain="github.com" name="GitHub" />
                      <IntegrationPill domain="hubspot.com" name="HubSpot" />
                      <IntegrationPill domain="drive.google.com" name="Drive" />
                    </>
                  }
                />
                <RuntimeColumn
                  icon={<Globe className="size-5" />}
                  title="The browser"
                  desc="A real browser session — Suna logs in, navigates, fills forms, scrapes, and clicks through anything you can."
                  pills={
                    <>
                      <IntegrationPill icon={<Globe className="size-4 text-foreground" />} name="Web browse" />
                      <IntegrationPill icon={<Globe className="size-4 text-foreground" />} name="Form fill" />
                      <IntegrationPill icon={<Globe className="size-4 text-foreground" />} name="Scrape" />
                    </>
                  }
                />
              </div>
            </Reveal>

            <Reveal delay={0.2}>
              <div className="mt-10">
                <MediaPlaceholder
                  label="DEMO: tri-surface runtime"
                  hint="Split-screen recording: Suna touching a local file (left) → calling a SaaS tool (middle) → driving the browser (right). 30s loop, no audio."
                  aspect="aspect-[21/9]"
                  kind="video"
                />
              </div>
            </Reveal>
          </section>

          {/* ═══════════════ USE CASES ═══════════════ */}
          <section className="max-w-6xl mx-auto px-6 py-12 sm:py-16 border-t border-border/50">
            <Reveal>
              <div className="max-w-2xl mb-12">
                <span className="text-[11px] font-mono uppercase tracking-wider text-muted-foreground">
                  /03 · What people hand off
                </span>
                <h2 className="mt-3 text-2xl sm:text-3xl md:text-4xl font-medium tracking-tight text-foreground leading-tight">
                  The work you'd rather not do yourself.
                </h2>
              </div>
            </Reveal>

            <div className="flex flex-col gap-16">
              <Reveal>
                <UseCase
                  n="01"
                  title="Prepare documents from source files"
                  desc="Hand Suna a folder of drafts, transcripts, and attachments. It assembles, synthesizes, and returns a structured draft — leaving only refinement for you."
                  src="/images/landing-showcase/docs.png"
                />
              </Reveal>
              <Reveal>
                <UseCase
                  n="02"
                  title="Synthesize research across dozens of sources"
                  desc="Share a question and a corpus — PDFs, web pages, Notion, Drive. Suna reads through everything and returns a summary ready for review, with citations."
                  src="/images/landing-showcase/research.png"
                />
              </Reveal>
              <Reveal>
                <UseCase
                  n="03"
                  title="Extract structured data from messy files"
                  desc="Contracts, invoices, scraped tables, scanned docs. Suna pulls out the fields that matter and returns a clean spreadsheet or JSON."
                  src="/images/landing-showcase/data.png"
                />
              </Reveal>
              <Reveal>
                <UseCase
                  n="04"
                  title="Build slide decks from your raw inputs"
                  desc="Point Suna at the source — a doc, a meeting transcript, a quarter of metrics — and get a brand-formatted deck back, not a wireframe."
                  src="/images/landing-showcase/slides.png"
                />
              </Reveal>
            </div>
          </section>

          {/* ═══════════════ PARALLEL ═══════════════ */}
          <section className="max-w-6xl mx-auto px-6 py-12 sm:py-16 border-t border-border/50">
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-10 lg:gap-16 items-center">
              <Reveal className="lg:col-span-5">
                <div>
                  <span className="text-[11px] font-mono uppercase tracking-wider text-muted-foreground">
                    /04 · Parallel by default
                  </span>
                  <h2 className="mt-3 text-2xl sm:text-3xl md:text-4xl font-medium tracking-tight text-foreground leading-tight">
                    Run many tasks at once.
                  </h2>
                  <p className="mt-3 text-base text-muted-foreground leading-relaxed">
                    Stop babysitting one prompt at a time. Kick off a dozen jobs in parallel, walk away, and check in when they're done. Each task gets its own sandbox, its own context, its own deliverable.
                  </p>
                  <ul className="mt-6 space-y-2.5 text-sm text-muted-foreground">
                    {[
                      'Spawn unlimited concurrent tasks from one workspace',
                      'Live progress, terminal output, and intermediate artifacts',
                      'Schedule recurring jobs with cron triggers and webhooks',
                      'Resume, fork, or hand off any task at any time',
                    ].map((line) => (
                      <li key={line} className="flex items-start gap-2.5">
                        <Check className="size-4 mt-0.5 text-foreground/70 shrink-0" />
                        <span>{line}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </Reveal>
              <Reveal delay={0.1} className="lg:col-span-7">
                <MediaPlaceholder
                  label="SCREENSHOT: parallel tasks dashboard"
                  hint="Capture of /instances or task list with 6–10 tasks running concurrently — different statuses, progress bars, deliverable thumbnails."
                  aspect="aspect-[4/3]"
                  kind="image"
                />
              </Reveal>
            </div>
          </section>

          {/* ═══════════════ OPEN BY DEFAULT ═══════════════ */}
          <section className="max-w-6xl mx-auto px-6 py-12 sm:py-16 border-t border-border/50">
            <Reveal>
              <div className="max-w-2xl mb-10">
                <span className="text-[11px] font-mono uppercase tracking-wider text-muted-foreground">
                  /05 · Open by default
                </span>
                <h2 className="mt-3 text-2xl sm:text-3xl md:text-4xl font-medium tracking-tight text-foreground leading-tight">
                  Yours. Forever.
                </h2>
                <p className="mt-3 text-base text-muted-foreground leading-relaxed max-w-xl">
                  Cowork-class capability without the vendor lock-in. Suna is open source, MIT-licensed at the core, and runs on your hardware or your cloud. Every secret stays where you put it.
                </p>
              </div>
            </Reveal>

            <Reveal delay={0.1}>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-5">
                {[
                  { icon: <Github className="size-4" />, title: 'Open source', desc: 'MIT-licensed core. Audit it. Fork it. Ship your own version.' },
                  { icon: <Server className="size-4" />, title: 'Self-hostable', desc: 'One-line install on your machine, your VPC, or your air-gapped cluster.' },
                  { icon: <ShieldCheck className="size-4" />, title: 'Your data, your keys', desc: 'BYOK for every model. Credentials and files never leave your perimeter.' },
                  { icon: <GitFork className="size-4" />, title: 'Open standards', desc: 'MCP, OAuth, REST, OpenCode skills. No proprietary glue.' },
                ].map(({ icon, title, desc }) => (
                  <div key={title} className="rounded-2xl border border-border bg-card/40 p-5">
                    <div className="flex items-center justify-center size-9 rounded-lg bg-foreground/[0.06] border border-foreground/10 text-foreground/80 mb-3.5">
                      {icon}
                    </div>
                    <h3 className="text-sm font-semibold text-foreground">{title}</h3>
                    <p className="mt-1.5 text-[13px] text-muted-foreground leading-relaxed">{desc}</p>
                  </div>
                ))}
              </div>
            </Reveal>

            <Reveal delay={0.15}>
              <div className="mt-10 rounded-2xl border border-border bg-card/40 p-6 sm:p-8 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-5">
                <div>
                  <h3 className="text-base font-semibold text-foreground">Self-host in one line.</h3>
                  <p className="mt-1 text-sm text-muted-foreground">Docker, single binary, or full Kubernetes. Bring your own models.</p>
                </div>
                <button
                  onClick={handleCopy}
                  className="group flex items-center gap-2.5 h-11 px-4 rounded-full bg-background border border-border hover:border-foreground/20 transition-colors cursor-pointer"
                >
                  <span className="font-mono text-[11px] text-muted-foreground select-none">$</span>
                  <code className="text-[12px] font-mono text-foreground tracking-tight">{INSTALL_CMD}</code>
                  <div className="pl-2.5 ml-1 border-l border-border">
                    {copied ? (
                      <Check className="size-3.5 text-emerald-500" />
                    ) : (
                      <Copy className="size-3.5 text-muted-foreground group-hover:text-foreground transition-colors" />
                    )}
                  </div>
                </button>
              </div>
            </Reveal>
          </section>

          {/* ═══════════════ FOR TEAMS ═══════════════ */}
          <section className="max-w-6xl mx-auto px-6 py-12 sm:py-16 border-t border-border/50">
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-10 items-center">
              <Reveal className="lg:col-span-6">
                <div>
                  <span className="text-[11px] font-mono uppercase tracking-wider text-muted-foreground">
                    /06 · For teams
                  </span>
                  <h2 className="mt-3 text-2xl sm:text-3xl md:text-4xl font-medium tracking-tight text-foreground leading-tight">
                    An AI workspace your whole company can share.
                  </h2>
                  <p className="mt-3 text-base text-muted-foreground leading-relaxed">
                    SSO, role-based access, audit logs, shared agents and skills, per-team budgets. Deploy once, give every department their own coworker.
                  </p>
                  <div className="mt-6 flex flex-wrap gap-3">
                    <Button size="lg" className="h-11 px-6 rounded-full" onClick={handleLaunch}>
                      Start a team workspace<ArrowRight className="ml-1.5 size-3.5" />
                    </Button>
                    <Button size="lg" variant="outline" className="h-11 px-6 rounded-full" asChild>
                      <Link href="/enterprise">Talk to sales</Link>
                    </Button>
                  </div>
                </div>
              </Reveal>
              <Reveal delay={0.1} className="lg:col-span-6">
                <MediaPlaceholder
                  label="SCREENSHOT: team workspace"
                  hint="Org-level admin / shared agents view. Multiple seats, agent permissions, audit log glimpse. Optional: Slack message of Suna posting a deliverable."
                  aspect="aspect-[4/3]"
                  kind="image"
                />
              </Reveal>
            </div>
          </section>

          {/* ═══════════════ UNDER THE HOOD ═══════════════ */}
          <section className="max-w-6xl mx-auto px-6 py-12 sm:py-16 border-t border-border/50">
            <Reveal>
              <div className="max-w-2xl mb-10">
                <span className="text-[11px] font-mono uppercase tracking-wider text-muted-foreground">
                  /07 · Under the hood
                </span>
                <h2 className="mt-3 text-2xl sm:text-3xl md:text-4xl font-medium tracking-tight text-foreground leading-tight">
                  Built on a real machine.
                </h2>
                <p className="mt-3 text-base text-muted-foreground leading-relaxed max-w-xl">
                  Every Suna workspace is a full Linux environment — bash, filesystem, package managers, browsers, the whole software ecosystem. That's why it can actually finish things.
                </p>
              </div>
            </Reveal>

            <Reveal delay={0.1}>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
                {[
                  { icon: <Layers className="size-4" />, title: 'Skills', desc: '60+ built-in capability packs — coding, browser automation, research, spreadsheets, deck-building. Add your own as code.' },
                  { icon: <Workflow className="size-4" />, title: 'Goal loop', desc: 'Suna self-verifies. It plans, executes, checks the output, retries — and only stops when the deliverable is provably done.' },
                  { icon: <GitFork className="size-4" />, title: 'Orchestration', desc: 'A primary agent decomposes work and delegates to parallel sub-agents. Like assembling a team for the job.' },
                ].map(({ icon, title, desc }) => (
                  <div key={title} className="rounded-2xl border border-border bg-card/40 p-6">
                    <div className="flex items-center justify-center size-9 rounded-lg bg-foreground/[0.06] border border-foreground/10 text-foreground/80 mb-4">
                      {icon}
                    </div>
                    <h3 className="text-sm font-semibold text-foreground">{title}</h3>
                    <p className="mt-1.5 text-[13px] text-muted-foreground leading-relaxed">{desc}</p>
                  </div>
                ))}
              </div>
            </Reveal>
          </section>

          {/* ═══════════════ FAQ ═══════════════ */}
          <section className="max-w-3xl mx-auto px-6 py-12 sm:py-16 border-t border-border/50">
            <Reveal>
              <div className="mb-8">
                <span className="text-[11px] font-mono uppercase tracking-wider text-muted-foreground">
                  /08 · FAQ
                </span>
                <h2 className="mt-3 text-2xl sm:text-3xl md:text-4xl font-medium tracking-tight text-foreground leading-tight">
                  Questions, answered.
                </h2>
              </div>
            </Reveal>
            <Reveal delay={0.1}>
              <Accordion type="single" collapsible className="w-full">
                {[
                  {
                    q: 'How is Suna different from Claude Cowork, Manus, or Perplexity Comet?',
                    a: 'Same class of capability — agents that work autonomously across files, tools, and the web — but Suna is open source and self-hostable. You can run it on your own hardware, audit every line, bring your own models, and never send a credential to a vendor.',
                  },
                  {
                    q: 'Can I really self-host the whole thing?',
                    a: 'Yes. One-line install on Linux/macOS, Docker images, or full Kubernetes for teams. Air-gapped deployments are supported. Bring your own model keys (Anthropic, OpenAI, local Llama, anything OpenAI-compatible).',
                  },
                  {
                    q: 'Does it work for non-technical teammates?',
                    a: 'That is the point. Marketing, ops, finance, legal, and support teams use Suna without writing code — they describe the work, and Suna handles assembly. Engineers get the full Linux machine when they want it.',
                  },
                  {
                    q: 'What about safety and oversight?',
                    a: 'Every action is observable. Permissions are scoped per agent. Sensitive steps require approval. Logs are persistent and exportable. Because you self-host, the full audit trail lives on your infrastructure.',
                  },
                  {
                    q: 'Pricing?',
                    a: 'The core is free and open source — host it yourself at zero per-seat cost. Hosted plans (free tier + paid team/enterprise) handle infra and SSO if you would rather not run it.',
                  },
                ].map(({ q, a }, i) => (
                  <AccordionItem key={i} value={`faq-${i}`}>
                    <AccordionTrigger className="text-left text-sm sm:text-base font-medium">{q}</AccordionTrigger>
                    <AccordionContent className="text-sm text-muted-foreground leading-relaxed">{a}</AccordionContent>
                  </AccordionItem>
                ))}
              </Accordion>
            </Reveal>
          </section>

          {/* ═══════════════ FINAL CTA ═══════════════ */}
          <section className="max-w-5xl mx-auto px-6 py-20 sm:py-24 text-center border-t border-border/50">
            <Reveal>
              <h2 className="text-3xl sm:text-4xl md:text-5xl font-medium tracking-tight text-foreground leading-tight">
                Hand off the work.<br />
                <span className="text-muted-foreground">Get back the deliverable.</span>
              </h2>
            </Reveal>
            <Reveal delay={0.1}>
              <div className="mt-8 flex flex-col sm:flex-row items-center justify-center gap-3">
                <Button size="lg" className="h-12 px-8 text-sm rounded-full" onClick={handleLaunch}>
                  Get started free<ArrowRight className="ml-1.5 size-3.5" />
                </Button>
                <Button size="lg" variant="outline" className="h-12 px-8 text-sm rounded-full" asChild>
                  <a href="https://github.com/kortix-ai/suna" target="_blank" rel="noopener noreferrer">
                    <Github className="mr-1.5 size-3.5" /> Star on GitHub
                  </a>
                </Button>
              </div>
            </Reveal>
          </section>

          {/* Bottom spacing for floating CTA clearance */}
          <div className="h-24 sm:h-28" />
        </motion.div>

        {/* ═══════════════ FLOATING CTA BAR ═══════════════ */}
        <div
          className={cn(
            'fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-1.5 px-1.5 py-1.5 rounded-full border border-border bg-background/95 backdrop-blur-md will-change-transform transition-[transform,opacity] duration-[600ms] ease-[cubic-bezier(0.32,0.72,0,1)]',
            showFloatingCta ? 'translate-y-0 opacity-100' : 'translate-y-16 opacity-0 pointer-events-none',
          )}
        >
          <button
            onClick={handleCopy}
            className="group hidden sm:flex items-center gap-2 h-8 px-3 rounded-full hover:bg-foreground/[0.08] transition-colors cursor-pointer"
          >
            <span className="font-mono text-[11px] text-muted-foreground select-none">$</span>
            <code className="text-[11px] font-mono text-foreground tracking-tight">curl -fsSL kortix.com/install</code>
            {copied ? (
              <Check className="size-3 text-emerald-500" />
            ) : (
              <Copy className="size-3 text-muted-foreground group-hover:text-foreground transition-colors" />
            )}
          </button>
          <span className="hidden sm:block w-px h-5 bg-border" />
          <a
            href="https://github.com/kortix-ai/suna"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center justify-center size-8 rounded-full hover:bg-foreground/[0.08] transition-colors"
          >
            <Github className="size-4" />
          </a>
          <Button size="sm" className="px-5 text-xs rounded-full font-medium" onClick={handleLaunch}>
            Get started<ArrowRight className="ml-1.5 size-3" />
          </Button>
        </div>
      </div>
    </BackgroundAALChecker>
  );
}
