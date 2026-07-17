/**
 * ChatActionsSheet — raised by long-pressing the dock pill.
 *
 * Replaces BottomBar's "···" session menu. Gating is decided by
 * `chatActionItems`, which mirrors BottomBar's original rules; this component
 * only renders and delegates.
 */
import * as React from 'react';
import { ChevronDown, MoreHorizontal } from 'lucide-react-native';

import { Icon } from '@/components/ui/icon';
import { ListRow } from '@/components/ui/list-row';
import { Separator } from '@/components/ui/separator';
import { Sheet, SheetBody, SheetHeader, type SheetRef } from '@/components/ui/sheet';
import {
  chatActionItems,
  type ChatActionGates,
  type ChatActionId,
} from '@/lib/session/dock-menu';
import { DOCK_ICONS } from './dock-icons';

export interface ChatActionsSheetProps {
  title: string;
  gates: ChatActionGates;
  onAction: (id: ChatActionId) => void;
}

export const ChatActionsSheet = React.forwardRef<SheetRef, ChatActionsSheetProps>(
  ({ title, gates, onAction }, ref) => {
    const innerRef = React.useRef<SheetRef>(null);
    const [showSecondary, setShowSecondary] = React.useState(false);

    React.useImperativeHandle(ref, () => ({
      open: () => {
        setShowSecondary(false);
        innerRef.current?.open();
      },
      close: () => innerRef.current?.close(),
    }));

    const actions = React.useMemo(() => chatActionItems(gates), [gates]);
    const primary = actions.filter((a) => !a.secondary && !a.destructive);
    const secondary = actions.filter((a) => a.secondary);
    const destructive = actions.filter((a) => a.destructive);

    const handle = React.useCallback(
      (id: ChatActionId) => {
        innerRef.current?.close();
        onAction(id);
      },
      [onAction],
    );

    return (
      <Sheet ref={innerRef} enablePanDownToClose>
        <SheetHeader title={title} />
        <SheetBody className="px-0 pb-2">
          {primary.map((a) => (
            <ListRow
              key={a.id}
              title={a.label}
              left={<Icon as={DOCK_ICONS[a.icon]} size={18} className="text-foreground" />}
              right={null}
              divider={false}
              onPress={() => handle(a.id)}
            />
          ))}

          {secondary.length > 0 ? (
            showSecondary ? (
              <>
                <Separator className="mx-4 my-1" />
                {secondary.map((a) => (
                  <ListRow
                    key={a.id}
                    title={a.label}
                    left={<Icon as={DOCK_ICONS[a.icon]} size={18} className="text-foreground" />}
                    right={null}
                    divider={false}
                    onPress={() => handle(a.id)}
                  />
                ))}
              </>
            ) : (
              <ListRow
                title="More"
                left={<Icon as={MoreHorizontal} size={18} className="text-muted-foreground" />}
                right={<Icon as={ChevronDown} size={18} className="text-muted-foreground" />}
                divider={false}
                onPress={() => setShowSecondary(true)}
              />
            )
          ) : null}

          {destructive.length > 0 ? (
            <>
              <Separator className="mx-4 my-1" />
              {destructive.map((a) => (
                <ListRow
                  key={a.id}
                  title={a.label}
                  variant="destructive"
                  left={<Icon as={DOCK_ICONS[a.icon]} size={18} className="text-destructive" />}
                  divider={false}
                  onPress={() => handle(a.id)}
                />
              ))}
            </>
          ) : null}
        </SheetBody>
      </Sheet>
    );
  },
);
ChatActionsSheet.displayName = 'ChatActionsSheet';
