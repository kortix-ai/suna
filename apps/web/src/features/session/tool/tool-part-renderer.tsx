'use client';

import { Button } from '@/components/ui/button';
import { STATUS_TEXT } from '@/components/ui/status';
import { QuestionPrompt } from '@/features/session/question-prompt';
import { GenericTool } from '@/features/session/tool/generic-tool';
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
} from '@/features/session/tool/shared/infrastructure';
import { ToolRegistry } from '@/features/session/tool/shared/registry';
import { ToolError } from '@/features/session/tool/tool-error';
import { cn } from '@/lib/utils';
import {
  PERMISSION_LABELS,
  type PermissionRequest,
  type QuestionRequest,
  type ToolPart,
} from '@/ui';
import { useTranslations } from 'next-intl';
import { memo, useCallback, useContext, useEffect, useMemo, useState } from 'react';

interface PermissionPromptInlineProps {
  permission: PermissionRequest;
  onReply?: (requestId: string, reply: 'once' | 'always' | 'reject') => void;
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
    (reply: 'once' | 'always' | 'reject') => {
      if (replying) return;
      setReplying(true);
      onReply?.(permission.id, reply);
    },
    [replying, permission.id, onReply],
  );

  if (!visible) return null;

  return (
    <div className={cn('flex items-center gap-2 px-2.5 py-2', STATUS_TEXT.warning)}>
      <span className="text-foreground flex-1 text-xs">
        Permission: <span className="font-medium">{label}</span>
      </span>
      <div className="flex items-center gap-1.5">
        <Button
          disabled={replying}
          onClick={() => handleReply('reject')}
          variant="muted"
          size="xs"
          className="hover:text-destructive hover:bg-destructive/10"
        >
          Deny
        </Button>
        <Button
          disabled={replying}
          onClick={() => handleReply('always')}
          variant="outline"
          size="xs"
        >
          {tHardcodedUi.raw('componentsSessionToolRenderers.line8026JsxTextAllowAlways')}
        </Button>
        <Button disabled={replying} onClick={() => handleReply('once')} variant="default" size="xs">
          {tHardcodedUi.raw('componentsSessionToolRenderers.line8034JsxTextAllowOnce')}
        </Button>
      </div>
    </div>
  );
}

interface ToolPartRendererProps {
  part: ToolPart;
  permission?: PermissionRequest;
  question?: QuestionRequest;
  onPermissionReply?: (requestId: string, reply: 'once' | 'always' | 'reject') => void;
  onQuestionReply?: (requestId: string, answers: string[][]) => void;
  onQuestionReject?: (requestId: string) => void;
  defaultOpen?: boolean;
  disableNavigation?: boolean;
}

function ToolPartRendererImpl({
  part,
  sessionId,
  permission,
  question,
  onPermissionReply,
  onQuestionReply,
  onQuestionReject,
  defaultOpen,
  disableNavigation = false,
}: ToolPartRendererProps & { sessionId?: string }) {
  const toolDurationMs = useMemo(() => {
    const s = (part.state as any)?.time?.start;
    const e = (part.state as any)?.time?.end;
    if (typeof s === 'number' && typeof e === 'number' && e > s) return e - s;
    return undefined;
  }, [part.state]);

  const onActivate = useContext(ToolActivateContext);
  const boundActivate = useMemo(
    () => (onActivate ? () => onActivate(part.callID) : null),
    [onActivate, part.callID],
  );

  const surface = useContext(ToolSurfaceContext);
  // Read with the other hooks, ABOVE the `todoread` and thrown-error early
  // returns — a `useContext` down beside its use site is a conditional hook,
  // and the order would break on the first errored tool part in a turn.
  const turnLive = useContext(TurnLiveContext);
  const fillsPanel = surface === 'panel' && (part.tool === 'show' || part.tool === 'show-user');

  // One verdict per part, computed once here and read by every BasicTool below
  // it. See `partOutcome` — a tool that RETURNS its error looks identical to a
  // tool that threw as far as the reader is concerned, so it must look
  // identical on the row too.
  const outcome = useMemo(() => partOutcome(part), [part]);

  if (part.tool === 'todoread') return null;

  if (part.state.status === 'error' && 'error' in part.state) {
    const errorStr = (part.state as { error: string }).error;
    const { display, server } = (() => {
      const slashIdx = part.tool.lastIndexOf('/');
      const s = slashIdx > 0 ? part.tool.slice(0, slashIdx) : null;
      const n = slashIdx > 0 ? part.tool.slice(slashIdx + 1) : part.tool;
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
                subtitle: 'failed',
                args: server ? [server] : undefined,
              }}
              badge="error"
              defaultOpen={defaultOpen}
              forceOpen={!!permission || !!question}
              locked={!!permission || !!question}
            >
              <ToolError error={errorStr} toolName={part.tool} />
            </BasicTool>
          </ToolDurationContext.Provider>
        </ToolOutcomeContext.Provider>
      </BoundActivateContext.Provider>
    );
  }

  const RegisteredComponent = ToolRegistry.get(part.tool);
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
    !turnLive &&
    part.state.status === 'pending' &&
    Object.keys(part.state.input ?? {}).length === 0 &&
    !(part.state as any).raw;

  const isRunning =
    !isStalePending && (part.state.status === 'running' || part.state.status === 'pending');

  const toolElement = RegisteredComponent ? (
    <RegisteredComponent
      part={part}
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
    <GenericTool
      part={part}
      defaultOpen={defaultOpen}
      forceOpen={forceOpen}
      locked={isLocked}
    />
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

// Register all tool renderers after ToolPartRenderer is defined (avoids circular imports).
import '@/features/session/tool/tools/register';

/**
 * The boundary that stops a settled tool row re-rendering with the stream.
 *
 * Everything expensive on a collapsed row lives BELOW this line: `partOutput`'s
 * regex passes, `getToolDiagnostics`, `parseReadOutput`. The disclosure gate
 * protects the child's render, but it protects nothing in the parent that
 * computed the props — so without a boundary here, a fifty-turn transcript
 * re-parses every tool's output on every SSE frame.
 *
 * The default shallow compare is right: `part` objects are replaced, not
 * mutated, when they change; `onPermissionReply` and `onQuestionReply` are
 * `useCallback`s; `permission` is either `undefined` or a store object.
 *
 * `memo` does not block context propagation, so `ToolSurfaceContext`,
 * `ToolActivateContext` and `ToolOutcomeContext` still reach the tool.
 */
export const ToolPartRenderer = memo(ToolPartRendererImpl);
ToolPartRenderer.displayName = 'ToolPartRenderer';
