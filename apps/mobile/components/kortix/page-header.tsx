/**
 * PageHeader — the header of every project tool page (Agents, Skills,
 * Schedules, Review, Secrets, Webhooks, Channels, Terminal, …).
 *
 * One row, three equal-width columns (Jay, 2026-09-22):
 *
 *   hamburger / back      Title, centred            actions · + · ···
 *
 * The left and right columns are each `flex-1`, so they take equal width
 * regardless of how many buttons either one holds; the title sits between
 * them and is centred in the column that remains, which is centred in the
 * row. A string title renders as `Text variant="h3"`, centred and truncated
 * to one line. A node title (an inline-editable field, a search input) is
 * rendered as passed and keeps whatever layout it already declares — it now
 * has a column's worth of width, not the whole row, so a wide custom title
 * truncates sooner than it used to.
 *
 * Before 2026-09-22 this was two rows — a control row of buttons, then a
 * full-width title row below it, left-aligned to the hamburger. That
 * `pageChrome` doc reference is now history; the layout below is the current
 * shape, not the size of an older Sessions-page title row.
 *
 * `onAdd` puts the page's one create action in the right column, before
 * `···`. Every control is a 40pt `icon` ghost button; the first and the last
 * sit on the 16pt padding edge (`-ml-2.5` on the hamburger, `-mr-2.5` on the
 * last button), like the floating header.
 *
 * Project pages show the hamburger: the project drawer opens from every
 * project page (see ProjectRoutes), and **nothing ever takes its place** (Jay,
 * 2026-09-22). `onBack` is for a detail shown inside a page (an agent, a
 * skill): the app's Go back button (`PlatformButton`, the one `SettingsHeader`
 * uses) sits beside the hamburger, back to the page's list. A folder view
 * passes no `onBack`: its breadcrumb goes up.
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
  /** The page title, centred between the left and right columns. A string
   *  renders as `Text variant="h3"`, centred, one line; a node replaces it
   *  (an inline-editable input) and keeps its own layout. */
  title: string | React.ReactNode;

  /** The page's create action: a `+` button in the right column, before `···`. */
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

  /** Extra `icon` ghost buttons in the right column, before `+` and `···`. */
  rightActions?: React.ReactNode;
  /** Hide the default apps-grid right button (for pages that don't have a
   *  right drawer, or that want to fully control the right side via
   *  `rightActions`). */
  hideRightDrawerToggle?: boolean;

  /** Bottom padding below the row. `PageContent` adds 4pt more. */
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
      <Text variant="h4" accessibilityRole="header" numberOfLines={1} className="text-center">
        {title}
      </Text>
    ) : (
      title
    );

  const showRightDrawer = !hideRightDrawerToggle && !!onOpenRightDrawer;

  return (
    <View style={{ paddingBottom }} className={`bg-background ${className ?? ''}`}>
      {/* `SettingsHeader`'s metrics (56pt min height, 12pt below). Three
          flex-1 columns: the outer two take equal width no matter how many
          buttons either holds, so the title is centred in the row, not in
          whichever space happened to be left over. */}
      <View
        className="flex-row items-center px-4 pb-3"
        style={{ paddingTop: Math.max(insets.top, 10) + 6, minHeight: 56 }}>
        <View className="flex-1 flex-row items-center gap-2">
          {onOpenDrawer ? <MenuButton onPress={onOpenDrawer} /> : null}
          {onBack ? (
            <PlatformButton
              systemImage="chevron.left"
              icon={CaretLeftIcon}
              fallbackVariant="secondary"
              accessibilityLabel="Go back"
              onPress={onBack}
            />
          ) : null}
        </View>

        <View className="flex-1 items-center px-1">{titleNode}</View>

        {/* The last button holds the padding edge: -mr-2.5 mirrors the
            hamburger's -ml-2.5. */}
        <View className="flex-1 flex-row items-center justify-end">
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
      </View>
    </View>
  );
}
