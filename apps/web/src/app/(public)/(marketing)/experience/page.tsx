'use client';

import { Button } from '@/components/ui/marketing/button';
import { KortixLetterField } from '@/components/ui/marketing/kortix-letter-field';
import { useAuth } from '@/features/providers/auth-provider';
import { trackCtaSignup } from '@/lib/analytics/gtm';
import { cn } from '@/lib/utils';
import { AnimatePresence, motion } from 'motion/react';
import {
  ArrowRight,
  Check,
  ChevronLeft,
  ChevronUp,
  Code2,
  Cpu,
  FolderGit2,
  GitPullRequest,
  KeyRound,
  Layers,
  Lock,
  RotateCcw,
  Shield,
  Sparkles,
} from 'lucide-react';
import Link from 'next/link';
import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

/* -------------------------------------------------------------------------- */
/*  Model                                                                       */
/* -------------------------------------------------------------------------- */

type Path = 'technical' | 'nontechnical';

type Beat =
  | { kind: 'intro' }
  | { kind: 'cta' }
  | { kind: 'scene'; kicker: string; title: ReactNode; body: string; visual: ReactNode };

const OWNERSHIP = [
  { label: 'Open source', icon: Code2 },
  { label: 'You own everything', icon: Shield },
  { label: 'Bring your own key', icon: KeyRound },
  { label: 'Any model', icon: Cpu },
] as const;

/* -------------------------------------------------------------------------- */
/*  Bespoke scene visuals — each fits one screen, no dumped page sections      */
/* -------------------------------------------------------------------------- */

function Panel({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        'border-border bg-card/70 w-full rounded-2xl border p-5 backdrop-blur-sm sm:p-6',
        className,
      )}
    >
      {children}
    </div>
  );
}

const REPO_TREE: { t: string; accent?: boolean }[] = [
  { t: 'your-company/' },
  { t: '├─ kortix.toml', accent: true },
  { t: '├─ agents/' },
  { t: '│  ├─ pr-reviewer.md' },
  { t: '│  ├─ support.md' },
  { t: '│  └─ growth.md' },
  { t: '├─ skills/' },
  { t: '│  └─ close-month/' },
  { t: '└─ memory/' },
  { t: '   └─ how-we-work.md' },
];

function RepoTree() {
  return (
    <Panel className="mx-auto max-w-md text-left">
      <div className="text-muted-foreground mb-3 flex items-center gap-2 text-xs font-medium">
        <FolderGit2 className="size-3.5" /> your company, as files
      </div>
      <div className="font-mono text-[13px] leading-relaxed">
        {REPO_TREE.map((l, i) => (
          <div key={i} className={cn('text-muted-foreground', l.accent && 'text-foreground')}>
            {l.t}
          </div>
        ))}
      </div>
    </Panel>
  );
}

const FLOW = [
  { icon: FolderGit2, t: 'Repo', s: 'your files — the source of truth' },
  { icon: Cpu, t: 'Runtime', s: 'each task in its own sandbox + branch' },
  { icon: GitPullRequest, t: 'Change request', s: 'lands back to review & merge' },
] as const;

function RuntimeFlow() {
  return (
    <div className="mx-auto flex max-w-3xl flex-col items-stretch gap-3 sm:flex-row sm:items-center">
      {FLOW.map((n, i) => (
        <Fragment key={n.t}>
          <Panel className="flex-1 text-left">
            <n.icon className="text-foreground size-5" />
            <div className="text-foreground mt-3 font-medium">{n.t}</div>
            <div className="text-muted-foreground mt-1 text-sm leading-relaxed">{n.s}</div>
          </Panel>
          {i < FLOW.length - 1 && (
            <ArrowRight className="text-muted-foreground/60 mx-auto size-4 shrink-0 rotate-90 sm:rotate-0" />
          )}
        </Fragment>
      ))}
    </div>
  );
}

function LearnCards() {
  return (
    <div className="mx-auto grid max-w-2xl gap-3 sm:grid-cols-2">
      <Panel className="text-left">
        <Layers className="text-foreground size-5" />
        <div className="text-foreground mt-3 font-medium">Skills</div>
        <p className="text-muted-foreground mt-1 text-sm leading-relaxed">
          Teach it a capability once. Saved as files any agent can reuse.
        </p>
        <code className="text-muted-foreground/80 mt-3 block font-mono text-xs">
          skills/close-month/
        </code>
      </Panel>
      <Panel className="text-left">
        <Sparkles className="text-foreground size-5" />
        <div className="text-foreground mt-3 font-medium">Memory</div>
        <p className="text-muted-foreground mt-1 text-sm leading-relaxed">
          It remembers how you work — the whole workforce keeps it.
        </p>
        <code className="text-muted-foreground/80 mt-3 block font-mono text-xs">
          “we ship Fridays · keep it dry”
        </code>
      </Panel>
    </div>
  );
}

const SURFACES = ['Web', 'Slack', 'Teams', 'Mobile', 'CLI'] as const;

function SurfaceChips() {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-5">
      <div className="flex flex-wrap justify-center gap-2">
        {SURFACES.map((s) => (
          <span
            key={s}
            className="border-border bg-background/60 text-foreground inline-flex items-center rounded-full border px-3.5 py-1.5 text-sm font-medium backdrop-blur-sm"
          >
            {s}
          </span>
        ))}
      </div>
      <Panel className="text-left">
        <div className="text-muted-foreground text-xs font-medium">#engineering · Slack</div>
        <p className="text-foreground mt-2 text-sm">
          <span className="text-muted-foreground">you →</span> @kortix review PR #4827
        </p>
        <p className="text-foreground mt-1.5 text-sm">
          <span className="text-muted-foreground">kortix →</span> Reviewed, tests green, approved ✓
        </p>
      </Panel>
    </div>
  );
}

const TEAMS = [
  { t: 'Engineering', ask: 'Review every PR, keep prod green' },
  { t: 'Support', ask: 'Answer tickets from our docs, 24/7' },
  { t: 'Sales', ask: 'Research leads, draft the outreach' },
  { t: 'Finance', ask: 'Close the books at month end' },
  { t: 'Growth', ask: 'Turn each ship into content' },
  { t: 'Ops', ask: 'Post the Monday shipping brief' },
] as const;

function TeamGrid() {
  return (
    <div className="mx-auto grid max-w-3xl gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {TEAMS.map((d) => (
        <Panel key={d.t} className="text-left">
          <div className="text-foreground font-medium">{d.t}</div>
          <p className="text-muted-foreground mt-1 text-sm leading-relaxed">{d.ask}</p>
        </Panel>
      ))}
    </div>
  );
}

const PROOF_STEPS = [
  'Pulled transactions from Stripe + the bank',
  'Reconciled and categorized everything',
  'Drafted the P&L, posted it to #finance',
] as const;

function CoworkerProof() {
  return (
    <Panel className="mx-auto max-w-md text-left">
      <p className="text-foreground text-sm">
        <span className="text-muted-foreground">you →</span> Close the books for October
      </p>
      <div className="border-border mt-4 space-y-2 border-t pt-4">
        {PROOF_STEPS.map((s) => (
          <div key={s} className="flex items-start gap-2.5">
            <Check className="text-foreground mt-0.5 size-4 shrink-0" />
            <span className="text-muted-foreground text-sm leading-relaxed">{s}</span>
          </div>
        ))}
        <p className="text-foreground pt-1 text-sm font-medium">Done — review the draft.</p>
      </div>
    </Panel>
  );
}

const SECURITY = [
  { icon: Lock, t: 'Scoped to exactly what you grant' },
  { icon: Shield, t: 'Sandboxed per task, on its own branch' },
  { icon: Check, t: 'Every action logged and auditable' },
  { icon: KeyRound, t: 'One token — bring your own keys' },
] as const;

function SecurityPanel() {
  return (
    <Panel className="mx-auto max-w-md text-left">
      <div className="space-y-3.5">
        {SECURITY.map((r) => (
          <div key={r.t} className="flex items-center gap-3">
            <span className="border-border bg-background text-foreground flex size-9 shrink-0 items-center justify-center rounded-lg border">
              <r.icon className="size-4" />
            </span>
            <span className="text-foreground text-sm">{r.t}</span>
          </div>
        ))}
      </div>
    </Panel>
  );
}

/* -------------------------------------------------------------------------- */
/*  Scenes — same set, re-ordered per path                                     */
/* -------------------------------------------------------------------------- */

const SCENES = {
  repo: {
    kind: 'scene',
    kicker: 'Source of truth',
    title: (
      <>
        Your company is <span className="text-muted-foreground">a Git repo.</span>
      </>
    ),
    body: 'Every agent, skill, and piece of context is just a file in one repo you own — forkable, auditable, yours.',
    visual: <RepoTree />,
  },
  runtime: {
    kind: 'scene',
    kicker: 'The runtime',
    title: (
      <>
        A runtime <span className="text-muted-foreground">runs the repo.</span>
      </>
    ),
    body: 'It reads the files, runs each task in its own sandbox on its own branch, then lands the work back as a change request.',
    visual: <RuntimeFlow />,
  },
  learn: {
    kind: 'scene',
    kicker: 'Skills & memory',
    title: (
      <>
        It gets better <span className="text-muted-foreground">the more you use it.</span>
      </>
    ),
    body: 'Teach it a skill or tell it to remember something. Saved as versioned files the whole workforce reuses.',
    visual: <LearnCards />,
  },
  surfaces: {
    kind: 'scene',
    kicker: 'Everywhere you work',
    title: (
      <>
        Reach your workforce <span className="text-muted-foreground">anywhere.</span>
      </>
    ),
    body: 'The same repo and the same agents — from the web app, Slack, Teams, your phone, or the CLI.',
    visual: <SurfaceChips />,
  },
  teams: {
    kind: 'scene',
    kicker: 'Every team',
    title: (
      <>
        Real work <span className="text-muted-foreground">for every team.</span>
      </>
    ),
    body: 'Engineering, support, sales, finance, growth, ops. Send an ask in chat — an agent runs it end to end.',
    visual: <TeamGrid />,
  },
  coworker: {
    kind: 'scene',
    kicker: 'Not a chatbot',
    title: (
      <>
        Coworkers, <span className="text-muted-foreground">not chatbots.</span>
      </>
    ),
    body: 'They ship finished work across your tools, on a schedule, and remember how you work.',
    visual: <CoworkerProof />,
  },
  security: {
    kind: 'scene',
    kicker: 'Secure by design',
    title: (
      <>
        Scoped, sandboxed, <span className="text-muted-foreground">audited.</span>
      </>
    ),
    body: 'Every session runs in isolation with only the access you grant. Governed from one place, end to end.',
    visual: <SecurityPanel />,
  },
} satisfies Record<string, Beat & { kind: 'scene' }>;

function buildBeats(path: Path): Beat[] {
  const order: (keyof typeof SCENES)[] =
    path === 'technical'
      ? ['repo', 'runtime', 'learn', 'surfaces', 'teams', 'security']
      : ['teams', 'coworker', 'surfaces', 'learn', 'repo', 'runtime'];
  return [{ kind: 'intro' }, ...order.map((k) => SCENES[k]), { kind: 'cta' }];
}

/* -------------------------------------------------------------------------- */
/*  Intro (the "are you technical?" choice) & CTA                              */
/* -------------------------------------------------------------------------- */

function Intro({ onChoose }: { onChoose: (p: Path) => void }) {
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
  }) => (
    <button
      type="button"
      onClick={() => onChoose(value)}
      className="group border-border bg-card/70 hover:border-foreground/30 hover:bg-foreground/[0.03] flex flex-1 flex-col items-start gap-3 rounded-2xl border p-5 text-left backdrop-blur-sm transition-all duration-200"
    >
      <span className="border-border bg-background text-foreground group-hover:bg-foreground group-hover:text-background flex size-10 items-center justify-center rounded-xl border transition-colors">
        <ChoiceIcon className="size-5" />
      </span>
      <span className="text-foreground text-base font-medium tracking-tight">{title}</span>
      <span className="text-muted-foreground text-sm leading-relaxed">{sub}</span>
      <span className="text-muted-foreground/70 group-hover:text-foreground mt-1 inline-flex items-center gap-1.5 text-sm font-medium transition-colors">
        Walk me through it
        <ArrowRight className="size-3.5 transition-transform group-hover:translate-x-0.5" />
      </span>
    </button>
  );

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col items-center text-center">
      <h1 className="text-foreground text-4xl leading-[1.05] font-medium tracking-tight text-balance md:text-6xl">
        Build the AI workforce
        <br />
        <span className="text-muted-foreground">that runs your company.</span>
      </h1>
      <p className="text-muted-foreground mx-auto mt-5 max-w-xl text-lg leading-relaxed text-balance">
        The open-source platform for AI agents that do real work across every team — teachable,
        governed, and run from one repo you own.
      </p>

      <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
        {OWNERSHIP.map(({ label, icon: PillIcon }) => (
          <span
            key={label}
            className="border-border bg-background/50 text-muted-foreground inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium backdrop-blur-sm"
          >
            <PillIcon className="text-foreground/70 size-3.5" />
            {label}
          </span>
        ))}
      </div>

      <div className="mt-9 flex w-full flex-col gap-3 sm:flex-row">
        <Choice
          value="technical"
          icon={Code2}
          title="I'm technical"
          sub="Start from the repo, runtime, and files — then the work."
        />
        <Choice
          value="nontechnical"
          icon={Sparkles}
          title="I'm not technical"
          sub="Start from what it does for each team — then under the hood."
        />
      </div>

      <p className="text-muted-foreground/70 mt-6 text-xs">
        Pick a path to begin — you can switch any time.
      </p>
    </div>
  );
}

function Cta({ onLaunch, onRestart }: { onLaunch: () => void; onRestart: () => void }) {
  return (
    <div className="mx-auto flex w-full max-w-xl flex-col items-center text-center">
      <h2 className="text-foreground text-3xl font-medium tracking-tight text-balance sm:text-5xl">
        Give your company <span className="text-muted-foreground">a workforce.</span>
      </h2>
      <p className="text-muted-foreground mx-auto mt-5 max-w-md text-base leading-relaxed text-balance">
        Free to self-host. Managed cloud from $20. Open source, you own everything, and it runs on
        any model — start with one workflow and grow from there.
      </p>
      <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
        <Button size="xl" onClick={onLaunch}>
          Launch Kortix
          <ArrowRight className="size-4" />
        </Button>
        <Button size="xl" variant="secondary" asChild>
          <Link href="/enterprise">Talk to sales</Link>
        </Button>
      </div>
      <button
        type="button"
        onClick={onRestart}
        className="text-muted-foreground/70 hover:text-foreground mt-8 inline-flex items-center gap-1.5 text-xs font-medium transition-colors"
      >
        <RotateCcw className="size-3" />
        Start over
      </button>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Scene render                                                                */
/* -------------------------------------------------------------------------- */

function Scene({ beat, n }: { beat: Beat & { kind: 'scene' }; n: number }) {
  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col items-center text-center">
      <span className="text-muted-foreground/70 text-xs font-medium tracking-wide uppercase">
        {String(n).padStart(2, '0')} — {beat.kicker}
      </span>
      <h2 className="text-foreground mt-3 text-3xl font-medium tracking-tight text-balance sm:text-5xl">
        {beat.title}
      </h2>
      <p className="text-muted-foreground mx-auto mt-4 max-w-xl text-base leading-relaxed text-balance sm:text-lg">
        {beat.body}
      </p>
      <div className="mt-9 w-full">{beat.visual}</div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Page — the immersive stage                                                 */
/* -------------------------------------------------------------------------- */

const variants = {
  enter: (dir: number) => ({ opacity: 0, y: dir > 0 ? 26 : -26, filter: 'blur(6px)' }),
  center: { opacity: 1, y: 0, filter: 'blur(0px)' },
  exit: (dir: number) => ({ opacity: 0, y: dir > 0 ? -26 : 26, filter: 'blur(6px)' }),
};

export default function ExperiencePage() {
  const { user } = useAuth();
  const [path, setPath] = useState<Path | null>(null);
  const [step, setStep] = useState(0);
  const [dir, setDir] = useState(1);

  const beats = useMemo<Beat[]>(() => (path ? buildBeats(path) : [{ kind: 'intro' }]), [path]);
  const total = beats.length;
  const current = beats[Math.min(step, total - 1)];

  // Lock body scroll — the stage owns the whole viewport (no footer peeking).
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  // Keep a live ref to the current step so `go` can stay stable and read the
  // latest step without a stale closure (used by wheel/keyboard/rail/buttons).
  const stepRef = useRef(step);
  stepRef.current = step;

  const go = useCallback(
    (next: number) => {
      const clamped = Math.max(0, Math.min(total - 1, next));
      const s = stepRef.current;
      if (clamped === s) return;
      setDir(clamped > s ? 1 : -1);
      setStep(clamped);
    },
    [total],
  );

  const choose = useCallback((p: Path) => {
    setPath(p);
    setDir(1);
    setStep(1);
  }, []);

  const restart = useCallback(() => {
    setDir(-1);
    setStep(0);
    setPath(null);
  }, []);

  const handleLaunch = useCallback(() => {
    trackCtaSignup();
    window.location.href = user ? '/projects' : '/auth';
  }, [user]);

  // Keyboard navigation.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (['ArrowDown', 'ArrowRight', 'PageDown'].includes(e.key)) {
        e.preventDefault();
        go(step + 1);
      } else if (['ArrowUp', 'ArrowLeft', 'PageUp'].includes(e.key)) {
        e.preventDefault();
        go(step - 1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [go, step]);

  // Wheel / trackpad — one gesture advances one beat (debounced).
  const wheelLock = useRef(false);
  const onWheel = useCallback(
    (e: React.WheelEvent) => {
      if (wheelLock.current || Math.abs(e.deltaY) < 16) return;
      wheelLock.current = true;
      go(step + (e.deltaY > 0 ? 1 : -1));
      window.setTimeout(() => {
        wheelLock.current = false;
      }, 720);
    },
    [go, step],
  );

  // Touch swipe (mobile).
  const touchY = useRef<number | null>(null);

  const isIntro = current.kind === 'intro';
  const isCta = current.kind === 'cta';

  return (
    <div
      className="bg-background relative h-[100svh] w-full overflow-hidden"
      onWheel={onWheel}
      onTouchStart={(e) => {
        touchY.current = e.touches[0]?.clientY ?? null;
      }}
      onTouchEnd={(e) => {
        if (touchY.current == null) return;
        const dy = touchY.current - (e.changedTouches[0]?.clientY ?? touchY.current);
        if (Math.abs(dy) > 44) go(step + (dy > 0 ? 1 : -1));
        touchY.current = null;
      }}
    >
      {/* Ambient backdrop — only on the bookend beats, kept faint elsewhere. */}
      <div
        className={cn(
          'pointer-events-none absolute inset-0 z-0 transition-opacity duration-700',
          isIntro || isCta ? 'opacity-100 mask-y-to-90%' : 'opacity-[0.18] mask-radial-from-30%',
        )}
        aria-hidden
      >
        <KortixLetterField seed={isCta ? 7321 : 4817} />
      </div>

      {/* The stage — one beat at a time, crossfaded. */}
      <div className="absolute inset-0 z-10">
        <AnimatePresence custom={dir} initial={false}>
          <motion.div
            key={step}
            custom={dir}
            variants={variants}
            initial="enter"
            animate="center"
            exit="exit"
            transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
            className="absolute inset-0 flex items-center justify-center overflow-y-auto px-6 py-24"
          >
            {current.kind === 'intro' && <Intro onChoose={choose} />}
            {current.kind === 'scene' && <Scene beat={current} n={step} />}
            {current.kind === 'cta' && <Cta onLaunch={handleLaunch} onRestart={restart} />}
          </motion.div>
        </AnimatePresence>
      </div>

      {/* Progress rail (right) — appears once a path is chosen. */}
      {path && (
        <div className="absolute top-1/2 right-5 z-30 hidden -translate-y-1/2 flex-col items-center gap-2.5 sm:flex">
          {beats.map((b, i) => (
            <button
              key={i}
              type="button"
              aria-label={`Go to step ${i + 1}`}
              onClick={() => go(i)}
              className={cn(
                'rounded-full transition-all duration-300',
                i === step
                  ? 'bg-foreground h-5 w-1.5'
                  : 'bg-foreground/20 hover:bg-foreground/40 h-1.5 w-1.5',
              )}
            />
          ))}
        </div>
      )}

      {/* Bottom navigation — appears once a path is chosen. */}
      {path && (
        <div className="absolute inset-x-0 bottom-6 z-30 flex flex-col items-center gap-3">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => go(step - 1)}
              disabled={step === 0}
              aria-label="Back"
              className="border-border bg-background/70 text-muted-foreground hover:text-foreground enabled:hover:border-foreground/30 flex size-10 items-center justify-center rounded-full border backdrop-blur-sm transition-colors disabled:opacity-40"
            >
              <ChevronLeft className="size-4" />
            </button>
            {!isCta && (
              <Button onClick={() => go(step + 1)} className="rounded-full">
                Next
                <ArrowRight className="size-4" />
              </Button>
            )}
          </div>
          <p className="text-muted-foreground/60 flex items-center gap-1.5 text-[11px] font-medium">
            <ChevronUp className="size-3" />
            scroll, arrow keys, or the dots
          </p>
        </div>
      )}
    </div>
  );
}
