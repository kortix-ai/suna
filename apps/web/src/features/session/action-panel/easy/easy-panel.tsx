'use client';

/**
 * `EasyPanel` — the non-technical home for a session's right panel: three
 * promise cards (Progress / Outputs / Context) over the same tool-call data
 * `AdvancedPanel` renders one-at-a-time. Same props shape as `AdvancedPanel`
 * (plus the project ids the file drill-in needs) so `session-layout.tsx` can
 * swap between them freely.
 *
 * Owns three views, swapped in place (no tab strip — Easy mode never shows
 * one):
 *   - `home` — the three cards.
 *   - `progress` — the plain-language step list (`ProgressView`).
 *   - `file` — a single output opened for viewing, back button included,
 *     built the same way as the Progress drill-in.
 *
 * Must use `collectAllToolParts`, not `collectToolParts`: the latter strips
 * `read`/`skill` parts, which is correct for Advanced's one-at-a-time
 * stepper but would silently empty out Easy mode's "Read N files" narration
 * and the Context card's "Files read" bucket.
 */

import { Button } from '@/components/ui/button';
import { useClearFocusedToolCall, useFocusedToolCallId } from '@/stores/kortix-computer-store';
import { useSessionBrowserStore } from '@/stores/session-browser-store';
import type { MessageWithParts } from '@/ui';
import { ChevronLeft } from 'lucide-react';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { SessionFilesExplorer } from '../../session-files-explorer';
import { collectAllToolParts } from '../shared/collect-tool-parts';
import { deriveContext, deriveOutputs, type OutputItem } from '../shared/derive-panels';
import { groupSteps } from '../shared/group-steps';
import { ContextCard } from './context-card';
import { shouldAutoExpandOutputs } from './easy-panel-logic';
import { OutputsCard } from './outputs-card';
import { ProgressCard } from './progress-card';
import { ProgressView } from './progress-view';

type EasyView = { kind: 'home' } | { kind: 'progress' } | { kind: 'file'; output: OutputItem };

export const EasyPanel = memo(function EasyPanel({
  sessionId,
  messages,
  projectId,
  projectSessionId,
}: {
  sessionId: string;
  messages: MessageWithParts[] | undefined;
  projectId?: string;
  projectSessionId?: string;
}) {
  const parts = useMemo(() => collectAllToolParts(messages), [messages]);
  const steps = useMemo(() => groupSteps(parts), [parts]);
  const outputs = useMemo(() => deriveOutputs(parts), [parts]);
  const context = useMemo(() => deriveContext(parts), [parts]);

  const isRunning = steps.some((s) => s.status === 'running');

  const [view, setView] = useState<EasyView>({ kind: 'home' });
  const [focusStepId, setFocusStepId] = useState<string | undefined>();

  // Auto-expand Outputs the moment a run finishes with something to show —
  // never on every render of an already-finished (or still-running) run.
  const wasRunningRef = useRef(isRunning);
  const [outputsDefaultOpen, setOutputsDefaultOpen] = useState(false);
  useEffect(() => {
    if (shouldAutoExpandOutputs(wasRunningRef.current, isRunning, outputs.length)) {
      setOutputsDefaultOpen(true);
    }
    wasRunningRef.current = isRunning;
  }, [isRunning, outputs.length]);

  // A tool call clicked in the chat transcript drills straight into Progress
  // at that step, expanded.
  const focusedToolCallId = useFocusedToolCallId();
  const clearFocusedToolCall = useClearFocusedToolCall();
  useEffect(() => {
    if (!focusedToolCallId) return;
    const step = steps.find((s) => s.parts.some((p) => p.callID === focusedToolCallId));
    if (step) {
      setFocusStepId(step.id);
      setView({ kind: 'progress' });
    }
    clearFocusedToolCall();
  }, [focusedToolCallId, steps, clearFocusedToolCall]);

  // Clicking an output must actually open the file. Easy mode has no tab
  // strip, so flipping the shared panel's `viewBySession` (what
  // `requestFileOpen` also does, as a side effect) would point at a view
  // nothing here renders — this drills into a `SessionFilesExplorer`
  // mounted right here instead, and still issues the real `requestFileOpen`
  // so that instance's file-open-request effect actually fires on mount.
  const requestFileOpen = useSessionBrowserStore((s) => s.requestFileOpen);
  const handleOpenOutput = (output: OutputItem) => {
    if (!output.path) return;
    requestFileOpen(sessionId, output.path);
    setView({ kind: 'file', output });
  };

  const goHome = () => {
    setView({ kind: 'home' });
    setFocusStepId(undefined);
  };

  if (view.kind === 'progress') {
    return (
      <ProgressView steps={steps} sessionId={sessionId} focusStepId={focusStepId} onBack={goHome} />
    );
  }

  if (view.kind === 'file') {
    return (
      <div className="flex h-full min-w-0 flex-col">
        <div className="border-border flex shrink-0 items-center gap-1 border-b px-2 py-1.5">
          <Button
            variant="ghost"
            size="icon"
            onClick={goHome}
            aria-label="Back"
            className="hit-area-2 active:scale-[0.96]"
          >
            <ChevronLeft className="size-4" />
          </Button>
          <span className="text-foreground truncate text-sm font-semibold">{view.output.name}</span>
        </div>
        <div className="min-h-0 min-w-0 flex-1">
          <SessionFilesExplorer
            chatSessionId={sessionId}
            projectId={projectId}
            projectSessionId={projectSessionId}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col gap-3 overflow-auto p-3">
      <ProgressCard
        steps={steps}
        isRunning={isRunning}
        onOpen={() => setView({ kind: 'progress' })}
      />
      <OutputsCard
        outputs={outputs}
        defaultExpanded={outputsDefaultOpen}
        onOpenOutput={handleOpenOutput}
      />
      <ContextCard files={context.files} web={context.web} tools={context.tools} />
    </div>
  );
});
