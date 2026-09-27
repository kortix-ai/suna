/**
 * `connector_get` — port of apps/web `tool/tools/connector-get-tool.tsx`.
 *
 * Card body `space-y-2 p-2`: the description (`text-muted-foreground mb-1
 * text-xs`), the source as an outline badge, `Env:` with the variable in a
 * `bg-muted rounded px-1` code chip, and notes under a `border-border/30`
 * rule. Unparsed output goes to the fallback.
 */

import { useMemo } from 'react';
import { View } from 'react-native';
import { Badge } from '@/components/ui/badge';
import { Text } from '@/components/ui/text';
import { PlugIcon } from '@/lib/icons';
import { disclosureKey } from '@/lib/session/disclosure-store';
import { connectorGetTrigger } from '@/lib/session/tools/projects-connectors';
import { parseConnectorGetOutput } from '@/lib/session/tools/projects-tool-output';
import { webSpace } from '@/lib/session/user-message';
import { BasicTool, partInput, partOutput, ToolEmptyState, ToolOutputFallback } from '../shared/infrastructure';
import { ToolRegistry } from '../shared/registry';
import { ToolResultCard } from '../shared/result-card';
import { TURN_SPACE, TURN_TYPE, monoFont, useTurnPalette } from '../shared/styles';
import type { ToolProps } from '../shared/types';

export function ConnectorGetTool({ part, defaultOpen, forceOpen }: ToolProps) {
  const palette = useTurnPalette();
  const input = partInput(part);
  const output = partOutput(part);
  const data = useMemo(() => parseConnectorGetOutput(output || ''), [output]);

  return (
    <BasicTool
      disclosureId={disclosureKey('tool', part.id)}
      icon={PlugIcon}
      trigger={connectorGetTrigger(input, data)}
      defaultOpen={defaultOpen}
      forceOpen={forceOpen}
    >
      {data ? (
        <ToolResultCard bodyStyle={{ rowGap: webSpace(2), padding: webSpace(2) }}>
          {data.description ? (
            <Text variant="muted" style={[TURN_TYPE.xs, { marginBottom: webSpace(1), color: palette.mutedForeground }]}>
              {data.description}
            </Text>
          ) : null}
          <View style={{ flexDirection: 'row', gap: TURN_SPACE.gap2 }}>
            <Badge variant="outline">
              <Text style={{ textTransform: 'capitalize' }}>{data.source}</Text>
            </Badge>
          </View>
          {data.env ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: webSpace(1) }}>
              <Text variant="muted" style={[TURN_TYPE.xs, { color: palette.muted60 }]}>
                Env:
              </Text>
              <View
                style={{
                  borderRadius: TURN_SPACE.radiusSm,
                  paddingHorizontal: webSpace(1),
                  backgroundColor: palette.muted,
                }}
              >
                <Text selectable style={[TURN_TYPE.xs, { fontFamily: monoFont, color: palette.foreground }]}>
                  {data.env}
                </Text>
              </View>
            </View>
          ) : null}
          {data.notes ? (
            <View
              style={{
                marginTop: webSpace(2),
                paddingTop: webSpace(2),
                borderTopWidth: 1,
                borderTopColor: palette.border30,
              }}
            >
              <Text variant="muted" selectable style={[TURN_TYPE.xs, { color: palette.mutedForeground }]}>
                {data.notes}
              </Text>
            </View>
          ) : null}
        </ToolResultCard>
      ) : output ? (
        <ToolOutputFallback output={output} toolName="connector_get" />
      ) : (
        <ToolResultCard>
          <ToolEmptyState message="Loading connector…" />
        </ToolResultCard>
      )}
    </BasicTool>
  );
}
ToolRegistry.register('connector_get', ConnectorGetTool);
ToolRegistry.register('connector-get', ConnectorGetTool);
ToolRegistry.register('oc-connector_get', ConnectorGetTool);
ToolRegistry.register('oc-connector-get', ConnectorGetTool);
