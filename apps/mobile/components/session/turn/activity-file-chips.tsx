/**
 * A run of reads or writes rendered as FILES rather than as tool cards.
 *
 * Mirrors apps/web `turn/activity-file-chips.tsx`:
 * - trigger: family glyph (a filled `Warning` in `text-destructive` replaces it
 *   while a failed run is closed), medium label ("Read 3 files",
 *   "Wrote a.ts", "Read 2 files · 1 failed"; shimmer while running), caret;
 * - body `mt-3 pl-7 space-y-3`: chips wrapping with `gap-2`, then the failed /
 *   directory / pathless calls as ordinary step rows;
 * - chip: `border bg-background rounded-md p-1.5 py-1 pr-3 gap-3`, pressed
 *   scale 0.97; icon well `size-9 bg-muted rounded-sm` with a `size-5`
 *   `text-muted-foreground` glyph; name `text-sm font-medium text-foreground`,
 *   type `text-xs text-muted-foreground`;
 * - a bare run with no chips renders its tool rows only.
 */

import { memo, useCallback } from 'react';
import { Pressable, View } from 'react-native';
import Animated from 'react-native-reanimated';
import type { Part } from '@kortix/sdk';
import { Text } from '@/components/ui/text';
import { WarningIcon } from '@/lib/icons';
import {
  fileCategory,
  fileChipRun,
  fileChipTypeLabel,
  filenameOf,
  resolveDisclosureOpen,
  samePartsList,
} from '@/lib/session/activity';
import { disclosureKey, useDisclosureChoice, useDisclosureStore } from '@/lib/session/disclosure-store';
import { DisclosureContent, useReportOpen } from '@/components/session/chain-of-thought';
import { usePressScale } from '@/components/session/use-press-scale';
import { FONT_MEDIUM, TURN_SPACE, TURN_TYPE, useTurnPalette } from '@/components/session/tool/shared/styles';
import { FILE_CATEGORY_ICONS } from '@/components/session/tool/shared/tool-icons';
import { ActivityStep, StepTrigger, iconFor, useActivityContext } from './activity-step';

function FileChipImpl({ path, onOpen }: { path: string; onOpen?: (path: string) => void }) {
  const palette = useTurnPalette();
  const { onPressIn, onPressOut, animatedStyle } = usePressScale(0.97);
  const filename = filenameOf(path);
  const Glyph = FILE_CATEGORY_ICONS[fileCategory(filename)];

  return (
    <Animated.View style={[{ maxWidth: '100%' }, animatedStyle]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Open ${filename}`}
        disabled={!onOpen}
        onPress={() => onOpen?.(path)}
        onPressIn={onPressIn}
        onPressOut={onPressOut}
        style={({ pressed }) => ({
          flexDirection: 'row',
          alignItems: 'center',
          gap: TURN_SPACE.gap3,
          borderWidth: 1,
          borderColor: palette.border,
          borderRadius: TURN_SPACE.radiusMd,
          // web `hover:bg-muted/50` is the pressed tint on touch.
          backgroundColor: pressed ? palette.mutedHalf : palette.background,
          paddingLeft: TURN_SPACE.chipPadLeft,
          paddingVertical: TURN_SPACE.chipPadY,
          paddingRight: TURN_SPACE.chipPadRight,
        })}
      >
        <View
          style={{
            width: TURN_SPACE.chipWell,
            height: TURN_SPACE.chipWell,
            borderRadius: TURN_SPACE.radiusSm,
            backgroundColor: palette.muted,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Glyph size={TURN_SPACE.chipGlyph} color={palette.mutedForeground} />
        </View>
        <View style={{ flexShrink: 1, minWidth: 0 }}>
          <Text variant="small" numberOfLines={1} style={[TURN_TYPE.sm, { fontFamily: FONT_MEDIUM, color: palette.foreground }]}>
            {filename}
          </Text>
          <Text variant="muted" numberOfLines={1} style={[TURN_TYPE.xs, { color: palette.mutedForeground }]}>
            {fileChipTypeLabel(filename)}
          </Text>
        </View>
      </Pressable>
    </Animated.View>
  );
}

const FileChip = memo(FileChipImpl);

function ActivityFileChipStepImpl({
  parts,
  running,
  bare = false,
}: {
  parts: ReadonlyArray<Part>;
  running: boolean;
  bare?: boolean;
}) {
  const palette = useTurnPalette();
  const { onOpenFile, toDisplayPath } = useActivityContext();
  const key = disclosureKey('chips', parts[0]?.id ?? '');
  const choice = useDisclosureChoice(key);
  const open = resolveDisclosureOpen({ userChoice: choice, auto: false });
  const run = fileChipRun(parts, { bare, toDisplayPath });
  const showsChips = Boolean(run && !run.bareFallback);

  useReportOpen(open && showsChips);

  const toggle = useCallback(() => {
    useDisclosureStore.getState().setChoice(key, !open);
  }, [key, open]);

  if (!run || !parts[0]) return null;

  if (run.bareFallback) {
    return (
      <>
        {run.fallbacks.map((part) => (
          <ActivityStep key={part.id} part={part} running={running} />
        ))}
      </>
    );
  }

  const Family = iconFor(parts[0]);
  const leading =
    run.status === 'error' && !open ? (
      <View accessible accessibilityLabel="This step failed">
        <WarningIcon weight="fill" size={TURN_SPACE.icon} color={palette.destructive} />
      </View>
    ) : (
      <Family size={TURN_SPACE.icon} color={palette.mutedForeground} />
    );

  return (
    <View>
      <StepTrigger
        open={open}
        onToggle={toggle}
        leading={leading}
        label={run.label}
        running={run.status === 'running'}
      />
      <DisclosureContent open={open}>
        <View style={{ marginTop: TURN_SPACE.gap3, paddingLeft: TURN_SPACE.nestIndent, rowGap: TURN_SPACE.gap3 }}>
          {run.paths.length > 0 ? (
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: TURN_SPACE.gap2 }}>
              {run.paths.map((path) => (
                <FileChip key={path} path={path} onOpen={onOpenFile} />
              ))}
            </View>
          ) : null}
          {run.fallbacks.length > 0 ? (
            <View style={{ rowGap: TURN_SPACE.gap3 }}>
              {run.fallbacks.map((part) => (
                <ActivityStep key={part.id} part={part} running={running} />
              ))}
            </View>
          ) : null}
        </View>
      </DisclosureContent>
    </View>
  );
}

/** `parts` is a fresh array per merge while a turn streams — compare element-wise. */
export const ActivityFileChipStep = memo(
  ActivityFileChipStepImpl,
  (a, b) => a.running === b.running && a.bare === b.bare && samePartsList(a.parts, b.parts),
);
ActivityFileChipStep.displayName = 'ActivityFileChipStep';
