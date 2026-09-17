/**
 * ModelPickerSheet — choose the model for a new chat from the project catalog.
 *
 * One titled group of picker rows (design.md §1: label, check on the active
 * row, no chevron). Choosing applies and closes. The list scrolls past 70% of
 * the screen height.
 */
import * as React from 'react';
import { useWindowDimensions } from 'react-native';
import { BottomSheetModal, BottomSheetScrollView } from '@gorhom/bottom-sheet';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useColorScheme } from 'nativewind';

import {
  SheetBackdrop,
  sheetHandleIndicatorStyle,
  useSheetBackground,
  type SheetRef,
} from '@/components/kortix/sheet';
import { SettingsGroup, SettingsRow } from '@/components/kortix/settings-list';
import type { ComposerModelOption } from '@/lib/session/composer-model';

interface ModelPickerSheetProps {
  models: ComposerModelOption[];
  /** The model a send would use now; its row carries the check. */
  activeModel: string | null;
  onSelect: (modelID: string) => void;
}

export const ModelPickerSheet = React.forwardRef<SheetRef, ModelPickerSheetProps>(
  ({ models, activeModel, onSelect }, ref) => {
    const modalRef = React.useRef<BottomSheetModal>(null);
    const { height } = useWindowDimensions();
    const insets = useSafeAreaInsets();
    const { colorScheme } = useColorScheme();
    const background = useSheetBackground();

    React.useImperativeHandle(ref, () => ({
      open: () => modalRef.current?.present(),
      close: () => modalRef.current?.dismiss(),
    }));

    return (
      <BottomSheetModal
        ref={modalRef}
        enableDynamicSizing
        maxDynamicContentSize={Math.floor(height * 0.7)}
        enablePanDownToClose
        backdropComponent={SheetBackdrop}
        handleIndicatorStyle={sheetHandleIndicatorStyle(colorScheme === 'dark')}
        backgroundStyle={{
          backgroundColor: background,
          borderTopLeftRadius: 20,
          borderTopRightRadius: 20,
        }}>
        <BottomSheetScrollView
          contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 4, paddingBottom: insets.bottom + 16 }}>
          <SettingsGroup title="Model">
            {models.map((m) => (
              <SettingsRow
                key={m.modelID}
                label={m.modelName}
                checked={m.modelID === activeModel}
                right={null}
                onPress={() => {
                  onSelect(m.modelID);
                  modalRef.current?.dismiss();
                }}
              />
            ))}
          </SettingsGroup>
        </BottomSheetScrollView>
      </BottomSheetModal>
    );
  },
);
ModelPickerSheet.displayName = 'ModelPickerSheet';
