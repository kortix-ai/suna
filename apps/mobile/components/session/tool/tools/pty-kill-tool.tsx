/**
 * `pty_kill`. Port of apps/web `tool/tools/pty-kill-tool.tsx`:
 * - trigger: `TerminalWindow` · "Stopped process" · the PTY id;
 * - body: an error output → `ToolOutputFallback`; else the output with its
 *   markup stripped (`stripMarkupForToolOutput`) in a `ToolResultCard`,
 *   `px-2 py-1.5 text-xs leading-relaxed text-muted-foreground`.
 */

import { useMemo } from 'react';
import { isErrorOutput } from '@kortix/sdk';
import { Text } from '@/components/ui/text';
import { TerminalWindowIcon } from '@/lib/icons';
import { disclosureKey } from '@/lib/session/disclosure-store';
import { PTY_TEXT, ptyKillId, stripMarkupForToolOutput } from '@/lib/session/tools/files-pty';
import { webSpace } from '@/lib/session/user-message';
import { BasicTool, partInput, partOutput, ToolOutputFallback, ToolResultCard } from '../shared/infrastructure';
import { ToolRegistry } from '../shared/registry';
import { TURN_TYPE, useTurnPalette } from '../shared/styles';
import type { ToolProps } from '../shared/types';

export function PtyKillTool({ part, defaultOpen, forceOpen, locked }: ToolProps) {
  const palette = useTurnPalette();
  const ptyId = ptyKillId(partInput(part));
  const output = partOutput(part);
  const cleanOutput = useMemo(() => (output ? stripMarkupForToolOutput(output) : ''), [output]);

  return (
    <BasicTool
      disclosureId={disclosureKey('tool', part.id)}
      icon={TerminalWindowIcon}
      trigger={{ title: PTY_TEXT.stoppedProcess, subtitle: ptyId || undefined }}
      defaultOpen={defaultOpen}
      forceOpen={forceOpen}
      locked={locked}
    >
      {isErrorOutput(output) ? (
        <ToolOutputFallback output={output} toolName="pty_kill" />
      ) : cleanOutput ? (
        <ToolResultCard>
          <Text
            variant="muted"
            selectable
            style={[
              TURN_TYPE.xsRelaxed,
              { paddingHorizontal: webSpace(2), paddingVertical: webSpace(1.5), color: palette.mutedForeground },
            ]}
          >
            {cleanOutput}
          </Text>
        </ToolResultCard>
      ) : null}
    </BasicTool>
  );
}
ToolRegistry.register('pty_kill', PtyKillTool);
