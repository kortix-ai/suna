'use client';

import { Reveal } from '@/components/home/reveal';
import { KortixLogo } from '@/components/sidebar/kortix-logo';
import { Button } from '@/components/ui/marketing/button';
import { KortixLetterField } from '@/components/ui/marketing/kortix-letter-field';
import { Icon } from '@/features/icon/icon';
import { CompanyAsRepo } from '@/features/marketing/company-as-repo';
import { Faq } from '@/features/marketing/faq';
import { ModalitySwitcher } from '@/features/marketing/modality-switcher';
import { RuntimeArchitecture } from '@/features/marketing/runtime-architecture';
import Security from '@/features/marketing/security/security';
import { SkillsMemory } from '@/features/marketing/skills-memory';
import { UseCasesByDepartment } from '@/features/marketing/use-cases-by-department';
import { WhyItsAHire } from '@/features/marketing/why-its-a-hire';
import { useAuth } from '@/features/providers/auth-provider';
import { useGitHubStars } from '@/hooks/utils/use-github-stars';
import { trackCtaSignup } from '@/lib/analytics/gtm';
import { cn } from '@/lib/utils';
import { Code2, Cpu, KeyRound, Sparkles, Unlock, UserCheck } from 'lucide-react';
import Link from 'next/link';
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { HiArrowRight } from 'react-icons/hi2';

/* -------------------------------------------------------------------------- */
/*  Path model                                                                */
/* -------------------------------------------------------------------------- */

type Path = 'technical' | 'nontechnical';

/** A single beat of the guided walkthrough: a typed line + the section it reveals. */
type Beat = {
  /** Short framing line, spoken as Kortix walking you through. */
  line: ReactNode;
  /** The existing marketing section to reveal under it. */
  section: ReactNode;
};

const OWNERSHIP = [
  { label: 'Open source', icon: Unlock },
  { label: 'You own everything', icon: UserCheck },
  { label: 'Bring your own API key', icon: KeyRound },
  { label: 'Run it on any model', icon: Cpu },
] as const;

/* -------------------------------------------------------------------------- */
/*  Guide chrome — the thin chat-feeling line above each revealed section     */
/* -------------------------------------------------------------------------- */

/** Kortix avatar tile, matching the marketing chat snippets. */
function KortixMark() {
  return (
    <span className="bg-foreground flex size-7 shrink-0 items-center justify-center rounded-md">
      <KortixLogo size={13} className="text-background" />
    </span>
  );
}

/** A single typed "message" line — the guide narrating the next reveal. */
function GuideLine({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto flex max-w-6xl items-start gap-3 px-6 lg:px-0">
      <KortixMark />
      <p className="text-foreground min-w-0 pt-0.5 text-base leading-relaxed sm:text-lg">
        <span className="text-muted-foreground font-medium">Kortix</span> {children}
      </p>
    </div>
  );
}

/**
 * One beat of the walkthrough: a typed line, the section it reveals, and a
 * "Continue" affordance that advances the conversation. Sections also reveal on
 * scroll, so the page never blocks a visitor who keeps scrolling.
 */
function GuideBeat({
  beat,
  index,
  total,
  active,
  onContinue,
}: {
  beat: Beat;
  index: number;
  total: number;
  active: boolean;
  onContinue: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  // Scrolling a beat into view advances the conversation, so a visitor who
  // keeps scrolling reveals everything without ever clicking Continue.
  useEffect(() => {
    if (active) return;
    const el = ref.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      ([e]) => {
        if (e.isIntersecting) {
          onContinue();
          obs.disconnect();
        }
      },
      { threshold: 0.2, rootMargin: '0px 0px -120px 0px' },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [active, onContinue]);

  const isLast = index === total - 1;

  return (
    <div ref={ref} className="scroll-mt-28">
      <Reveal>
        <GuideLine>{beat.line}</GuideLine>
      </Reveal>

      {beat.section}

      {!isLast && (
        <div className="mx-auto -mt-4 flex max-w-6xl justify-center px-6 pb-4 lg:px-0">
          <Button variant="outline" size="sm" onClick={onContinue} className="rounded-full">
            Continue
            <HiArrowRight className="size-3.5" />
          </Button>
        </div>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  The "Are you technical?" flip                                             */
/* -------------------------------------------------------------------------- */

function PathChooser({ chosen, onChoose }: { chosen: Path | null; onChoose: (p: Path) => void }) {
  const Choice = ({
    value,
    icon: ChoiceIcon,
    title,
    sub,
  }: {
    value: Path;
    icon: typeof Code2;
    title: string;
    sub: string;
  }) => {
    const isActive = chosen === value;
    return (
      <button
        type="button"
        onClick={() => onChoose(value)}
        aria-pressed={isActive}
        className={cn(
          'group border-border bg-card flex flex-1 flex-col items-start gap-3 rounded-2xl border p-6 text-left transition-all duration-200',
          'hover:border-foreground/25 hover:bg-foreground/[0.02]',
          isActive && 'border-foreground/40 bg-primary/[0.05] ring-primary/20 ring-2',
        )}
      >
        <span
          className={cn(
            'border-border bg-background text-foreground flex size-11 items-center justify-center rounded-xl border transition-colors',
            isActive && 'bg-foreground text-background border-transparent',
          )}
        >
          <ChoiceIcon className="size-5" />
        </span>
        <span className="space-y-1">
          <span className="text-foreground block text-lg font-medium tracking-tight">{title}</span>
          <span className="text-muted-foreground block text-sm leading-relaxed">{sub}</span>
        </span>
        <span className="text-muted-foreground/80 group-hover:text-foreground mt-auto inline-flex items-center gap-1.5 pt-2 text-sm font-medium transition-colors">
          {isActive ? 'Walking you through this' : 'Show me this way'}
          <HiArrowRight className="size-3.5" />
        </span>
      </button>
    );
  };

  return (
    <section className="mx-auto max-w-6xl px-6 py-16 sm:py-20 lg:px-0">
      <Reveal>
        <div className="mx-auto flex max-w-2xl items-start gap-3">
          <KortixMark />
          <div className="min-w-0 pt-0.5">
            <p className="text-foreground text-xl font-medium tracking-tight sm:text-2xl">
              Before I show you around — are you technical?
            </p>
            <p className="text-muted-foreground mt-2 text-base leading-relaxed">
              I&apos;ll walk you through Kortix either way. Pick the path that fits, and I&apos;ll
              reveal the right parts in the right order.
            </p>
          </div>
        </div>
      </Reveal>

      <Reveal delay={0.08}>
        <div className="mx-auto mt-8 flex max-w-2xl flex-col gap-4 pl-0 sm:flex-row sm:pl-10">
          <Choice
            value="technical"
            icon={Code2}
            title="I'm technical"
            sub="Start from the repo, the runtime, and the files. Then the surfaces and the work."
          />
          <Choice
            value="nontechnical"
            icon={Sparkles}
            title="I'm not technical"
            sub="Start from the outcomes — what it does for each team — then peek under the hood."
          />
        </div>
      </Reveal>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/*  Hero (static, minimal — Nat-Friedman)                                      */
/* -------------------------------------------------------------------------- */

function ExperienceHero({ onLaunch }: { onLaunch: () => void }) {
  const { formattedStars, loading: starsLoading } = useGitHubStars('kortix-ai', 'kortix');

  return (
    <section className="relative overflow-hidden px-6 pt-36 pb-16 sm:pt-44 sm:pb-20">
      <div className="pointer-events-none absolute inset-0 z-0 mask-y-to-95%" aria-hidden>
        <KortixLetterField seed={4817} />
      </div>

      <div className="relative z-20 mx-auto flex w-full max-w-3xl flex-col items-center text-center">
        <h1 className="text-foreground text-4xl leading-[1.08] font-medium tracking-tight text-balance md:text-6xl">
          Build the AI workforce
          <br />
          <span className="text-muted-foreground">that runs your company.</span>
        </h1>
        <p className="text-muted-foreground mx-auto mt-6 max-w-2xl text-lg leading-relaxed text-balance">
          The open-source platform for AI agents that do real work across every team — connected to
          your tools, teachable, and governed from one repo you own.
        </p>

        <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
          {OWNERSHIP.map(({ label, icon: PillIcon }) => (
            <span
              key={label}
              className="border-border bg-background/60 text-muted-foreground inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium backdrop-blur-sm"
            >
              <PillIcon className="text-foreground/70 size-3.5" />
              {label}
            </span>
          ))}
        </div>

        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          <Button size="xl" onClick={onLaunch}>
            Launch Kortix
            <HiArrowRight className="size-4" />
          </Button>
          <Button size="xl" variant="secondary" asChild>
            <Link
              href="https://github.com/kortix-ai/suna"
              target="_blank"
              rel="noopener noreferrer"
            >
              <Icon.Github className="size-4" />
              Star on GitHub
              {!starsLoading && formattedStars && (
                <span className="text-muted-foreground ml-0.5 font-medium tabular-nums">
                  {formattedStars}
                </span>
              )}
            </Link>
          </Button>
        </div>
      </div>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/*  Closing CTA — shared by both paths                                         */
/* -------------------------------------------------------------------------- */

function ClosingCta({ onLaunch }: { onLaunch: () => void }) {
  return (
    <section className="mx-auto max-w-6xl px-6 py-20 sm:py-28 lg:px-0">
      <Reveal>
        <div className="border-border bg-card relative overflow-hidden rounded-2xl border px-6 py-14 text-center sm:px-10 sm:py-20">
          <div
            className="pointer-events-none absolute inset-0 z-0 mask-radial-from-40% opacity-60"
            aria-hidden
          >
            <KortixLetterField seed={7321} />
          </div>
          <div className="relative z-10 mx-auto max-w-2xl">
            <h2 className="text-foreground text-3xl font-medium tracking-tight text-balance sm:text-4xl">
              Give your company a workforce.
            </h2>
            <p className="text-muted-foreground mx-auto mt-4 max-w-xl text-base leading-relaxed text-balance">
              Free to self-host. Managed cloud from $20. Open source, you own everything, and it
              runs on any model — start with one workflow and grow from there.
            </p>
            <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
              <Button size="xl" onClick={onLaunch}>
                Get started
                <HiArrowRight className="size-4" />
              </Button>
              <Button size="xl" variant="secondary" asChild>
                <Link href="/enterprise">Talk to sales</Link>
              </Button>
            </div>
          </div>
        </div>
      </Reveal>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/*  Page                                                                        */
/* -------------------------------------------------------------------------- */

export default function ExperiencePage() {
  const { user } = useAuth();
  const [path, setPath] = useState<Path | null>(null);
  const [revealed, setRevealed] = useState(0);

  const handleLaunch = useCallback(() => {
    trackCtaSignup();
    window.location.href = user ? '/projects' : '/auth';
  }, [user]);

  const choosePath = useCallback((p: Path) => {
    setPath(p);
    setRevealed(1);
  }, []);

  // Default to the non-technical path if a visitor scrolls the chooser fully
  // out of view without picking — the walkthrough should never dead-end. We
  // watch the chooser's own box and only default once its bottom has passed
  // above the top of the viewport, so the prompt always gets shown first.
  const chooserRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (path) return;
    const el = chooserRef.current;
    if (!el) return;
    const check = () => {
      if (el.getBoundingClientRect().bottom <= 0) {
        choosePath('nontechnical');
        window.removeEventListener('scroll', check);
      }
    };
    window.addEventListener('scroll', check, { passive: true });
    return () => window.removeEventListener('scroll', check);
  }, [path, choosePath]);

  // The two walkthroughs reuse the same existing sections — only the order and
  // the framing lines change. Technical leads with the repo/runtime story;
  // non-technical leads with outcomes and reveals the internals at the end.
  const beats = useMemo<Beat[]>(() => {
    if (path === 'technical') {
      return [
        {
          line: 'starts from a repo. Your whole company — agents, skills, context — is just files in one Git repo you own.',
          section: <CompanyAsRepo />,
        },
        {
          line: 'and a runtime runs it. OpenCode reads those files, runs each task in its own sandbox, and lands the work back as a change request.',
          section: <RuntimeArchitecture />,
        },
        {
          line: "learns as you go. Hand it a skill or tell it to remember something — it's saved as versioned files any agent can reuse.",
          section: <SkillsMemory />,
        },
        {
          line: 'reaches you anywhere. The same repo and agents from the web app, Slack, Teams, your phone, or the CLI.',
          section: <ModalitySwitcher />,
        },
        {
          line: 'does real work for every team — engineering, sales, support, finance. Pick a department and see the asks.',
          section: <UseCasesByDepartment />,
        },
        {
          line: 'runs in isolation, scoped and audited. Every session is sandboxed with only the access it needs.',
          section: <Security />,
        },
        {
          line: 'in short — here are the questions engineers usually ask.',
          section: <Faq />,
        },
      ];
    }

    // Non-technical (also the default): outcomes first, internals last.
    return [
      {
        line: 'is a workforce for every team. Real, one-off asks you send in chat — each run end to end by an agent. Pick a team.',
        section: <UseCasesByDepartment />,
      },
      {
        line: "isn't a chatbot — it's a coworker. It ships finished work, across every tool, on a schedule, and it remembers how you work.",
        section: <WhyItsAHire />,
      },
      {
        line: 'meets you where you already work — the web app, Slack, Teams, your phone, or the CLI. Same agents, everywhere.',
        section: <ModalitySwitcher />,
      },
      {
        line: 'gets better the more you use it. Teach it a skill or tell it to remember something, and the whole workforce keeps it.',
        section: <SkillsMemory />,
      },
      {
        line: 'now, under the hood: your whole company is one Git repo you own — agents, skills, and context are all just files.',
        section: <CompanyAsRepo />,
      },
      {
        line: 'and a runtime runs it. Each task gets its own sandbox, then lands back as a reviewable change request — secure and audited.',
        section: <RuntimeArchitecture />,
      },
      {
        line: 'the short version of what it is and how to start.',
        section: <Faq />,
      },
    ];
  }, [path]);

  const advance = useCallback(() => {
    setRevealed((r) => Math.min(r + 1, beats.length));
  }, [beats.length]);

  return (
    <div className="bg-background relative">
      <ExperienceHero onLaunch={handleLaunch} />

      {/* Scrolling the chooser fully out of view without picking defaults to
          the non-technical walkthrough (see the effect above). */}
      <div ref={chooserRef}>
        <PathChooser chosen={path} onChoose={choosePath} />
      </div>

      {path &&
        beats.slice(0, revealed).map((beat, i) => (
          <Fragment key={`${path}-${i}`}>
            <GuideBeat
              beat={beat}
              index={i}
              total={beats.length}
              active={i < revealed - 1}
              onContinue={advance}
            />
          </Fragment>
        ))}

      {path && revealed >= beats.length && <ClosingCta onLaunch={handleLaunch} />}

      <div className="h-16 sm:h-20" />
    </div>
  );
}
