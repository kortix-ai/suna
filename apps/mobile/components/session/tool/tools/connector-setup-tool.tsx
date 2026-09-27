/**
 * `connector_setup` — port of apps/web `tool/tools/connector-setup-tool.tsx`:
 * one `flex items-center gap-2 px-2 py-1 text-xs` row per configured
 * connector (`size-3.5` plug, `font-medium` name), the failure, the raw
 * output, or "Setting up connectors...".
 */

import { useMemo } from 'react';
import { View } from 'react-native';
import { Text } from '@/components/ui/text';
import { PlugIcon } from '@/lib/icons';
import { disclosureKey } from '@/lib/session/disclosure-store';
import { connectorSetupTrigger, keyConnectors } from '@/lib/session/tools/projects-connectors';
import { parseConnectorSetupOutput } from '@/lib/session/tools/projects-tool-output';
import { webSpace } from '@/lib/session/user-message';
import {
  BasicTool,
  isErrorOutput,
  partOutput,
  ToolEmptyState,
  ToolOutputFallback,
} from '../shared/infrastructure';
import { ToolRegistry } from '../shared/registry';
import { ToolResultCard } from '../shared/result-card';
import { FONT_MEDIUM, TURN_SPACE, TURN_TYPE, useTurnPalette } from '../shared/styles';
import type { ToolProps } from '../shared/types';

export function ConnectorSetupTool({ part, defaultOpen, forceOpen }: ToolProps) {
  const palette = useTurnPalette();
  const output = partOutput(part);
  const data = useMemo(() => parseConnectorSetupOutput(output || ''), [output]);
  // `isErrorOutput` trims a copy of the whole output and runs `JSON.parse` over it.
  const isError = useMemo(() => isErrorOutput(output), [output]);
  const keyedConnectors = useMemo(() => keyConnectors(data?.connectors ?? []), [data]);

  return (
    <BasicTool
      disclosureId={disclosureKey('tool', part.id)}
      icon={PlugIcon}
      trigger={connectorSetupTrigger(data, isError)}
      defaultOpen={defaultOpen}
      forceOpen={forceOpen}
    >
      {isError ? (
        <ToolOutputFallback output={output} toolName="connector_setup" />
      ) : data && data.connectors.length > 0 ? (
        <ToolResultCard bodyStyle={{ rowGap: webSpace(0.5) }}>
          {keyedConnectors.map(({ conn, key }) => (
            <View
              key={key}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: TURN_SPACE.gap2,
                paddingHorizontal: webSpace(2),
                paddingVertical: webSpace(1),
              }}
            >
              <PlugIcon size={TURN_SPACE.caret} color={palette.mutedForeground} />
              <Text style={[TURN_TYPE.xs, { fontFamily: FONT_MEDIUM, color: palette.foreground }]}>{conn}</Text>
            </View>
          ))}
        </ToolResultCard>
      ) : output ? (
        <ToolOutputFallback output={output} toolName="connector_setup" />
      ) : (
        <ToolResultCard>
          <ToolEmptyState message="Setting up connectors..." />
        </ToolResultCard>
      )}
    </BasicTool>
  );
}
ToolRegistry.register('connector_setup', ConnectorSetupTool);
ToolRegistry.register('connector-setup', ConnectorSetupTool);
ToolRegistry.register('oc-connector_setup', ConnectorSetupTool);
ToolRegistry.register('oc-connector-setup', ConnectorSetupTool);
