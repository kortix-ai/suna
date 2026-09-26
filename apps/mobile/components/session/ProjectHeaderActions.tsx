/**
 * ProjectHeaderActions — the right end of the floating header on project home,
 * in a thread, and on a connecting session: the agent pill (`children`), and
 * optionally a `···` button after it.
 *
 * The `···` button opened the project sheet (`CustomizeSheet`), which is
 * deleted (COR-123/COR-160 Task 3). Project home and the connecting state
 * pass no `onOpenMore`, so it never renders there. The thread's is back
 * (COR-140 Task 5): `ProjectScreen` passes `onOpenMore` for the open thread's
 * project session, opening `SessionActionsSheet`.
 *
 * `onShare` (KRTX-248) adds a Share button before the `···`: the thread's
 * prominent Share entry. It opens the same `SessionActionsSheet`, straight to
 * its Share view — never a second share sheet.
 *
 * `-mr-2.5` mirrors `MenuButton`'s `-ml-2.5`: the last control's right edge
 * sits on the page's 16pt padding edge. When the `···` button is absent, the
 * pill itself must hold that edge — callers pass `edge={false}` on the pill
 * only when `onOpenMore` is also passed.
 */
import * as React from 'react';
import { Keyboard, View } from 'react-native';

import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { DotsThreeIcon, ExportIcon } from '@/lib/icons';

interface ProjectHeaderActionsProps {
  /** Omit to hide the `···` button. */
  onOpenMore?: () => void;
  /** Omit to hide the Share button (a session the viewer cannot share). */
  onShare?: () => void;
  /** Controls before the Share button and the `···` (the thread's `SubAgentHeaderChip`). */
  children?: React.ReactNode;
}

export function ProjectHeaderActions({ onOpenMore, onShare, children }: ProjectHeaderActionsProps) {
  return (
    <View className="shrink flex-row items-center">
      {children}
      {onShare ? (
        <Button
          variant="ghost"
          size="icon"
          className="rounded-full bg-background"
          onPress={() => {
            Keyboard.dismiss();
            onShare();
          }}
          accessibilityLabel="Share session">
          <Icon as={ExportIcon} size={20} className="text-foreground" />
        </Button>
      ) : null}
      {onOpenMore ? (
        <Button
          variant="ghost"
          size="icon"
          className="-mr-2.5 rounded-full bg-background"
          onPress={() => {
            Keyboard.dismiss();
            onOpenMore();
          }}
          accessibilityLabel="Session actions"
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
          <Icon as={DotsThreeIcon} size={20} className="text-foreground" />
        </Button>
      ) : null}
    </View>
  );
}
