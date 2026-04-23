/**
 * PageHeader — unified top header for every page in the mobile app.
 *
 * Matches the session page header: bg-muted surface, lucide hamburger on the
 * left (flips to X when the drawer is open), muted-foreground title, and
 * apps-grid icon on the right (flips to X when the right drawer is open).
 *
 * Pages that need additional action buttons (Files, Running Services, etc.)
 * render them through the `rightActions` slot. To replace the default
 * apps-grid right button entirely, pass `hideRightDrawerToggle`.
 */

import * as React from 'react';
import { TouchableOpacity, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useColorScheme } from 'nativewind';
import { Text } from '@/components/ui/text';
import { AnimatedToggleIcon } from '@/components/ui/animated-toggle-icon';

export interface PageHeaderProps {
  /** The title shown in the center. String, or a custom React node (e.g. an
   *  inline-editable input). If a string is given it's truncated to one line
   *  and styled with the canonical muted-foreground typography. */
  title: string | React.ReactNode;

  /** Left hamburger handler. Omit to hide the left icon entirely. */
  onOpenDrawer?: () => void;
  /** Right apps-grid handler. Omit or combine with `hideRightDrawerToggle`. */
  onOpenRightDrawer?: () => void;

  /** Drawer state — hamburger rotates to X when true. */
  isDrawerOpen?: boolean;
  /** Right-drawer state — apps-grid rotates to X when true. */
  isRightDrawerOpen?: boolean;

  /** Extra action buttons rendered to the LEFT of the right-drawer toggle.
   *  Typical use: icon buttons like search, filter, view-mode, etc. */
  rightActions?: React.ReactNode;
  /** Hide the default apps-grid right button (for pages that don't have a
   *  right drawer, or that want to fully control the right side via
   *  `rightActions`). */
  hideRightDrawerToggle?: boolean;

  /** Extra bottom padding. The default (36) matches the session header so
   *  a `<PageContent>` below can tuck under with rounded corners. Override
   *  to 12 for pages that don't use `<PageContent>` (flat layout). */
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
  paddingBottom = 36,
  className,
}: PageHeaderProps) {
  const insets = useSafeAreaInsets();
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const iconColor = isDark ? '#F8F8F8' : '#121215';

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
      className={`px-4 bg-muted ${className ?? ''}`}
    >
      <View className="flex-row items-center">
        {/* Left — hamburger (flips to X when drawer is open) */}
        {onOpenDrawer && (
          <TouchableOpacity
            onPress={onOpenDrawer}
            className="mr-3 p-1"
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          >
            <AnimatedToggleIcon
              open={!!isDrawerOpen}
              color={iconColor}
              icon="menu-lucide"
              size={ICON_SIZE}
            />
          </TouchableOpacity>
        )}

        {/* Title — flexes to fill remaining space */}
        <View className="flex-1 flex-row items-center">{titleNode}</View>

        {/* Right — optional custom actions + apps-grid drawer toggle */}
        {rightActions && (
          <View className="flex-row items-center">{rightActions}</View>
        )}
        {showRightDrawer && (
          <TouchableOpacity
            onPress={onOpenRightDrawer}
            className="ml-3 p-1"
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          >
            <AnimatedToggleIcon
              open={!!isRightDrawerOpen}
              color={iconColor}
              icon="apps-outline"
              size={ICON_SIZE}
            />
          </TouchableOpacity>
        )}
      </View>
    </View>
  );
}
