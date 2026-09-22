/**
 * CustomizeSheet — the "Customize" sheet: the project's sections, in two groups
 * (`CUSTOMIZE_SHEET_GROUPS`). Was `ProjectMoreSheet` (renamed 2026-09-22).
 * Opens from the header's `···` button on project home and in a thread
 * (`ProjectHeaderActions`), and from a tool page's `PageHeader` "···" button.
 *
 * A `KortixBottomSheetModal` with a `BottomSheetScrollView` body, not `Sheet`:
 * the rows are taller than a small phone, and `Sheet`'s `BottomSheetView` does
 * not scroll.
 * Layout is `PickerSheet`'s: 16pt sides (the project edge), 16pt between groups.
 *
 * Title row (Jay, 2026-09-22): `KortixBottomSheetModal title="Customize"` (web's
 * name for this section): a close button at the far left, the title centred.
 */
import * as React from 'react';
import { useWindowDimensions } from 'react-native';
import { BottomSheetModal, BottomSheetScrollView } from '@gorhom/bottom-sheet';
import { useColorScheme } from 'nativewind';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { SettingsGroup, SettingsRow } from '@/components/kortix/settings-list';
import {
  type SheetRef,
  KortixBottomSheetModal,
} from '@/components/kortix/sheet';
import { CUSTOMIZE_SHEET_GROUPS, REVIEW_PAGE_ID } from '@/lib/session/dock-menu';
import { DOCK_ICONS } from './dock-icons';

/** The second stop: full screen. The first is the content's own height. */
const FULL_SCREEN_SNAP = ['100%'];

export interface CustomizeSheetProps {
  onNavigate: (pageId: string) => void;
  /** Items that wait for the user. Shown as the Review row's value. */
  reviewBadgeCount?: number;
}

export const CustomizeSheet = React.forwardRef<SheetRef, CustomizeSheetProps>(
  ({ onNavigate, reviewBadgeCount = 0 }, ref) => {
    const modalRef = React.useRef<BottomSheetModal>(null);
    const { height } = useWindowDimensions();
    const insets = useSafeAreaInsets();
    const { colorScheme } = useColorScheme();

    React.useImperativeHandle(ref, () => ({
      open: () => modalRef.current?.present(),
      close: () => modalRef.current?.dismiss(),
    }));

    const handlePress = React.useCallback(
      (pageId: string) => {
        modalRef.current?.dismiss();
        onNavigate(pageId);
      },
      [onNavigate],
    );

    return (
      <KortixBottomSheetModal
        ref={modalRef}
        title="Customize"
        // Two stops (Jay, 2026-09-22): the sheet opens at its content's height
        // (the dynamic snap point, capped at 85% of the screen), and a drag up
        // takes it to full screen, under the status bar.
        snapPoints={FULL_SCREEN_SNAP}
        enableDynamicSizing
        maxDynamicContentSize={Math.floor(height * 0.85)}
        topInset={insets.top}
        enablePanDownToClose>
        <BottomSheetScrollView
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{
            paddingHorizontal: 16,
            paddingTop: 4,
            paddingBottom: Math.max(insets.bottom, 16) + 8,
            gap: 16,
          }}>
          {CUSTOMIZE_SHEET_GROUPS.map((group) => (
            <SettingsGroup key={group.title ?? 'core'} title={group.title ?? undefined}>
              {group.items.map((item) => (
                <SettingsRow
                  key={item.pageId}
                  icon={DOCK_ICONS[item.icon]}
                  label={item.label}
                  value={
                    item.pageId === REVIEW_PAGE_ID && reviewBadgeCount > 0
                      ? String(reviewBadgeCount)
                      : undefined
                  }
                  onPress={() => handlePress(item.pageId)}
                />
              ))}
            </SettingsGroup>
          ))}
        </BottomSheetScrollView>
      </KortixBottomSheetModal>
    );
  },
);
CustomizeSheet.displayName = 'CustomizeSheet';
