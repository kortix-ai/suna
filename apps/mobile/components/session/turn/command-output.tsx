/**
 * CommandOutputCard — the card a slash command's response renders in.
 *
 * Mirrors the `commandForTurn` branch of apps/web `session-chat.tsx`:
 *
 *   bg-secondary flex w-full flex-col overflow-hidden rounded-lg
 *     header  p-3 pb-0 — a chip: bg-popover rounded-sm border px-1.5 py-0.5
 *             font-mono text-xs font-medium, one line, truncated
 *     body    px-4 py-3 text-sm — the response
 *
 * The body is passed as `children` (the caller renders the markdown). Web
 * also clamps the body at 288px behind an Expand toggle (`ExpandableOutput`);
 * that clamp is not part of this component.
 */

import * as React from 'react';
import { View } from 'react-native';

import { monoFont } from '@/components/session/tool/shared/styles';
import { Text } from '@/components/ui/text';

/** Web `text-xs`: 13px / 16px. */
const CHIP_TEXT = { fontSize: 13, lineHeight: 16, fontFamily: monoFont, fontWeight: '500' } as const;

export function CommandOutputCard({
  name,
  children,
}: {
  /** The command name, without the leading slash (web shows `commandForTurn.name`). */
  name: string;
  children?: React.ReactNode;
}) {
  return (
    <View className="w-full overflow-hidden rounded-lg bg-secondary" testID="session-command-output">
      <View className="min-w-0 flex-row items-center justify-between gap-2 p-3 pb-0">
        <View
          className="min-w-0 shrink rounded-sm border border-border bg-popover px-1.5 py-0.5"
          accessibilityLabel={`/${name}`}>
          <Text variant="small" numberOfLines={1} style={CHIP_TEXT}>
            {name}
          </Text>
        </View>
      </View>
      <View className="min-w-0 px-4 py-3">{children}</View>
    </View>
  );
}
