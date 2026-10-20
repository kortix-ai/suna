/**
 * PageHeader — the header of every project tool page (Agents, Skills,
 * Schedules, Review, Secrets, Channels, Terminal, …).
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
 * iOS 26+ (Jay, 2026-10-20): the right column's buttons (`rightActions` and
 * `+`) share one Liquid Glass capsule, a button group (a circle for one
 * button, a pill for two or more), on the 16pt edge with no `-mr-2.5` pull.
 * The hamburger is its own glass circle (`MenuButton`). Android and older iOS
 * keep the plain ghost buttons.
 *
 * Project pages show the hamburger: the project drawer opens from every
 * project page (see ProjectRoutes) (Jay, 2026-09-22). One exception: a
 * pushed sub-page (project Settings from Settings, Schedules or Secrets from
 * project Settings; Jay, 2026-09-23) passes `onBack` and no `onOpenDrawer`,
 * so the app's Go back button (`BackButton`, the one `SettingsHeader`
 * uses) takes the hamburger's place and returns to the page it was opened
 * from. A page that passes both shows Go back beside the hamburger, back to
 * a detail's list. A folder view passes no `onBack`: its breadcrumb goes up.
 */

import * as React from 'react';
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useColorScheme } from 'nativewind';
import { Text } from '@/components/ui/text';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { CaretLeftIcon, PlusIcon } from '@/lib/icons';
import { BackButton } from '@/components/kortix/back-button';
import { MenuButton } from '@/components/kortix/menu-button';
import { THEME } from '@/lib/utils/theme';
import { LIQUID_GLASS_AVAILABLE, LiquidGlassCapsule } from '@/components/kortix/liquid-glass-capsule';

interface PageHeaderProps {
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
  /**
   * Go back (`BackButton` chevron). Alone for a pushed sub-page (no
   * `onOpenDrawer`), in the hamburger's place; beside the hamburger otherwise.
   */
  onBack?: () => void;
  /** Extra `icon` ghost buttons in the right column, before `+`. */
  rightActions?: React.ReactNode;

  /** Bottom padding below the row. `PageContent` adds 4pt more. */
  paddingBottom?: number;

  /**
   * The title takes all the width the buttons leave (the Browser's address
   * field), instead of the centred third. The outer columns shrink to their
   * buttons.
   */
  fillTitle?: boolean;

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
  rightActions,
  paddingBottom = 0,
  fillTitle = false,
  className,
}: PageHeaderProps) {
  const insets = useSafeAreaInsets();

  const titleNode =
    typeof title === 'string' ? (
      <Text variant="h4" accessibilityRole="header" numberOfLines={1} className="text-center">
        {title}
      </Text>
    ) : (
      title
    );

  return (
    <View style={{ paddingBottom }} className={`bg-background ${className ?? ''}`}>
      {/* `SettingsHeader`'s metrics (56pt min height, 12pt below). Three
          flex-1 columns: the outer two take equal width no matter how many
          buttons either holds, so the title is centred in the row, not in
          whichever space happened to be left over. */}
      <View
        className="flex-row items-center px-4 pb-3"
        style={{ paddingTop: Math.max(insets.top, 10) + 6, minHeight: 56 }}>
        <View className={`${fillTitle ? '' : 'flex-1 '}flex-row items-center gap-2`}>
          {onOpenDrawer ? <MenuButton onPress={onOpenDrawer} /> : null}
          {onBack ? (
            <BackButton onPress={onBack} />
          ) : null}
        </View>

        <View className={fillTitle ? 'flex-1 flex-row items-center px-2' : 'flex-1 items-center px-1'}>{titleNode}</View>

        {/* The last button holds the padding edge: -mr-2.5 mirrors the
            hamburger's -ml-2.5. */}
        <View className={`${fillTitle ? '' : 'flex-1 '}flex-row items-center justify-end`}>
          <View className={LIQUID_GLASS_AVAILABLE ? 'flex-row items-center rounded-full' : '-mr-2.5 flex-row items-center'}>
            {LIQUID_GLASS_AVAILABLE && (rightActions || onAdd) ? <LiquidGlassCapsule /> : null}
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
          </View>
        </View>
      </View>
    </View>
  );
}
