/**
 * PageHeader — unified top header for every page in the mobile app.
 *
 * Flat bar on the page's own background: lucide hamburger on the left (flips
 * to X when the drawer is open), muted-foreground title, and a "···" more
 * button on the right (opens the dock's More sheet; flips to X when open).
 *
 * Inside a PageBackProvider (a project page, see ProjectRoutes) the left
 * button is Go back instead of the hamburger: the page is a child of project
 * home, and back returns there.
 *
 * Pages that need additional action buttons (Files, Running Services, etc.)
 * render them through the `rightActions` slot. To replace the default
 * right button entirely, pass `hideRightDrawerToggle`.
 */

import * as React from 'react';
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useColorScheme } from 'nativewind';
import { ChevronLeft } from 'lucide-react-native';
import { Text } from '@/components/ui/text';
import { Button } from '@/components/ui/button';
import { AnimatedToggleIcon } from '@/components/kortix/animated-toggle-icon';
import { PlatformButton } from '@/components/kortix/platform-button';
import { haptics } from '@/lib/haptics';
import { THEME } from '@/lib/utils/theme';

const PageBackContext = React.createContext<(() => void) | null>(null);

/**
 * Gives every PageHeader below it a Go back button that runs `value`.
 * The project view route provides it with "return to project home".
 */
export const PageBackProvider = PageBackContext.Provider;

export interface PageHeaderProps {
  /** The title shown in the center. String, or a custom React node (e.g. an
   *  inline-editable input). If a string is given it's truncated to one line
   *  and styled with the canonical muted-foreground typography. */
  title: string | React.ReactNode;

  /** Left hamburger handler. Omit to hide the left icon entirely. */
  onOpenDrawer?: () => void;
  /** Right "···" more-button handler. Omit or combine with `hideRightDrawerToggle`. */
  onOpenRightDrawer?: () => void;

  /** Drawer state — hamburger rotates to X when true. */
  isDrawerOpen?: boolean;
  /** Right-drawer state — the "···" icon rotates to X when true. */
  isRightDrawerOpen?: boolean;

  /** Extra action buttons rendered to the LEFT of the right-drawer toggle.
   *  Typical use: icon buttons like search, filter, view-mode, etc. */
  rightActions?: React.ReactNode;
  /** Hide the default apps-grid right button (for pages that don't have a
   *  right drawer, or that want to fully control the right side via
   *  `rightActions`). */
  hideRightDrawerToggle?: boolean;

  /** Extra bottom padding below the title row. */
  paddingBottom?: number;

  /** Optional className passed to the outer View (e.g. to override bg). */
  className?: string;
}

const ICON_SIZE = 20;

export function PageHeader({
  title,
  onOpenDrawer,
  onOpenRightDrawer,
  isDrawerOpen,
  isRightDrawerOpen,
  rightActions,
  hideRightDrawerToggle,
  paddingBottom = 12,
  className,
}: PageHeaderProps) {
  const insets = useSafeAreaInsets();
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  // AnimatedToggleIcon takes a raw `color` prop (Reanimated/Ionicons can't
  // resolve a className), so the foreground token is read from THEME — the
  // hex-free source of truth for exactly this "className can't reach it"
  // case (see lib/theme-colors.ts's header comment for the same pattern).
  const iconColor = isDark ? THEME.dark.foreground : THEME.light.foreground;
  const onBack = React.useContext(PageBackContext);

  const titleNode =
    typeof title === 'string' ? (
      <Text
        className="text-base font-medium text-muted-foreground"
        numberOfLines={1}
      >
        {title}
      </Text>
    ) : (
      title
    );

  const showRightDrawer = !hideRightDrawerToggle && !!onOpenRightDrawer;

  return (
    <View
      style={{ paddingTop: insets.top, paddingBottom }}
      className={`px-4 bg-background ${className ?? ''}`}
    >
      <View className="flex-row items-center">
        {/* Left — Go back on a project page (same button as SettingsHeader),
            otherwise the hamburger (flips to X when drawer is open). Same
            rounded secondary icon button as the floating menu button on
            project home. */}
        {onBack ? (
          <View className="mr-3">
            <PlatformButton
              systemImage="chevron.left"
              icon={ChevronLeft}
              fallbackVariant="secondary"
              accessibilityLabel="Go back"
              onPress={() => {
                haptics.tap();
                onBack();
              }}
            />
          </View>
        ) : onOpenDrawer && (
          <Button
            variant="secondary"
            size="icon"
            onPress={onOpenDrawer}
            accessibilityLabel="Open menu"
            className="mr-3"
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          >
            <AnimatedToggleIcon
              open={!!isDrawerOpen}
              color={iconColor}
              icon="menu-lucide"
              size={ICON_SIZE}
            />
          </Button>
        )}

        {/* Title — flexes to fill remaining space */}
        <View className="flex-1 flex-row items-center">{titleNode}</View>

        {/* Right — optional custom actions + apps-grid drawer toggle */}
        {rightActions && (
          <View className="flex-row items-center">{rightActions}</View>
        )}
        {showRightDrawer && (
          <Button
            variant="ghost"
            onPress={onOpenRightDrawer}
            accessibilityLabel="More options"
            className="ml-3 h-auto w-auto p-1"
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          >
            <AnimatedToggleIcon
              open={!!isRightDrawerOpen}
              color={iconColor}
              icon="ellipsis-horizontal"
              size={ICON_SIZE}
            />
          </Button>
        )}
      </View>
    </View>
  );
}
