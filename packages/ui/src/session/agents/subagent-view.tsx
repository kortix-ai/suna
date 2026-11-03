'use client';

import { useEffect, useLayoutEffect, useRef } from 'react';

import { useIsMobile } from '../../hooks/use-mobile';
import { useOpenedOnce } from '../../internal/hooks/use-opened-once';
import { lazyClient } from '../../lib/lazy-client';
import { useSessionIds } from '../../providers/session-ids';
import { useOptionalSessionPanel, type SessionPanelValue } from '../panel/session-panel-provider';
import type { SubagentDialogProps, SubagentPaneProps } from './subagent-dialog-content';

export type { SubagentDialogProps } from './subagent-dialog-content';

// Tool rows, notices and the agents line render this dialog closed on every
// transcript (the marketing home demo too), so its body loads on first open.
const SubagentDialogContent = lazyClient(() =>
  import('./subagent-dialog-content').then((mod) => mod.SubagentDialogContent),
);
const SubagentPaneContent = lazyClient(() =>
  import('./subagent-dialog-content').then((mod) => mod.SubagentPaneContent),
);

/** One key for every agent: switching agents swaps the body in place, it does not slide a new card in. */
const PANE_KEY = 'agent-pane';

type PaneTarget = Omit<SubagentPaneProps, 'onClose' | 'onNavigate'>;

/** Show one agent in the session's right-hand panel. */
export function openAgentPane(panel: SessionPanelValue, target: PaneTarget) {
  panel.openDetail({
    key: PANE_KEY,
    title: target.title ?? '',
    hideHeader: true,
    padded: false,
    body: (
      <SubagentPaneContent
        {...target}
        onClose={panel.closeDetail}
        onNavigate={(next) => openAgentPane(panel, { ...target, ...next })}
      />
    ),
  });
}

/**
 * THE view of a session another session started: a sub-agent, a teammate, a
 * workflow agent or runner. Every entry point opens this one (the agents line,
 * notice rows, the agent and workflow tool cards, the worker report card).
 *
 * On a session page wide enough for a split, it opens in the right-hand panel
 * beside the lead's chat (`SubagentPaneContent`), and the opener's `open`
 * resets at once: the panel owns it from there. A phone, or a transcript with
 * no session panel (a read-only legacy chat), gets the dialog.
 */
export function SubagentDialog(props: SubagentDialogProps) {
  const panel = useOptionalSessionPanel();
  const mobile = useIsMobile();
  const ids = useSessionIds();
  const projectId = props.projectId ?? ids.projectId ?? undefined;
  const inPane = !!panel && !mobile && !!projectId;
  const latest = useRef({ panel, props, leadSessionId: ids.sessionId ?? undefined });
  // The open effect below reads the newest panel and opener without re-running on their identity.
  useLayoutEffect(() => {
    latest.current = { panel, props, leadSessionId: ids.sessionId ?? undefined };
  });

  useEffect(() => {
    if (!props.open || !inPane || !projectId) return;
    const { panel: current, props: opener, leadSessionId } = latest.current;
    if (!current) return;
    openAgentPane(current, { projectId, sessionId: props.sessionId, title: opener.title, leadSessionId });
    opener.onOpenChange(false);
  }, [props.open, props.sessionId, inPane, projectId]);

  const opened = useOpenedOnce(props.open && !inPane);
  if (inPane || !opened) return null;
  return <SubagentDialogContent {...props} />;
}
