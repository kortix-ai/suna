'use client';

import { Button } from '../../../components/ui/button';
import { SubSessionModal } from '../../sub-session-modal';
import { partInput, partStatus } from '../shared/infrastructure';
import { ToolRegistry } from '../shared/registry';
import {
  SubAgentActivity,
  SubAgentStatusBanner,
  useSubAgentThread,
} from '../shared/sub-agent';
import type { ToolProps } from '../shared/types';
import { useTranslations } from '../../../i18n';
import { cn } from '../../../lib/utils';
import { getChildSessionId, getToolInfo } from '../../../shared/ui';
import { capitalizeWords } from '@kortix/shared';
import { CpuIcon as Cpu, ArrowSquareOutIcon as ExternalLink } from '@phosphor-icons/react';
import { useUiLink, useUiPathname } from '../../../providers/ui-provider';
import { useMemo, useState } from 'react';
import { projectChildSessionHref } from './session-spawn-urls';
import { subAgentCalls } from '@kortix/sdk';

export function SessionSpawnTool({ call, forceOpen }: ToolProps) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const input = partInput(call);
  const status = partStatus(call);
  const pathname = useUiPathname();
  const Link = useUiLink();

  const agentName = capitalizeWords((input.agent as string) || 'kortix');
  const description = (input.description as string) || '';
  const projectName = (input.project as string) || '';
  const fullPrompt = (input.prompt as string) || '';

  const childSessionId: string | undefined = useMemo(() => getChildSessionId(call), [call]);

  const childThread = useSubAgentThread(childSessionId);
  const childCalls = useMemo(() => subAgentCalls(childThread), [childThread]);

  const [modalOpen, setModalOpen] = useState(false);

  const isRunning = status === 'running' || status === 'pending';
  const isCompleted = status === 'completed';
  const childHref = useMemo(
    () => projectChildSessionHref(pathname, childSessionId),
    [pathname, childSessionId],
  );

  const lastActivity = useMemo(() => {
    if (childCalls.length === 0) return null;
    const last = childCalls[childCalls.length - 1];
    const info = getToolInfo(last.name, partInput(last) as Record<string, any>);
    return info.title + (info.subtitle ? ` · ${info.subtitle}` : '');
  }, [childCalls]);

  // The fallback splits the ENTIRE spawn prompt into lines just to read the
  // first one. A spawn prompt is routinely kilobytes, and this sits in the
  // component body, so it ran on every render of a worker row.
  const label = useMemo(
    () => description || projectName || fullPrompt.split('\n')[0]?.slice(0, 80) || '',
    [description, projectName, fullPrompt],
  );

  const subtitle = isRunning ? (lastActivity ?? label) : label || undefined;
  const hasPreview = Boolean(childSessionId);

  const openPreview = () => {
    if (hasPreview) setModalOpen(true);
  };

  return (
    <>
      <div
        data-component="tool-trigger"
        className={cn(
          'group text-muted-foreground/70 flex max-w-full items-center gap-1.5 py-0.5 text-xs transition-colors select-none',
          '[&>span:first-child>svg]:text-muted-foreground/50 [&>span:first-child>svg]:size-3.5',
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
          <span className="shrink-0 whitespace-nowrap">
            {tI18nComplete.raw('text2ee7054bf895')} {agentName}
          </span>
          {subtitle && (
            <span className="text-muted-foreground min-w-0 truncate font-mono text-xs">
              {subtitle}
            </span>
          )}
          {isRunning && (
            <span className="ml-auto size-2 shrink-0 animate-pulse rounded-full bg-current opacity-50" />
          )}
          {isCompleted && childCalls.length > 0 && (
            <span className="text-muted-foreground/60 ml-auto shrink-0 font-mono text-xs whitespace-nowrap">
              {childCalls.length} {tI18nComplete.raw('textb7595e2a8639')}
            </span>
          )}
        </button>
        {childHref && (
          <Button asChild variant="ghost" size="xs" className="h-6 shrink-0 gap-1 px-1.5 text-xs">
            {/* An anchor, not a button: the child session href is known at render
                time, so Next prefetches it and the click never runs a cold RSC
                fetch that could degrade into a full page load. */}
            <Link href={childHref} prefetch>
              {tI18nComplete.raw('textb205bb47f81a')}
              <ExternalLink className="size-3" />
            </Link>
          </Button>
        )}
      </div>
      {forceOpen && childCalls.length > 0 && (
        <SubAgentActivity childSessionId={childSessionId} calls={childCalls} />
      )}
      <SubAgentStatusBanner childSessionId={childSessionId} childThread={childThread} />
      {childSessionId && (
        <SubSessionModal
          open={modalOpen}
          onOpenChange={setModalOpen}
          sessionId={childSessionId}
          title={tI18nComplete('textc65feb0006ea', {
            value0: agentName,
            value1: label ? tI18nComplete('textb581fd88ea24', { value0: label }) : '',
          })}
        />
      )}
    </>
  );
}
ToolRegistry.register('session-spawn', SessionSpawnTool);
ToolRegistry.register('session-start-background', SessionSpawnTool);
