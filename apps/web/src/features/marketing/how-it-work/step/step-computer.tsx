'use client';

import { ok, t } from '@/components/home/interactive-demo/cli/terminal';
import { PageHead, Panel, Row } from '@/components/home/interactive-demo/primitives';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import {
  CheckIcon,
  CpuIcon,
  GitBranchIcon,
  HardDrivesIcon,
  TrashIcon,
} from '@phosphor-icons/react';
import { m } from 'motion/react';
import type { ReactNode } from 'react';
import { StepCliTerminal } from '../step-cli-terminal';
import { useCliMovie, type Stage } from '../step-director';
import { useStepShowcaseStart } from '../use-step-showcase';
import { WebPanelWrapper } from '../web-panel-wrapper';

/**
 * One id, three jobs. `apps/api/src/projects/routes/r7.ts` states the invariant
 * outright: `session_id == sandbox_id == git branch name`. So there is no
 * `session/` branch prefix to show — the branch *is* the id.
 */
const SESSION = '7f2a1c94';

type ComputerState = {
  phase: 'idle' | 'booting' | 'running';
  /** Steps already finished inside the box, newest last. */
  done: string[];
  /** What it is doing right now, or null when it has not started. */
  doing: string | null;
};

const INITIAL: ComputerState = { phase: 'idle', done: [], doing: null };

/** `sessions new --prompt` is the real command; `create` is not one. */
const SCRIPT: Stage<ComputerState>[] = [
  {
    run: 'kortix sessions new --prompt "fix the billing webhook retry"',
    out: [
      {
        line: [t('  booting a machine for this session…', 'dim')],
        state: { phase: 'booting' },
        pause: 900,
      },
      {
        line: ok(t('sandbox ready · branch '), t(SESSION, 'faded')),
        state: { phase: 'running', done: ['Machine booted'], doing: 'Cloning the project repo' },
        pause: 800,
      },
      {
        line: [t('  agent working…', 'dim')],
        state: {
          done: ['Machine booted', 'Repo cloned', 'Dependencies installed'],
          doing: 'Running the test suite',
        },
      },
    ],
  },
];

const FACTS = [
  {
    icon: CpuIcon,
    title: 'Its own isolated machine',
    sub: 'booted from your project image, with your tools already on it',
  },
  {
    icon: GitBranchIcon,
    title: SESSION,
    sub: 'the session id, the sandbox id and the branch are one string',
  },
  {
    icon: TrashIcon,
    title: 'Disposable',
    sub: 'the agent can install, run and break anything. Only commits survive',
  },
];

function ComputerView({ state }: { state: ComputerState }): ReactNode {
  const started = state.phase !== 'idle';

  return (
    <div className="flex h-full flex-col">
      <PageHead
        title="Sandbox"
        sub="One session, one computer, one branch."
        action={
          <Badge
            size="sm"
            variant={state.phase === 'running' ? 'success' : 'outline'}
            className="shrink-0 gap-1.5"
          >
            <span
              className={cn(
                'size-1.5 rounded-full',
                state.phase === 'running'
                  ? 'bg-kortix-green animate-pulse'
                  : 'bg-muted-foreground/40',
              )}
            />
            {state.phase === 'running' ? 'running' : started ? 'booting' : 'idle'}
          </Badge>
        }
      />

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
        <Panel title="Session" count={started ? SESSION : '—'}>
          {FACTS.map((fact) => (
            <Row
              key={fact.title}
              leading={
                <span className="border-border bg-background text-muted-foreground flex size-8 items-center justify-center rounded-md border">
                  <fact.icon className="size-4" />
                </span>
              }
              title={<span className="font-mono text-[12.5px]">{fact.title}</span>}
              subtitle={fact.sub}
            />
          ))}
        </Panel>

        <Panel title="Inside the box">
          <div className="space-y-2 px-4 py-3 font-mono text-[11.5px]">
            {!started && <div className="text-muted-foreground">waiting for a session…</div>}

            {state.done.map((step) => (
              <m.div
                key={step}
                initial={{ opacity: 0, x: -4 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ duration: 0.24, ease: 'easeOut' }}
                className="text-muted-foreground flex items-center gap-2"
              >
                <CheckIcon className="text-kortix-green size-3 shrink-0" />
                {step}
              </m.div>
            ))}

            {state.doing && (
              <div className="text-foreground flex items-center gap-2">
                <HardDrivesIcon className="size-3 shrink-0 animate-pulse" />
                {state.doing}…
              </div>
            )}
          </div>
        </Panel>
      </div>
    </div>
  );
}

/** Layer 05 — every session gets its own computer, and its own branch. */
export function StepComputer(): ReactNode {
  const movie = useCliMovie(INITIAL, SCRIPT);
  const rootRef = useStepShowcaseStart(movie.start);

  return (
    <div
      ref={rootRef}
      className="grid h-full w-full grid-cols-1 gap-3 lg:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)]"
    >
      <div className="min-h-0">
        <WebPanelWrapper activeTab="sandbox">
          <ComputerView state={movie.state} />
        </WebPanelWrapper>
      </div>

      <div className="hidden min-h-0 lg:block">
        <StepCliTerminal director={movie} />
      </div>
    </div>
  );
}
