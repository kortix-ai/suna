/**
 * DCP `prune` — port of apps/web `tool/tools/dcp-prune-tool.tsx`.
 *
 * The trigger is "Prune · DCP · <reason>" (reason at `/70`, truncating) with
 * "N tools" (`/60`) at the right edge and the loader while the call runs.
 * The body is the tool's output.
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

export function DCPPruneTool({ part, defaultOpen, forceOpen }: ToolProps) {
  const palette = useTurnPalette();
  const input = partInput(part);
  const output = partOutput(part);
  const isRunning = useContext(ToolRunningContext);
  const idsLabel = dcpIdsLabel(input.ids);
  const reason = typeof input.reason === 'string' ? input.reason : '';

  return (
    <BasicTool
      disclosureId={disclosureKey('tool', part.id)}
      icon={ScissorsIcon}
      trigger={
        <>
          <Text style={[TURN_TYPE.xs, { flexShrink: 0, fontFamily: FONT_MEDIUM, color: palette.foreground }]}>Prune</Text>
          <Text variant="muted" style={[TURN_TYPE.xs, { flexShrink: 0, fontFamily: FONT_MEDIUM, color: palette.muted50 }]}>
            DCP
          </Text>
          {reason ? (
            <Text variant="muted" numberOfLines={1} style={[TURN_TYPE.xs, { flexShrink: 1, color: palette.muted70 }]}>
              {reason}
            </Text>
          ) : null}
          {idsLabel ? (
            <Text variant="muted" style={[TURN_TYPE.xs, { marginLeft: 'auto', flexShrink: 0, color: palette.muted60 }]}>
              {idsLabel}
            </Text>
          ) : null}
          {isRunning ? <KortixLoader customSize={TURN_SPACE.statusIcon} style={{ marginLeft: 'auto' }} /> : null}
        </>
      }
      defaultOpen={defaultOpen}
      forceOpen={forceOpen}
    >
      {output ? <ToolOutputFallback output={output} toolName="prune" /> : null}
    </BasicTool>
  );
}
ToolRegistry.register('prune', DCPPruneTool);
