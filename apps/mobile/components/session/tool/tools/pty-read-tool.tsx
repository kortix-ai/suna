/**
 * `pty_read`. Port of apps/web `tool/tools/pty-read-tool.tsx`:
 * - trigger: `TerminalWindow` · "Terminal output" · the PTY id. Web also
 *   passes the process status as a `badge`, which web's `BasicTool` draws on
 *   the panel surface only; mobile has no panel, so it is not drawn here
 *   either;
 * - body: an error output → `ToolOutputFallback`; else a `ToolResultCard`
 *   holding the last 24 lines of the buffer (mono `text-xs leading-relaxed
 *   text-foreground/80`, `px-2 py-1.5`) under a folded "N earlier lines"
 *   section for the scrollback (`px-2 pt-1.5`, text at `/70`), and the
 *   runtime's "(End of buffer…)" note (`text-xs text-muted-foreground/50`).
 */

import { useMemo } from 'react';
import { View } from 'react-native';
import { isErrorOutput } from '@kortix/sdk';
import { Text } from '@/components/ui/text';
import { TerminalWindowIcon } from '@/lib/icons';
import { disclosureKey } from '@/lib/session/disclosure-store';
import { PTY_TEXT, earlierLinesLabel, parsePtyReadOutput } from '@/lib/session/tools/files-pty';
import { webSpace } from '@/lib/session/user-message';
import { BasicTool, partInput, partOutput, ToolOutputFallback, ToolResultCard } from '../shared/infrastructure';
import { FoldedSection } from '../shared/output-block';
import { ToolRegistry } from '../shared/registry';
import { TURN_TYPE, monoFont, useTurnPalette } from '../shared/styles';
import type { ToolProps } from '../shared/types';
import { ToneBadge } from './apply-patch-tool';

export function PtyReadTool({ part, defaultOpen, forceOpen, locked }: ToolProps) {
  const palette = useTurnPalette();
  const input = partInput(part);
  const output = partOutput(part);
  const parsed = useMemo(() => parsePtyReadOutput(output), [output]);
  const ptyId = parsed.id || (input.id as string) || '';
  const live = parsed.ptyStatus === 'running';

  return (
    <BasicTool
      disclosureId={disclosureKey('tool', part.id)}
      icon={TerminalWindowIcon}
      trigger={{ title: PTY_TEXT.terminalOutput, subtitle: ptyId || undefined }}
      badge={
        parsed.ptyStatus ? (
          <ToneBadge tone={live ? 'success' : 'muted'} dot={live ? { pulse: true } : undefined} uppercase={live}>
            {parsed.ptyStatus}
          </ToneBadge>
        ) : undefined
      }
      defaultOpen={defaultOpen}
      forceOpen={forceOpen}
      locked={locked}
    >
      {isErrorOutput(output) ? (
        <ToolOutputFallback output={output} toolName="pty_read" />
      ) : parsed.content ? (
        <ToolResultCard>
          {parsed.buffer.earlierCount > 0 ? (
            <FoldedSection
              label={earlierLinesLabel(parsed.buffer.earlierCount)}
              style={{ paddingHorizontal: webSpace(2), paddingTop: webSpace(1.5) }}
            >
              <Text
                variant="muted"
                selectable
                style={[TURN_TYPE.xsRelaxed, { fontFamily: monoFont, color: palette.muted70 }]}
              >
                {parsed.buffer.earlier}
              </Text>
            </FoldedSection>
          ) : null}
          <Text
            variant="muted"
            selectable
            style={[
              TURN_TYPE.xsRelaxed,
              {
                paddingHorizontal: webSpace(2),
                paddingVertical: webSpace(1.5),
                fontFamily: monoFont,
                color: palette.foreground80,
              },
            ]}
          >
            {parsed.buffer.tail}
          </Text>
          {parsed.bufferInfo ? (
            <View style={{ paddingHorizontal: webSpace(2), paddingBottom: webSpace(1.5) }}>
              <Text variant="muted" style={[TURN_TYPE.xs, { color: palette.muted50 }]}>
                {parsed.bufferInfo}
              </Text>
            </View>
          ) : null}
        </ToolResultCard>
      ) : null}
    </BasicTool>
  );
}
ToolRegistry.register('pty_read', PtyReadTool);
