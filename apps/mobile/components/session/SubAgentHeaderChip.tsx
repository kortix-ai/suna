/**
 * SubAgentHeaderChip — the thread header's sub-agent control (COR-162). An
 * icon-only 32pt pill in the header's right-side row, before the `···`, so
 * the centred title keeps the width (Jay's ruling, 2026-09-23).
 *
 * The relation is the session list's (`lib/session/sub-agents.ts`): a project
 * session spawned by another project session. Never both at once:
 * - `child` — this thread is a sub-agent. `ArrowElbowLeftUpIcon`, 32 × 32.
 *   Tapping opens the parent session.
 * - `parent` — this thread spawned sub-agents. `TreeStructureIcon` plus the
 *   count. Tapping opens the `SubAgentListSheet`.
 *
 * The words live in `accessibilityLabel` only: "Sub-agent of {parent}" /
 * "{N} sub-agents". A `PressableSurface`, not a `Button`: no Button size is a
 * 32pt pill, and a Button takes no size classes. `hitSlop` keeps the target
 * 44pt.
 */
import * as React from 'react';
import { View } from 'react-native';

import { PressableSurface } from '@/components/kortix/pressable-surface';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { ArrowElbowLeftUpIcon, TreeStructureIcon } from '@/lib/icons';
import type { SubAgentRelation } from '@/lib/session/sub-agents';

/** Pill height; also its width when it holds a glyph only. */
const CHIP_SIZE = 32;
/** 32 + 2 × 6 = 44pt touch target. */
const CHIP_HIT_SLOP = 6;

interface SubAgentHeaderChipProps {
  relation: SubAgentRelation | null;
  onPress: () => void;
}

export function SubAgentHeaderChip({ relation, onPress }: SubAgentHeaderChipProps) {
  if (!relation) return null;

  const isChild = relation.type === 'child';
  const accessibilityLabel = isChild
    ? `Sub-agent of ${relation.parentTitle}`
    : `${relation.count} sub-agent${relation.count === 1 ? '' : 's'}`;

  return (
    <PressableSurface
      onPress={onPress}
      hitSlop={CHIP_HIT_SLOP}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={isChild ? 'Opens the parent session' : 'Lists the sub-agent sessions'}
      className="rounded-full bg-background"
      style={({ pressed }) => ({
        height: CHIP_SIZE,
        minWidth: CHIP_SIZE,
        paddingHorizontal: isChild ? 0 : 10,
        opacity: pressed ? 0.7 : 1,
      })}>
      <View className="flex-1 flex-row items-center justify-center gap-1">
        <Icon as={isChild ? ArrowElbowLeftUpIcon : TreeStructureIcon} size={16} className="text-foreground" />
        {isChild ? null : (
          <Text variant="small" className="leading-5">
            {relation.count}
          </Text>
        )}
      </View>
    </PressableSurface>
  );
}
