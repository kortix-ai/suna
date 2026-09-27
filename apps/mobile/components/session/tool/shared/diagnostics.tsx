/**
 * LSP diagnostics under an edit / write row.
 *
 * Mirrors apps/web `tool/shared/infrastructure.tsx` `getToolDiagnostics` +
 * `DiagnosticsDisplay`: `space-y-1 px-2 pb-2`, one row per diagnostic
 * (`gap-1.5 text-xs`), `WarningCircle` for an error and `Warning` otherwise at
 * `size-3 mt-0.5`, text `[line:col] message` in the destructive / warning /
 * info tone; tapping opens the file (web opens the preview at that line).
 * Rows are inert (`opacity-70`) when navigation is off or there is no path.
 */

import { Pressable, View } from 'react-native';
import type { Diagnostic, ToolPart } from '@kortix/sdk';
import { Text } from '@/components/ui/text';
import { WarningCircleIcon, WarningIcon } from '@/lib/icons';
import { partMetadata, partOutput } from '@/lib/session/tool-part-accessors';
import { getToolDiagnosticsFrom } from '@/lib/session/tool-output-parsers';
import { webSpace } from '@/lib/session/user-message';
import { TURN_SPACE, TURN_TYPE, useTurnPalette } from './styles';
import { useToolNavigation } from './navigation';

export function getToolDiagnostics(part: ToolPart, filePath: string | undefined): Diagnostic[] {
  if (!filePath) return [];
  return getToolDiagnosticsFrom(partOutput(part), partMetadata(part), filePath);
}

export function DiagnosticsDisplay({ diagnostics, filePath }: { diagnostics: Diagnostic[]; filePath?: string }) {
  const palette = useTurnPalette();
  const { enabled: navigationEnabled, openFile } = useToolNavigation();
  if (diagnostics.length === 0) return null;
  const active = navigationEnabled && Boolean(filePath);

  return (
    <View style={{ rowGap: webSpace(1), paddingHorizontal: webSpace(2), paddingBottom: webSpace(2) }}>
      {diagnostics.map((d) => {
        const isError = d.severity === 1;
        const isWarning = d.severity === 2;
        const color = isError ? palette.destructive : isWarning ? palette.warning : palette.info;
        const Glyph = isError ? WarningCircleIcon : WarningIcon;
        return (
          <Pressable
            key={`${d.range.start.line}:${d.range.start.character}:${d.severity ?? 0}:${d.message}`}
            accessibilityRole="button"
            disabled={!active}
            onPress={() => filePath && openFile(filePath, d.range.start.line + 1)}
            style={{ flexDirection: 'row', alignItems: 'flex-start', gap: TURN_SPACE.gap1_5, opacity: active ? 1 : 0.7 }}
          >
            <View style={{ marginTop: webSpace(0.5) }}>
              <Glyph size={TURN_SPACE.statusIcon} color={color} />
            </View>
            <Text variant="muted" style={[TURN_TYPE.xs, { flex: 1, color }]}>
              [{d.range.start.line + 1}:{d.range.start.character + 1}] {d.message}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}
