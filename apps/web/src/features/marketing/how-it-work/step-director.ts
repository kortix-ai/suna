'use client';

import { cmdLine, meta, ok, t, type Line } from '@/components/home/interactive-demo/cli/terminal';
import { useReducedMotion } from 'motion/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  RUNTIMES,
  type RuntimeOption,
  type StepCliBlock,
  type StepCliMenuState,
} from './step-cli-terminal';

/* ───────────────────────────────────────────────────────────────────────────
 * How-it-works CLI directors — one scripted movie per step.
 * ─────────────────────────────────────────────────────────────────────────── */

// ── Step 1 — "Create" ───────────────────────────────────────────────────────

export type Step1Project = {
  name: string;
  status: 'draft' | 'live';
  files: number;
  branch: string;
  runtime: string;
};

export type Step1Director = {
  projects: Step1Project[];
  scrollback: StepCliBlock[];
  typed: string;
  menu: StepCliMenuState | null;
  running: boolean;
  start: () => void;
};

const STEP1_PROJECT = 'acme-ops';

const STEP1_SPEED = {
  start: 520,
  type: 38,
  afterType: 260,
  afterFlush: 150,
  line: 110,
  menuOpen: 480,
  menuStep: 320,
  menuSettle: 540,
  afterChoose: 460,
  hold: 2800,
  afterClear: 720,
};

function step1SelectionPath(chosen: number): number[] {
  const down = RUNTIMES.map((_, i) => i);
  const up: number[] = [];
  for (let i = RUNTIMES.length - 2; i >= chosen; i -= 1) up.push(i);
  return [...down, ...up];
}

function step1ScaffoldLines(runtime: RuntimeOption): Line[] {
  return [
    ok(t('Using '), t(runtime.label, 'fg'), t(' runtime')),
    [],
    [
      t('Initialized Kortix project '),
      t(`"${STEP1_PROJECT}"`, 'fg'),
      t(' in '),
      t(`~/${STEP1_PROJECT}`, 'faded'),
    ],
    [t('Wrote 9 files:')],
    [t('  + ', 'faded'), t('kortix.yaml')],
    [t('  + ', 'faded'), t('.kortix/opencode/agents/kortix.md')],
    [t('  + ', 'faded'), t('.claude/skills/kortix/SKILL.md')],
    [t('  + ', 'faded'), t('…and 6 more', 'faded')],
    meta('runtime', runtime.label, 'fg'),
    [t('Git: initialized (main)', 'dim')],
    [],
    [t('Next:')],
    [t(`  cd ${STEP1_PROJECT}`, 'fg')],
  ];
}

function step1StaticBlocks(): StepCliBlock[] {
  return [
    {
      cmd: cmdLine(`kortix init ${STEP1_PROJECT}`),
      out: [[], [t('Creating a new Kortix project…', 'dim')], ...step1ScaffoldLines(RUNTIMES[0])],
    },
  ];
}

export function useStep1Director(): Step1Director {
  const reduced = useReducedMotion();

  const [projects, setProjects] = useState<Step1Project[]>([]);
  const [scrollback, setScrollback] = useState<StepCliBlock[]>([]);
  const [typed, setTyped] = useState('');
  const [menu, setMenu] = useState<StepCliMenuState | null>(null);
  const [started, setStarted] = useState(false);

  const loopRef = useRef(0);

  const start = useCallback(() => setStarted(true), []);

  useEffect(() => {
    if (!reduced) return;
    setScrollback(step1StaticBlocks());
    setProjects([
      {
        name: STEP1_PROJECT,
        status: 'draft',
        files: 9,
        branch: 'main',
        runtime: RUNTIMES[0].label,
      },
    ]);
  }, [reduced]);

  useEffect(() => {
    if (!started || reduced) return;
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

    const reset = () => {
      setScrollback([]);
      setProjects([]);
      setMenu(null);
      setTyped('');
    };

    async function typeCommand(input: string) {
      for (let i = 1; i <= input.length; i += 1) {
        if (cancelled) return;
        setTyped(input.slice(0, i));
        await sleep(STEP1_SPEED.type);
      }
      await sleep(STEP1_SPEED.afterType);
      if (cancelled) return;
      setScrollback((prev) => [...prev, { cmd: cmdLine(input), out: [] }]);
      setTyped('');
      await sleep(STEP1_SPEED.afterFlush);
    }

    async function run() {
      reset();
      await sleep(STEP1_SPEED.start);

      while (!cancelled) {
        const chosenIdx = loopRef.current % RUNTIMES.length;
        const runtime = RUNTIMES[chosenIdx];

        await typeCommand(`kortix init ${STEP1_PROJECT}`);
        if (cancelled) return;

        appendLine([]);
        appendLine([t('Creating a new Kortix project…', 'dim')]);
        await sleep(STEP1_SPEED.line);

        setMenu({ selected: 0, chosen: null });
        await sleep(STEP1_SPEED.menuOpen);
        for (const idx of step1SelectionPath(chosenIdx)) {
          if (cancelled) return;
          setMenu((m) => (m ? { ...m, selected: idx } : m));
          await sleep(STEP1_SPEED.menuStep);
        }
        await sleep(STEP1_SPEED.menuSettle);
        if (cancelled) return;
        setMenu((m) => (m ? { ...m, chosen: chosenIdx } : m));
        await sleep(STEP1_SPEED.afterChoose);
        if (cancelled) return;
        setMenu(null);

        const lines = step1ScaffoldLines(runtime);
        for (let i = 0; i < lines.length; i += 1) {
          if (cancelled) return;
          appendLine(lines[i]);
          if (i === 0) {
            setProjects([
              {
                name: STEP1_PROJECT,
                status: 'draft',
                files: 9,
                branch: 'main',
                runtime: runtime.label,
              },
            ]);
          }
          await sleep(STEP1_SPEED.line);
        }

        await sleep(STEP1_SPEED.hold);
        if (cancelled) return;
        loopRef.current += 1;
        reset();
        await sleep(STEP1_SPEED.afterClear);
      }
    }

    run();
    return () => {
      cancelled = true;
      timers.forEach(clearTimeout);
    };
  }, [started, reduced]);

  return {
    projects,
    scrollback,
    typed,
    menu,
    running: started && !reduced,
    start,
  };
}

// ── Step 2 — "Connect" ──────────────────────────────────────────────────────

export type Step2View = 'models' | 'integrations';

export type Step2Director = {
  view: Step2View;
  connectedProviders: string[];
  connectedConnectors: string[];
  showCostPanel: boolean;
  scrollback: StepCliBlock[];
  typed: string;
  running: boolean;
  start: () => void;
};

const STEP2_SPEED = {
  start: 520,
  type: 38,
  afterType: 260,
  afterFlush: 150,
  line: 110,
  afterSlack: 480,
  afterLinear: 520,
  hold: 2800,
  afterClear: 720,
};

function step2StaticBlocks(): StepCliBlock[] {
  return [
    {
      cmd: cmdLine('kortix connectors connect slack'),
      out: [ok(t('Slack connected — coworker can reply in-channel'))],
    },
    {
      cmd: cmdLine('kortix connectors connect linear'),
      out: [ok(t('Linear connected — scoped actions ready'))],
    },
  ];
}

export function useStep2Director(): Step2Director {
  const reduced = useReducedMotion();

  const [view, setView] = useState<Step2View>('models');
  const [connectedProviders, setConnectedProviders] = useState<string[]>([]);
  const [connectedConnectors, setConnectedConnectors] = useState<string[]>([]);
  const [showCostPanel, setShowCostPanel] = useState(false);
  const [scrollback, setScrollback] = useState<StepCliBlock[]>([]);
  const [typed, setTyped] = useState('');
  const [started, setStarted] = useState(false);

  const start = useCallback(() => setStarted(true), []);

  useEffect(() => {
    if (!reduced) return;
    setScrollback(step2StaticBlocks());
    setView('integrations');
    setConnectedProviders([]);
    setConnectedConnectors(['Slack', 'Linear']);
    setShowCostPanel(false);
  }, [reduced]);

  useEffect(() => {
    if (!started || reduced) return;
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

    const reset = () => {
      setScrollback([]);
      setView('models');
      setConnectedProviders([]);
      setConnectedConnectors([]);
      setShowCostPanel(false);
      setTyped('');
    };

    async function typeCommand(input: string) {
      for (let i = 1; i <= input.length; i += 1) {
        if (cancelled) return;
        setTyped(input.slice(0, i));
        await sleep(STEP2_SPEED.type);
      }
      await sleep(STEP2_SPEED.afterType);
      if (cancelled) return;
      setScrollback((prev) => [...prev, { cmd: cmdLine(input), out: [] }]);
      setTyped('');
      await sleep(STEP2_SPEED.afterFlush);
    }

    async function run() {
      reset();
      await sleep(STEP2_SPEED.start);

      while (!cancelled) {
        setView('integrations');
        await typeCommand('kortix connectors connect slack');
        if (cancelled) return;

        appendLine(ok(t('Slack connected — coworker can reply in-channel')));
        await sleep(STEP2_SPEED.line);
        setConnectedConnectors(['Slack']);
        await sleep(STEP2_SPEED.afterSlack);
        if (cancelled) return;

        await typeCommand('kortix connectors connect linear');
        if (cancelled) return;

        appendLine(ok(t('Linear connected — scoped actions ready')));
        setConnectedConnectors(['Slack', 'Linear']);
        await sleep(STEP2_SPEED.afterLinear);

        await sleep(STEP2_SPEED.hold);
        if (cancelled) return;
        reset();
        await sleep(STEP2_SPEED.afterClear);
      }
    }

    run();
    return () => {
      cancelled = true;
      timers.forEach(clearTimeout);
    };
  }, [started, reduced]);

  return {
    view,
    connectedProviders,
    connectedConnectors,
    showCostPanel,
    scrollback,
    typed,
    running: started && !reduced,
    start,
  };
}

// ── Step 5 — "Run" ──────────────────────────────────────────────────────────

export type Step5Phase = 'idle' | 'session' | 'working';

export type Step5Director = {
  phase: Step5Phase;
  sessionId: string;
  branch: string;
  scrollback: StepCliBlock[];
  typed: string;
  running: boolean;
  start: () => void;
};

const STEP5_SESSION = 's_7f2a';
const STEP5_BRANCH = 'session/s_7f2a';

const STEP5_SPEED = {
  start: 520,
  type: 38,
  afterType: 260,
  afterFlush: 150,
  line: 110,
  afterSession: 420,
  afterWorking: 680,
  hold: 2800,
  afterClear: 720,
};

function step5StaticBlocks(): StepCliBlock[] {
  return [
    {
      cmd: cmdLine('kortix sessions create'),
      out: [
        ok(t('secure workspace ready · branch '), t(STEP5_BRANCH, 'faded')),
        [t('coworker working across connected tools…', 'dim')],
      ],
    },
  ];
}

export function useStep5Director(): Step5Director {
  const reduced = useReducedMotion();
  const [phase, setPhase] = useState<Step5Phase>('idle');
  const [scrollback, setScrollback] = useState<StepCliBlock[]>([]);
  const [typed, setTyped] = useState('');
  const [started, setStarted] = useState(false);
  const start = useCallback(() => setStarted(true), []);

  useEffect(() => {
    if (!reduced) return;
    setScrollback(step5StaticBlocks());
    setPhase('working');
  }, [reduced]);

  useEffect(() => {
    if (!started || reduced) return;
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

    const reset = () => {
      setScrollback([]);
      setPhase('idle');
      setTyped('');
    };

    async function typeCommand(input: string) {
      for (let i = 1; i <= input.length; i += 1) {
        if (cancelled) return;
        setTyped(input.slice(0, i));
        await sleep(STEP5_SPEED.type);
      }
      await sleep(STEP5_SPEED.afterType);
      if (cancelled) return;
      setScrollback((prev) => [...prev, { cmd: cmdLine(input), out: [] }]);
      setTyped('');
      await sleep(STEP5_SPEED.afterFlush);
    }

    async function run() {
      reset();
      await sleep(STEP5_SPEED.start);

      while (!cancelled) {
        await typeCommand('kortix sessions create');
        if (cancelled) return;

        appendLine(ok(t('secure workspace ready · branch '), t(STEP5_BRANCH, 'faded')));
        setPhase('session');
        await sleep(STEP5_SPEED.afterSession);
        if (cancelled) return;

        appendLine([t('coworker working across connected tools…', 'dim')]);
        setPhase('working');
        await sleep(STEP5_SPEED.afterWorking);

        await sleep(STEP5_SPEED.hold);
        if (cancelled) return;
        reset();
        await sleep(STEP5_SPEED.afterClear);
      }
    }

    run();
    return () => {
      cancelled = true;
      timers.forEach(clearTimeout);
    };
  }, [started, reduced]);

  return {
    phase,
    sessionId: STEP5_SESSION,
    branch: STEP5_BRANCH,
    scrollback,
    typed,
    running: started && !reduced,
    start,
  };
}
