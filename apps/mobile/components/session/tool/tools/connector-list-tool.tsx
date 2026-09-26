/**
 * `connector_list` — port of apps/web `tool/tools/connector-list-tool.tsx`.
 *
 * Each connector is a `flex items-start gap-2 px-2 py-1 text-xs` row: a
 * `size-3.5` plug, the name (`font-medium`, truncating) over its description
 * (`text-muted-foreground/60`), and the source as an outline badge. Web's
 * `hover:bg-muted/30` has no touch equivalent and is not drawn.
 */

import { useMemo } from 'react';
import { View } from 'react-native';
import { Badge } from '@/components/ui/badge';
import { Text } from '@/components/ui/text';
import { PlugIcon } from '@/lib/icons';
import { disclosureKey } from '@/lib/session/disclosure-store';
import { connectorListTrigger } from '@/lib/session/tools/projects-connectors';
import { parseConnectorListOutput } from '@/lib/session/tools/projects-tool-output';
import { webSpace } from '@/lib/session/user-message';
import {
  BasicTool,
  isErrorOutput,
  partInput,
  partOutput,
  ToolEmptyState,
  ToolOutputFallback,
} from '../shared/infrastructure';
import { ToolRegistry } from '../shared/registry';
import { ToolResultCard } from '../shared/result-card';
import { FONT_MEDIUM, TURN_SPACE, TURN_TYPE, useTurnPalette } from '../shared/styles';
import type { ToolProps } from '../shared/types';

export function ConnectorListTool({ part, defaultOpen, forceOpen }: ToolProps) {
  const palette = useTurnPalette();
  const input = partInput(part);
  const output = partOutput(part);
  const connectors = useMemo(() => parseConnectorListOutput(output || ''), [output]);
  // `isErrorOutput` trims a copy of the whole output and runs `JSON.parse` over it.
  const isError = useMemo(() => isErrorOutput(output), [output]);

  return (
    <BasicTool
      disclosureId={disclosureKey('tool', part.id)}
      icon={PlugIcon}
      trigger={connectorListTrigger(input, connectors.length)}
      defaultOpen={defaultOpen || connectors.length === 0}
      forceOpen={forceOpen}
    >
      {connectors.length > 0 ? (
        <ToolResultCard bodyStyle={{ rowGap: webSpace(1) }}>
          {connectors.map((conn) => (
            <View
              key={conn.name}
              style={{
                flexDirection: 'row',
                alignItems: 'flex-start',
                gap: TURN_SPACE.gap2,
                paddingHorizontal: webSpace(2),
                paddingVertical: webSpace(1),
              }}
            >
              <View style={{ marginTop: webSpace(0.5) }}>
                <PlugIcon size={TURN_SPACE.caret} color={palette.mutedForeground} />
              </View>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text
                  numberOfLines={1}
                  style={[TURN_TYPE.xs, { fontFamily: FONT_MEDIUM, color: palette.foreground }]}
                >
                  {conn.name}
                </Text>
                {conn.description ? (
                  <Text variant="muted" style={[TURN_TYPE.xs, { color: palette.muted60 }]}>
                    {conn.description}
                  </Text>
                ) : null}
              </View>
              <Badge variant="outline">
                <Text style={{ textTransform: 'capitalize' }}>{conn.source}</Text>
              </Badge>
            </View>
          ))}
        </ToolResultCard>
      ) : isError ? (
        <ToolOutputFallback output={output} toolName="connector_list" />
      ) : output ? (
        <ToolResultCard>
          <ToolEmptyState message="No connectors found." />
        </ToolResultCard>
      ) : (
        <ToolResultCard>
          <ToolEmptyState message="Loading connectors…" />
        </ToolResultCard>
      )}
    </BasicTool>
  );
}
ToolRegistry.register('connector_list', ConnectorListTool);
ToolRegistry.register('connector-list', ConnectorListTool);
ToolRegistry.register('oc-connector_list', ConnectorListTool);
ToolRegistry.register('oc-connector-list', ConnectorListTool);
