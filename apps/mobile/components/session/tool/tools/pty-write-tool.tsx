/**
 * `pty_write` / `pty_input`. Port of apps/web `tool/tools/pty-write-tool.tsx`:
 * - trigger: `TerminalWindow` · "Terminal input" · the PTY id;
 * - body (only when there is input): a `ToolResultCard` (`px-2 py-1.5`) with
 *   `>` at `text-muted-foreground/50` and the sent text in mono `text-xs
 *   leading-relaxed text-foreground/80`, wrapped.
 */

import { Text } from '@/components/ui/text';
import { TerminalWindowIcon } from '@/lib/icons';
import { disclosureKey } from '@/lib/session/disclosure-store';
import { PTY_TEXT, ptyWriteView } from '@/lib/session/tools/files-pty';
import { webSpace } from '@/lib/session/user-message';
import { BasicTool, partInput, ToolResultCard } from '../shared/infrastructure';
import { ToolRegistry } from '../shared/registry';
import { TURN_TYPE, monoFont, useTurnPalette } from '../shared/styles';
import type { ToolProps } from '../shared/types';

export function PtyWriteTool({ part, defaultOpen, forceOpen, locked }: ToolProps) {
  const palette = useTurnPalette();
  const { ptyInput, ptyId } = ptyWriteView(partInput(part));

  return (
    <BasicTool
      disclosureId={disclosureKey('tool', part.id)}
      icon={TerminalWindowIcon}
      trigger={{ title: PTY_TEXT.terminalInput, subtitle: ptyId || undefined }}
      defaultOpen={defaultOpen}
      forceOpen={forceOpen}
      locked={locked}
    >
      {ptyInput ? (
        <ToolResultCard bodyStyle={{ paddingHorizontal: webSpace(2), paddingVertical: webSpace(1.5) }}>
          <Text
            variant="muted"
            selectable
            style={[TURN_TYPE.xsRelaxed, { fontFamily: monoFont, color: palette.foreground80 }]}
          >
            <Text style={{ color: palette.muted50 }}>{PTY_TEXT.inputPrompt}</Text>
            {ptyInput}
          </Text>
        </ToolResultCard>
      ) : null}
    </BasicTool>
  );
}
ToolRegistry.register('pty_write', PtyWriteTool);
ToolRegistry.register('pty_input', PtyWriteTool);
