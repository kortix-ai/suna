'use client';

import { useOpenedOnce } from '../../internal/hooks/use-opened-once';
import { lazyClient } from '../../lib/lazy-client';
import type { SubagentDialogProps } from './subagent-dialog-content';

export type { SubagentDialogProps } from './subagent-dialog-content';

// Tool rows, notices and the agents line render this dialog closed on every
// transcript (the marketing home demo too), so its body loads on first open.
const SubagentDialogContent = lazyClient(() =>
  import('./subagent-dialog-content').then((mod) => mod.SubagentDialogContent),
);

/**
 * THE dialog of a session another session started: a sub-agent, a teammate, a
 * workflow agent or runner. Every entry point opens this one (the agents line,
 * notice rows, the agent and workflow tool cards, the worker report card).
 */
export function SubagentDialog(props: SubagentDialogProps) {
  const opened = useOpenedOnce(props.open);
  if (!opened) return null;
  return <SubagentDialogContent {...props} />;
}
