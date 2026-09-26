/**
 * The retired `integration-*` tools — port of apps/web
 * `tool/tools/removed-connector-tool.tsx`.
 *
 * The row says "Legacy Connector Tool" with "removed" at its right edge; the
 * body explains the surface is gone and shows any output the call produced.
 * Web's file also declares two unused sub-agent helpers; they are not ported.
 */

import { View } from 'react-native';
import { Text } from '@/components/ui/text';
import { PlugIcon } from '@/lib/icons';
import { disclosureKey } from '@/lib/session/disclosure-store';
import { webSpace } from '@/lib/session/user-message';
import { BasicTool, partOutput, partStatus, ToolOutputFallback } from '../shared/infrastructure';
import { ToolRegistry } from '../shared/registry';
import { ToolResultCard } from '../shared/result-card';
import { FONT_MEDIUM, TURN_TYPE, useTurnPalette } from '../shared/styles';
import type { ToolProps } from '../shared/types';

/** Web: the retired integration tool names, all rendered by this row. */
export const REMOVED_CONNECTOR_TOOL_NAMES = [
  'integration-list',
  'integration-connect',
  'integration-search',
  'integration-actions',
  'integration-run',
  'integration-request',
  'integration-exec',
] as const;

export function RemovedConnectorTool({ part, defaultOpen, forceOpen, locked }: ToolProps) {
  const palette = useTurnPalette();
  const output = partOutput(part);

  return (
    <BasicTool
      disclosureId={disclosureKey('tool', part.id)}
      icon={PlugIcon}
      trigger={
        <>
          <Text numberOfLines={1} style={[TURN_TYPE.xs, { flexShrink: 0, fontFamily: FONT_MEDIUM, color: palette.foreground }]}>
            Legacy Connector Tool
          </Text>
          <Text
            variant="muted"
            numberOfLines={1}
            style={[TURN_TYPE.xs, { marginLeft: 'auto', flexShrink: 0, fontFamily: FONT_MEDIUM, color: palette.muted60 }]}
          >
            removed
          </Text>
        </>
      }
      defaultOpen={defaultOpen}
      forceOpen={forceOpen}
      locked={locked}
    >
      <View>
        <ToolResultCard bodyStyle={{ paddingHorizontal: webSpace(2), paddingVertical: webSpace(1.5) }}>
          <Text variant="muted" style={[TURN_TYPE.xsRelaxed, { color: palette.mutedForeground }]}>
            This legacy connector tool surface has been removed while connectors are rebuilt.
          </Text>
        </ToolResultCard>
        {output ? (
          <ToolOutputFallback output={output} isStreaming={partStatus(part) === 'running'} toolName="legacy-integration" />
        ) : null}
      </View>
    </BasicTool>
  );
}
REMOVED_CONNECTOR_TOOL_NAMES.forEach((toolName) => ToolRegistry.register(toolName, RemovedConnectorTool));
