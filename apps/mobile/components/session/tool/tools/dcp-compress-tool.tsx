/**
 * DCP `compress` — port of apps/web `tool/tools/dcp-compress-tool.tsx`.
 *
 * The trigger is "Compress · DCP · <topic>" (`text-xs font-medium`, DCP at
 * `/50`, topic at `/70` capped at 200px) with the loader at the right edge
 * while the call runs. The body is the tool's output.
 */

import { useContext } from 'react';
import { KortixLoader } from '@/components/kortix/kortix-loader';
import { Text } from '@/components/ui/text';
import { ScissorsIcon } from '@/lib/icons';
import { disclosureKey } from '@/lib/session/disclosure-store';
import { BasicTool, partInput, partOutput, ToolOutputFallback, ToolRunningContext } from '../shared/infrastructure';
import { ToolRegistry } from '../shared/registry';
import { FONT_MEDIUM, TURN_SPACE, TURN_TYPE, useTurnPalette } from '../shared/styles';
import type { ToolProps } from '../shared/types';

export function DCPCompressTool({ part, defaultOpen, forceOpen }: ToolProps) {
  const palette = useTurnPalette();
  const input = partInput(part);
  const output = partOutput(part);
  const isRunning = useContext(ToolRunningContext);
  const topic = typeof input.topic === 'string' ? input.topic : '';

  return (
    <BasicTool
      disclosureId={disclosureKey('tool', part.id)}
      icon={ScissorsIcon}
      trigger={
        <>
          <Text style={[TURN_TYPE.xs, { flexShrink: 0, fontFamily: FONT_MEDIUM, color: palette.foreground }]}>Compress</Text>
          <Text variant="muted" style={[TURN_TYPE.xs, { flexShrink: 0, fontFamily: FONT_MEDIUM, color: palette.muted50 }]}>
            DCP
          </Text>
          {topic ? (
            <Text variant="muted" numberOfLines={1} style={[TURN_TYPE.xs, { flexShrink: 1, maxWidth: 200, color: palette.muted70 }]}>
              {topic}
            </Text>
          ) : null}
          {isRunning ? <KortixLoader customSize={TURN_SPACE.statusIcon} style={{ marginLeft: 'auto' }} /> : null}
        </>
      }
      defaultOpen={defaultOpen}
      forceOpen={forceOpen}
    >
      {output ? <ToolOutputFallback output={output} toolName="compress" /> : null}
    </BasicTool>
  );
}
ToolRegistry.register('compress', DCPCompressTool);
