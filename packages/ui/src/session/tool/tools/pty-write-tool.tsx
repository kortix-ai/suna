'use client';
import { BasicTool, partInput, partOutput } from '../shared/infrastructure';
import { ToolRegistry } from '../shared/registry';
import { ToolResultCard } from '../shared/result-card';
import type { ToolProps } from '../shared/types';
import { TerminalWindowIcon as Terminal } from '@phosphor-icons/react';
import { useTranslations } from '../../../i18n';

/** @deprecated Renders an OpenCode-only tool or todo list in an OpenCode session (pi has none). OpenCode is sunset (2026-10-23): no new code; delete with OpenCode. */
export function PtyWriteTool({ call, defaultOpen, forceOpen, locked }: ToolProps) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const input = partInput(call);
  const output = partOutput(call);
  const ptyInput = (input.input as string) || (input.text as string) || '';
  const ptyId = (input.id as string) || (input.pty_id as string) || '';

  return (
    <BasicTool
      icon={<Terminal className="size-3.5 shrink-0" />}
      trigger={{
        title: tHardcodedUi.raw('i18nComplete.text32822e8808cc'),
        subtitle: ptyId || undefined,
      }}
      defaultOpen={defaultOpen}
      forceOpen={forceOpen}
      locked={locked}
    >
      {ptyInput && (
        <ToolResultCard bodyClassName="px-2 py-1.5">
          <pre className="text-foreground/80 font-mono text-xs leading-relaxed break-all whitespace-pre-wrap">
            <span className="text-muted-foreground/50 select-none">
              {tHardcodedUi.raw('componentsSessionToolRenderers.line2685JsxTextText')}
            </span>
            {ptyInput}
          </pre>
        </ToolResultCard>
      )}
    </BasicTool>
  );
}
ToolRegistry.register('pty_write', PtyWriteTool);
ToolRegistry.register('pty_input', PtyWriteTool);
