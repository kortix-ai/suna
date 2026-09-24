/**
 * DCP `context_info` — port of apps/web `tool/tools/context-info-tool.tsx`.
 *
 * Renders nothing until the call has output; then a "Context Info · DCP" row
 * (title at `/70`, DCP at `/50`) over the output.
 */

import { Text } from '@/components/ui/text';
import { ScissorsIcon } from '@/lib/icons';
import { disclosureKey } from '@/lib/session/disclosure-store';
import { BasicTool, partOutput, ToolOutputFallback } from '../shared/infrastructure';
import { ToolRegistry } from '../shared/registry';
import { FONT_MEDIUM, TURN_TYPE, useTurnPalette } from '../shared/styles';
import type { ToolProps } from '../shared/types';

export function ContextInfoTool({ part, defaultOpen, forceOpen }: ToolProps) {
  const palette = useTurnPalette();
  const output = partOutput(part);
  if (!output) return null;

  return (
    <BasicTool
      disclosureId={disclosureKey('tool', part.id)}
      icon={ScissorsIcon}
      trigger={
        <>
          <Text variant="muted" style={[TURN_TYPE.xs, { flexShrink: 0, fontFamily: FONT_MEDIUM, color: palette.muted70 }]}>
            Context Info
          </Text>
          <Text variant="muted" style={[TURN_TYPE.xs, { flexShrink: 0, fontFamily: FONT_MEDIUM, color: palette.muted50 }]}>
            DCP
          </Text>
        </>
      }
      defaultOpen={defaultOpen}
      forceOpen={forceOpen}
    >
      <ToolOutputFallback output={output} toolName="context_info" />
    </BasicTool>
  );
}
ToolRegistry.register('context_info', ContextInfoTool);
