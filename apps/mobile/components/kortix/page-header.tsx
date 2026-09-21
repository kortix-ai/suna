/**
 * PageHeader — the header of every project tool page (Agents, Skills,
 * Schedules, Review, Secrets, Webhooks, Channels, Terminal, …).
 *
 * The Sessions page's layout (`SettingsHeader largeTitle`, design.md §7), so
 * every project page reads the same (Jay, 2026-09-21):
 *
 *   control row   hamburger · · · · · · · · · actions · + · ···
 *   title row     Title                       (`Text variant="h3"`)
 *
 * The title is the page's largest text, in the foreground colour: 24pt Roobert
 * semibold, the size of the Account tab's and the Sessions page's title. It is
 * not a grey 16pt label beside the hamburger any more.
 *
 * `onAdd` puts the page's one create action in the control row, before `···`.
 * The search field below the title then takes the full width
 * (`SearchListHeader` without `onAdd`). Every control is a 40pt `icon` ghost
 * button; the first and the last sit on the 16pt padding edge (`-ml-2.5` on
 * the hamburger, `-mr-2.5` on the last button), like the floating header.
 *
 * Project pages show the hamburger: the project drawer opens from every
 * project page (see ProjectRoutes). `onBack` is for a detail shown inside a
 * page (an agent, a skill): the app's Go back button (`PlatformButton`, the one
 * `SettingsHeader` uses) takes the hamburger's place, back to the page's list.
 */

import * as React from 'react';
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useColorScheme } from 'nativewind';
import { Text } from '@/components/ui/text';
import { Button } from '@/components/ui/button';
import { AnimatedToggleIcon } from '@/components/kortix/animated-toggle-icon';
import { Icon } from '@/components/ui/icon';
import { CaretLeftIcon, DotsThreeIcon, PlusIcon } from '@/lib/icons';
import { PlatformButton } from '@/components/kortix/platform-button';
import { MenuButton } from '@/components/kortix/menu-button';
import { THEME } from '@/lib/utils/theme';

export interface PageHeaderProps {
  /** The page title, below the control row. A string renders as
   *  `Text variant="h3"` on one line; a node replaces it (an inline-editable
   *  input). */
  title: string | React.ReactNode;

  /** The page's create action: a `+` button in the control row, before `···`. */
  onAdd?: () => void;
  /** Its accessibility label, e.g. "New agent". */
  addLabel?: string;

  /** Left hamburger handler. Omit to hide the left icon entirely. */
  onOpenDrawer?: () => void;
  /** A detail inside the page: Go back takes the hamburger's place. */
  onBack?: () => void;
  /** Right "···" more-button handler. Omit or combine with `hideRightDrawerToggle`. */
  onOpenRightDrawer?: () => void;

  /** Ignored: the hamburger is a static icon (Jay, 2026-09-16). Kept so the
   *  pages that spread `pageChrome` still type-check. */
  isDrawerOpen?: boolean;
  /** Right-drawer state — the "···" icon rotates to X when true. */
  isRightDrawerOpen?: boolean;

  /** Extra `icon` ghost buttons in the control row, before `+` and `···`. */
  rightActions?: React.ReactNode;
  /** Hide the default apps-grid right button (for pages that don't have a
   *  right drawer, or that want to fully control the right side via
   *  `rightActions`). */
  hideRightDrawerToggle?: boolean;

  /** Bottom padding below the title row. `PageContent` adds 4pt more. */
  paddingBottom?: number;

  /** Optional className passed to the outer View (e.g. to override bg). */
  className?: string;
}

const ICON_SIZE = 20;

export function PageHeader({
  title,
  onAdd,
  addLabel = 'New',
  onOpenDrawer,
  onBack,
  onOpenRightDrawer,
  isRightDrawerOpen,
  rightActions,
  hideRightDrawerToggle,
  paddingBottom = 0,
  className,
}: PageHeaderProps) {
  const insets = useSafeAreaInsets();
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  // AnimatedToggleIcon takes a raw `color` prop (Reanimated can't
  // resolve a className), so the foreground token is read from THEME — the
  // hex-free source of truth for exactly this "className can't reach it"
  // case (see lib/theme-colors.ts's header comment for the same pattern).
  const iconColor = isDark ? THEME.dark.foreground : THEME.light.foreground;

  const titleNode =
    typeof title === 'string' ? (
      <Text variant="h3" accessibilityRole="header" numberOfLines={1}>
        {title}
      </Text>
    ) : (
      title
    );

  const showRightDrawer = !hideRightDrawerToggle && !!onOpenRightDrawer;

  return (
    <View style={{ paddingBottom }} className={`bg-background ${className ?? ''}`}>
      {/* Control row: `SettingsHeader`'s metrics (56pt min height, 12pt below). */}
      <View
        className="flex-row items-center justify-between px-4 pb-3"
        style={{ paddingTop: Math.max(insets.top, 10) + 6, minHeight: 56 }}>
        {onBack ? (
          <PlatformButton
            systemImage="chevron.left"
            icon={CaretLeftIcon}
            fallbackVariant="secondary"
            accessibilityLabel="Go back"
            onPress={onBack}
          />
        ) : onOpenDrawer ? (
          <MenuButton onPress={onOpenDrawer} />
        ) : (
          <View />
        )}

        {/* The last button holds the padding edge: -mr-2.5 mirrors the
            hamburger's -ml-2.5. */}
        <View className="-mr-2.5 flex-row items-center">
          {rightActions}
          {onAdd ? (
            <Button
              variant="ghost"
              size="icon"
              className="rounded-full"
              onPress={onAdd}
              accessibilityLabel={addLabel}
              hitSlop={{ top: 10, bottom: 10 }}>
              <Icon as={PlusIcon} size={ICON_SIZE} className="text-foreground" />
            </Button>
          ) : null}
          {showRightDrawer ? (
            <Button
              variant="ghost"
              size="icon"
              className="rounded-full"
              onPress={onOpenRightDrawer}
              accessibilityLabel="Project sections"
              hitSlop={{ top: 10, bottom: 10, right: 10 }}>
              <AnimatedToggleIcon
                open={!!isRightDrawerOpen}
                color={iconColor}
                icon={DotsThreeIcon}
                size={ICON_SIZE}
              />
            </Button>
          ) : null}
        </View>
      </View>

      {/* Title row: the Sessions page's and the Account tab's 40pt title row. */}
      <View className="h-10 justify-center px-4 pb-1">{titleNode}</View>
    </View>
  );
}
