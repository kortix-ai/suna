'use client';

/**
 * `EasyPanel` — the non-technical home for a session's right panel: three
 * promise cards (Progress / Outputs / Context) over the same tool-call data
 * `AdvancedPanel` renders one-at-a-time. Same props shape as `AdvancedPanel`
 * (plus the session's busy flag) so `session-layout.tsx` can swap between them
 * freely.
 *
 * Easy mode is chrome-free: no tab strip, no header, no border. The panel IS
 * the three cards. They expand in place and never navigate away from each
 * other — the only thing that ever replaces them is a detail (a step's tool
 * views, a Context group, a file, a running app), and the panel owns that,
 * because a card cannot replace its own parent.
 *
 * Must use `collectAllToolParts`, not `collectToolParts`: the latter strips
 * `read`/`skill` parts, which is correct for Advanced's one-at-a-time
 * stepper but would silently empty out Easy mode's "Read N files" narration
 * and the Context card's "Files read" bucket.
 */

import { useIsMobile } from '@/hooks/utils';
import { useClearFocusedToolCall, useFocusedToolCallId } from '@/stores/kortix-computer-store';
import type { MessageWithParts } from '@/ui';
import { FileText } from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { collectAllToolParts } from '../shared/collect-tool-parts';
import { deriveContext, deriveOutputs, type OutputItem } from '../shared/derive-panels';
import { groupSteps } from '../shared/group-steps';
import { sortOutputs } from '../shared/output-priority';
import { AppPreview } from './app-preview';
import { ContextCard } from './context-card';
import { type Detail, DetailLayer } from './detail-view';
import { deriveIsRunning, shouldAutoExpandOutputs } from './easy-panel-logic';
import { FilePreview } from './file-preview';
import { AppsCard } from './apps-card';
import { OutputsCard } from './outputs-card';
import { ProgressCard } from './progress-card';

export const EasyPanel = memo(function EasyPanel({
  sessionId,
  messages,
  isSessionBusy = false,
}: {
  sessionId: string;
  messages: MessageWithParts[] | undefined;
  /** The session's own busy/retry status — see `deriveIsRunning`. */
  isSessionBusy?: boolean;
}) {
  const parts = useMemo(() => collectAllToolParts(messages), [messages]);
  const steps = useMemo(() => groupSteps(parts), [parts]);
  const outputs = useMemo(() => deriveOutputs(parts), [parts]);
  const context = useMemo(() => deriveContext(parts), [parts]);

  // A running app is not "one of" the outputs — it's the thing the user asked
  // for, and a list flattens it into row 13 of 13 under a dozen .tsx files they
  // never wanted. It gets its own card; Outputs keeps the files.
  const apps = useMemo(() => outputs.filter((o) => o.kind === 'app'), [outputs]);
  // Sorted, not filtered: everything the agent produced is still here, but the
  // report leads and the twelve files it took to build the report follow. See
  // `sortOutputs` — chronological order buries the answer under its scaffolding.
  const files = useMemo(
    () => sortOutputs(outputs.filter((o) => o.kind !== 'app')),
    [outputs],
  );

  // Part-derived alone flickers between tool calls (assistant text streams
  // with no part running/pending) — OR it with the session's own status so
  // Outputs only auto-expands at the real finish, and Progress's
  // shimmer/subtitle don't flicker at every tool boundary. See `deriveIsRunning`.
  const isRunning = deriveIsRunning(
    steps.some((s) => s.status === 'running'),
    isSessionBusy,
  );

  const isMobile = useIsMobile();

  // The panel owns the detail, because on desktop the detail REPLACES the
  // cards — a card can't replace its own parent. Opening a file is just
  // another detail, so Back behaves identically wherever you came from.
  const [detail, setDetail] = useState<Detail | null>(null);
  const [focusStepId, setFocusStepId] = useState<string | undefined>();

  // Auto-expand Outputs the moment a run finishes with something to show —
  // never on every render of an already-finished (or still-running) run.
  const wasRunningRef = useRef(isRunning);
  const [outputsDefaultOpen, setOutputsDefaultOpen] = useState(false);
  useEffect(() => {
    if (shouldAutoExpandOutputs(wasRunningRef.current, isRunning, files.length)) {
      setOutputsDefaultOpen(true);
    }
    wasRunningRef.current = isRunning;
  }, [isRunning, files.length]);

  // A tool call clicked in the chat transcript opens the Progress card with
  // that step's real tool view already expanded.
  const focusedToolCallId = useFocusedToolCallId();
  const clearFocusedToolCall = useClearFocusedToolCall();
  useEffect(() => {
    if (!focusedToolCallId) return;
    const step = steps.find((s) => s.parts.some((p) => p.callID === focusedToolCallId));
    if (step) setFocusStepId(step.id);
    clearFocusedToolCall();
  }, [focusedToolCallId, steps, clearFocusedToolCall]);

  /**
   * Opening an output shows the THING, not the machinery around it: a running
   * app opens as the app, a file opens as that one file — never the file
   * manager, which is a filing cabinet in answer to "show me the page".
   *
   * Both bring their own toolbar, so the layer's header is suppressed for both
   * (one bar, not two), and both fill the pane, so neither takes the layer's
   * padding.
   */
  const handleOpenOutput = useCallback((output: OutputItem) => {
    if (output.kind === 'app' && output.url) {
      setDetail({
        key: `app:${output.url}`,
        title: output.name,
        hideHeader: true,
        padded: false,
        body: <AppPreview url={output.url} name={output.name} onClose={() => setDetail(null)} />,
      });
      return;
    }

    if (!output.path) return;
    setDetail({
      key: `file:${output.path}`,
      title: output.name,
      icon: <FileText className="text-muted-foreground size-4 shrink-0" />,
      hideHeader: true,
      padded: false,
      body: <FilePreview path={output.path} name={output.name} onClose={() => setDetail(null)} />,
    });
  }, []);

  const goHome = useCallback(() => {
    setDetail(null);
    setFocusStepId(undefined);
  }, []);

  return (
    <DetailLayer detail={detail} onBack={goHome} isMobile={isMobile}>
      <div className="flex h-full flex-col gap-3 overflow-auto p-3">
        <ProgressCard
          steps={steps}
          sessionId={sessionId}
          isRunning={isRunning}
          focusStepId={focusStepId}
          onOpenDetail={setDetail}
          onCloseDetail={goHome}
        />
        <OutputsCard
          outputs={files}
          defaultExpanded={outputsDefaultOpen}
          onOpenOutput={handleOpenOutput}
        />
        <ContextCard
          files={context.files}
          web={context.web}
          tools={context.tools}
          sessionId={sessionId}
          onOpenDetail={setDetail}
        />
        {apps.length > 0 && <AppsCard apps={apps} onOpenApp={handleOpenOutput} />}
      </div>
    </DetailLayer>
  );
});
