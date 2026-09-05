/**
 * ProjectMoreSheet — everything the right drawer held that isn't in the dock's
 * short menu, grouped. Nothing was removed in the redesign; it lives one tap
 * deeper than it used to.
 */
import * as React from 'react';
import { View } from 'react-native';

import { Badge } from '@/components/ui/badge';
import { Icon } from '@/components/ui/icon';
import { ListRow } from '@/components/ui/list-row';
import { Sheet, SheetBody, SheetHeader, type SheetRef } from '@/components/ui/sheet';
import { Text } from '@/components/ui/text';
import { MORE_SHEET_GROUPS } from '@/lib/session/dock-menu';
import { DOCK_ICONS } from './dock-icons';

export interface ProjectMoreSheetProps {
  onNavigate: (pageId: string) => void;
  changesBadgeCount?: number;
}

export const ProjectMoreSheet = React.forwardRef<SheetRef, ProjectMoreSheetProps>(
  ({ onNavigate, changesBadgeCount = 0 }, ref) => {
    const innerRef = React.useRef<SheetRef>(null);

    React.useImperativeHandle(ref, () => ({
      open: () => innerRef.current?.open(),
      close: () => innerRef.current?.close(),
    }));

    const handlePress = React.useCallback(
      (pageId: string) => {
        innerRef.current?.close();
        onNavigate(pageId);
      },
      [onNavigate],
    );

    return (
      <Sheet ref={innerRef} enablePanDownToClose>
        <SheetHeader title="More" />
        <SheetBody className="px-0 pb-2">
          {MORE_SHEET_GROUPS.map((group) => (
            <View key={group.title}>
              <Text variant="label" className="px-4 pb-1 pt-3 text-muted-foreground">
                {group.title}
              </Text>
              {group.items.map((item) => (
                <ListRow
                  key={item.pageId}
                  title={item.label}
                  left={<Icon as={DOCK_ICONS[item.icon]} size={18} className="text-foreground" />}
                  right={
                    item.pageId === 'page:changes' && changesBadgeCount > 0 ? (
                      <Badge>
                        <Text>{changesBadgeCount}</Text>
                      </Badge>
                    ) : undefined
                  }
                  divider={false}
                  onPress={() => handlePress(item.pageId)}
                />
              ))}
            </View>
          ))}
        </SheetBody>
      </Sheet>
    );
  },
);
ProjectMoreSheet.displayName = 'ProjectMoreSheet';
