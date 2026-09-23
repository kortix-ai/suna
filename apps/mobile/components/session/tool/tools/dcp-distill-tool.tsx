/**
 * DCP `distill` — port of apps/web `tool/tools/dcp-distill-tool.tsx`.
 *
 * The trigger is "Distill · DCP" with "N tools" (`/60`) at the right edge and
 * the loader while the call runs. The body is the tool's output.
 */

import { useContext } from 'react';
import { KortixLoader } from '@/components/kortix/kortix-loader';
import { Text } from '@/components/ui/text';
import { ScissorsIcon } from '@/lib/icons';
import { disclosureKey } from '@/lib/session/disclosure-store';
import { dcpIdsLabel } from '@/lib/session/tools/projects-generic';
import { BasicTool, partInput, partOutput, ToolOutputFallback, ToolRunningContext } from '../shared/infrastructure';
import { ToolRegistry } from '../shared/registry';
import { FONT_MEDIUM, TURN_SPACE, TURN_TYPE, useTurnPalette } from '../shared/styles';
import type { ToolProps } from '../shared/types';

export function DCPDistillTool({ part, defaultOpen, forceOpen }: ToolProps) {
  const palette = useTurnPalette();
  const input = partInput(part);
  const output = partOutput(part);
  const isRunning = useContext(ToolRunningContext);
  const idsLabel = dcpIdsLabel(input.ids);

  return (
    <BasicTool
      disclosureId={disclosureKey('tool', part.id)}
      icon={ScissorsIcon}
      trigger={
        <>
          <Text style={[TURN_TYPE.xs, { flexShrink: 0, fontFamily: FONT_MEDIUM, color: palette.foreground }]}>Distill</Text>
          <Text variant="muted" style={[TURN_TYPE.xs, { flexShrink: 0, fontFamily: FONT_MEDIUM, color: palette.muted50 }]}>
            DCP
          </Text>
          {idsLabel ? (
            <Text variant="muted" style={[TURN_TYPE.xs, { marginLeft: 'auto', color: palette.muted60 }]}>
              {idsLabel}
            </Text>
          ) : null}
          {isRunning ? <KortixLoader customSize={TURN_SPACE.statusIcon} style={{ marginLeft: 'auto' }} /> : null}
        </>
      }
      defaultOpen={defaultOpen}
      forceOpen={forceOpen}
    >
      {output ? <ToolOutputFallback output={output} toolName="distill" /> : null}
    </BasicTool>
  );
}
ToolRegistry.register('distill', DCPDistillTool);
