'use client';

import { useCopy } from '@/hooks/use-copy';
import { cn } from '@/lib/utils';
import { Check, Copy } from 'lucide-react';
import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useRef,
  useState,
} from 'react';
import { HyperText } from '../ui/hyper-text';
import { KORTIX_BULLET_GRADIENT, KortixAsterisk } from '../ui/kortix-asterisk';
import { Button } from '../ui/marketing/button';
import { KortixHyperLogo } from '../ui/marketing/kortix-hyper-logo';
import { TextShimmer } from '../ui/text-shimmer';

type Color = 'cyan' | 'green' | 'amber' | 'red' | 'fg' | 'dim' | 'faded';

const KORTIX_CMD_CLASS =
  'animate-kortix-bullet-flow inline-block bg-size-[100%_300%] bg-clip-text text-transparent';

const KORTIX_CMD_STYLE: CSSProperties = {
  backgroundImage: KORTIX_BULLET_GRADIENT,
  backgroundSize: '100% 300%',
  WebkitBackgroundClip: 'text',
  backgroundClip: 'text',
  WebkitTextFillColor: 'transparent',
  color: 'transparent',
};

const COLOR: Record<Color, string> = {
  cyan: 'text-cyan-500 dark:text-cyan-400',
  green: 'text-emerald-500',
  amber: 'text-amber-500',
  red: 'text-red-500',
  fg: 'text-foreground',
  dim: 'text-muted-foreground',
  faded: 'text-muted-foreground/45',
};

type Span = { t: string; c?: Color | 'kortix' | 'cursor' };
type Line = Span[];

type OutEvent =
  | { k: 'line'; line: Line }
  | { k: 'ask'; label: Line; answer: string; color?: Color }
  | { k: 'pick'; intro: Line[]; options: string[]; selected: number };

type Step = { input: string; note?: boolean; out?: Line[]; events?: OutEvent[] };

const t = (text: string, c?: Color | 'kortix' | 'cursor'): Span => ({ t: text, c });
const ok = (...spans: Span[]): Line => [t('  '), t('✓', 'green'), t('  '), ...spans];

const CURSOR: Span = { t: '', c: 'cursor' };
const lines = (arr: Line[]): OutEvent[] => arr.map((line) => ({ k: 'line', line }));

const pickOptionsLine = (options: string[], selected: number): Line => {
  const spans: Span[] = [t('  ')];
  options.forEach((opt, i) => {
    if (i > 0) spans.push(t('  ·  ', 'faded'));
    spans.push(i === selected ? t(opt, 'kortix') : t(opt, 'dim'));
  });
  return spans;
};

const eventsToLines = (events: OutEvent[]): Line[] => {
  const out: Line[] = [];
  for (const ev of events) {
    if (ev.k === 'line') out.push(ev.line);
    else if (ev.k === 'ask') out.push([...ev.label, t(ev.answer, ev.color)]);
    else {
      out.push(...ev.intro);
      out.push(pickOptionsLine(ev.options, ev.selected));
      out.push(ok(t('Using '), t(ev.options[ev.selected], 'fg')));
    }
  }
  return out;
};

const BANNER_ART = [
  '██╗  ██╗ ██████╗ ██████╗ ████████╗██╗██╗  ██╗',
  '██║ ██╔╝██╔═══██╗██╔══██╗╚══██╔══╝██║╚██╗██╔╝',
  '█████╔╝ ██║   ██║██████╔╝   ██║   ██║ ╚███╔╝ ',
  '██╔═██╗ ██║   ██║██╔══██╗   ██║   ██║ ██╔██╗ ',
  '██║  ██╗╚██████╔╝██║  ██║   ██║   ██║██╔╝ ██╗',
  '╚═╝  ╚═╝ ╚═════╝ ╚═╝  ╚═╝   ╚═╝   ╚═╝╚═╝  ╚═╝',
  '                                             ',
];

const BW = 42;
const padTo = (s: string, w: number) => s + ' '.repeat(Math.max(0, w - s.length));
const boxLine = (content: string) => `║ ${padTo(content, BW)} ║`;
const boxTop = (title: string) => {
  const inner = ` ${title} `;
  const fill = '═'.repeat(Math.max(0, BW + 2 - inner.length));
  const half = Math.floor(fill.length / 2);
  return `╔${'═'.repeat(half)}${inner}${'═'.repeat(fill.length - half)}╗`;
};
const boxBottom = () => `╚${'═'.repeat(BW + 2)}╝`;
const insetCard = (title: string, body: string[]): string[] => {
  const titleStr = ` ${title} `;
  const fill = '─'.repeat(Math.max(0, BW - 2 - titleStr.length));
  const half = Math.floor(fill.length / 2);
  const out = [`╭${'─'.repeat(half)}${titleStr}${'─'.repeat(fill.length - half)}╮`];
  for (const line of body) out.push(`│ ${padTo(line, BW - 4)} │`);
  out.push(`╰${'─'.repeat(BW - 2)}╯`);
  return out.map(boxLine);
};

const PROMPT_BODY = [
  'Read the kortix skill, then propose an',
  'initial agent, wire up the trigger,',
  'and list the secrets to set.',
];

function getStartedBox(): Line[] {
  const lines: Line[] = [[]];
  lines.push([t(boxTop('get started'), 'faded')]);
  lines.push([t(boxLine(''), 'faded')]);
  for (const s of [
    'Paste this prompt into your coding agent',
    'to configure your Kortix project:',
  ]) {
    lines.push([t('║ ', 'faded'), t(padTo(s, BW), 'dim'), t(' ║', 'faded')]);
  }
  lines.push([t(boxLine(''), 'faded')]);
  for (const l of insetCard('prompt', PROMPT_BODY)) lines.push([t(l, 'dim')]);
  lines.push([t(boxLine(''), 'faded')]);
  const pre = 'When ready, take it live:  ';
  const cmd = 'kortix ship';
  const trailing = ' '.repeat(Math.max(0, BW - pre.length - cmd.length));
  lines.push([t('║ ', 'faded'), t(pre, 'dim'), t(cmd, 'kortix'), t(trailing), t(' ║', 'faded')]);
  lines.push([t(boxLine(''), 'faded')]);
  lines.push([t(boxBottom(), 'faded')]);
  return lines;
}

const INIT_INTRO: Line[] = [
  [],
  [],
  ...BANNER_ART.map((r): Line => [t(r, 'cyan')]),
  [],
  [
    t('   '),
    t('The operating system for AI workers', 'fg'),
    t('   '),
    t('·  configure your Kortix project', 'faded'),
  ],
  [],
];

const AGENT_PICK_INTRO: Line[] = [
  [],
  [t('  Pick your local coding agent to configure this Kortix project.', 'dim')],
  [],
  [t('  It picks up the Kortix skill — ask it to scaffold triggers,', 'dim')],
  [t('  custom agents, or edit kortix.toml for you.', 'dim')],
  [t('  (Kortix itself runs opencode inside every sandbox session.)', 'dim')],
  [],
];

const AGENTS = ['opencode', 'claude', 'codex', 'cursor'];
const PROJECT_NAME_LABEL: Line = [t('Project name '), t('(my-app)', 'dim'), t(': ')];

const initTail = (name: string): Line[] => [
  [],
  [t('Initialized Kortix project '), t(`"${name}"`, 'fg'), t(' in '), t(`~/${name}`, 'faded')],
  [t('Wrote 9 files:')],
  [t('  + ', 'faded'), t('kortix.toml')],
  [t('  + ', 'faded'), t('.kortix/Dockerfile')],
  [t('  + ', 'faded'), t('.kortix/opencode/opencode.jsonc')],
  [t('  + ', 'faded'), t('.kortix/opencode/agents/kortix.md')],
  [t('  + ', 'faded'), t('.kortix/opencode/skills/kortix-system/SKILL.md')],
  [t('  + ', 'faded'), t('.claude/skills/kortix/SKILL.md')],
  [t('Git: initialized (main)', 'dim')],
  [],
  [t('Next:')],
  [t(`  cd ${name}`, 'fg')],
  ...getStartedBox(),
];

const INIT_EVENTS: OutEvent[] = [
  ...lines(INIT_INTRO),
  { k: 'ask', label: PROJECT_NAME_LABEL, answer: 'my-app', color: 'fg' },
  { k: 'pick', intro: AGENT_PICK_INTRO, options: AGENTS, selected: 0 },
  ...lines(initTail('my-app')),
];

const SCRIPT: Step[] = [
  {
    input: 'kortix init my-app',
    events: INIT_EVENTS,
  },
  { input: "# build your agents locally — they're just files", note: true, out: [] },
  {
    input: 'kortix ship',
    out: [
      ok(t('kortix.toml verified')),
      [],
      [t('  '), t('kortix ship', 'kortix'), t('  new project → managed Kortix git', 'dim')],
      [t('  name    ', 'dim'), t('my-app')],
      [],
      ok(t('Committed: '), t('kortix: ship', 'fg')),
      [],
      ok(t('Pushed '), t('main', 'fg'), t(' → '), t('origin/main', 'fg')),
      [],
      ok(t('Shipped '), t('my-app', 'fg')),
      [t('  repo  ', 'dim'), t('git.kortix.com/acme/my-app', 'faded')],
      [t('  live  ', 'dim'), t('kortix.com/p/my-app', 'cyan')],
      [],
    ],
  },
  {
    input: 'kortix sessions new --prompt "Audit auth"',
    out: [
      ok(t('Session started '), t('1f3a', 'fg')),
      [t('  session_id ', 'dim'), t('1f3a2b7c-…')],
      [t('  status     ', 'dim'), t('provisioning')],
      [t('  branch     ', 'dim'), t('session-1f3a')],
      [],
    ],
  },
  {
    input: 'kortix cr open --title "Fix auth timeout"',
    out: [
      [t('  '), t('✓', 'green'), t(' Opened '), t('CR #3', 'fg'), t(': Fix auth timeout')],
      [t('  session-1f3a → main', 'dim')],
      [],
    ],
  },
];

type InstallCta = {
  message: string;
  command: string;
};

type Block = { cmd: Line; out: Line[]; pending?: boolean; installCta?: InstallCta };

const cmdLineOf = (step: Step): Line =>
  step.note ? [t(step.input, 'faded')] : [t('$ ', 'faded'), t(step.input, 'kortix')];

const STATIC_BLOCKS: Block[] = SCRIPT.map((step) => ({
  cmd: cmdLineOf(step),
  out: step.events ? eventsToLines(step.events) : (step.out ?? []),
}));

const PALETTE: { cmd: string; desc: string }[] = [
  { cmd: 'kortix init', desc: 'scaffold a new Kortix project' },
  { cmd: 'kortix ship', desc: 'commit, push & deploy to managed git' },
  { cmd: 'kortix sessions new', desc: 'start an agent session' },
  { cmd: 'kortix cr open', desc: 'open a change request' },
];

const DEFAULT_INSTALL_HOST = 'kortix.com';
const INSTALL_CTA_MESSAGE =
  'Install the CLI to start an agent from your terminal, give it the right tools, and review every change before you merge.';

function demoResponse(cmd: string, installCmd: string): Block {
  return {
    cmd: [t('$ ', 'faded'), t(cmd, 'kortix')],
    out: [
      [],
      // [t('demo response', 'amber')],
      [t('This preview can’t run commands from the browser.', 'amber')],
      [],
    ],
    installCta: {
      message: INSTALL_CTA_MESSAGE,
      command: installCmd,
    },
  };
}

const SPEED = {
  start: 400,
  type: 36,
  afterType: 280,
  afterFlush: 110,
  line: 80,
  prompt: 2000, // "press enter" beat before a prompt accepts its default
  afterStep: 750,
  hold: 2200,
  afterClear: 420,
};

const DEMO_RESPONSE_HOLD = 6000;

function LineView({ line }: { line: Line }) {
  return (
    <div className="whitespace-pre">
      {line.length === 0
        ? ' '
        : line.map((s, i) =>
            s.c === 'kortix' ? (
              <span key={i} className={KORTIX_CMD_CLASS} style={KORTIX_CMD_STYLE}>
                {s.t}
              </span>
            ) : s.c === 'cursor' ? (
              <span
                key={i}
                aria-hidden
                className="bg-foreground/70 ml-px inline-block h-[1.05em] w-[0.5em] translate-y-[0.12em] animate-pulse"
              />
            ) : (
              <span key={i} className={s.c ? COLOR[s.c] : undefined}>
                {s.t}
              </span>
            ),
          )}
    </div>
  );
}

function ReasoningView() {
  return (
    <div className="text-muted-foreground flex items-center gap-2 py-0.5">
      <KortixAsterisk index={0} parentClass="mt-0 animate-spin" />
      <div className="inline-flex items-center gap-0">
        {/* <span className="text-primary text-sm font-medium">Reasoning</span> */}
        <TextShimmer>Reasoning...</TextShimmer>
      </div>
    </div>
  );
}

function InstallCtaView({ cta }: { cta: InstallCta }) {
  const { copied, copy } = useCopy();

  return (
    <div className="space-y-4">
      <p className="text-muted-foreground text-[11px] leading-relaxed sm:text-xs">{cta.message}</p>

      <div className="bg-card flex w-full items-center justify-between gap-4 rounded-sm border p-3 px-5">
        <div className="flex gap-3">
          <span className="text-foreground font-mono text-sm">$ </span>
          <span className="text-foreground font-mono text-sm select-all">{cta.command}</span>
        </div>
        <Button size="icon-sm" variant="ghost" onClick={() => copy(cta.command)}>
          {copied ? <Check className="text-primary size-4" /> : <Copy className="size-4" />}
        </Button>
      </div>
    </div>
  );
}

export function CliDemo() {
  const rootRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [inView, setInView] = useState(false);
  const [reduced, setReduced] = useState(false);
  const [scrollback, setScrollback] = useState<Block[]>([]);
  const [typed, setTyped] = useState('');
  const [isNote, setIsNote] = useState(false);
  const [installHost, setInstallHost] = useState(DEFAULT_INSTALL_HOST);

  const [draft, setDraft] = useState('');
  const [focused, setFocused] = useState(false);
  const [interacted, setInteracted] = useState(false);
  const [paletteIdx, setPaletteIdx] = useState(0);
  const [thinking, setThinking] = useState(false);
  const thinkTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const [wizard, setWizard] = useState<
    { phase: 'name' } | { phase: 'agent'; name: string; agentIdx: number } | null
  >(null);

  const paletteOpen = focused && !wizard && draft.startsWith('/');
  const paletteItems = paletteOpen
    ? PALETTE.filter((p) => p.cmd.toLowerCase().includes(draft.slice(1).trim().toLowerCase()))
    : [];
  const installCmd = `curl -fsSL https://${installHost}/install | bash`;

  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setInView(e?.isIntersecting ?? false), {
      threshold: 0.25,
    });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    const m = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduced(m.matches);
    const h = () => setReduced(m.matches);
    m.addEventListener('change', h);
    return () => m.removeEventListener('change', h);
  }, []);

  useEffect(() => {
    setInstallHost(window.location.host);
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [scrollback]);

  useEffect(() => () => clearTimeout(thinkTimer.current), []);

  useEffect(() => {
    if (!inView || reduced || focused || interacted) return;
    let cancelled = false;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const sleep = (ms: number) =>
      new Promise<void>((res) => {
        const id = setTimeout(() => {
          timers.delete(id);
          res();
        }, ms);
        timers.add(id);
      });

    const appendLine = (line: Line) =>
      setScrollback((prev) => {
        const next = prev.slice();
        const last = next[next.length - 1];
        if (last) next[next.length - 1] = { ...last, out: [...last.out, line] };
        return next;
      });

    const replaceLastLine = (line: Line) =>
      setScrollback((prev) => {
        const next = prev.slice();
        const last = next[next.length - 1];
        if (last && last.out.length) {
          const out = last.out.slice();
          out[out.length - 1] = line;
          next[next.length - 1] = { ...last, out };
        }
        return next;
      });

    async function streamEvents(events: OutEvent[]) {
      for (const ev of events) {
        if (cancelled) return;
        if (ev.k === 'line') {
          appendLine(ev.line);
          await sleep(SPEED.line);
        } else if (ev.k === 'ask') {
          appendLine([...ev.label, CURSOR]);
          await sleep(SPEED.prompt);
          if (cancelled) return;
          for (let i = 1; i <= ev.answer.length; i += 1) {
            if (cancelled) return;
            replaceLastLine([...ev.label, t(ev.answer.slice(0, i), ev.color), CURSOR]);
            await sleep(SPEED.type);
          }
          replaceLastLine([...ev.label, t(ev.answer, ev.color)]);
          await sleep(SPEED.afterType);
        } else {
          for (const l of ev.intro) {
            if (cancelled) return;
            appendLine(l);
            await sleep(SPEED.line);
          }
          appendLine([...pickOptionsLine(ev.options, ev.selected), t(' '), CURSOR]);
          await sleep(SPEED.prompt);
          if (cancelled) return;
          replaceLastLine(pickOptionsLine(ev.options, ev.selected));
          appendLine(ok(t('Using '), t(ev.options[ev.selected], 'fg')));
          await sleep(SPEED.afterType);
        }
      }
    }

    async function run() {
      setScrollback([]);
      setTyped('');
      setIsNote(false);
      await sleep(SPEED.start);
      while (!cancelled) {
        for (const step of SCRIPT) {
          if (cancelled) return;
          setIsNote(!!step.note);
          for (let i = 1; i <= step.input.length; i += 1) {
            if (cancelled) return;
            setTyped(step.input.slice(0, i));
            await sleep(SPEED.type);
          }
          await sleep(SPEED.afterType);
          if (cancelled) return;
          setScrollback((prev) => [...prev, { cmd: cmdLineOf(step), out: [] }]);
          setTyped('');
          setIsNote(false);
          await sleep(SPEED.afterFlush);
          if (step.events) {
            await streamEvents(step.events);
          } else {
            for (const line of step.out ?? []) {
              if (cancelled) return;
              appendLine(line);
              await sleep(SPEED.line);
            }
          }
          await sleep(SPEED.afterStep);
        }
        await sleep(SPEED.hold);
        if (cancelled) return;
        setScrollback([]);
        await sleep(SPEED.afterClear);
      }
    }

    run();
    return () => {
      cancelled = true;
      timers.forEach(clearTimeout);
    };
  }, [inView, reduced, focused, interacted]);

  const blocks = reduced ? STATIC_BLOCKS : scrollback;
  const animating = !reduced && !focused && !interacted;

  const respond = (block: Block) => {
    clearTimeout(thinkTimer.current);
    setInteracted(true);
    setDraft('');
    setPaletteIdx(0);
    setThinking(true);
    setScrollback((prev) => [...prev, { cmd: block.cmd, out: [], pending: true }]);
    thinkTimer.current = setTimeout(() => {
      setScrollback((prev) => {
        const next = prev.slice();
        const i = next.findIndex((b) => b.pending);
        if (i !== -1) next[i] = block;
        return next;
      });
      setThinking(false);
      thinkTimer.current = setTimeout(() => {
        inputRef.current?.blur();
        setFocused(false);
        setInteracted(false);
      }, DEMO_RESPONSE_HOLD);
    }, 2000);
  };

  const pushOutLines = (newLines: Line[]) =>
    setScrollback((prev) => {
      const next = prev.slice();
      const last = next[next.length - 1];
      if (last) next[next.length - 1] = { ...last, out: [...last.out, ...newLines] };
      return next;
    });

  const startInitWizard = () => {
    if (thinking) return;
    clearTimeout(thinkTimer.current);
    setInteracted(true);
    setThinking(false);
    setDraft('');
    setPaletteIdx(0);
    setScrollback((prev) => [
      ...prev,
      { cmd: [t('$ ', 'faded'), t('kortix init', 'kortix')], out: [...INIT_INTRO] },
    ]);
    setWizard({ phase: 'name' });
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  const submitName = () => {
    const name = draft.trim() || 'my-app';
    pushOutLines([[...PROJECT_NAME_LABEL, t(name, 'fg')], ...AGENT_PICK_INTRO]);
    setWizard({ phase: 'agent', name, agentIdx: 0 });
    setDraft('');
  };

  const confirmAgent = (idx: number) => {
    if (!wizard || wizard.phase !== 'agent') return;
    pushOutLines([
      pickOptionsLine(AGENTS, idx),
      ok(t('Using '), t(AGENTS[idx], 'fg')),
      ...initTail(wizard.name),
    ]);
    setWizard(null);
    setDraft('');
    clearTimeout(thinkTimer.current);
    thinkTimer.current = setTimeout(() => {
      inputRef.current?.blur();
      setFocused(false);
      setInteracted(false);
    }, DEMO_RESPONSE_HOLD);
  };

  const runCommand = (cmd: string) => {
    if (thinking) return;
    if (cmd === 'kortix init') {
      startInitWizard();
      return;
    }
    respond(demoResponse(cmd, installCmd));
    inputRef.current?.focus();
  };

  const submit = () => {
    if (thinking) return;
    const value = draft.trim();
    if (!value) return;
    if (value.startsWith('/')) {
      const item = paletteItems[paletteIdx] ?? paletteItems[0];
      runCommand(item ? item.cmd : value.slice(1).trim());
    } else if (/^kortix\s+init$/.test(value)) {
      startInitWizard();
    } else {
      respond(demoResponse(value, installCmd));
    }
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (wizard?.phase === 'agent') {
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
        e.preventDefault();
        setWizard((w) =>
          w && w.phase === 'agent'
            ? { ...w, agentIdx: Math.min(w.agentIdx + 1, AGENTS.length - 1) }
            : w,
        );
        return;
      }
      if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        e.preventDefault();
        setWizard((w) =>
          w && w.phase === 'agent' ? { ...w, agentIdx: Math.max(w.agentIdx - 1, 0) } : w,
        );
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        confirmAgent(wizard.agentIdx);
      }
      return;
    }
    if (wizard?.phase === 'name') {
      if (e.key === 'Enter') {
        e.preventDefault();
        submitName();
      }
      return;
    }
    if (paletteOpen && paletteItems.length) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setPaletteIdx((i) => Math.min(i + 1, paletteItems.length - 1));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setPaletteIdx((i) => Math.max(i - 1, 0));
        return;
      }
    }
    if (e.key === 'Escape') {
      setDraft('');
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div
      ref={rootRef}
      className="border-card bg-background relative flex aspect-video h-120 w-full flex-col overflow-hidden rounded-[calc(var(--radius)+2px)] border-4 lg:h-full"
    >
      <div className="border-border/60 bg-muted/30 flex shrink-0 items-center gap-3 border-b p-4 py-2">
        <span className="text-muted-foreground/70 inline-flex items-center gap-1 text-xs">
          <KortixAsterisk index={0} parentClass="mt-0" />
          <HyperText animateOnHover={false}>kortix</HyperText>
        </span>
      </div>

      <div
        ref={scrollRef}
        className="text-foreground scrollbar-hide min-h-0 flex-1 space-y-3 overflow-auto mask-y-from-95% px-4 py-3 font-mono text-[10px] leading-relaxed sm:text-xs"
      >
        {blocks.length > 0 ? (
          blocks.map((block, i) => (
            <div key={i} className="">
              <div className="bg-card ring-border/60 mb-3 rounded-sm px-3 py-2 ring-1">
                <LineView line={block.cmd} />
              </div>

              {block.pending ? (
                <ReasoningView />
              ) : (
                <>
                  {block.out.map((line, j) => (
                    <LineView key={j} line={line} />
                  ))}
                  {block.installCta && <InstallCtaView cta={block.installCta} />}
                </>
              )}
            </div>
          ))
        ) : (
          <div className="flex h-full w-full items-center justify-center">
            <KortixHyperLogo />
          </div>
        )}
      </div>

      <div className="p-4 pt-0">
        <div
          className="border-border bg-muted/20 shrink-0 overflow-hidden rounded-sm border px-4 py-2.5 font-mono text-[10px] leading-relaxed sm:text-xs"
          onClick={() => inputRef.current?.focus()}
        >
          <div className="flex items-center whitespace-pre">
            {animating ? (
              <>
                {!isNote && <span className="text-muted-foreground/45">$ </span>}
                <span
                  className={
                    isNote
                      ? 'text-muted-foreground/45'
                      : typed.startsWith('kortix')
                        ? KORTIX_CMD_CLASS
                        : 'text-foreground'
                  }
                  style={!isNote && typed.startsWith('kortix') ? KORTIX_CMD_STYLE : undefined}
                >
                  {typed}
                </span>
                <span
                  aria-hidden
                  className="bg-foreground/70 ml-px inline-block h-[1.05em] w-[0.5em] translate-y-[0.12em] animate-pulse"
                />
              </>
            ) : wizard?.phase === 'name' ? (
              <>
                <span className="text-foreground">Project name </span>
                <span className="text-muted-foreground">(my-app)</span>
                <span className="text-foreground">: </span>
              </>
            ) : wizard?.phase === 'agent' ? (
              <span className="text-muted-foreground/70 font-sans tracking-normal">
                Pick your coding agent — ←/→ to move · enter to confirm · or click below
              </span>
            ) : (
              <span className="text-muted-foreground/45">$ </span>
            )}
            <input
              ref={inputRef}
              value={draft}
              spellCheck={false}
              autoComplete="off"
              disabled={thinking}
              readOnly={wizard?.phase === 'agent'}
              aria-label="kortix terminal input"
              placeholder={
                thinking
                  ? 'reasoning…'
                  : animating || wizard?.phase === 'agent'
                    ? ''
                    : wizard?.phase === 'name'
                      ? 'my-app'
                      : 'try kortix init, or / for commands'
              }
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              onChange={(e) => {
                setDraft(e.target.value);
                setPaletteIdx(0);
              }}
              onKeyDown={onKeyDown}
              className={
                animating || wizard?.phase === 'agent'
                  ? 'absolute h-0 w-0 opacity-0'
                  : 'text-foreground placeholder:text-muted-foreground/40 flex-1 bg-transparent caret-current outline-none'
              }
            />
          </div>
        </div>

        {wizard?.phase === 'agent' && (
          <div className="flex flex-wrap items-center gap-2 px-1 py-2 font-mono text-[10px] sm:text-xs">
            {AGENTS.map((agent, i) => {
              const active = i === wizard.agentIdx;
              return (
                <button
                  key={agent}
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseEnter={() =>
                    setWizard((w) => (w && w.phase === 'agent' ? { ...w, agentIdx: i } : w))
                  }
                  onClick={() => confirmAgent(i)}
                  className={cn(
                    'rounded-sm border px-3 py-1.5 transition-colors',
                    active
                      ? 'border-foreground/30 bg-muted/50'
                      : 'border-border/50 text-muted-foreground hover:text-foreground',
                  )}
                >
                  <span
                    className={active ? KORTIX_CMD_CLASS : undefined}
                    style={active ? KORTIX_CMD_STYLE : undefined}
                  >
                    {agent}
                  </span>
                </button>
              );
            })}
          </div>
        )}

        {paletteOpen && paletteItems.length > 0 && (
          <div className="shrink-0 space-y-2 px-1 py-2 font-mono text-[10px] sm:text-xs">
            {paletteItems.map((item, i) => (
              <button
                key={item.cmd}
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setPaletteIdx(i)}
                onClick={() => runCommand(item.cmd)}
                className="flex w-full items-baseline gap-2 rounded-sm text-left"
              >
                <span className="min-w-40 shrink-0">{item.cmd}</span>
                <span className="text-muted-foreground/60 truncate font-sans tracking-normal">
                  {item.desc}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
