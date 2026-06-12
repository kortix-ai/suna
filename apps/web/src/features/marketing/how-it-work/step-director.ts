'use client';

import { cmdLine, meta, ok, t, type Line } from '@/components/home/interactive-demo/cli/terminal';
import type { ProjectCard } from '@/components/home/interactive-demo/types';
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
    [t('  + ', 'faded'), t('kortix.toml')],
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
  afterSecret: 480,
  nav: 320,
  afterConnector: 520,
  hold: 2800,
  afterClear: 720,
};

function step2StaticBlocks(): StepCliBlock[] {
  return [
    {
      cmd: cmdLine('kortix secrets set ANTHROPIC_API_KEY'),
      out: [ok(t('secret stored '), t('(project-scoped, server-side)', 'faded'))],
    },
    {
      cmd: cmdLine('kortix connectors connect linear'),
      out: [ok(t('linear connected '), t('— agents call it as a tool', 'faded'))],
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
    setConnectedProviders(['anthropic.com']);
    setConnectedConnectors(['Linear']);
    setShowCostPanel(true);
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
        setView('models');
        await typeCommand('kortix secrets set ANTHROPIC_API_KEY');
        if (cancelled) return;

        appendLine(ok(t('secret stored '), t('(project-scoped, server-side)', 'faded')));
        await sleep(STEP2_SPEED.line);
        setConnectedProviders(['anthropic.com']);
        setShowCostPanel(true);
        await sleep(STEP2_SPEED.afterSecret);
        if (cancelled) return;

        setView('integrations');
        await sleep(STEP2_SPEED.nav);
        await typeCommand('kortix connectors connect linear');
        if (cancelled) return;

        appendLine(ok(t('linear connected '), t('— agents call it as a tool', 'faded')));
        setConnectedConnectors(['Linear']);
        await sleep(STEP2_SPEED.afterConnector);

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

// ── Step 3 — "Build" ────────────────────────────────────────────────────────

export type Step3Director = {
  showAgent: boolean;
  showSkills: boolean;
  scrollback: StepCliBlock[];
  typed: string;
  running: boolean;
  start: () => void;
};

const STEP3_SPEED = {
  start: 520,
  type: 38,
  afterType: 260,
  afterFlush: 150,
  line: 110,
  afterInfo: 420,
  afterAgent: 520,
  hold: 2800,
  afterClear: 720,
};

function step3StaticBlocks(): StepCliBlock[] {
  return [
    {
      cmd: cmdLine('kortix dev'),
      out: [
        [t('running OpenCode against this project…', 'dim')],
        [t('agents: support-triage · skills: ticket-summary', 'faded')],
      ],
    },
  ];
}

export function useStep3Director(): Step3Director {
  const reduced = useReducedMotion();
  const [showAgent, setShowAgent] = useState(false);
  const [showSkills, setShowSkills] = useState(false);
  const [scrollback, setScrollback] = useState<StepCliBlock[]>([]);
  const [typed, setTyped] = useState('');
  const [started, setStarted] = useState(false);
  const start = useCallback(() => setStarted(true), []);

  useEffect(() => {
    if (!reduced) return;
    setScrollback(step3StaticBlocks());
    setShowAgent(true);
    setShowSkills(true);
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
      setShowAgent(false);
      setShowSkills(false);
      setTyped('');
    };

    async function typeCommand(input: string) {
      for (let i = 1; i <= input.length; i += 1) {
        if (cancelled) return;
        setTyped(input.slice(0, i));
        await sleep(STEP3_SPEED.type);
      }
      await sleep(STEP3_SPEED.afterType);
      if (cancelled) return;
      setScrollback((prev) => [...prev, { cmd: cmdLine(input), out: [] }]);
      setTyped('');
      await sleep(STEP3_SPEED.afterFlush);
    }

    async function run() {
      reset();
      await sleep(STEP3_SPEED.start);

      while (!cancelled) {
        await typeCommand('kortix dev');
        if (cancelled) return;

        appendLine([t('running OpenCode against this project…', 'dim')]);
        await sleep(STEP3_SPEED.line);
        setShowAgent(true);
        await sleep(STEP3_SPEED.afterInfo);
        if (cancelled) return;

        appendLine([t('agents: support-triage · skills: ticket-summary', 'faded')]);
        setShowSkills(true);
        await sleep(STEP3_SPEED.afterAgent);

        await sleep(STEP3_SPEED.hold);
        if (cancelled) return;
        reset();
        await sleep(STEP3_SPEED.afterClear);
      }
    }

    run();
    return () => {
      cancelled = true;
      timers.forEach(clearTimeout);
    };
  }, [started, reduced]);

  return { showAgent, showSkills, scrollback, typed, running: started && !reduced, start };
}

// ── Step 4 — "Ship" ─────────────────────────────────────────────────────────

export type Step4View = 'projects' | 'team';

export type Step4Member = { name: string; email: string; role: string };

export type Step4Director = {
  view: Step4View;
  project: ProjectCard | null;
  members: Step4Member[];
  scrollback: StepCliBlock[];
  typed: string;
  running: boolean;
  start: () => void;
};

const STEP4_PROJECT = 'acme-ops';

const STEP4_BASE_MEMBERS: Step4Member[] = [
  { name: 'marko', email: 'marko@acme.com', role: 'Owner' },
  { name: 'Dom Williams', email: 'dom@acme.com', role: 'Admin' },
];

const STEP4_INVITED: Step4Member = {
  name: 'Team',
  email: 'team@acme.com',
  role: 'Member',
};

const STEP4_SPEED = {
  start: 520,
  type: 38,
  afterType: 260,
  afterFlush: 150,
  line: 110,
  afterShip: 480,
  nav: 320,
  afterInvite: 520,
  hold: 2800,
  afterClear: 720,
};

function step4StaticBlocks(): StepCliBlock[] {
  return [
    {
      cmd: cmdLine('kortix ship'),
      out: [
        ok(t('cloud project created')),
        ok(t('pushed main → origin/main')),
        [t('  live  ', 'dim'), t(`kortix.com/p/${STEP4_PROJECT}`, 'cyan')],
      ],
    },
    {
      cmd: cmdLine('kortix access invite team@acme.com'),
      out: [ok(t('invited '), t('— whole org, one deployment', 'faded'))],
    },
  ];
}

export function useStep4Director(): Step4Director {
  const reduced = useReducedMotion();
  const [view, setView] = useState<Step4View>('projects');
  const [project, setProject] = useState<ProjectCard | null>(null);
  const [members, setMembers] = useState<Step4Member[]>(STEP4_BASE_MEMBERS);
  const [scrollback, setScrollback] = useState<StepCliBlock[]>([]);
  const [typed, setTyped] = useState('');
  const [started, setStarted] = useState(false);
  const start = useCallback(() => setStarted(true), []);

  useEffect(() => {
    if (!reduced) return;
    setScrollback(step4StaticBlocks());
    setView('team');
    setProject({
      name: STEP4_PROJECT,
      status: 'live',
      files: 9,
      branch: 'main',
      repo: `git.kortix.com/acme/${STEP4_PROJECT}`,
      url: `kortix.com/p/${STEP4_PROJECT}`,
    });
    setMembers([STEP4_INVITED, ...STEP4_BASE_MEMBERS]);
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
      setView('projects');
      setProject({
        name: STEP4_PROJECT,
        status: 'draft',
        files: 9,
        branch: 'main',
      });
      setMembers(STEP4_BASE_MEMBERS);
      setTyped('');
    };

    async function typeCommand(input: string) {
      for (let i = 1; i <= input.length; i += 1) {
        if (cancelled) return;
        setTyped(input.slice(0, i));
        await sleep(STEP4_SPEED.type);
      }
      await sleep(STEP4_SPEED.afterType);
      if (cancelled) return;
      setScrollback((prev) => [...prev, { cmd: cmdLine(input), out: [] }]);
      setTyped('');
      await sleep(STEP4_SPEED.afterFlush);
    }

    async function run() {
      reset();
      await sleep(STEP4_SPEED.start);

      while (!cancelled) {
        setView('projects');
        await typeCommand('kortix ship');
        if (cancelled) return;

        setProject((p) => (p ? { ...p, status: 'shipping' } : p));
        await sleep(STEP4_SPEED.line);
        appendLine(ok(t('cloud project created')));
        await sleep(STEP4_SPEED.line);
        appendLine(ok(t('pushed main → origin/main')));
        await sleep(STEP4_SPEED.line);
        appendLine([t('  live  ', 'dim'), t(`kortix.com/p/${STEP4_PROJECT}`, 'cyan')]);
        setProject({
          name: STEP4_PROJECT,
          status: 'live',
          files: 9,
          branch: 'main',
          repo: `git.kortix.com/acme/${STEP4_PROJECT}`,
          url: `kortix.com/p/${STEP4_PROJECT}`,
        });
        await sleep(STEP4_SPEED.afterShip);
        if (cancelled) return;

        setView('team');
        await sleep(STEP4_SPEED.nav);
        await typeCommand('kortix access invite team@acme.com');
        if (cancelled) return;

        appendLine(ok(t('invited '), t('— whole org, one deployment', 'faded')));
        setMembers([STEP4_INVITED, ...STEP4_BASE_MEMBERS]);
        await sleep(STEP4_SPEED.afterInvite);

        await sleep(STEP4_SPEED.hold);
        if (cancelled) return;
        reset();
        await sleep(STEP4_SPEED.afterClear);
      }
    }

    run();
    return () => {
      cancelled = true;
      timers.forEach(clearTimeout);
    };
  }, [started, reduced]);

  return { view, project, members, scrollback, typed, running: started && !reduced, start };
}

// ── Step 5 — "Run" ──────────────────────────────────────────────────────────

export type Step5Phase = 'idle' | 'session' | 'working' | 'cr-open' | 'cr-merged';

export type Step5Director = {
  phase: Step5Phase;
  sessionId: string;
  branch: string;
  crNumber: number;
  scrollback: StepCliBlock[];
  typed: string;
  running: boolean;
  start: () => void;
};

const STEP5_SESSION = 's_7f2a';
const STEP5_BRANCH = 'session/s_7f2a';
const STEP5_CR = 42;
const STEP5_PROMPT = 'triage today\u2019s tickets';

const STEP5_SPEED = {
  start: 520,
  type: 38,
  afterType: 260,
  afterFlush: 150,
  line: 110,
  afterSession: 420,
  afterChat: 680,
  afterCr: 520,
  hold: 2800,
  afterClear: 720,
};

function step5StaticBlocks(): StepCliBlock[] {
  return [
    {
      cmd: cmdLine('kortix sessions create'),
      out: [
        ok(
          t('session '),
          t(STEP5_SESSION, 'fg'),
          t('  · sandbox up · branch '),
          t(STEP5_BRANCH, 'faded'),
        ),
      ],
    },
    {
      cmd: cmdLine(`kortix chat ${STEP5_SESSION} --prompt "${STEP5_PROMPT}"`),
      out: [[t('agent working…', 'dim')]],
    },
    {
      cmd: cmdLine(`kortix cr merge ${STEP5_CR}`),
      out: [ok(t('merged into main'))],
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
    setPhase('cr-merged');
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

        appendLine(
          ok(
            t('session '),
            t(STEP5_SESSION, 'fg'),
            t('  · sandbox up · branch '),
            t(STEP5_BRANCH, 'faded'),
          ),
        );
        setPhase('session');
        await sleep(STEP5_SPEED.afterSession);
        if (cancelled) return;

        await typeCommand(`kortix chat ${STEP5_SESSION} --prompt "${STEP5_PROMPT}"`);
        if (cancelled) return;

        appendLine([t('agent working…', 'dim')]);
        setPhase('working');
        await sleep(STEP5_SPEED.afterChat);
        setPhase('cr-open');
        if (cancelled) return;

        await typeCommand(`kortix cr merge ${STEP5_CR}`);
        if (cancelled) return;

        appendLine(ok(t('merged into main')));
        setPhase('cr-merged');
        await sleep(STEP5_SPEED.afterCr);

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
    crNumber: STEP5_CR,
    scrollback,
    typed,
    running: started && !reduced,
    start,
  };
}

// ── Step 6 — "Own" ──────────────────────────────────────────────────────────

export type Step6Host = 'managed' | 'local' | 'my-vpc' | 'on-prem' | 'air-gapped';

export type Step6Director = {
  activeHost: Step6Host;
  dockerRunning: boolean;
  scrollback: StepCliBlock[];
  typed: string;
  running: boolean;
  start: () => void;
};

const STEP6_SPEED = {
  start: 520,
  type: 38,
  afterType: 260,
  afterFlush: 150,
  line: 110,
  afterInit: 480,
  afterHost: 520,
  hold: 2800,
  afterClear: 720,
};

function step6StaticBlocks(): StepCliBlock[] {
  return [
    {
      cmd: cmdLine('kortix self-host init'),
      out: [ok(t('Kortix Cloud running locally '), t('(docker)', 'faded'))],
    },
    {
      cmd: cmdLine('kortix hosts use my-vpc'),
      out: [ok(t('switched host → '), t('my-vpc', 'fg'))],
    },
  ];
}

export function useStep6Director(): Step6Director {
  const reduced = useReducedMotion();
  const [activeHost, setActiveHost] = useState<Step6Host>('managed');
  const [dockerRunning, setDockerRunning] = useState(false);
  const [scrollback, setScrollback] = useState<StepCliBlock[]>([]);
  const [typed, setTyped] = useState('');
  const [started, setStarted] = useState(false);
  const start = useCallback(() => setStarted(true), []);

  useEffect(() => {
    if (!reduced) return;
    setScrollback(step6StaticBlocks());
    setDockerRunning(true);
    setActiveHost('my-vpc');
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
      setActiveHost('managed');
      setDockerRunning(false);
      setTyped('');
    };

    async function typeCommand(input: string) {
      for (let i = 1; i <= input.length; i += 1) {
        if (cancelled) return;
        setTyped(input.slice(0, i));
        await sleep(STEP6_SPEED.type);
      }
      await sleep(STEP6_SPEED.afterType);
      if (cancelled) return;
      setScrollback((prev) => [...prev, { cmd: cmdLine(input), out: [] }]);
      setTyped('');
      await sleep(STEP6_SPEED.afterFlush);
    }

    async function run() {
      reset();
      await sleep(STEP6_SPEED.start);

      while (!cancelled) {
        await typeCommand('kortix self-host init');
        if (cancelled) return;

        appendLine(ok(t('Kortix Cloud running locally '), t('(docker)', 'faded')));
        setDockerRunning(true);
        setActiveHost('local');
        await sleep(STEP6_SPEED.afterInit);
        if (cancelled) return;

        await typeCommand('kortix hosts use my-vpc');
        if (cancelled) return;

        appendLine(ok(t('switched host → '), t('my-vpc', 'fg')));
        setActiveHost('my-vpc');
        await sleep(STEP6_SPEED.afterHost);

        await sleep(STEP6_SPEED.hold);
        if (cancelled) return;
        reset();
        await sleep(STEP6_SPEED.afterClear);
      }
    }

    run();
    return () => {
      cancelled = true;
      timers.forEach(clearTimeout);
    };
  }, [started, reduced]);

  return {
    activeHost,
    dockerRunning,
    scrollback,
    typed,
    running: started && !reduced,
    start,
  };
}
