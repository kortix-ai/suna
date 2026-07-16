'use client';
import { ToolRegistry } from '@/features/session/tool/shared/registry';
import type { ToolProps } from '@/features/session/tool/shared/types';
import {
  BasicTool,
  partInput,
  partOutput,
} from '@/features/session/tool/shared/infrastructure';
import {
  Terminal,
} from 'lucide-react';
import { useTranslations } from 'next-intl';


export function PtyWriteTool({ part, defaultOpen, forceOpen, locked }: ToolProps) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const input = partInput(part);
  const output = partOutput(part);
  const ptyInput = (input.input as string) || (input.text as string) || '';
  const ptyId = (input.id as string) || (input.pty_id as string) || '';

  return (
    <BasicTool
      icon={<Terminal className="size-3.5 flex-shrink-0" />}
      trigger={{ title: 'Terminal input', subtitle: ptyId || undefined }}
      defaultOpen={defaultOpen}
      forceOpen={forceOpen}
      locked={locked}
    >
      {ptyInput && (
        <div data-scrollable className="max-h-96 overflow-auto px-3 py-2">
          <pre className="text-foreground/80 font-mono text-xs leading-relaxed break-all whitespace-pre-wrap">
            <span className="text-muted-foreground/50 select-none">
              {tHardcodedUi.raw('componentsSessionToolRenderers.line2685JsxTextText')}
            </span>
            {ptyInput}
          </pre>
        </div>
      )}
    </BasicTool>
  );
}
ToolRegistry.register('pty_write', PtyWriteTool);
ToolRegistry.register('pty_input', PtyWriteTool);

