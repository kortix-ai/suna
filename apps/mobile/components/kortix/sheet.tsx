// apps/mobile/components/kortix/sheet.tsx
import * as React from 'react';
import { View, Dimensions, type ViewStyle } from 'react-native';
import {
  BottomSheetModal,
  BottomSheetView,
  BottomSheetBackdrop,
  useBottomSheetModal,
  useBottomSheetInternal,
  type BottomSheetModalProps,
} from '@gorhom/bottom-sheet';
import Animated, { useAnimatedStyle } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useColorScheme } from 'nativewind';
import { getSheetBg } from '@/lib/theme-colors';
import { THEME } from '@/lib/utils/theme';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import * as Clipboard from 'expo-clipboard';
import { haptics } from '@/lib/haptics';
import { CheckIcon, CopyIcon, XIcon } from '@/lib/icons';
import { cn } from '@/lib/utils/utils';
import { detentsKey, withFullDetent } from '@/lib/ui/sheet-detents';
import { SurfaceContext } from '@/components/kortix/surface-context';

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
  return (
    <BottomSheetBackdrop
      {...props}
      appearsOnIndex={props.appearsOnIndex ?? 0}
      disappearsOnIndex={props.disappearsOnIndex ?? -1}
      opacity={props.opacity ?? 0.5}
    />
  );
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

/**
 * KortixBottomSheetModal — the one bottom sheet of the app (Jay, 2026-09-22).
 *
 * A drop-in for gorhom's `BottomSheetModal`: same props, same ref (`present`,
 * `dismiss`, `snapToIndex`, …), so `useRef<BottomSheetModal>` keeps working.
 * Every sheet renders through it, so the sheet's look is set HERE and nowhere
 * else: the values in `SHEET_DEFAULTS`, the backdrop, the handle, the surface
 * colour, the top corners, and the title row. Change one value in this file and
 * every sheet changes. A call site passes a chrome prop only to differ on
 * purpose (a lighter backdrop, a custom footer), and says why.
 *
 * `title` adds the sheet's title row inside the handle area, above any content
 * (a list, a scroll view, a form): a close button at the far left, the title
 * centred, a spacer that balances the button. It is part of the handle, so it
 * stays put while the content scrolls, and the sheet still drags from it.
 * `hideClose` drops the button and keeps the title centred. `titleTrailing`
 * puts one icon button at the far right of that row.
 */
export const SHEET_DEFAULTS = {
  /** Top corner radius. */
  radius: 32,
  /** Side padding of the title row: the project edge. */
  titlePaddingX: 16,
  /** Space between the grab handle and the title row, and under the title row. */
  titlePaddingTop: 4,
  titlePaddingBottom: 8,
  /** Space above the grab handle. */
  handlePaddingTop: 5,
} as const;

/**
 * SheetTitleRow — the one title row of every sheet: a close button at the far
 * left, the title centred, a spacer that balances the button. Drawn by
 * `KortixBottomSheetModal title` (in the handle area) and by `SheetHeader`
 * (inside a sheet's content, for a title that depends on that content). Never
 * hand-roll a sheet title: no left-aligned title, no close button on the right.
 *
 * `leading` replaces the close button's slot with the sheet's own control (a
 * Back chevron inside a multi-step sheet). `trailing` fills the far right, the
 * slot that is empty otherwise, with one 40pt icon `Button` (the file preview's
 * Copy). The slot mirrors the leading one, so the title stays centred.
 */
export function SheetTitleRow({
  title,
  onClose,
  hideClose = false,
  leading,
  trailing,
  center,
}: {
  title?: string;
  onClose?: () => void;
  hideClose?: boolean;
  leading?: React.ReactNode;
  trailing?: React.ReactNode;
  /** Replaces the centred title text (e.g. a tab list). */
  center?: React.ReactNode;
}) {
  return (
    <View
      className="flex-row items-center"
      style={{
        paddingHorizontal: SHEET_DEFAULTS.titlePaddingX,
        paddingTop: SHEET_DEFAULTS.titlePaddingTop,
        paddingBottom: SHEET_DEFAULTS.titlePaddingBottom,
      }}>
      {leading ? (
        <View className="-ml-2.5">{leading}</View>
      ) : hideClose ? (
        <View className="size-10" />
      ) : (
        <Button
          variant="ghost"
          size="icon"
          className="-ml-2.5 rounded-full"
          onPress={onClose}
          accessibilityLabel="Close"
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
          <Icon as={XIcon} size={20} className="text-foreground" />
        </Button>
      )}
      {center ? (
        <View className="flex-1 items-center">{center}</View>
      ) : (
        <Text
          variant="large"
          accessibilityRole="header"
          className="flex-1 text-center"
          numberOfLines={1}>
          {title ?? ''}
        </Text>
      )}
      {trailing ? (
        <View className="-mr-2.5">{trailing}</View>
      ) : (
        // Balances the leading slot: 40pt, less its 10pt pull to the edge.
        <View style={{ width: hideClose && !leading ? 40 : 30 }} />
      )}
    </View>
  );
}

export interface KortixBottomSheetModalProps extends BottomSheetModalProps {
  /** Centred title in the handle area, with a close button at the far left. */
  title?: string;
  /** A titled sheet without the close button. */
  hideClose?: boolean;
  /**
   * Replaces the close button at the far left of the title row (a Back
   * chevron while a pushed view shows). Needs `title`.
   */
  titleLeading?: React.ReactNode;
  /** One 40pt icon `Button` at the far right of the title row. Needs `title`. */
  titleTrailing?: React.ReactNode;
  /** Replaces the centred title text with a control (a tab list). Needs `title` (used as the accessible name). */
  titleCenter?: React.ReactNode;
}

export const KortixBottomSheetModal = React.forwardRef<
  BottomSheetModal,
  KortixBottomSheetModalProps
>(({ title, hideClose = false, backgroundStyle, handleComponent, snapPoints, topInset, children, ...rest }, ref) => {
  const { titleLeading, titleTrailing, titleCenter, ...props } = rest;
  // gorhom sizes the content box to the HIGHEST detent, which is now always
  // 100%. A fixed-detent sheet shown at 92% would lay its content out
  // full-screen tall and push a bottom Save row off-screen, so its body is
  // wrapped in `SheetFill`: exactly the visible sheet, growing with a drag.
  // A content-sized sheet (dynamic sizing) measures its own height instead.
  const fixedDetents = props.enableDynamicSizing === false;
  const innerRef = React.useRef<BottomSheetModal>(null);
  // Full screen stops under the status bar, so the container is the safe area.
  const insets = useSafeAreaInsets();
  // Every sheet reaches full screen (Jay, 2026-09-22): the call site's detents
  // stay the ones it opens at, and `'100%'` is added after them, so a drag up
  // expands any sheet. Keyed by value: most call sites pass an inline array.
  const key = detentsKey(snapPoints);
  const detents = React.useMemo(() => withFullDetent(snapPoints), [key]);
  React.useImperativeHandle(ref, () => innerRef.current as BottomSheetModal, []);
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const background = getSheetBg(isDark);
  const indicatorStyle = React.useMemo(() => sheetHandleIndicatorStyle(isDark), [isDark]);

  const titledHandle = React.useCallback(
    () => (
      <View style={{ paddingTop: SHEET_DEFAULTS.handlePaddingTop }}>
        <View style={[{ alignSelf: 'center' }, indicatorStyle]} />
        <SheetTitleRow
          title={title}
          hideClose={hideClose}
          leading={titleLeading}
          trailing={titleTrailing}
          center={titleCenter}
          onClose={() => innerRef.current?.dismiss()}
        />
      </View>
    ),
    [indicatorStyle, hideClose, title, titleLeading, titleTrailing, titleCenter]
  );

  return (
    <BottomSheetModal
      ref={innerRef}
      backdropComponent={SheetBackdrop}
      handleIndicatorStyle={indicatorStyle}
      handleComponent={handleComponent ?? (title ? titledHandle : undefined)}
      snapPoints={detents as BottomSheetModalProps['snapPoints']}
      topInset={topInset ?? insets.top}
      {...props}
      backgroundStyle={[
        {
          backgroundColor: background,
          borderTopLeftRadius: SHEET_DEFAULTS.radius,
          borderTopRightRadius: SHEET_DEFAULTS.radius,
        },
        backgroundStyle,
      ]}>
      {typeof children === 'function' ? (
        children
      ) : (
        // Rows inside know they sit on the sheet colour (`SettingsGroup`).
        <SurfaceContext.Provider value="sheet">
          {fixedDetents ? <SheetFill>{children}</SheetFill> : children}
        </SurfaceContext.Provider>
      )}
    </BottomSheetModal>
  );
});
KortixBottomSheetModal.displayName = 'KortixBottomSheetModal';

/**
 * SheetFill — a box exactly as tall as the sheet's visible content area
 * (container − sheet position − handle), tracking drags on the UI thread.
 *
 * gorhom sizes its content box to the sheet's HIGHEST detent
 * (`animatedSheetHeight = containerHeight − highestDetentPosition`), and every
 * sheet's highest detent is 100% (`withFullDetent`). A sheet shown at 92% lays
 * its content out full-screen tall, `flex: 1` children fill that box, and a
 * `PinnedBar` at `bottom: 0` lands off-screen (measured 787pt of content for a
 * 722pt visible area, 2026-09-22). Wrap a sheet body that pins
 * anything to its bottom edge in `SheetFill`; inside it, `flex: 1` and
 * `absolute bottom-0` mean the visible sheet. `KortixBottomSheetModal` wraps
 * every fixed-detent sheet (`enableDynamicSizing={false}`) in it; a
 * content-sized sheet has no height of its own to fill. Never give it
 * `flex: 1`: React Native's `flex: 1` sets `flexBasis: 0`, which discards the
 * height (measured: 787pt again).
 */
export function SheetFill({ children, style }: { children: React.ReactNode; style?: Omit<ViewStyle, 'flex' | 'height'> }) {
  const { animatedLayoutState, animatedPosition } = useBottomSheetInternal();
  const fill = useAnimatedStyle(() => {
    const { containerHeight, handleHeight } = animatedLayoutState.get();
    if (containerHeight <= 0) return {};
    const height = containerHeight - animatedPosition.get() - Math.max(0, handleHeight);
    return { height: Math.max(0, height) };
  }, [animatedLayoutState, animatedPosition]);
  return <Animated.View style={[style, fill]}>{children}</Animated.View>;
}

/** Copies `text`; the glyph is a check for 1.5 s after. For `titleTrailing`. */
export function CopyContentButton({ text }: { text: string }) {
  const [copied, setCopied] = React.useState(false);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  React.useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  return (
    <Button
      variant="ghost"
      size="icon"
      className="rounded-full"
      hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
      accessibilityLabel={copied ? 'Copied' : 'Copy file content'}
      onPress={async () => {
        await Clipboard.setStringAsync(text);
        haptics.success();
        setCopied(true);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(false), 1500);
      }}>
      <Icon as={copied ? CheckIcon : CopyIcon} size={20} className="text-foreground" />
    </Button>
  );
}

export interface SheetRef {
  open: () => void;
  close: () => void;
}
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
    React.useImperativeHandle(ref, () => ({
      open: () => modalRef.current?.present(),
      close: () => modalRef.current?.dismiss(),
    }));
    const effectiveSnapPoints = fullScreen ? ['100%'] : snapPoints;
    return (
      <KortixBottomSheetModal
        ref={modalRef}
        snapPoints={effectiveSnapPoints}
        enableDynamicSizing={!effectiveSnapPoints}
        enablePanDownToClose={enablePanDownToClose}
        onDismiss={onDismiss}
        keyboardBehavior="interactive"
        keyboardBlurBehavior="restore"
        android_keyboardInputMode="adjustResize">
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
      </KortixBottomSheetModal>
    );
  }
);
Sheet.displayName = 'Sheet';

/**
 * `SheetHeader` — the title row inside a sheet's content, for a title that
 * depends on that content. A sheet with a fixed title passes
 * `KortixBottomSheetModal title` instead. Same row either way: `SheetTitleRow`.
 * The close button dismisses the sheet it sits in.
 */
function Header({
  title,
  onClose,
  hideClose,
  leading,
}: {
  title?: string;
  /** Defaults to dismissing the open sheet. */
  onClose?: () => void;
  hideClose?: boolean;
  leading?: React.ReactNode;
  /** @deprecated The row owns its padding (`SHEET_DEFAULTS`). Ignored. */
  className?: string;
}) {
  const { dismiss } = useBottomSheetModal();
  return (
    <SheetTitleRow
      title={title}
      hideClose={hideClose}
      leading={leading}
      onClose={onClose ?? (() => dismiss())}
    />
  );
}
function Body({ children, className }: { children: React.ReactNode; className?: string }) {
  return <View className={cn('px-5 pb-6', className)}>{children}</View>;
}
function Footer({ children, className }: { children: React.ReactNode; className?: string }) {
  return <View className={cn('flex-row gap-3 px-5 pb-8 pt-2', className)}>{children}</View>;
}
(Sheet as any).Header = Header;
(Sheet as any).Body = Body;
(Sheet as any).Footer = Footer;
export { Header as SheetHeader, Body as SheetBody, Footer as SheetFooter };
