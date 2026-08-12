'use client';

import { useMemo } from 'react';

import type { SessionScopeCommit } from '@/features/session/scope/session-scope-model';
import { useProjectSession } from '@kortix/sdk/react';

import { SessionOverridesToolbar, type SessionOverrideSlot } from './session-overrides-toolbar';

export interface SessionOverridesComposerProps {
  projectId: string;
  sessionId?: string;
  onCommittedDraft?: (commit: SessionScopeCommit | undefined) => void;

  /**
   * The agent this session runs as. NOT rendered as a row — it is the key the
   * scope catalog is fetched under, because secrets and connectors are scoped
   * to what that agent is granted. Drop this and the panel below shows the
   * wrong grant.
   */
  selectedAgent: string | null;

  /**
   * Pre-create only: a live sandbox-template chooser for the session about to
   * be created. Absent for existing sessions, whose environment is fixed.
   */
  sandboxSlot?: SessionOverrideSlot;
}

/**
 * The composer's overrides control — the axes that have NO other home.
 *
 * Agent, model and reasoning effort are deliberately absent. Every one of them
 * is already a first-class control on the composer itself: agent in the
 * under-row (`composer-underbar.tsx`), model and effort in the toolbar inside
 * the card (`composer-toolbar.tsx`). Rendering them here as well gave each axis
 * two live controls one click apart, which is a worse problem than it looks —
 * two surfaces showing the same value means two places to read, two places to
 * mistrust when they appear to disagree mid-render, and a panel whose top half
 * is a restatement of the row directly above it. The panel now carries only
 * what the composer cannot: secrets, connectors, and the sandbox.
 *
 * `SessionOverridesToolbar` carried all three as optional slots; with this, its
 * last caller, no longer passing them, the branches went too rather than
 * sitting there unreachable. Re-adding one is a `SessionOverrideSlot` prop plus
 * a `rows` entry there — `sandboxSlot` is the worked example.
 *
 * It still exists as a separate component so the two composers (the
 * project-home one in `composer-chat-input.tsx` and the in-session one in
 * `session-chat.tsx`) build the panel from one place.
 */
export function SessionOverridesComposer({
  projectId,
  sessionId,
  onCommittedDraft,
  selectedAgent,
  sandboxSlot,
}: SessionOverridesComposerProps) {
  const sessionRow = useProjectSession(projectId, sessionId, { enabled: Boolean(sessionId) });

  const sandbox = useMemo(
    () => ({
      slug: (sessionRow.data?.metadata?.sandbox_slug as string | undefined) ?? null,
      provider: sessionRow.data?.sandbox_provider ?? null,
    }),
    [sessionRow.data?.metadata, sessionRow.data?.sandbox_provider],
  );

  return (
    <SessionOverridesToolbar
      projectId={projectId}
      sessionId={sessionId}
      agentName={selectedAgent ?? undefined}
      onCommittedDraft={onCommittedDraft}
      sandbox={sandbox}
      sandboxSlot={sandboxSlot}
    />
  );
}
