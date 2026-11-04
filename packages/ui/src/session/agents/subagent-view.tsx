'use client';

import { useContext, useEffect } from 'react';

import { useOpenedOnce } from '../../internal/hooks/use-opened-once';
import { lazyClient } from '../../lib/lazy-client';
import { useSessionIds } from '../../providers/session-ids';
import { AgentActivateContext } from '../tool/shared/infrastructure-contexts';
import type { SubagentDialogProps } from './subagent-dialog-content';

export type { SubagentDialogProps, SubagentPanelProps } from './subagent-dialog-content';

// Tool rows, notices and the agents line render this dialog closed on every
// transcript (the marketing home demo too), so its body loads on first open.
const SubagentDialogContent = lazyClient(() =>
  import('./subagent-dialog-content').then((mod) => mod.SubagentDialogContent),
);

/** An agent's session in the side panel (the panel's detail body). Loads on first open. */
export const SubagentPanel = lazyClient(() => import('./subagent-dialog-content').then((mod) => mod.SubagentPanel));

/**
 * THE way to open a session another session started: a sub-agent, a teammate, a
 * workflow agent or runner. Every entry point opens it (the agents line, notice
 * rows, the agent and workflow tool cards, the worker report card).
 *
 * Inside a chat with a side panel, the agent opens there, beside the chat
 * (`AgentActivateContext`), and this dialog never shows. Where there is no panel
 * (a read-only transcript, the agent's own panel, another project's agent) it
 * opens as a dialog.
 */
export function SubagentDialog(props: SubagentDialogProps & { handle?: string; task?: string }) {
  const { open, onOpenChange, sessionId, title, projectId, handle, task, failure } = props;
  const activate = useContext(AgentActivateContext);
  const ids = useSessionIds();
  const inPanel = !!activate && (!projectId || projectId === ids.projectId);

  // One request per open: handing it on closes `open`, so the effect does not fire again.
  useEffect(() => {
    if (!open || !inPanel || !activate) return;
    activate({ sessionId, title: title ?? '', handle: handle ?? '', task: task || undefined, failure: failure || undefined });
    onOpenChange(false);
  }, [open, inPanel, activate, onOpenChange, sessionId, title, handle, task, failure]);

  const opened = useOpenedOnce(open && !inPanel);
  if (!opened || inPanel) return null;
  const { handle: _handle, task: _task, ...dialogProps } = props;
  return <SubagentDialogContent {...dialogProps} />;
}
