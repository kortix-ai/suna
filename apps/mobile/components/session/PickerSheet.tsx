/**
 * PickerSheet — the bottom sheet behind the composer's model pill and the
 * thread header's agent pill.
 *
 * Title, an optional search field (lists longer than `PICKER_SEARCH_THRESHOLD`),
 * an optional block above the list (`children`: the model sheet's thinking
 * control), then picker rows (design.md §1: label, check on the active row, no
 * chevron) grouped by `option.group`. Choosing a row applies and, unless
 * `closeOnSelect` is false, closes.
 *
 * A short list sizes the sheet to its content. A searchable list opens at a
 * fixed height, so the sheet does not resize while the results filter.
 */
import * as React from 'react';
import { View, useWindowDimensions } from 'react-native';
import { BottomSheetModal, BottomSheetScrollView } from '@gorhom/bottom-sheet';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useColorScheme } from 'nativewind';

import {
  SheetBackdrop,
  sheetHandleIndicatorStyle,
  useSheetBackground,
  type SheetRef,
} from '@/components/kortix/sheet';
import { SheetTextInput } from '@/components/kortix/SheetInput';
import { SettingsGroup, SettingsRow } from '@/components/kortix/settings-list';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { haptics } from '@/lib/haptics';
import { pickerSections, showsPickerSearch, type PickerOption } from '@/lib/session/composer-config';

const SEARCH_SNAP_POINTS = ['85%'];

interface PickerSheetProps {
  title: string;
  options: PickerOption[];
  /** The option in effect now; its row carries the check. */
  activeKey: string | null;
  onSelect: (key: string) => void;
  /** Placeholder and label of the search field, e.g. "Search models". */
  searchLabel: string;
  /** Shown when the search hides every row, e.g. "No matching models". */
  emptyLabel: string;
  /** Rendered between the search field and the rows. */
  children?: React.ReactNode;
  /**
   * Choosing a row closes the sheet (default). The model sheet passes false:
   * after a model pick the user may still set its thinking level.
   */
  closeOnSelect?: boolean;
  /**
   * Shown instead of the rows when there are no options at all (design.md
   * Projects empty state: `large` title, one primary pill, nothing else).
   */
  empty?: { title: string; actionLabel: string; onAction: () => void };
}

export const PickerSheet = React.forwardRef<SheetRef, PickerSheetProps>(
  ({ title, options, activeKey, onSelect, searchLabel, emptyLabel, children, empty, closeOnSelect = true }, ref) => {
    const modalRef = React.useRef<BottomSheetModal>(null);
    const { height } = useWindowDimensions();
    const insets = useSafeAreaInsets();
    const { colorScheme } = useColorScheme();
    const background = useSheetBackground();
    const [query, setQuery] = React.useState('');

    React.useImperativeHandle(ref, () => ({
      open: () => modalRef.current?.present(),
      close: () => modalRef.current?.dismiss(),
    }));

    const searchable = showsPickerSearch(options.length);
    const sections = React.useMemo(() => pickerSections(options, query), [options, query]);

    return (
      <BottomSheetModal
        ref={modalRef}
        snapPoints={searchable ? SEARCH_SNAP_POINTS : undefined}
        enableDynamicSizing={!searchable}
        maxDynamicContentSize={Math.floor(height * 0.7)}
        enablePanDownToClose
        onDismiss={() => setQuery('')}
        backdropComponent={SheetBackdrop}
        keyboardBehavior="interactive"
        keyboardBlurBehavior="restore"
        android_keyboardInputMode="adjustResize"
        handleIndicatorStyle={sheetHandleIndicatorStyle(colorScheme === 'dark')}
        backgroundStyle={{
          backgroundColor: background,
          borderTopLeftRadius: 20,
          borderTopRightRadius: 20,
        }}>
        <BottomSheetScrollView
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{
            // The app's sheet layout (Sessions and Projects action sheets):
            // 16pt sides — the project edge (`px-4`; Jay, 2026-09-21), for the
            // model sheet and the agent sheet alike. 4pt under the handle, 16pt
            // between blocks. The sheet title and every group title share one
            // 8pt inset (24pt line).
            paddingHorizontal: 16,
            paddingTop: 4,
            paddingBottom: Math.max(insets.bottom, 16) + 8,
            gap: 16,
          }}>
          <Text variant="large" accessibilityRole="header" className="px-2" numberOfLines={1}>
            {title}
          </Text>

          {searchable ? (
            <SheetTextInput
              value={query}
              onChangeText={setQuery}
              placeholder={searchLabel}
              accessibilityLabel={searchLabel}
              autoCapitalize="none"
              autoCorrect={false}
              clearButtonMode="while-editing"
              returnKeyType="search"
            />
          ) : null}

          {children}

          {sections.map((section) => (
            // `bg-secondary`: in dark mode `card` equals the sheet's `popover`.
            <View key={section.title ?? ''}>
              {/* The group title sits 8pt in (Jay, 2026-09-21), on the sheet
                  title's line — not `SettingsGroup`'s 16pt title inset. */}
              {section.title ? (
                <Text variant="muted" className="mb-2 px-2">
                  {section.title}
                </Text>
              ) : null}
              <SettingsGroup className="bg-secondary">
                {section.options.map((option) => (
                  <SettingsRow
                    key={option.key}
                    label={option.label}
                    checked={option.key === activeKey}
                    right={null}
                    onPress={() => {
                      haptics.selection();
                      onSelect(option.key);
                      if (closeOnSelect) modalRef.current?.dismiss();
                    }}
                  />
                ))}
              </SettingsGroup>
            </View>
          ))}

          {options.length === 0 && empty ? (
            <View className="items-center gap-6 py-6">
              <Text variant="large">{empty.title}</Text>
              <Button
                size="lg"
                className="rounded-full"
                onPress={() => {
                  haptics.tap();
                  modalRef.current?.dismiss();
                  empty.onAction();
                }}>
                <Text>{empty.actionLabel}</Text>
              </Button>
            </View>
          ) : sections.length === 0 ? (
            <View className="items-center py-6">
              <Text variant="muted">{emptyLabel}</Text>
            </View>
          ) : null}
        </BottomSheetScrollView>
      </BottomSheetModal>
    );
  },
);
PickerSheet.displayName = 'PickerSheet';
