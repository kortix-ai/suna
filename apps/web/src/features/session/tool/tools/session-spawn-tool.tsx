'use client';
import { Button } from '@/components/ui/button';
import { SubSessionModal } from '@/features/session/sub-session-modal';
import { ToolRegistry } from '@/features/session/tool/shared/registry';
import type { ToolProps } from '@/features/session/tool/shared/types';
import {
  partInput,
  partStatus,
} from '@/features/session/tool/shared/infrastructure';
import { SubAgentActivity, SubAgentStatusBanner } from '@/features/session/tool/shared/sub-agent';
import { useOpenCodeMessages } from '@/hooks/opencode/use-opencode-sessions';
import { cn } from '@/lib/utils';
import {
  Cpu,
  ExternalLink,
} from 'lucide-react';
import { usePathname, useRouter } from 'next/navigation';
import {
  useMemo,
  useState,
} from 'react';
import {
  getChildSessionId,
  getChildSessionToolParts,
  getToolInfo,
  type MessageWithParts,
} from '@/ui';
import { projectChildSessionHref } from './session-spawn-urls';

export function SessionSpawnTool({ part, forceOpen }: ToolProps) {
  const input = partInput(part);
  const status = partStatus(part);
  const pathname = usePathname();
  const router = useRouter();

  const agentName = (input.agent as string) || 'kortix';
  const description = (input.description as string) || '';
  const projectName = (input.project as string) || '';
  const fullPrompt = (input.prompt as string) || '';

  const childSessionId: string | undefined = useMemo(() => getChildSessionId(part), [part]);

  const { data: childMessages } = useOpenCodeMessages(childSessionId ?? '');

  const childToolParts = useMemo(() => {
    if (!childMessages) return [];
    return getChildSessionToolParts(childMessages as MessageWithParts[]);
  }, [childMessages]);

  const [modalOpen, setModalOpen] = useState(false);

  const isRunning = status === 'running' || status === 'pending';
  const isCompleted = status === 'completed';
  const childHref = useMemo(
    () => projectChildSessionHref(pathname, childSessionId),
    [pathname, childSessionId],
  );

  const lastActivity = useMemo(() => {
    if (childToolParts.length === 0) return null;
    const last = childToolParts[childToolParts.length - 1];
    const info = getToolInfo(last.tool, partInput(last) as Record<string, any>);
    return info.title + (info.subtitle ? ` · ${info.subtitle}` : '');
  }, [childToolParts]);

  const label = description || projectName || fullPrompt.split('\n')[0]?.slice(0, 80) || '';

  const subtitle = isRunning ? (lastActivity ?? label) : label || undefined;
  const hasPreview = Boolean(childSessionId);

  const openPreview = () => {
    if (hasPreview) setModalOpen(true);
  };

  const openFullSession = () => {
    if (!childHref) return;
    router.push(childHref);
  };

  return (
    <>
      <div
        data-component="tool-trigger"
        className={cn(
          'group flex max-w-full items-center gap-1.5 py-0.5 text-xs text-muted-foreground/70 transition-colors select-none',
          '[&>span:first-child>svg]:size-3.5 [&>span:first-child>svg]:text-muted-foreground/50',
        )}
      >
        <span className="shrink-0">
          <Cpu />
        </span>
        <button
          type="button"
          disabled={!hasPreview}
          onClick={openPreview}
          className={cn(
            'flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden text-left',
            hasPreview ? 'cursor-pointer' : 'cursor-default',
          )}
        >
          <span className="shrink-0 whitespace-nowrap">Worker · {agentName}</span>
          {subtitle && (
            <span className="text-muted-foreground min-w-0 truncate font-mono text-xs">
              {subtitle}
            </span>
          )}
          {isRunning && (
            <span className="ml-auto size-2 shrink-0 animate-pulse rounded-full bg-current opacity-50" />
          )}
          {isCompleted && childToolParts.length > 0 && (
            <span className="text-muted-foreground/60 ml-auto shrink-0 font-mono text-xs whitespace-nowrap">
              {childToolParts.length} steps
            </span>
          )}
        </button>
        {childHref && (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={openFullSession}
            className="h-6 shrink-0 gap-1 px-1.5 text-xs"
          >
            Open session
            <ExternalLink className="size-3" />
          </Button>
        )}
      </div>
      {forceOpen && childToolParts.length > 0 && (
        <SubAgentActivity childSessionId={childSessionId} parts={childToolParts} />
      )}
      <SubAgentStatusBanner childSessionId={childSessionId} childMessages={childMessages} />
      {childSessionId && (
        <SubSessionModal
          open={modalOpen}
          onOpenChange={setModalOpen}
          sessionId={childSessionId}
          title={`Worker · ${agentName}${label ? `: ${label}` : ''}`}
        />
      )}
    </>
  );
}
ToolRegistry.register('session_spawn', SessionSpawnTool);
ToolRegistry.register('session-spawn', SessionSpawnTool);
ToolRegistry.register('oc-session_spawn', SessionSpawnTool);
ToolRegistry.register('oc-session-spawn', SessionSpawnTool);
ToolRegistry.register('session_start_background', SessionSpawnTool);
ToolRegistry.register('session-start-background', SessionSpawnTool);
ToolRegistry.register('oc-session_start_background', SessionSpawnTool);
ToolRegistry.register('oc-session-start-background', SessionSpawnTool);
