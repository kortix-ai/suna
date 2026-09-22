/**
 * LogoPaletteSheet — the hidden control for the Kortix symbol's style and
 * colours. It opens only from a 5-second press on the project home symbol
 * (`ProjectHero`).
 *
 * A list, the settings screens' layout: a `SettingsGroup` of styles (Dither,
 * the default, then Heatmap: `lib/effects/logo-style`), then one `SettingsGroup`
 * of predefined colours (`lib/effects/logo-palette`; metal finish only, Jay,
 * 2026-09-22 — pastel removed): swatch · name · check on the active one.
 * There is no free colour picker. A tap applies the choice at once
 * (`useLogoPaletteStore`, kept on the device) and the sheet stays open, so
 * the symbol behind it changes while the user compares. For that reason the
 * sheet takes at most half the screen and its backdrop is lighter than the
 * default: the symbol must stay visible above it.
 */
import * as React from 'react';
import { View, useWindowDimensions } from 'react-native';
import { BottomSheetModal, BottomSheetScrollView } from '@gorhom/bottom-sheet';
import { useColorScheme } from 'nativewind';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { SettingsGroup, SettingsRow } from '@/components/kortix/settings-list';
import { KortixBottomSheetModal, SheetBackdrop, type SheetRef } from '@/components/kortix/sheet';
import { LOGO_PALETTES, logoPaletteSwatch } from '@/lib/effects/logo-palette';
import { LOGO_STYLES } from '@/lib/effects/logo-style';
import { haptics } from '@/lib/haptics';
import { THEME } from '@/lib/utils/theme';
import { useLogoPaletteStore } from '@/stores/logo-palette-store';

/** The row's leading swatch: `SettingsRow`'s 20pt slot. */
const SWATCH_SIZE = 20;

type BackdropProps = React.ComponentProps<typeof SheetBackdrop>;
/** Lighter than the default 0.5: the symbol behind the sheet is the preview. */
const PreviewBackdrop = (props: BackdropProps) => <SheetBackdrop {...props} opacity={0.2} />;

export const LogoPaletteSheet = React.forwardRef<SheetRef>((_props, ref) => {
  const modalRef = React.useRef<BottomSheetModal>(null);
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const { colorScheme } = useColorScheme();
  const tone = colorScheme === 'dark' ? 'dark' : 'light';
  const styleId = useLogoPaletteStore((s) => s.styleId);
  const setStyleId = useLogoPaletteStore((s) => s.setStyleId);
  const paletteId = useLogoPaletteStore((s) => s.paletteId);
  const setPaletteId = useLogoPaletteStore((s) => s.setPaletteId);

  React.useImperativeHandle(ref, () => ({
    open: () => modalRef.current?.present(),
    close: () => modalRef.current?.dismiss(),
  }));

  return (
    <KortixBottomSheetModal
      ref={modalRef}
      title="Kortix"
      enableDynamicSizing
      maxDynamicContentSize={Math.floor(height * 0.5)}
      enablePanDownToClose
      backdropComponent={PreviewBackdrop}>
      <BottomSheetScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{
          // `PickerSheet`'s layout: 16pt sides, 16pt between groups.
          paddingHorizontal: 16,
          paddingTop: 4,
          paddingBottom: Math.max(insets.bottom, 16) + 8,
          gap: 16,
        }}>
        <SettingsGroup title="Style" className="bg-secondary">
          {LOGO_STYLES.map((style) => (
            <SettingsRow
              key={style.id}
              label={style.label}
              checked={style.id === styleId}
              right={null}
              onPress={() => {
                haptics.selection();
                setStyleId(style.id);
              }}
            />
          ))}
        </SettingsGroup>
        <SettingsGroup title="Colour" className="bg-secondary">
          {LOGO_PALETTES.map((palette) => (
            <SettingsRow
              key={palette.id}
              leading={
                <Swatch
                  colors={
                    logoPaletteSwatch(palette.accent ? THEME.accent[palette.accent] : null, tone) ?? {
                      // The default metal: the page's foreground over its border tone.
                      highlight: THEME[tone].foreground,
                      body: THEME[tone].border,
                    }
                  }
                />
              }
              label={palette.label}
              checked={palette.id === paletteId}
              right={null}
              onPress={() => {
                haptics.selection();
                setPaletteId(palette.id);
              }}
            />
          ))}
        </SettingsGroup>
      </BottomSheetScrollView>
    </KortixBottomSheetModal>
  );
});
LogoPaletteSheet.displayName = 'LogoPaletteSheet';

/** The palette's body colour with its highlight as the centre dot: the symbol's two colours. */
function Swatch({ colors }: { colors: { highlight: string; body: string } }) {
  return (
    <View
      className="items-center justify-center rounded-full"
      style={{ width: SWATCH_SIZE, height: SWATCH_SIZE, backgroundColor: colors.body }}>
      <View
        className="rounded-full"
        style={{
          width: SWATCH_SIZE / 2.5,
          height: SWATCH_SIZE / 2.5,
          backgroundColor: colors.highlight,
        }}
      />
    </View>
  );
}
