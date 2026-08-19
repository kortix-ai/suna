'use client';

import { PreWithPaths } from '@/components/common/clickable-path';
import { Badge } from '@/components/ui/badge';
import { StatusDot } from '@/components/ui/status';
import {
  BasicTool,
  isErrorOutput,
  partInput,
  partOutput,
  ToolOutputFallback,
} from '@/features/session/tool/shared/infrastructure';
import { FoldedSection } from '@/features/session/tool/shared/output-block';
import { ToolRegistry } from '@/features/session/tool/shared/registry';
import { ToolResultCard } from '@/features/session/tool/shared/result-card';
import type { ToolProps } from '@/features/session/tool/shared/types';
import { stripAnsi } from '@/ui';
import { TerminalWindowIcon as Terminal } from '@phosphor-icons/react';
import { useTranslations } from 'next-intl';
import { useMemo } from 'react';

/**
 * How much of the terminal buffer stays on screen unasked.
 *
 * 24 lines is the classic terminal height and, in practice, everything a
 * command's outcome needs: the prompt that ran, its result, the next prompt.
 */
const VISIBLE_TAIL_LINES = 24;

/**
 * The terminal buffer split into the part that stays on screen and the part
 * that folds.
 *
 * A terminal reads bottom-up: the newest output is the answer and the
 * scrollback above it is context you ask for. Capping the buffer again is not
 * an option — the cap this file used to carry was `data-scrollable max-h-96`,
 * and the Easy panel removes every `data-scrollable` height it contains
 * (`detail-view.tsx`) so that the detail's own container is the only scroller.
 * Re-adding that wrapper would change nothing on the surface where the wall
 * actually appears, while re-creating inline the nested-scroll wheel trap the
 * comment further down records. Folding works on both surfaces: the tail stays
 * visible, the history is one click away, and no second scroller is created.
 */
export function splitTerminalBuffer(content: string): {
  earlier: string;
  tail: string;
  earlierCount: number;
} {
  const lines = content ? content.split('\n') : [];
  if (lines.length <= VISIBLE_TAIL_LINES) return { earlier: '', tail: content, earlierCount: 0 };

  const cut = lines.length - VISIBLE_TAIL_LINES;
  return {
    earlier: lines.slice(0, cut).join('\n'),
    tail: lines.slice(cut).join('\n'),
    earlierCount: cut,
  };
}

export function PtyReadTool({ part, defaultOpen, forceOpen, locked }: ToolProps) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const input = partInput(part);
  const output = partOutput(part);

  const parsed = useMemo(() => {
    const match = output.match(/<pty_output\s+([^>]*)>([\s\S]*?)<\/pty_output>/);
    if (!match) {
      const content = stripAnsi(output);
      return {
        id: '',
        ptyStatus: '',
        content,
        bufferInfo: '',
        // Split HERE, inside the parse, so the fold costs nothing extra per
        // render — this view sits on the streaming path.
        buffer: splitTerminalBuffer(content),
      };
    }

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

    const content = stripAnsi(contentLines.join('\n').trim());

    return {
      id: idMatch?.[1] || '',
      ptyStatus: statusMatch?.[1] || '',
      content,
      bufferInfo,
      buffer: splitTerminalBuffer(content),
    };
  }, [output]);

  const ptyId = parsed.id || (input.id as string) || '';

  return (
    <BasicTool
      icon={<Terminal className="size-3.5 shrink-0" />}
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
        // `ToolResultCard` already owns the capped scroll container, so the
        // local `data-scrollable max-h-96` wrapper is gone — two nested scroll
        // areas would trap the wheel in the inner one.
        <ToolResultCard>
          {parsed.buffer.earlierCount > 0 && (
            <FoldedSection
              label={`${parsed.buffer.earlierCount} earlier lines`}
              className="px-2 pt-1.5"
            >
              <PreWithPaths
                text={parsed.buffer.earlier}
                className="text-muted-foreground/70 font-mono text-xs leading-relaxed whitespace-pre-wrap"
              />
            </FoldedSection>
          )}
          <PreWithPaths
            text={parsed.buffer.tail}
            className="text-foreground/80 px-2 py-1.5 font-mono text-xs leading-relaxed whitespace-pre-wrap"
          />
          {parsed.bufferInfo && (
            <div className="text-muted-foreground/50 px-2 pb-1.5 text-xs">{parsed.bufferInfo}</div>
          )}
        </ToolResultCard>
      ) : null}
    </BasicTool>
  );
}
ToolRegistry.register('pty_read', PtyReadTool);
