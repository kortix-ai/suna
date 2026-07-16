'use client';

import { PreWithPaths } from '@/components/common/clickable-path';
import { Badge } from '@/components/ui/badge';
import { StatusDot } from '@/components/ui/status';
import { ToolRegistry } from '@/features/session/tool/shared/registry';
import type { ToolProps } from '@/features/session/tool/shared/types';
import {
  BasicTool,
  isErrorOutput,
  ToolOutputFallback,
  partInput,
  partOutput,
} from '@/features/session/tool/shared/infrastructure';
import {
  Terminal,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import {
  useMemo,
} from 'react';
import {
  stripAnsi,
} from '@/ui';


export function PtyReadTool({ part, defaultOpen, forceOpen, locked }: ToolProps) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const input = partInput(part);
  const output = partOutput(part);

  const parsed = useMemo(() => {
    const match = output.match(/<pty_output\s+([^>]*)>([\s\S]*?)<\/pty_output>/);
    if (!match)
      return {
        id: '',
        ptyStatus: '',
        content: stripAnsi(output),
        bufferInfo: '',
      };

    const attrs = match[1];
    const rawContent = match[2];

    const idMatch = attrs.match(/id="([^"]+)"/);
    const statusMatch = attrs.match(/status="([^"]+)"/);

    const lines = rawContent.trim().split('\n');
    const contentLines: string[] = [];
    let bufferInfo = '';

    for (const line of lines) {
      if (/^\(End of buffer/.test(line.trim())) {
        bufferInfo = line.trim();
        continue;
      }
      contentLines.push(line.replace(/^\d{5}\|\s?/, ''));
    }

    return {
      id: idMatch?.[1] || '',
      ptyStatus: statusMatch?.[1] || '',
      content: stripAnsi(contentLines.join('\n').trim()),
      bufferInfo,
    };
  }, [output]);

  const ptyId = parsed.id || (input.id as string) || '';

  return (
    <BasicTool
      icon={<Terminal className="size-3.5 flex-shrink-0" />}
      trigger={{
        title: tHardcodedUi.raw('componentsSessionToolRenderers.line2624JsxTextTerminalOutput'),
        subtitle: ptyId || undefined,
      }}
      badge={
        parsed.ptyStatus ? (
          <Badge
            variant={parsed.ptyStatus === 'running' ? 'success' : 'muted'}
            size="sm"
            className="gap-1"
          >
            {parsed.ptyStatus === 'running' && <StatusDot tone="success" pulse />}
            {parsed.ptyStatus}
          </Badge>
        ) : undefined
      }
      defaultOpen={defaultOpen}
      forceOpen={forceOpen}
      locked={locked}
    >
      {isErrorOutput(output) ? (
        <ToolOutputFallback output={output} toolName="pty_read" />
      ) : parsed.content ? (
        <div data-scrollable className="max-h-96 overflow-auto">
          <PreWithPaths
            text={parsed.content}
            className="text-foreground/80 px-3 py-2 font-mono text-xs leading-relaxed whitespace-pre-wrap"
          />
          {parsed.bufferInfo && (
            <div className="text-muted-foreground/50 px-3 pb-2 text-xs">{parsed.bufferInfo}</div>
          )}
        </div>
      ) : null}
    </BasicTool>
  );
}
ToolRegistry.register('pty_read', PtyReadTool);

