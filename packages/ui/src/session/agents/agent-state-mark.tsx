'use client';

import { CheckIcon } from '@phosphor-icons/react';
import { StatusDot, type StatusTone } from '../../primitives/status';
import { useTranslations } from '../../i18n';
import { cn } from '../../lib/utils';
import type { AgentRowState } from './agent-model';

const DOT_TONE: Record<Exclude<AgentRowState, 'idle' | 'completed'>, StatusTone> = {
  working: 'success',
  needs_input: 'warning',
  failed: 'destructive',
  stopped: 'neutral',
};

/**
 * The state mark of an agent row: the live dot while it works, the attention
 * dot while it waits on the person, a check once its turn ended. The words
 * beside it say the state; the mark repeats it. The agents line and the
 * multi-agent tool cards draw the same mark.
 */
export function AgentStateMark({ state }: { state: AgentRowState }) {
  const t = useTranslations('multiAgent.strip');
  return (
    <span className="flex size-3 shrink-0 items-center justify-center">
      {state === 'idle' || state === 'completed' ? (
        <CheckIcon aria-hidden weight="bold" className="text-kortix-green size-3" />
      ) : (
        <StatusDot
          tone={DOT_TONE[state]}
          pulse={state === 'working'}
          className={cn(state === 'working' && 'motion-reduce:animate-none')}
        />
      )}
      <span className="sr-only">{t(`state.${state}`)}</span>
    </span>
  );
}
