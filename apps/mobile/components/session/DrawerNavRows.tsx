import React from 'react';
import { Pressable, View } from 'react-native';
import { CaretUpDownIcon, type AppIcon } from '@/lib/icons';
import { Avatar } from '@/components/kortix/avatar';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { useLanguage } from '@/contexts';
import { cn } from '@/lib/utils/index';

// ─── Nav pill ────────────────────────────────────────────────────────────────

/**
 * One leading column for the drawer: nav pill icons sit in the same 20pt slot
 * as a session's `SessionStatusMark` (`h-5 min-w-5`), and both rows pad 16pt
 * (`px-4`), so every icon and status mark centres on one vertical line.
 */
const LEADING_SLOT_CLASS = 'w-5 shrink-0 items-center';

/**
 * One trailing column for the drawer's top rows: the switcher caret and the
 * Review and Notifications count pills centre on the same vertical line. 28pt
 * holds a two-digit count; "99+" widens it by ~5pt.
 */
const TRAILING_SLOT_CLASS = 'min-w-7 shrink-0 items-center';

export function NavPill({
  icon,
  label,
  onPress,
  trailing,
  accessibilityLabel,
}: {
  icon: AppIcon;
  label: string;
  onPress: () => void;
  /** A trailing count pill (Review, Notifications). */
  trailing?: React.ReactNode;
  /** Overrides `label` for a screen reader (Review and Notifications speak their count). */
  accessibilityLabel?: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      className="flex-row items-center gap-3 rounded-full px-4 py-2.5 active:bg-foreground/5">
      <View className={LEADING_SLOT_CLASS}>
        <Icon as={icon} size={18} className="text-foreground" />
      </View>
      <Text className="flex-1 font-medium" numberOfLines={1}>
        {label}
      </Text>
      {trailing ? <View className={TRAILING_SLOT_CLASS}>{trailing}</View> : null}
    </Pressable>
  );
}

// ─── Switcher row ────────────────────────────────────────────────────────────

export function SwitcherRow({
  projectName,
  onPress,
}: {
  /** The open workspace's name. */
  projectName: string;
  onPress: () => void;
}) {
  const { t } = useLanguage();
  const label = projectName
    ? t('workspace.switchNamed', { defaultValue: 'Switch workspace, {{workspace}}', workspace: projectName })
    : t('workspace.switch', 'Switch workspace');
  return (
    // The workspace's chalk tile, its name, and a trailing up/down caret
    // (Workspaces ux.md §3: one concept, so no account avatar and no
    // "in <account>" line). No fill at rest (in light mode `bg-card` equals
    // the drawer surface, so a fill never showed); `bg-secondary` pressed.
    // One button edge to edge; inner views ignore touches so every part
    // presses it.
    <View className="px-1 pb-1">
      <Pressable
        onPress={onPress}
        hitSlop={4}
        accessibilityRole="button"
        accessibilityLabel={label}
        className="flex-row items-center gap-3 rounded-full px-3 py-2 active:bg-foreground/5">
        <View pointerEvents="none">
          <Avatar chalk size={36} fallbackText={projectName} />
        </View>
        <View pointerEvents="none" className="min-w-0 flex-1">
          <Text
            className="font-roobert-semibold text-foreground"
            style={{ fontSize: 17, lineHeight: 22, letterSpacing: -0.17 }}
            numberOfLines={1}>
            {projectName}
          </Text>
        </View>
        {/* mr-1: this row's content ends 4pt closer to the edge than a NavPill's (px-1 + px-3 vs px-2 -mx-1 + px-4). */}
        <View pointerEvents="none" className={cn(TRAILING_SLOT_CLASS, 'mr-1')}>
          <Icon as={CaretUpDownIcon} size={16} className="shrink-0 text-muted-foreground" />
        </View>
      </Pressable>
    </View>
  );
}
