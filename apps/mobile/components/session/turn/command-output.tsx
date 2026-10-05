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
 *
 * `chrome={false}` draws no card: no surface, no chip, no padding, only the
 * children. The element tree keeps its shape, so a reply that streams without
 * the card and finishes inside it stays mounted (`SessionTurn`).
 */

import * as React from 'react';
import { View } from 'react-native';

import { monoFont } from '@/components/session/tool/shared/styles';
import { Text } from '@/components/ui/text';

/** Web `text-xs`: 13px / 16px. */
const CHIP_TEXT = { fontSize: 13, lineHeight: 16, fontFamily: monoFont, fontWeight: '500' } as const;

export function CommandOutputCard({
  name,
  chrome = true,
  children,
}: {
  /** The command name, without the leading slash (web shows `commandForTurn.name`). */
  name: string;
  /** Draw the card. False renders only the children, in the same element tree. */
  chrome?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <View
      className={chrome ? 'w-full overflow-hidden rounded-lg bg-secondary' : undefined}
      testID={chrome ? 'session-command-output' : undefined}>
      {chrome ? (
        <View className="min-w-0 flex-row items-center justify-between gap-2 p-3 pb-0">
          <View
            className="min-w-0 shrink rounded-sm border border-border bg-popover px-1.5 py-0.5"
            accessibilityLabel={`/${name}`}>
            <Text variant="small" numberOfLines={1} style={CHIP_TEXT}>
              {name}
            </Text>
          </View>
        </View>
      ) : null}
      <View className={chrome ? 'min-w-0 px-4 py-3' : undefined}>{children}</View>
    </View>
  );
}
