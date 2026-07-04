'use client';

import { GenericTool } from '@/features/session/tool/generic-tool';
import { ToolError } from '@/features/session/tool/tool-error';
import {
  BasicTool,
  BoundActivateContext,
  partInput,
  shouldShowToolPartInActionsPanel,
  StalePendingContext,
  ToolActivateContext,
  ToolDurationContext,
  ToolNavigationContext,
  ToolRunningContext,
  ToolSurfaceContext,
} from '@/features/session/tool/shared/infrastructure';
import { ToolRegistry } from '@/features/session/tool/shared/registry';
import { QuestionPrompt } from '@/features/session/question-prompt';
import { Button } from '@/components/ui/button';
import { STATUS_TEXT } from '@/components/ui/status';
import { PERMISSION_LABELS, type PermissionRequest, type QuestionRequest, type ToolPart } from '@/ui';
import { CircleAlert } from 'lucide-react';
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';

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

export function ToolPartRenderer({
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
  const fillsPanel = surface === 'panel' && (part.tool === 'show' || part.tool === 'show-user');

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

    return (
      <BoundActivateContext.Provider value={boundActivate}>
        <ToolDurationContext.Provider value={toolDurationMs}>
          <BasicTool
            icon={<CircleAlert />}
            trigger={{
              title: display,
              subtitle: 'failed',
              args: server ? [server] : undefined,
            }}
            badge="error"
          >
            <div className="p-0">
              <ToolError error={errorStr} toolName={part.tool} />
            </div>
          </BasicTool>
        </ToolDurationContext.Provider>
      </BoundActivateContext.Provider>
    );
  }

  const RegisteredComponent = ToolRegistry.get(part.tool);
  const forceOpen = !!permission || !!question;
  const isLocked = !!permission || !!question;

  const isStalePending =
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
    <GenericTool part={part} />
  );

  return (
    <ToolNavigationContext.Provider value={!disableNavigation}>
      <ToolRunningContext.Provider value={isRunning}>
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
      </ToolRunningContext.Provider>
    </ToolNavigationContext.Provider>
  );
}


// Register all tool renderers after ToolPartRenderer is defined (avoids circular imports).
import '@/features/session/tool/tools/register';
