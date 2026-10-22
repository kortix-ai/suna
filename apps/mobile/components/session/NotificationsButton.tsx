/**
 * NotificationsButton — the bell at the top right of project home. It opens
 * the Notifications page (`/projects/[id]/inbox`, KRTX-1742): the caller's
 * notifications across every project. It replaces the drawer's Notifications
 * row.
 *
 * The mirror of `MenuButton` on the row's other end: a ghost icon button
 * (`header-button.ts`: 44pt / 22pt icon on iOS, 40pt / 20pt on Android),
 * `-mr-2.5` so the glyph sits on the page's right padding edge,
 * 10pt hit slop. Unread: a `CountBadge tone="waiting"` on the top-right
 * corner (web's `NotificationBell`), on the page colour so the bell does not
 * show through its tint. Hidden at 0, `99+` above 99.
 */

import * as React from 'react';
import { View } from 'react-native';

import { HEADER_BUTTON_SIZE, HEADER_ICON_SIZE } from '@/components/kortix/header-button';
import { CountBadge } from '@/components/kortix/count-badge';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { BellIcon } from '@/lib/icons';

export function NotificationsButton({ unreadCount, onPress }: { unreadCount: number; onPress: () => void }) {
  return (
    <Button
      variant="ghost"
      size={HEADER_BUTTON_SIZE}
      className="-mr-2.5 rounded-full bg-background"
      onPress={onPress}
      accessibilityLabel={unreadCount > 0 ? `Notifications, ${unreadCount} unread` : 'Notifications'}
      hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
      <Icon as={BellIcon} size={HEADER_ICON_SIZE} className="text-foreground" />
      {unreadCount > 0 ? (
        <View className="absolute -right-0.5 -top-0.5 rounded-[5px] bg-background" pointerEvents="none">
          <CountBadge count={unreadCount} tone="waiting" />
        </View>
      ) : null}
    </Button>
  );
}
