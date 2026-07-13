'use client';

/**
 * `EasyPanel` — the non-technical home for a session's right panel: three
 * promise cards (Progress / Outputs / Context) over the same tool-call data
 * `AdvancedPanel` renders one-at-a-time. Same props shape as `AdvancedPanel`
 * (plus the project ids the file drill-in needs) so `session-layout.tsx` can
 * swap between them freely.
 *
 * Easy mode is chrome-free: no tab strip, no header, no border. The panel IS
 * the three cards. They expand in place and never navigate away from each
 * other — the only thing that ever replaces them is a file opened from
 * Outputs, which has nowhere else to go.
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
import { ContextCard } from './context-card';
import { type Detail, DetailLayer } from './detail-view';
import { deriveIsRunning, shouldAutoExpandOutputs } from './easy-panel-logic';
import { FilePreview } from './file-preview';
import { OutputsCard } from './outputs-card';
import { ProgressCard } from './progress-card';

export const EasyPanel = memo(function EasyPanel({
  sessionId,
  messages,
  projectId,
  projectSessionId,
  isSessionBusy = false,
}: {
  sessionId: string;
  messages: MessageWithParts[] | undefined;
  projectId?: string;
  projectSessionId?: string;
  /** The session's own busy/retry status — see `deriveIsRunning`. */
  isSessionBusy?: boolean;
}) {
  const parts = useMemo(() => collectAllToolParts(messages), [messages]);
  const steps = useMemo(() => groupSteps(parts), [parts]);
  const outputs = useMemo(() => deriveOutputs(parts), [parts]);
  const context = useMemo(() => deriveContext(parts), [parts]);

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
    if (shouldAutoExpandOutputs(wasRunningRef.current, isRunning, outputs.length)) {
      setOutputsDefaultOpen(true);
    }
    wasRunningRef.current = isRunning;
  }, [isRunning, outputs.length]);

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

  // Clicking an output must actually open the file. Easy mode has no tab
  // strip, so flipping the shared panel's `viewBySession` (what
  // `requestFileOpen` also does, as a side effect) would point at a view
  // nothing here renders — worse, it would silently overwrite whatever view
  // Advanced mode had last shown, breaking `session-layout.tsx`'s invariant
  // that Easy mode leaves `viewBySession` untouched so Advanced resumes right
  // where the user left it. This drills into a `SessionFilesExplorer` mounted
  // right here instead, and uses `requestFileOpenSilently` — the same
  // file-open-request nonce, without the `viewBySession` write — so that
  // instance's file-open-request effect actually fires on mount.
  // Opening an output shows THAT FILE — not the file manager. Mounting the
  // whole explorer (tree, search, breadcrumbs, git chips) to display one path
  // the user already named is a filing cabinet in answer to "show me the page".
  const handleOpenOutput = useCallback((output: OutputItem) => {
    if (!output.path) return;
    setDetail({
      key: `file:${output.path}`,
      title: output.name,
      icon: <FileText className="text-muted-foreground size-4 shrink-0" />,
      // The preview brings its own toolbar (view toggle, file name, copy,
      // full screen, close) — the layer's header would just repeat it.
      hideHeader: true,
      padded: false,
      body: (
        <FilePreview
          path={output.path}
          name={output.name}
          onClose={() => setDetail(null)}
        />
      ),
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
          outputs={outputs}
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
      </div>
    </DetailLayer>
  );
});
