// apps/mobile/components/kortix/sheet.tsx
import * as React from 'react';
import { Keyboard, Platform, View, useWindowDimensions, type ViewStyle } from 'react-native';
import {
  ANIMATION_STATUS,
  BottomSheetModal,
  BottomSheetView,
  BottomSheetBackdrop,
  useBottomSheetModal,
  useBottomSheetInternal,
  type BottomSheetModalProps,
} from '@gorhom/bottom-sheet';
import { State as GestureState } from 'react-native-gesture-handler';
import Animated, { Easing, useAnimatedStyle, useDerivedValue, useSharedValue } from 'react-native-reanimated';
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
import { sheetScrimColor } from '@/lib/ui/sheet-scrim';
import { SurfaceContext } from '@/components/kortix/surface-context';
import { PinnedBarShiftContext } from '@/components/kortix/pinned-bar';
import { SheetSettledContext } from '@/components/kortix/sheet-settled';
import { LIQUID_GLASS_AVAILABLE, LiquidGlassCapsule } from '@/components/kortix/liquid-glass-capsule';

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
  const { colorScheme } = useColorScheme();
  // Dark mode fades toward the page background, not black: black at 50% sank
  // the page to rgb 5, which OLED panels show reddish (`lib/ui/sheet-scrim.ts`).
  const scrim = sheetScrimColor(colorScheme === 'dark', THEME.dark.background);
  return (
    <BottomSheetBackdrop
      {...props}
      style={scrim ? [props.style, { backgroundColor: scrim }] : props.style}
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
const SHEET_DEFAULTS = {
  /** Top corner radius. */
  radius: 32,
  /** Side padding of the title row: the project edge. */
  titlePaddingX: 16,
  /** Space between the grab handle and the title row, and under the title row.
   *  iOS gets 6pt more on each side (Jay, 2026-10-20: the header felt cramped). */
  titlePaddingTop: Platform.OS === 'ios' ? 10 : 4,
  titlePaddingBottom: Platform.OS === 'ios' ? 14 : 8,
  /** Space above the grab handle. */
  handlePaddingTop: 5,
} as const;

/**
 * The one sheet motion (KRTX-2929). Every sheet moves on the UI thread with
 * these values; no call site passes `animationConfigs`.
 *
 * `open` — the present, every snap after a drag, a pan-down close and a
 * backdrop tap. A critically damped spring (ratio 1: no overshoot, `stiffness`
 * 256 with `mass` 1 is ω0 = 16 rad/s): 95% of the way in ~300 ms, 99% in
 * ~415 ms. A spring, not a timing curve, because gorhom hands it the finger's
 * release velocity: a flick carries straight into the snap with no seam.
 * `energyThreshold` 5e-6 ends it once less than ~0.2% of the distance is left
 * (~520 ms), so `onChange` (and `SheetSettledContext`) fire close to the
 * visible end. Reanimated 4 ignores gorhom's old `restDisplacementThreshold`;
 * at the default threshold the sheet reported "moving" for ~750 ms.
 * Replaces gorhom's defaults, which differed per platform: a
 * damping-500/stiffness-1000/mass-3 spring on iOS, 250 ms ease-out-expo on Android.
 *
 * `close` — `dismiss()` from code (the X, a row pick). 250 ms on the iOS
 * sheet curve (`cubic-bezier(0.32, 0.72, 0, 1)`, the curve Vaul and Ionic use):
 * faster than the open, as an exit should be, with a fixed end so the next
 * sheet chained on `onDismiss` (`useCloseThen`) appears without waiting on a
 * spring's tail.
 */
export const SHEET_MOTION = {
  open: { stiffness: 256, damping: 32, mass: 1, overshootClamping: true, energyThreshold: 5e-6 },
  close: { duration: 250, easing: Easing.bezier(0.32, 0.72, 0, 1) },
} as const;

type TitleSlots = {
  title?: string;
  hideClose: boolean;
  leading?: React.ReactNode;
  trailing?: React.ReactNode;
  trailingGlass: boolean;
  center?: React.ReactNode;
  onClose: () => void;
};

/**
 * The title row's props as a tiny store, read by one stable handle component.
 *
 * gorhom renders `handleComponent` as `<HandleComponent />`. A new function on
 * each render is a new component type: React unmounts and remounts the whole
 * title row (close button, title, trailing button) and gorhom rebuilds its
 * layout-readiness worklet, on every parent render — each search keystroke,
 * each tab switch, each list refresh during the open. Call sites pass
 * `titleTrailing` as inline JSX, so a `useCallback` over the slots changed on
 * every render. The handle now stays one component, and only re-renders.
 */
function useTitleSlotStore(slots: TitleSlots) {
  const [store] = React.useState(() => {
    let current = slots;
    const listeners = new Set<() => void>();
    return {
      get: () => current,
      set: (next: TitleSlots) => {
        current = next;
        listeners.forEach((listener) => listener());
      },
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
  });
  React.useLayoutEffect(() => store.set(slots));
  return store;
}

function TitledHandle({
  store,
  indicatorStyle,
}: {
  store: ReturnType<typeof useTitleSlotStore>;
  indicatorStyle: ViewStyle;
}) {
  const slots = React.useSyncExternalStore(store.subscribe, store.get);
  return (
    <View style={{ paddingTop: SHEET_DEFAULTS.handlePaddingTop }}>
      <View style={[{ alignSelf: 'center' }, indicatorStyle]} />
      <SheetTitleRow
        title={slots.title}
        hideClose={slots.hideClose}
        leading={slots.leading}
        trailing={slots.trailing}
        trailingGlass={slots.trailingGlass}
        center={slots.center}
        onClose={slots.onClose}
      />
    </View>
  );
}

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
 *
 * iOS 26+ (Jay, 2026-10-20): the close button, `leading` and `trailing` each
 * sit on a Liquid Glass capsule (`GlassSlot`): a circle behind a 40pt icon
 * button, a pill behind a wider one. The visible glass then sits on the 16pt
 * edge, so the `-ml-2.5` / `-mr-2.5` pulls go and the balance spacer is the
 * full 40pt. `trailingGlass={false}` keeps a trailing slot that is not a
 * button (the participants count) off the glass. Android and older iOS keep
 * the plain ghost buttons and the pulls.
 */
export function SheetTitleRow({
  title,
  onClose,
  hideClose = false,
  leading,
  trailing,
  trailingGlass = true,
  center,
}: {
  title?: string;
  onClose?: () => void;
  hideClose?: boolean;
  leading?: React.ReactNode;
  trailing?: React.ReactNode;
  /** `false` when `trailing` is not a button: no glass behind it. */
  trailingGlass?: boolean;
  /** Replaces the centred title text (e.g. a tab list). */
  center?: React.ReactNode;
}) {
  const glass = LIQUID_GLASS_AVAILABLE;
  return (
    // `gap-3`: 12pt between the close button, the title (or `center`) and the
    // trailing slot, so a long title or a centred control never touches a
    // glass button (Jay, 2026-10-20). Equal on both sides: the centre holds.
    <View
      className="flex-row items-center gap-3"
      style={{
        paddingHorizontal: SHEET_DEFAULTS.titlePaddingX,
        paddingTop: SHEET_DEFAULTS.titlePaddingTop,
        paddingBottom: SHEET_DEFAULTS.titlePaddingBottom,
      }}>
      {leading ? (
        <GlassSlot className={glass ? undefined : '-ml-2.5'}>{leading}</GlassSlot>
      ) : hideClose ? (
        <View className="size-10" />
      ) : (
        <GlassSlot className={glass ? undefined : '-ml-2.5'}>
          <Button
            variant="ghost"
            size="icon"
            className="rounded-full"
            onPress={onClose}
            accessibilityLabel="Close"
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
            <Icon as={XIcon} size={20} className="text-foreground" />
          </Button>
        </GlassSlot>
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
        trailingGlass ? (
          <GlassSlot className={glass ? undefined : '-mr-2.5'}>{trailing}</GlassSlot>
        ) : (
          <View className="-mr-2.5">{trailing}</View>
        )
      ) : (
        // Balances the leading slot: 40pt, less its 10pt pull to the edge
        // (no pull on glass).
        <View style={{ width: glass || (hideClose && !leading) ? 40 : 30 }} />
      )}
    </View>
  );
}

/**
 * A title-row control on iOS 26+ Liquid Glass: the capsule fills the slot
 * behind the child (a circle for a 40pt icon button). Elsewhere a plain
 * wrapper. `className` carries the non-glass edge pull.
 */
function GlassSlot({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <View className={cn(LIQUID_GLASS_AVAILABLE && 'rounded-full', className)}>
      {LIQUID_GLASS_AVAILABLE ? <LiquidGlassCapsule /> : null}
      {children}
    </View>
  );
}

interface KortixBottomSheetModalProps extends BottomSheetModalProps {
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
  /** `false` when `titleTrailing` is not a button (a count): no Liquid Glass behind it. */
  titleTrailingGlass?: boolean;
  /** Replaces the centred title text with a control (a tab list). Needs `title` (used as the accessible name). */
  titleCenter?: React.ReactNode;
}

export const KortixBottomSheetModal = React.forwardRef<
  BottomSheetModal,
  KortixBottomSheetModalProps
>(({ title, hideClose = false, backgroundStyle, handleComponent, snapPoints, topInset, children, ...rest }, ref) => {
  const { titleLeading, titleTrailing, titleTrailingGlass = true, titleCenter, onChange, onDismiss, ...props } = rest;
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
  // Opening a sheet closes the keyboard. A sheet is a new context: a keyboard
  // left up from the screen behind covers the sheet's lower half, and its field
  // keeps the focus. Set HERE so no call site has to remember it. A sheet's own
  // auto-focused field mounts after this and raises the keyboard again.
  //
  // `dismiss()` / `close()` from code run `SHEET_MOTION.close` unless the
  // caller passes its own config.
  React.useImperativeHandle(
    ref,
    () => ({
      ...(innerRef.current as BottomSheetModal),
      present: (...args: Parameters<BottomSheetModal['present']>) => {
        Keyboard.dismiss();
        innerRef.current?.present(...args);
      },
      dismiss: (config?: Parameters<BottomSheetModal['dismiss']>[0]) =>
        innerRef.current?.dismiss(config ?? SHEET_MOTION.close),
      close: (config?: Parameters<BottomSheetModal['close']>[0]) =>
        innerRef.current?.close(config ?? SHEET_MOTION.close),
    }),
    []
  );
  // False from mount (gorhom mounts the body on present) until the open
  // animation first comes to rest; reset once the body is gone. Never reset
  // on the way down: that would re-render a long list during the close.
  const [settled, setSettled] = React.useState(false);
  const handleChange = React.useCallback<NonNullable<BottomSheetModalProps['onChange']>>(
    (index, position, type) => {
      if (index >= 0) setSettled(true);
      onChange?.(index, position, type);
    },
    [onChange]
  );
  const handleDismiss = React.useCallback(() => {
    setSettled(false);
    onDismiss?.();
  }, [onDismiss]);
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const background = getSheetBg(isDark);
  const indicatorStyle = React.useMemo(() => sheetHandleIndicatorStyle(isDark), [isDark]);

  const titleStore = useTitleSlotStore({
    title,
    hideClose,
    leading: titleLeading,
    trailing: titleTrailing,
    trailingGlass: titleTrailingGlass,
    center: titleCenter,
    onClose: () => innerRef.current?.dismiss(SHEET_MOTION.close),
  });
  const titledHandle = React.useCallback(
    () => <TitledHandle store={titleStore} indicatorStyle={indicatorStyle} />,
    [titleStore, indicatorStyle]
  );

  return (
    <BottomSheetModal
      ref={innerRef}
      backdropComponent={SheetBackdrop}
      handleIndicatorStyle={indicatorStyle}
      handleComponent={handleComponent ?? (title ? titledHandle : undefined)}
      snapPoints={detents as BottomSheetModalProps['snapPoints']}
      topInset={topInset ?? insets.top}
      animationConfigs={SHEET_MOTION.open}
      {...props}
      onChange={handleChange}
      onDismiss={handleDismiss}
      // Android keyboard: ONE mode app-wide. The window is `adjustResize`
      // (app.json `softwareKeyboardLayoutMode: "resize"`), but the root
      // KeyboardProvider draws edge-to-edge, so the window never actually
      // resizes or pans. The sheet must lift itself above the keyboard,
      // which is gorhom's `adjustPan` path (the same path iOS uses). gorhom's
      // `adjustResize` assumes the OS already resized and does nothing, so a
      // field near the sheet bottom stays under the keyboard. Inputs inside a
      // sheet must be `BottomSheetTextInput` (or `SheetTextInput`): gorhom only
      // lifts for a focused input it registered.
      android_keyboardInputMode="adjustPan"
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
        // Rows inside know they sit on the sheet colour (`SettingsGroup`),
        // and whether the sheet is still opening (`useSheetRowLimit`).
        <SurfaceContext.Provider value="sheet">
          <SheetSettledContext.Provider value={settled}>
            {fixedDetents ? <SheetFill>{children}</SheetFill> : children}
          </SheetSettledContext.Provider>
        </SurfaceContext.Provider>
      )}
    </BottomSheetModal>
  );
});
KortixBottomSheetModal.displayName = 'KortixBottomSheetModal';

/**
 * SheetFill — a box as tall as the sheet's visible content area
 * (container − sheet position − handle) whenever the sheet is at rest.
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
 *
 * A height change re-lays out the whole body, lists included. So while the
 * sheet moves, the body keeps one height (`sheetFillHeight`) and a `PinnedBar`
 * inside follows the visible edge by a transform (`PinnedBarShiftContext`).
 */
export function SheetFill({ children, style }: { children: React.ReactNode; style?: Omit<ViewStyle, 'flex' | 'height'> }) {
  const {
    animatedLayoutState,
    animatedPosition,
    animatedAnimationState,
    animatedContentGestureState,
    animatedHandleGestureState,
  } = useBottomSheetInternal();
  // The last laid-out height: the memory `sheetFillHeight` keeps across frames.
  const laidOut = useSharedValue<number | null>(null);
  // Derived values, not a reaction: `useDerivedValue` registers its mapper
  // with the value as an output, so Reanimated runs it before every mapper
  // that reads it (`mappers.ts` `updateMappersOrder`). The height, the shift
  // and both styles then update in the same frame, whatever order React
  // registered them in. A reaction has no outputs: a child `PinnedBar`'s style
  // registered first would read the new shift one frame late.
  const height = useDerivedValue(() => {
    const dragging =
      isGestureLive(animatedContentGestureState.get()) || isGestureLive(animatedHandleGestureState.get());
    const next = sheetFillHeight(
      animatedLayoutState.get(),
      animatedPosition.get(),
      animatedAnimationState.get(),
      dragging,
      laidOut.get()
    );
    if (next !== laidOut.get()) laidOut.set(next);
    return next;
  }, [animatedLayoutState, animatedPosition, animatedAnimationState, animatedContentGestureState, animatedHandleGestureState, laidOut]);
  const shift = useDerivedValue(
    () => sheetFillShift(animatedLayoutState.get(), animatedPosition.get(), height.get()),
    [animatedLayoutState, animatedPosition, height]
  );
  const fill = useAnimatedStyle(() => {
    const h = height.get();
    return h === null ? {} : { height: h };
  }, [height]);
  return (
    <Animated.View style={[style, fill]}>
      <PinnedBarShiftContext.Provider value={shift}>{children}</PinnedBarShiftContext.Provider>
    </Animated.View>
  );
}

// Plain numbers: a worklet captures them by value.
const ANIMATION_RUNNING = ANIMATION_STATUS.RUNNING;
const GESTURE_BEGAN = GestureState.BEGAN;
const GESTURE_ACTIVE = GestureState.ACTIVE;

function isGestureLive(state: number): boolean {
  'worklet';
  return state === GESTURE_BEGAN || state === GESTURE_ACTIVE;
}

/** The sheet below the handle, in points. */
function visibleFill(layout: { containerHeight: number; handleHeight: number }, position: number): number {
  'worklet';
  return Math.max(0, layout.containerHeight - position - Math.max(0, layout.handleHeight));
}

/**
 * `SheetFill`'s laid-out height for one frame. `null` until the container is
 * measured.
 * - At rest (no animation, no drag): `visible`. This is the one layout a move
 *   down costs.
 * - An animation lays out once at `max(visible, its target)` when that is
 *   taller than `previous` (the open, a snap up, the keyboard lift), and keeps
 *   `previous` otherwise (the close, a snap down, the keyboard drop).
 * - A drag keeps `previous` going down, and grows with the drag past it going
 *   up, so no empty band shows between the content's end and the bar.
 */
export function sheetFillHeight(
  layout: { containerHeight: number; handleHeight: number },
  position: number,
  animation: { status: number; nextPosition?: number },
  dragging: boolean,
  previous: number | null
): number | null {
  'worklet';
  if (layout.containerHeight <= 0) return null;
  const visible = visibleFill(layout, position);
  const running = animation.status === ANIMATION_RUNNING;
  if (!running && !dragging) return visible;
  let wanted = visible;
  if (running && animation.nextPosition !== undefined) {
    wanted = Math.max(visible, visibleFill(layout, animation.nextPosition));
  }
  return previous === null || wanted > previous ? wanted : previous;
}

/**
 * How far a `PinnedBar` moves to sit on the visible edge: `visible − height`,
 * 0 or less (`sheetFillHeight` never returns less than `visible`). The bar's
 * bottom is then at `height + shift === visible`, where it was before.
 */
export function sheetFillShift(
  layout: { containerHeight: number; handleHeight: number },
  position: number,
  height: number | null
): number {
  'worklet';
  if (height === null || layout.containerHeight <= 0) return 0;
  return visibleFill(layout, position) - height;
}

/** Copies `text`; the glyph is a check for 1.5 s after. For `titleTrailing`. */
export function CopyContentButton({
  text,
  label = 'Copy file content',
}: {
  text: string;
  label?: string;
}) {
  const [copied, setCopied] = React.useState(false);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  React.useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  return (
    <Button
      variant="ghost"
      size="icon"
      className="rounded-full"
      hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
      accessibilityLabel={copied ? 'Copied' : label}
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

/**
 * The `ref` half of a sheet component: the modal ref plus the
 * `useImperativeHandle({ open, close })` wiring every sheet hand-rolls.
 * `onOpen` runs before the sheet presents (reset-to-tab, fresh timestamps).
 */
export function useSheetHandle(
  ref: React.ForwardedRef<SheetRef>,
  onOpen?: () => void,
): React.RefObject<BottomSheetModal | null> {
  const modalRef = React.useRef<BottomSheetModal>(null);
  React.useImperativeHandle(
    ref,
    () => ({
      open: () => {
        onOpen?.();
        modalRef.current?.present();
      },
      close: () => modalRef.current?.dismiss(),
    }),
    [onOpen],
  );
  return modalRef;
}

export { useCloseThen } from './use-close-then';
export { useSheetOpenMove } from './use-sheet-open-move';
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
    const { height: windowHeight } = useWindowDimensions();
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
        keyboardBlurBehavior="restore">
        <BottomSheetView style={fullScreen ? { flex: 1 } : undefined}>
          {fullScreen ? (
            // BottomSheetView content-sizes, so a concrete min-height is what
            // lets inner `flex-1` regions expand and pin content to the bottom.
            <View
              style={{
                flex: 1,
                minHeight: windowHeight - insets.top - insets.bottom - 20,
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
export { Header as SheetHeader, Body as SheetBody };
