// apps/mobile/components/kortix/sheet.tsx
import * as React from 'react';
import { View, Dimensions, type ViewStyle } from 'react-native';
import { BottomSheetModal, BottomSheetView, BottomSheetBackdrop } from '@gorhom/bottom-sheet';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useColorScheme } from 'nativewind';
import { getSheetBg } from '@/lib/theme-colors';
import { THEME } from '@/lib/utils/theme';
import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils/utils';

/**
 * Shared bottom-sheet backdrop. Every gorhom sheet creator in the app
 * (~50 of them) hand-rolled this exact shape:
 * `<BottomSheetBackdrop {...props} disappearsOnIndex={-1} appearsOnIndex={0} opacity={0.5} />`.
 *
 * Use directly as `backdropComponent={SheetBackdrop}` for the dominant case
 * (opacity 0.5). A handful of call sites deliberately used a lighter overlay
 * (opacity 0.35 or 0.4) — for those, wrap: `backdropComponent={(p) => <SheetBackdrop {...p} opacity={0.4} />}`.
 *
 * `pressBehavior="close"` was hand-written at ~14 call sites, but gorhom's
 * `BottomSheetBackdrop` already defaults `pressBehavior` to `'close'`
 * (`DEFAULT_PRESS_BEHAVIOR` in `@gorhom/bottom-sheet`), so it is never set
 * here explicitly — it is redundant everywhere it appeared.
 */
export function SheetBackdrop(props: React.ComponentProps<typeof BottomSheetBackdrop>) {
  return <BottomSheetBackdrop {...props} appearsOnIndex={props.appearsOnIndex ?? 0} disappearsOnIndex={props.disappearsOnIndex ?? -1} opacity={props.opacity ?? 0.5} />;
}

/**
 * Shared bottom-sheet grab-handle indicator. Collapses 5+ accidental
 * variants into one token-driven definition. The values it replaced, kept as
 * the historical record of what drifted:
 *   hex-allowlist: `#3F3F46`/`#D4D4D8`, `rgba(255,255,255,0.2)`/`rgba(0,0,0,0.2)`
 *   hex-allowlist: `#555`/`#ccc`, `#3A3A3A`/`#D4D4D4`, `#E4E4E7`, width 40 …
 * Documentation only — this module renders no color literal.
 *
 * Color comes from `--border`, not `--muted-foreground`: measured against
 * the most common hand-written literal
 * (hex-allowlist: `#D4D4D8` light / `#3F3F46` dark — the expected values,
 * HSL lightness ~84% / ~26%), `THEME.*.border` (L 89.8% / 15.9%) is within
 * ~6-10pp — a subtle divider tone, matching original intent. `--muted-foreground`
 * (L 45.1% / 63.1%) is a *text* color — using it would make every handle in
 * the app render far darker (light mode) or far lighter (dark mode) than any
 * of the originals, i.e. it would look like a new, more prominent handle
 * rather than the same subtle grab affordance.
 *
 * Geometry (`width: 36, height: 5, borderRadius: 3`) is kept from the
 * 11-file variant — the most common deliberate sizing found.
 *
 * Exposed as a function (not a bare object) because the color must react to
 * color scheme, and every call site already computes `isDark` (or
 * `colorScheme === 'dark'`) before rendering its sheet — mirrors the
 * existing `getSheetBg(isDark)` calling convention exactly, so callers swap
 * in a one-line replacement.
 */
export const sheetHandleIndicatorStyle = (isDark: boolean): ViewStyle => ({
  backgroundColor: isDark ? THEME.dark.border : THEME.light.border,
  width: 36,
  height: 5,
  borderRadius: 3,
});

/**
 * Shared bottom-sheet background color. Replaces `getSheetBg(isDark)` at
 * call sites that already compute `isDark` themselves purely to feed it —
 * this hook reads color scheme internally so callers don't have to.
 * Same token as `getSheetBg`: `--popover`.
 */
export function useSheetBackground(): string {
  const { colorScheme } = useColorScheme();
  return getSheetBg(colorScheme === 'dark');
}

export interface SheetRef { open: () => void; close: () => void; }
interface SheetProps {
  snapPoints?: (string | number)[];
  /** Present at full screen height (100%) with a safe-area top inset. */
  fullScreen?: boolean;
  /** Opt in to swipe-down-to-dismiss. Off by default, matching gorhom. */
  enablePanDownToClose?: boolean;
  onDismiss?: () => void;
  children: React.ReactNode;
}

export const Sheet = React.forwardRef<SheetRef, SheetProps>(
  ({ snapPoints, fullScreen, enablePanDownToClose, onDismiss, children }, ref) => {
    const modalRef = React.useRef<BottomSheetModal>(null);
    const insets = useSafeAreaInsets();
    const { colorScheme } = useColorScheme();
    const isDark = colorScheme === 'dark';
    React.useImperativeHandle(ref, () => ({
      open: () => modalRef.current?.present(),
      close: () => modalRef.current?.dismiss(),
    }));
    const effectiveSnapPoints = fullScreen ? ['100%'] : snapPoints;
    return (
      <BottomSheetModal
        ref={modalRef}
        snapPoints={effectiveSnapPoints}
        enableDynamicSizing={!effectiveSnapPoints}
        enablePanDownToClose={enablePanDownToClose}
        topInset={fullScreen ? insets.top : 0}
        onDismiss={onDismiss}
        backdropComponent={SheetBackdrop}
        keyboardBehavior="interactive"
        keyboardBlurBehavior="restore"
        android_keyboardInputMode="adjustResize"
        handleIndicatorStyle={sheetHandleIndicatorStyle(isDark)}
        backgroundStyle={{ backgroundColor: getSheetBg(isDark), borderTopLeftRadius: 20, borderTopRightRadius: 20 }}>
        <BottomSheetView style={fullScreen ? { flex: 1 } : undefined}>
          {fullScreen ? (
            // BottomSheetView content-sizes, so a concrete min-height is what
            // lets inner `flex-1` regions expand and pin content to the bottom.
            <View
              style={{
                flex: 1,
                minHeight: Dimensions.get('window').height - insets.top - insets.bottom - 20,
              }}>
              {children}
            </View>
          ) : (
            children
          )}
        </BottomSheetView>
      </BottomSheetModal>
    );
  }
);
Sheet.displayName = 'Sheet';

function Header({ title, className }: { title?: string; className?: string }) {
  return <View className={cn('px-5 pt-1 pb-3', className)}>{title ? <Text className="font-roobert-semibold text-lg text-foreground">{title}</Text> : null}</View>;
}
function Body({ children, className }: { children: React.ReactNode; className?: string }) {
  return <View className={cn('px-5 pb-6', className)}>{children}</View>;
}
function Footer({ children, className }: { children: React.ReactNode; className?: string }) {
  return <View className={cn('px-5 pb-8 pt-2 flex-row gap-3', className)}>{children}</View>;
}
(Sheet as any).Header = Header;
(Sheet as any).Body = Body;
(Sheet as any).Footer = Footer;
export { Header as SheetHeader, Body as SheetBody, Footer as SheetFooter };
