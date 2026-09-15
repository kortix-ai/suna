/**
 * Settings list — the one layout for every settings-style screen: the
 * (settings) stack, the Account tab, Accounts, Billing.
 *
 *   <SettingsHeader title="Accounts" right={<PlatformButton … />} />
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
  ArrowUpRight,
  Check,
  ChevronLeft,
  ChevronRight,
  Monitor,
  Moon,
  Palette,
  Sun,
  type LucideIcon,
} from 'lucide-react-native';

import { Card } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { Separator } from '@/components/ui/separator';
import { Text } from '@/components/ui/text';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { PlatformButton } from '@/components/kortix/platform-button';
import { haptics } from '@/lib/haptics';
import { cn } from '@/lib/utils/index';
import { useThemeStore, type ThemePreference } from '@/stores/theme-store';

/**
 * Screen header: Go back (native SwiftUI button on iOS, secondary pill on
 * Android), the title, and an optional trailing action. Tab roots pass
 * `showBack={false}`.
 */
export function SettingsHeader({
  title,
  showBack = true,
  right,
  align = 'start',
  transparent = false,
}: {
  title: string;
  showBack?: boolean;
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
}) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const topPadding = Math.max(insets.top, 10) + 6;
  const centered = align === 'center';

  const handleBack = () => {
    haptics.tap();
    // The screen can be first in history (deep link / cold start): go home.
    if (router.canGoBack()) router.back();
    else router.replace('/projects');
  };

  return (
    <View
      className={cn('flex-row items-center gap-3 px-5 pb-3', !transparent && 'bg-background')}
      style={{ paddingTop: topPadding, minHeight: 56 }}>
      {showBack ? (
        <PlatformButton
          systemImage="chevron.left"
          icon={ChevronLeft}
          fallbackVariant="secondary"
          accessibilityLabel="Go back"
          onPress={handleBack}
        />
      ) : centered ? (
        <View className="size-10" />
      ) : null}
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

/** Scrollable screen body: 20pt side margins, 18pt between groups. */
export function SettingsPage({
  children,
  header,
  hero,
  paddingBottom,
  contentInsetAdjustmentBehavior,
  refreshControl,
}: {
  children: React.ReactNode;
  /** Content above the first group (e.g. the profile avatar). */
  header?: React.ReactNode;
  /**
   * Full-bleed block that scrolls with the page, above the body (the Billing
   * balance). The body then sits on a `rounded-t-3xl` sheet that overlaps the
   * hero's bottom 24pt, so the hero needs at least that much bottom padding.
   */
  hero?: React.ReactNode;
  /** Defaults to the safe-area inset + 28pt. Tab roots pass the tab bar clearance. */
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
          'px-5 pb-2 pt-1',
          hero && '-mt-6 flex-1 rounded-t-3xl bg-background pt-6'
        )}
        style={{ gap: 18 }}>
        {header}
        {children}
      </View>
    </ScrollView>
  );
}

/** Sentence-case title above a borderless rounded card; renders nothing when empty. */
export function SettingsGroup({ title, children }: { title?: string; children: React.ReactNode }) {
  // toArray drops null / false, so conditional rows (`{cond && <SettingsRow/>}`) just work.
  const rows = React.Children.toArray(children).filter(React.isValidElement);
  if (rows.length === 0) return null;

  return (
    <View>
      {title ? (
        <Text variant="muted" className="mb-2 px-4">
          {title}
        </Text>
      ) : null}
      <Card className="gap-0 overflow-hidden rounded-2xl border-0 py-0">
        {rows.map((row, i) => (
          <React.Fragment key={row.key ?? i}>
            {i > 0 ? <Separator /> : null}
            {row}
          </React.Fragment>
        ))}
      </Card>
    </View>
  );
}

export interface SettingsRowProps {
  /** Lucide icon in the 20pt leading slot. */
  icon?: LucideIcon;
  /** Custom leading content instead of `icon` (flag emoji, avatar). */
  leading?: React.ReactNode;
  label: string;
  /** Read-only value shown on the right, e.g. the account email. */
  value?: string;
  /** Shows a check mark — the selected option in a picker list. */
  checked?: boolean;
  /** Omit for a row whose control lives in `right`. */
  onPress?: () => void;
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
}

const TRAILING_ICON = { size: 16, strokeWidth: 2.75 } as const;

export function SettingsRow({
  icon,
  leading,
  label,
  value,
  checked = false,
  onPress,
  right,
  external = false,
  badge,
  destructive = false,
}: SettingsRowProps) {
  const trailing =
    right !== undefined ? (
      right
    ) : onPress ? (
      <Icon
        as={external ? ArrowUpRight : ChevronRight}
        className="text-muted-foreground/70"
        {...TRAILING_ICON}
      />
    ) : null;

  const leadingContent =
    leading ??
    (icon ? (
      <Icon
        as={icon}
        size={18}
        className={destructive ? 'text-destructive' : 'text-foreground/80'}
        strokeWidth={2.2}
      />
    ) : null);

  // Rows inside a card highlight on press (iOS list behaviour) instead of
  // scaling, which would pull them away from the card edges.
  return (
    <Pressable onPress={onPress} disabled={!onPress} className="active:bg-accent">
      <View className="flex-row items-center px-4 py-3.5">
        {/* Leading slot is at least 20pt wide so icon rows share one label line.
            A row without leading content drops the slot and its gap entirely. */}
        {leadingContent ? (
          <View className="mr-3 min-w-5 items-center">{leadingContent}</View>
        ) : null}

        <View className="flex-1 flex-row items-center">
          <Text className={destructive ? 'text-destructive' : 'text-foreground'} numberOfLines={1}>
            {label}
          </Text>
          {badge ? (
            <View className="ml-2 rounded-full bg-destructive/15 px-2 py-0.5">
              <Text className="font-roobert-medium text-[10px] text-destructive">{badge}</Text>
            </View>
          ) : null}
        </View>

        {value ? (
          <Text variant="muted" className="ml-3 max-w-[60%]" numberOfLines={1}>
            {value}
          </Text>
        ) : null}
        {checked ? (
          <View className="ml-3">
            <Icon as={Check} className="text-primary" {...TRAILING_ICON} />
          </View>
        ) : null}
        {trailing ? <View className="ml-3">{trailing}</View> : null}
      </View>
    </Pressable>
  );
}

const APPEARANCE_OPTIONS: {
  value: ThemePreference;
  icon: LucideIcon;
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
          <SettingsGroup>
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
