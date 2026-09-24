/**
 * Settings list — the one layout for every settings-style screen: the
 * (settings) stack, the Account page, an account's own page, Billing.
 *
 *   <SettingsHeader title="Account" right={<PlatformButton … />} />
 *   <SettingsPage>
 *     <SettingsGroup title="Preferences">
 *       <SettingsRow icon={User} label="General" onPress={…} />
 *       <AppearanceRow />
 *     </SettingsGroup>
 *   </SettingsPage>
 *
 * A group is a sentence-case title above a borderless, rounded card. A row is
 * leading (icon, flag, avatar) · label · trailing (chevron, external arrow,
 * value, check mark, or an inline control). The group inserts full-width
 * separators between rows, so rows never manage dividers.
 * Rules and exact values: apps/mobile/design.md.
 */

import * as React from 'react';
import { Pressable, ScrollView, View, useWindowDimensions, type ScrollViewProps } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import {
  ArrowUpRightIcon as ArrowUpRight,
  CheckIcon as Check,
  CaretLeftIcon as ChevronLeft,
  CaretRightIcon as ChevronRight,
  MonitorIcon as Monitor,
  MoonIcon as Moon,
  PaletteIcon as Palette,
  SunIcon as Sun,
  type AppIcon,
} from '@/lib/icons';

import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { MenuButton } from '@/components/kortix/menu-button';
import { PlatformButton } from '@/components/kortix/platform-button';
import { haptics } from '@/lib/haptics';
import { cn } from '@/lib/utils/index';
import { SHEET_ROW_SURFACE, SurfaceContext } from '@/components/kortix/surface-context';
import { useThemeStore, type ThemePreference } from '@/stores/theme-store';

/**
 * Side padding of a settings-style screen. `page` is the app default (20pt);
 * `project` is the 16pt edge (`px-4`) of every page inside a project
 * (Jay, 2026-09-16), the same as the project home composer.
 */
/**
 * A screen's side margin. `project` (16pt) is the default and what every
 * settings-style screen uses, so a settings page, an account page and the
 * project's own Account page share one edge (Jay, 2026-09-22 — the 20pt
 * `page` screens read as a different app beside it). `page` (20pt) is kept
 * for a surface that deliberately sits wider.
 */
export type Gutter = 'page' | 'project';
const GUTTER_CLASS: Record<Gutter, string> = {
  page: 'px-5',
  project: 'px-4',
};

/**
 * Screen header: Go back (native SwiftUI button on iOS, secondary pill on
 * Android), the title, and an optional trailing action. Tab roots pass
 * `showBack={false}`. A project page passes `onOpenMenu`: the hamburger that
 * opens the project drawer replaces Go back.
 */
export function SettingsHeader({
  title,
  showBack = true,
  onOpenMenu,
  right,
  align = 'start',
  transparent = false,
  largeTitle = false,
  gutter = 'project',
}: {
  title: string;
  showBack?: boolean;
  /**
   * Show the hamburger (the same secondary icon button as `PageHeader`) in
   * place of Go back. It opens the project drawer.
   */
  onOpenMenu?: () => void;
  /** Trailing action, e.g. a `PlatformButton` "New". */
  right?: React.ReactNode;
  /**
   * `center` centres the title between the back button and the trailing
   * action. An empty side gets a 40pt spacer (the icon button size), so pair
   * it with icon-only actions: a labelled pill pushes the title off centre.
   */
  align?: 'start' | 'center';
  /** No background: the header sits on a `SettingsPage` hero (Billing). */
  transparent?: boolean;
  /**
   * Large page title: the control row holds only the leading button and
   * `right`, and the title renders below it as `Text variant="h3"`, above
   * the page content (Sessions page).
   */
  largeTitle?: boolean;
  /** Side padding: `page` 20pt (`px-5`), `project` 12pt (`px-3`) on project pages. */
  gutter?: Gutter;
}) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const topPadding = Math.max(insets.top, 10) + 6;
  const centered = align === 'center';

  const handleBack = () => {
    haptics.tap();
    // The screen can be first in history (deep link / cold start): go home.
    if (router.canGoBack()) router.back();
    else router.replace('/'); // the last project (app/index.tsx), never the list
  };

  const leading = onOpenMenu ? (
    <MenuButton onPress={onOpenMenu} />
  ) : showBack ? (
    <PlatformButton
      systemImage="chevron.left"
      icon={ChevronLeft}
      fallbackVariant="secondary"
      accessibilityLabel="Go back"
      onPress={handleBack}
    />
  ) : centered ? (
    <View className="size-10" />
  ) : null;

  if (largeTitle) {
    return (
      <View className={cn(!transparent && 'bg-background')}>
        <View
          className={cn('flex-row items-center justify-between gap-3 pb-3', GUTTER_CLASS[gutter])}
          style={{ paddingTop: topPadding, minHeight: 56 }}>
          {leading}
          {right ?? null}
        </View>
        <View className={cn('h-10 justify-center pb-1', GUTTER_CLASS[gutter])}>
          <Text variant="h3" accessibilityRole="header" numberOfLines={1}>
            {title}
          </Text>
        </View>
      </View>
    );
  }

  return (
    <View
      className={cn('flex-row items-center gap-3 pb-3', GUTTER_CLASS[gutter], !transparent && 'bg-background')}
      style={{ paddingTop: topPadding, minHeight: 56 }}>
      {leading}
      <Text
        className={cn(
          'flex-1 text-xl leading-6 font-roobert-medium text-foreground tracking-tight',
          centered && 'text-center'
        )}
        numberOfLines={1}>
        {title}
      </Text>
      {right ?? (centered ? <View className="size-10" /> : null)}
    </View>
  );
}

/** Scrollable screen body: 16pt side margins (`gutter="project"`, the default — every settings-style screen matches the project's Account page; Jay, 2026-09-22), 18pt between groups. */
export function SettingsPage({
  children,
  header,
  hero,
  paddingBottom,
  contentInsetAdjustmentBehavior,
  refreshControl,
  gutter = 'project',
}: {
  children: React.ReactNode;
  /** Side padding: `page` 20pt (`px-5`), `project` 12pt (`px-3`) on project pages. */
  gutter?: Gutter;
  /** Content above the first group (e.g. the profile avatar). */
  header?: React.ReactNode;
  /**
   * Full-bleed block that scrolls with the page, above the body (the Billing
   * balance). The body then sits on a `rounded-t-3xl` sheet that overlaps the
   * hero's bottom 24pt, so the hero needs at least that much bottom padding.
   */
  hero?: React.ReactNode;
  /** Defaults to the safe-area inset + 28pt. The Projects page passes its own. */
  paddingBottom?: number;
  contentInsetAdjustmentBehavior?: ScrollViewProps['contentInsetAdjustmentBehavior'];
  /** Pull-to-refresh for list screens (Members, Groups, …). */
  refreshControl?: ScrollViewProps['refreshControl'];
}) {
  const insets = useSafeAreaInsets();
  return (
    <ScrollView
      className="flex-1 bg-background"
      showsVerticalScrollIndicator={false}
      refreshControl={refreshControl}
      contentInsetAdjustmentBehavior={contentInsetAdjustmentBehavior}
      contentContainerStyle={{
        flexGrow: hero ? 1 : undefined,
        paddingBottom: paddingBottom ?? insets.bottom + 28,
      }}>
      {hero}
      <View
        className={cn(
          'pb-2 pt-1',
          GUTTER_CLASS[gutter],
          hero && '-mt-6 flex-1 rounded-t-3xl bg-background pt-6'
        )}
        style={{ gap: 18 }}>
        {header}
        {children}
      </View>
    </ScrollView>
  );
}

/**
 * Sentence-case title above a group of rows; renders nothing when empty.
 *
 * Each row is its own rounded tile (Jay, 2026-09-22). The divider between two
 * rows is a 2pt gap, not a hairline: whatever is behind the group shows through
 * it (`bg-background` on a page, the sheet colour in a sheet), so the rows read
 * as separate tiles of one group. The group's outer corners are `rounded-2xl`;
 * the corners between two rows are `rounded-md`.
 */
const ROW_GAP = 2;

export function SettingsGroup({
  title,
  className,
  children,
  parentClassName,
}: {
  title?: string;
  /**
   * Row surface override. Rarely needed: inside `KortixBottomSheetModal` the
   * rows take `SHEET_ROW_SURFACE` on their own, elsewhere `bg-card`.
   */
  className?: string;
  children: React.ReactNode;
  parentClassName?: string;
}) {
  // toArray drops null / false, so conditional rows (`{cond && <SettingsRow/>}`) just work.
  const rows = React.Children.toArray(children).filter(React.isValidElement);
  const surface = React.useContext(SurfaceContext);
  if (rows.length === 0) return null;

  return (
    <View>
      {title ? (
        <Text variant="muted" className="mb-2 px-4">
          {title}
        </Text>
      ) : null}
      <View style={{ gap: ROW_GAP }} className={cn('rounded-2xl overflow-hidden', parentClassName)}>
        {rows.map((row, i) => (
          // `overflow-hidden` clips the row's pressed fill to the tile's corners.
          <View
            key={row.key ?? i}
            className={cn(
              'overflow-hidden rounded-sm',
              surface === 'sheet' ? SHEET_ROW_SURFACE : 'bg-card',
              // i === 0 && 'rounded-t-2xl',
              // i === rows.length - 1 && 'rounded-b-2xl',
              className
            )}>
            {row}
          </View>
        ))}
      </View>
    </View>
  );
}

/**
 * One row of a `SettingsGroup`, drawn on its own — for a virtualised list
 * (`FlatList`, `PageList` `data`), where the rows cannot share one group
 * `View`. `index` / `count` place it in its group: the first row takes the
 * group's top corners, the last its bottom corners, and every row after the
 * first sits `ROW_GAP` below the one before. It reads the same as the row
 * inside a `SettingsGroup` (COR-155).
 */
export function SettingsGroupItem({
  index,
  count,
  className,
  children,
}: {
  index: number;
  count: number;
  /** Row surface override, as `SettingsGroup`'s `className`. */
  className?: string;
  children: React.ReactNode;
}) {
  const surface = React.useContext(SurfaceContext);
  return (
    <View
      style={index > 0 ? { marginTop: ROW_GAP } : undefined}
      className={cn(
        'overflow-hidden rounded-sm',
        surface === 'sheet' ? SHEET_ROW_SURFACE : 'bg-card',
        index === 0 && 'rounded-t-2xl',
        index === count - 1 && 'rounded-b-2xl',
        className
      )}>
      {children}
    </View>
  );
}

export interface SettingsRowProps {
  /** Icon (from `@/lib/icons`) in the 20pt leading slot. */
  icon?: AppIcon;
  /** Custom leading content instead of `icon` (flag emoji, avatar). */
  leading?: React.ReactNode;
  label: string;
  /** Extra classes on the label `Text` (e.g. `font-semibold` for a name that
   *  should read heavier than the row's default weight). */
  labelClassName?: string;
  /**
   * One muted line under the label (an agent's mode and description, a
   * skill's description; Jay, 2026-09-22). List rows only: a settings row
   * stays icon · label · trailing.
   */
  description?: string;
  /** Read-only value shown on the right, e.g. the account email. */
  value?: string;
  /** Shows a check mark — the selected option in a picker list. */
  checked?: boolean;
  /** Omit for a row whose control lives in `right`. */
  onPress?: () => void;
  /** A second action on a long press (a session row's actions sheet). */
  onLongPress?: () => void;
  /** Spoken name of the long-press action. Needs `onLongPress`. */
  longPressLabel?: string;
  /** Spoken label when the visible label alone is not enough ("{title}, {status}, {time}"). */
  accessibilityLabel?: string;
  accessibilityHint?: string;
  /**
   * Trailing content. Defaults to a chevron when the row has `onPress`
   * (an arrow when `external`). Pass a Switch / ToggleGroup to replace it,
   * or `null` for nothing (picker rows).
   */
  right?: React.ReactNode;
  /** Opens a page outside the app (browser, device settings): arrow instead of chevron. */
  external?: boolean;
  badge?: string;
  destructive?: boolean;
  /**
   * The action exists but cannot run now (a session with no changes, a busy
   * session): the row stays in place at half opacity and ignores taps. Its
   * `value` says why.
   */
  disabled?: boolean;
  /** Wraps a long label onto more lines instead of truncating it (plan feature lists). */
  multiline?: boolean;
  /**
   * Tighter row: `py-2` instead of `py-3`, and the description sits directly
   * under the label. For a row inside the TRANSCRIPT (a `show` output), where
   * a settings screen's breathing room reads as a gap in the conversation
   * (Jay, 2026-09-22). A settings screen never sets it.
   */
  dense?: boolean;
}

const TRAILING_ICON_SIZE = 16;

export function SettingsRow({
  icon,
  leading,
  label,
  labelClassName,
  description,
  value,
  checked = false,
  onPress,
  onLongPress,
  longPressLabel,
  accessibilityLabel,
  accessibilityHint,
  right,
  external = false,
  badge,
  destructive = false,
  disabled = false,
  multiline = false,
  dense = false,
}: SettingsRowProps) {
  const trailing =
    right !== undefined ? (
      right
    ) : onPress ? (
      <Icon
        as={external ? ArrowUpRight : ChevronRight}
        className="text-muted-foreground/70"
        size={TRAILING_ICON_SIZE}
      />
    ) : null;

  const leadingContent =
    leading ??
    (icon ? (
      <Icon
        as={icon}
        size={18}
        className={destructive ? 'text-destructive' : 'text-foreground/80'}
      />
    ) : null);

  // Rows inside a card highlight on press (iOS list behaviour) instead of
  // scaling, which would pull them away from the card edges.
  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      disabled={disabled || !onPress}
      accessibilityRole={onPress ? 'button' : undefined}
      accessibilityState={disabled ? { disabled: true } : undefined}
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      // A screen reader cannot long-press: the second action is a named one.
      accessibilityActions={
        onLongPress
          ? [{ name: 'activate' }, { name: 'longpress', label: longPressLabel }]
          : undefined
      }
      onAccessibilityAction={
        onLongPress
          ? (event) => (event.nativeEvent.actionName === 'longpress' ? onLongPress() : onPress?.())
          : undefined
      }
      className="active:bg-accent">
      <View className={cn('flex-row items-center px-4', dense ? 'py-2' : 'py-3', disabled && 'opacity-50')}>
        {/* Leading slot is at least 20pt wide so icon rows share one label line.
            A row without leading content drops the slot and its gap entirely. */}
        {leadingContent ? (
          <View className="mr-3 min-w-5 items-center">{leadingContent}</View>
        ) : null}

        <View className="flex-1">
          <View className="flex-row items-center">
            <Text
              className={cn(
                destructive ? 'text-destructive' : 'text-foreground',
                multiline && 'flex-1',
                labelClassName,
              )}
              numberOfLines={multiline ? undefined : 1}>
              {label}
            </Text>
            {badge ? (
              <View className="ml-2 rounded-full bg-destructive/15 px-2 py-0.5">
                <Text className="font-roobert-medium text-[10px] text-destructive">{badge}</Text>
              </View>
            ) : null}
          </View>
          {description ? (
            <Text variant="muted" className={dense ? undefined : 'mt-0.5'} numberOfLines={1}>
              {description}
            </Text>
          ) : null}
        </View>

        {value ? (
          <Text variant="muted" className="ml-3 max-w-[60%]" numberOfLines={1}>
            {value}
          </Text>
        ) : null}
        {checked ? (
          <View className="ml-3">
            <Icon as={Check} className="text-primary" size={TRAILING_ICON_SIZE} />
          </View>
        ) : null}
        {trailing ? <View className="ml-3">{trailing}</View> : null}
      </View>
    </Pressable>
  );
}

const APPEARANCE_OPTIONS: {
  value: ThemePreference;
  icon: AppIcon;
  labelKey: string;
  fallback: string;
}[] = [
  { value: 'system', icon: Monitor, labelKey: 'theme.system', fallback: 'System' },
  { value: 'light', icon: Sun, labelKey: 'theme.light', fallback: 'Light' },
  { value: 'dark', icon: Moon, labelKey: 'theme.dark', fallback: 'Dark' },
];

/**
 * The Appearance row: shows the current mode as its value and opens a dialog
 * listing System, Light and Dark (icon · label · check on the active one).
 * Choosing an option applies it and closes the dialog. Drop it into a
 * `SettingsGroup` like any row.
 */
export function AppearanceRow() {
  const { t } = useTranslation();
  const preference = useThemeStore((s) => s.preference);
  const setPreference = useThemeStore((s) => s.setPreference);
  const [open, setOpen] = React.useState(false);
  // DialogContent's `w-full` resolves against the overlay's shrink-wrapped
  // animated wrappers on native, so the dialog collapsed to its content.
  // An explicit width: screen minus 16pt each side, capped at 420pt.
  const { width: windowWidth } = useWindowDimensions();
  const dialogWidth = Math.min(windowWidth - 32, 420);

  const current = APPEARANCE_OPTIONS.find((o) => o.value === preference) ?? APPEARANCE_OPTIONS[0];
  const title = t('theme.title', 'Appearance');

  return (
    <>
      <SettingsRow
        icon={Palette}
        label={title}
        value={t(current.labelKey, current.fallback)}
        onPress={() => {
          haptics.tap();
          setOpen(true);
        }}
      />
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="rounded-3xl" style={{ width: dialogWidth }}>
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
          </DialogHeader>
          {/* The dialog is `bg-popover`, the sheet colour. */}
          <SettingsGroup className={SHEET_ROW_SURFACE}>
            {APPEARANCE_OPTIONS.map((option) => (
              <SettingsRow
                key={option.value}
                icon={option.icon}
                label={t(option.labelKey, option.fallback)}
                checked={option.value === preference}
                right={null}
                onPress={() => {
                  haptics.selection();
                  void setPreference(option.value);
                  setOpen(false);
                }}
              />
            ))}
          </SettingsGroup>
        </DialogContent>
      </Dialog>
    </>
  );
}
