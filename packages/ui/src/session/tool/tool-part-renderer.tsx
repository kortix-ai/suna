'use client';

import { Button } from '../../primitives/button';
import { STATUS_TEXT } from '../../primitives/status';
import { QuestionPrompt } from '../prompts/question-prompt';
import { GenericTool } from './generic-tool';
import {
  BasicTool,
  BoundActivateContext,
  partOutcome,
  StalePendingContext,
  ToolActivateContext,
  ToolDurationContext,
  ToolNavigationContext,
  ToolOutcomeContext,
  ToolRunningContext,
  ToolSurfaceContext,
  TurnLiveContext,
} from './shared/infrastructure';
import { ToolRegistry } from './shared/registry';
import { ToolError } from './tool-error';
import { type InlinePermissionReply, replyToInlinePermission } from './inline-permission-reply';
import { errorToast } from '../../primitives/toast';
import { cn } from '../../lib/utils';
import { partError, partStreamingInput } from './shared/infrastructure-parts';
import {
  PERMISSION_LABELS,
  type PermissionRequest,
  type QuestionRequest,
  getChildSessionId,
  shouldShowToolPart,
} from '../../internal/session-types';
import { sessionLogCallStatus, sessionLogOpenCall, toolKind, type ToolCallBlock } from '@kortix/sdk';
import { useTranslations } from '../../i18n';
import { memo, useCallback, useContext, useEffect, useMemo, useState } from 'react';

interface PermissionPromptInlineProps {
  permission: PermissionRequest;
  onReply?: (requestId: string, reply: InlinePermissionReply) => Promise<void> | void;
}

function PermissionPromptInline({ permission, onReply }: PermissionPromptInlineProps) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const [visible, setVisible] = useState(false);
  const [replying, setReplying] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setVisible(true), 50);
    return () => clearTimeout(timer);
  }, []);

  const label = PERMISSION_LABELS[permission.permission] || permission.permission;

  const handleReply = useCallback(
    async (reply: InlinePermissionReply) => {
      if (replying) return;
      setReplying(true);
      // The card disappears once the runtime accepts; a refusal re-enables it.
      const accepted = await replyToInlinePermission(onReply, permission.id, reply, (error) =>
        errorToast(error instanceof Error ? error.message : String(error)),
      );
      if (!accepted) setReplying(false);
    },
    [replying, permission.id, onReply],
  );

  if (!visible) return null;

  return (
    <div className={cn('flex items-center gap-2 px-2.5 py-2', STATUS_TEXT.warning)}>
      <span className="text-foreground flex-1 text-xs">
        {tHardcodedUi.raw('i18nComplete.text5427e0ef4eba')}{' '}
        <span className="font-medium">{label}</span>
      </span>
      <div className="flex items-center gap-1.5">
        <Button
          disabled={replying}
          onClick={() => void handleReply('reject')}
          variant="muted"
          size="xs"
          className="hover:text-destructive hover:bg-destructive/10"
        >
          {tHardcodedUi.raw('i18nComplete.text05a2d7332eb9')}
        </Button>
        <Button
          disabled={replying}
          onClick={() => void handleReply('always')}
          variant="outline"
          size="xs"
        >
          {tHardcodedUi.raw('componentsSessionToolRenderers.line8026JsxTextAllowAlways')}
        </Button>
        <Button disabled={replying} onClick={() => void handleReply('once')} variant="default" size="xs">
          {tHardcodedUi.raw('componentsSessionToolRenderers.line8034JsxTextAllowOnce')}
        </Button>
      </div>
    </div>
  );
}

interface ToolPartRendererProps {
  /**
   * The session-log tool call. A caller that still holds a v1 part (a child
   * session's rows) passes `toolCallBlock(part)`. A closure-rule block is read
   * open (`sessionLogOpenCall`), so a dead call renders the same on v1 and v2.
   */
  call: ToolCallBlock;
  permission?: PermissionRequest;
  question?: QuestionRequest;
  onPermissionReply?: (requestId: string, reply: InlinePermissionReply) => Promise<void> | void;
  onQuestionReply?: (requestId: string, answers: string[][]) => void;
  onQuestionReject?: (requestId: string) => void;
  defaultOpen?: boolean;
  disableNavigation?: boolean;
}

function ToolPartRendererImpl({
  call: given,
  sessionId,
  permission,
  question,
  onPermissionReply,
  onQuestionReply,
  onQuestionReject,
  defaultOpen,
  disableNavigation = false,
}: ToolPartRendererProps & { sessionId?: string }) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  // One open block per call object (`sessionLogOpenCall` caches it), so the memos
  // below and the renderers' own memos hold while the call is unchanged.
  const call = sessionLogOpenCall(given);
  const toolDurationMs = useMemo(() => {
    const s = call.started_at ? Date.parse(call.started_at) : undefined;
    const e = call.ended_at ? Date.parse(call.ended_at) : undefined;
    if (typeof s === 'number' && typeof e === 'number' && e > s) return e - s;
    return undefined;
  }, [call]);

  const onActivate = useContext(ToolActivateContext);
  const boundActivate = useMemo(
    () => (onActivate ? () => onActivate(call.call_id) : null),
    [onActivate, call.call_id],
  );

  const surface = useContext(ToolSurfaceContext);
  // Read with the other hooks, ABOVE the hidden-tool and thrown-error early
  // returns — a `useContext` down beside its use site is a conditional hook,
  // and the order would break on the first errored tool part in a turn.
  const turnLive = useContext(TurnLiveContext);
  const fillsPanel = surface === 'panel' && (call.name === 'show' || call.name === 'show-user');

  // One verdict per part, computed once here and read by every BasicTool below
  // it. See `partOutcome` — a tool that RETURNS its error looks identical to a
  // tool that threw as far as the reader is concerned, so it must look
  // identical on the row too.
  const outcome = useMemo(() => partOutcome(call), [call]);

  // The SDK's verdict on tools that never render (a todo read, context bookkeeping).
  if (!shouldShowToolPart(call)) return null;

  // A failed `task` dispatch is still a dispatch. OpenCode keeps the child
  // session alive through the failure (its id rides the part's
  // `state.metadata.sessionId`, or the `task_id:` sentence in the error), so
  // the row must stay a dispatch row — TaskTool's "Open full view" affordance
  // and the child's transcript. Collapsing it into the generic error card
  // below left the child thread unopenable from the session UI, which is
  // exactly what a failed subagent looked like to a reader (KRTX-1746).
  // TaskTool draws `state.error` itself, so the failure reason stays on the
  // row too. Only the task tool takes this route: the other errored tools have
  // no child thread to lose, and the generic card is the only renderer that
  // shows the error text of a tool that does not draw it itself.
  const errorStr = partError(call);
  const childBearingTaskError =
    errorStr !== undefined && toolKind(call.name) === 'task' && Boolean(getChildSessionId(call));
  // A failed codemode script keeps its partial output and the calls it made before
  // the failure: its own row draws them, with the error.
  const drawsOwnError = childBearingTaskError || call.name === 'codemode';

  if (errorStr !== undefined && !drawsOwnError) {
    const { display, server } = (() => {
      const slashIdx = call.name.lastIndexOf('/');
      const s = slashIdx > 0 ? call.name.slice(0, slashIdx) : null;
      const n = slashIdx > 0 ? call.name.slice(slashIdx + 1) : call.name;
      const d = n.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
      return { display: d, server: s };
    })();

    // No `icon` prop: the outcome context supplies the same warning triangle a
    // tool that returned its error gets. A thrown call and a returned error are
    // the same event to the reader, so they must not be two different marks.
    //
    // `defaultOpen`/`forceOpen` are threaded for the same reason every other
    // branch threads them: the panel surface is a disclosure now, and the one
    // thing nobody wants behind a closed row is the error that explains the
    // failure. This branch used to drop both, so an errored call painted shut
    // on the very surface (Advanced, a single-call detail) whose whole job is
    // showing it.
    return (
      <BoundActivateContext.Provider value={boundActivate}>
        <ToolOutcomeContext.Provider value={outcome}>
          <ToolDurationContext.Provider value={toolDurationMs}>
            <BasicTool
              trigger={{
                title: display,
                subtitle: tI18nComplete.raw('text5d28a90f4498'),
                args: server ? [server] : undefined,
              }}
              badge="error"
              defaultOpen={defaultOpen}
              forceOpen={!!permission || !!question}
              locked={!!permission || !!question}
            >
              <ToolError error={errorStr} toolName={call.name} />
            </BasicTool>
          </ToolDurationContext.Provider>
        </ToolOutcomeContext.Provider>
      </BoundActivateContext.Provider>
    );
  }

  const RegisteredComponent = ToolRegistry.get(call.name, call.kind);
  const forceOpen = !!permission || !!question;
  const isLocked = !!permission || !!question;

  // A call whose arguments have not arrived: `pending`, no `input`, no streamed
  // `raw`. That shape is produced twice — once by a leftover part from a run
  // that died, and once by every live call, for the frames between "the call
  // exists" and "its first argument chunk landed".
  //
  // `turnLive` is what separates them, and nothing on the part can (see
  // {@link TurnLiveContext}). Without it this test matched the live case too,
  // so a `write` that had just started rendered its "the run is over" body —
  // the frozen-looking row under a status line that was still saying
  // "Making changes...".
  const isStalePending =
    sessionLogCallStatus(call, turnLive) === 'interrupted' &&
    call.status === 'pending' &&
    Object.keys(partStreamingInput(call)).length === 0;

  const isRunning = !isStalePending && (call.status === 'running' || call.status === 'pending');

  const toolElement = RegisteredComponent ? (
    <RegisteredComponent
      call={call}
      sessionId={sessionId}
      defaultOpen={defaultOpen}
      forceOpen={forceOpen}
      locked={isLocked}
      hasActiveQuestion={!!question}
      onPermissionReply={onPermissionReply}
    />
  ) : (
    // Same four props the registered branch above gets. `GenericTool` is the
    // fallback for every unregistered/MCP tool, and dropping them left that
    // whole class of call permanently closed and unopenable on the panel — the
    // one surface where a single call IS the view.
    <GenericTool call={call} defaultOpen={defaultOpen} forceOpen={forceOpen} locked={isLocked} />
  );

  return (
    <ToolNavigationContext.Provider value={!disableNavigation}>
      <ToolRunningContext.Provider value={isRunning}>
        <ToolOutcomeContext.Provider value={outcome}>
          <ToolDurationContext.Provider value={toolDurationMs}>
            <StalePendingContext.Provider value={isStalePending}>
              <BoundActivateContext.Provider value={boundActivate}>
                <div className={cn('relative', fillsPanel && 'h-full')}>
                  {toolElement}

                  {permission && onPermissionReply && (
                    <div className="mt-1.5">
                      <PermissionPromptInline permission={permission} onReply={onPermissionReply} />
                    </div>
                  )}

                  {question && onQuestionReply && onQuestionReject && (
                    <div className="mt-1.5">
                      <QuestionPrompt
                        request={question}
                        onReply={onQuestionReply}
                        onReject={onQuestionReject}
                      />
                    </div>
                  )}
                </div>
              </BoundActivateContext.Provider>
            </StalePendingContext.Provider>
          </ToolDurationContext.Provider>
        </ToolOutcomeContext.Provider>
      </ToolRunningContext.Provider>
    </ToolNavigationContext.Provider>
  );
}

/**
 * The boundary that stops a settled tool row re-rendering with the stream.
 *
 * Everything expensive on a collapsed row lives BELOW this line: `partOutput`'s
 * regex passes, `getToolDiagnostics`, `parseReadOutput`. The disclosure gate
 * protects the child's render, but it protects nothing in the parent that
 * computed the props — so without a boundary here, a fifty-turn transcript
 * re-parses every tool's output on every SSE frame.
 *
 * The default shallow compare is right: `call` objects are replaced, not
 * mutated, when they change; `onPermissionReply` and `onQuestionReply` are
 * `useCallback`s; `permission` is either `undefined` or a store object.
 *
 * `memo` does not block context propagation, so `ToolSurfaceContext`,
 * `ToolActivateContext` and `ToolOutcomeContext` still reach the tool.
 */
export const ToolPartRenderer = memo(ToolPartRendererImpl);
ToolPartRenderer.displayName = 'ToolPartRenderer';
