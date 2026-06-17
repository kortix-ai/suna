'use client';

import {
  cmdLine,
  t,
  type Line,
} from '@/components/home/interactive-demo/cli/terminal';
import { DraggableCliPanel } from '@/components/home/interactive-demo/cli/draggable-cli-panel';
import { motion, useReducedMotion } from 'motion/react';
import { useCallback, useEffect, useState } from 'react';
import { STEP_CLI_PANEL_ANCHOR, StepCliTerminal, type StepCliBlock } from '../step-cli-terminal';
import { useStepShowcaseStart } from '../use-step-showcase';
import { WebPanelWrapper } from '../web-panel-wrapper';

const ASK_PROMPT = 'draft the Monday revenue brief';

const ASK_SPEED = {
  start: 520,
  type: 38,
  afterType: 260,
  afterFlush: 150,
  line: 110,
  afterRead: 520,
  hold: 2800,
  afterClear: 720,
};

const ASK_CMD = `kortix chat --prompt "${ASK_PROMPT}"`;

function askStaticBlocks(): StepCliBlock[] {
  return [
    {
      cmd: cmdLine(ASK_CMD),
      out: [
        [t('coworker reading connected tools…')],
        [t('sources: Stripe · HubSpot · Linear · Slack', 'dim')],
      ],
    },
  ];
}

function useStepAskDirector() {
  const reduced = useReducedMotion();
  const [scrollback, setScrollback] = useState<StepCliBlock[]>([]);
  const [typed, setTyped] = useState('');
  const [started, setStarted] = useState(false);
  const start = useCallback(() => setStarted(true), []);

  useEffect(() => {
    if (!reduced) return;
    setScrollback(askStaticBlocks());
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
      setTyped('');
    };

    async function typeCommand(input: string) {
      for (let i = 1; i <= input.length; i += 1) {
        if (cancelled) return;
        setTyped(input.slice(0, i));
        await sleep(ASK_SPEED.type);
      }
      await sleep(ASK_SPEED.afterType);
      if (cancelled) return;
      setScrollback((prev) => [...prev, { cmd: cmdLine(input), out: [] }]);
      setTyped('');
      await sleep(ASK_SPEED.afterFlush);
    }

    async function run() {
      reset();
      await sleep(ASK_SPEED.start);

      while (!cancelled) {
        await typeCommand(ASK_CMD);
        if (cancelled) return;

        appendLine([t('coworker reading connected tools…')]);
        await sleep(ASK_SPEED.line);
        appendLine([t('sources: Stripe · HubSpot · Linear · Slack', 'dim')]);
        await sleep(ASK_SPEED.afterRead);

        await sleep(ASK_SPEED.hold);
        if (cancelled) return;
        reset();
        await sleep(ASK_SPEED.afterClear);
      }
    }

    run();
    return () => {
      cancelled = true;
      timers.forEach(clearTimeout);
    };
  }, [started, reduced]);

  return {
    scrollback,
    typed,
    running: started && !reduced,
    start,
  };
}

function AskView() {
  return (
    <div className="flex h-full flex-col space-y-3">
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        className="space-y-3"
      >
        <div className="bg-primary/10 text-foreground ml-auto max-w-[85%] rounded-2xl px-3.5 py-2.5 text-sm">
          {ASK_PROMPT}
        </div>
        <div className="text-muted-foreground rounded-lg border border-dashed px-3 py-2 text-xs">
          coworker reading connected tools…
        </div>
        <div className="text-muted-foreground text-xs">sources: Stripe · HubSpot · Linear · Slack</div>
      </motion.div>
    </div>
  );
}

export function StepAskCli() {
  const director = useStepAskDirector();
  const rootRef = useStepShowcaseStart(director.start);

  return (
    <div ref={rootRef} className="relative aspect-19/22 w-full overflow-visible">
      <DraggableCliPanel containerRef={rootRef} initialAnchor={STEP_CLI_PANEL_ANCHOR}>
        {({ dragHandleProps }) => (
          <StepCliTerminal director={director} dragHandleProps={dragHandleProps} />
        )}
      </DraggableCliPanel>

      <WebPanelWrapper activeTab="chat">
        <AskView />
      </WebPanelWrapper>
    </div>
  );
}
