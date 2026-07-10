/**
 * ProjectDock — the floating bottom dock.
 *
 * Collapsed: a context pill (the label + a chevron) and a detached `+` circle.
 * Tapping the pill morphs it upward into a menu card; the circle stays anchored,
 * as in Linear. Long-pressing the pill raises the chat-actions sheet.
 *
 * Purely presentational: no stores, no queries. The parent supplies the label
 * and every callback.
 */
import * as React from 'react';
import { Keyboard, Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Reanimated, {
  Easing,
  interpolate,
  type SharedValue,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { useReanimatedKeyboardAnimation } from 'react-native-keyboard-controller';
import { Plus, type LucideIcon } from 'lucide-react-native';

import { Icon } from '@/components/ui/icon';
import { ListRow } from '@/components/ui/list-row';
import { Separator } from '@/components/ui/separator';
import { Text } from '@/components/ui/text';
import { haptics } from '@/lib/haptics';
import { DOCK_MENU_ENTRIES } from '@/lib/session/dock-menu';
import { DOCK_CHEVRON, DOCK_ICONS } from './dock-icons';

const PILL_H = 48;
const FALLBACK_CARD_H = 340;

// House motion tokens. Expand is the strong ease-out quint; collapse accelerates
// away in ~70% of the enter time; reduced motion drops to a linear cross-fade.
const EXPAND = { duration: 260, easing: Easing.bezier(0.23, 1, 0.32, 1) };
const COLLAPSE = { duration: 180, easing: Easing.bezier(0.4, 0, 1, 1) };
const REDUCED = { duration: 120, easing: Easing.linear };

export interface ProjectDockProps {
  label: string;
  onNewChat: () => void;
  onNavigate: (pageId: string) => void;
  onOpenMore: () => void;
  /** Omit to disable the long-press (non-thread states). */
  onLongPressLabel?: () => void;
  /** When set, renders a change-request circle next to the `+` (web parity:
   *  the session header's changes action). Pass only in thread states. */
  onOpenChangeRequest?: () => void;
}

/** One animated row. Staggers itself off the shared expansion progress. */
function DockRow({
  progress,
  index,
  reduced,
  title,
  icon,
  onPress,
}: {
  progress: SharedValue<number>;
  index: number;
  reduced: boolean;
  title: string;
  icon: LucideIcon;
  onPress: () => void;
}) {
  const style = useAnimatedStyle(() => {
    if (reduced) return { opacity: progress.value, transform: [{ translateY: 0 }] };
    const start = 0.25 + index * 0.06;
    const t = interpolate(progress.value, [start, Math.min(1, start + 0.35)], [0, 1], 'clamp');
    return { opacity: t, transform: [{ translateY: (1 - t) * 6 }] };
  });

  return (
    <Reanimated.View style={style}>
      <ListRow
        title={title}
        left={<Icon as={icon} size={18} className="text-foreground" />}
        right={null}
        divider={false}
        onPress={onPress}
      />
    </Reanimated.View>
  );
}

export function ProjectDock({
  label,
  onNewChat,
  onNavigate,
  onOpenMore,
  onLongPressLabel,
  onOpenChangeRequest,
}: ProjectDockProps) {
  const insets = useSafeAreaInsets();
  const reduced = useReducedMotion();
  const progress = useSharedValue(0);
  const heightProgress = useSharedValue(0);
  const cardH = useSharedValue(FALLBACK_CARD_H);
  const [open, setOpen] = React.useState(false);
  const [keyboardUp, setKeyboardUp] = React.useState(false);

  // RNKC's `height` animates 0 → -keyboardHeight, so negating it slides the
  // dock DOWN behind the keyboard instead of letting it ride up over it.
  const { height: kbHeight, progress: kbProgress } = useReanimatedKeyboardAnimation();

  const timing = reduced ? REDUCED : EXPAND;
  const timingOut = reduced ? REDUCED : COLLAPSE;

  const collapse = React.useCallback(() => {
    setOpen(false);
    heightProgress.value = withTiming(0, reduced ? { duration: 0 } : COLLAPSE);
    progress.value = withTiming(0, timingOut);
  }, [progress, heightProgress, timingOut, reduced]);

  const expand = React.useCallback(() => {
    haptics.tap();
    setOpen(true);
    heightProgress.value = withTiming(1, reduced ? { duration: 0 } : EXPAND);
    progress.value = withTiming(1, timing);
  }, [progress, heightProgress, timing, reduced]);

  // The keyboard and the expanded menu are mutually exclusive.
  React.useEffect(() => {
    const show = Keyboard.addListener('keyboardWillShow', () => setKeyboardUp(true));
    const showA = Keyboard.addListener('keyboardDidShow', () => setKeyboardUp(true));
    const hide = Keyboard.addListener('keyboardWillHide', () => setKeyboardUp(false));
    const hideA = Keyboard.addListener('keyboardDidHide', () => setKeyboardUp(false));
    return () => {
      show.remove();
      showA.remove();
      hide.remove();
      hideA.remove();
    };
  }, []);

  React.useEffect(() => {
    if (keyboardUp && open) collapse();
  }, [keyboardUp, open, collapse]);

  const handlePillPress = React.useCallback(() => {
    if (open) collapse();
    else expand();
  }, [open, collapse, expand]);

  const handleLongPress = React.useCallback(() => {
    haptics.medium();
    onLongPressLabel?.();
  }, [onLongPressLabel]);

  const handleNavigate = React.useCallback(
    (pageId: string) => {
      collapse();
      onNavigate(pageId);
    },
    [collapse, onNavigate],
  );

  const handleMore = React.useCallback(() => {
    collapse();
    onOpenMore();
  }, [collapse, onOpenMore]);

  const handleNewChat = React.useCallback(() => {
    haptics.tap();
    if (open) collapse();
    onNewChat();
  }, [open, collapse, onNewChat]);

  const handleChangeRequest = React.useCallback(() => {
    if (open) collapse();
    onOpenChangeRequest?.();
  }, [open, collapse, onOpenChangeRequest]);

  const scrimStyle = useAnimatedStyle(() => ({ opacity: progress.value * 0.4 }));

  const cardStyle = useAnimatedStyle(() => ({
    height: interpolate(heightProgress.value, [0, 1], [PILL_H, cardH.value]),
  }));

  const pillContentStyle = useAnimatedStyle(() => ({
    opacity: interpolate(progress.value, [0, 0.35], [1, 0], 'clamp'),
  }));

  const dockStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: -kbHeight.value }],
    opacity: 1 - kbProgress.value,
  }));

  // The pill needs no press-scale: its 260ms morph is the feedback. The circle
  // does. It cannot come from Pressable's `style` callback — css-interop
  // overwrites props.style on a classNamed component — so drive it directly.
  const circleScale = useSharedValue(1);
  const circleStyle = useAnimatedStyle(() => ({ transform: [{ scale: circleScale.value }] }));
  const onCirclePressIn = React.useCallback(() => {
    if (reduced) return;
    circleScale.value = withTiming(0.96, { duration: 90, easing: Easing.out(Easing.quad) });
  }, [circleScale, reduced]);
  const onCirclePressOut = React.useCallback(() => {
    if (reduced) return;
    circleScale.value = withTiming(1, { duration: 140, easing: Easing.out(Easing.quad) });
  }, [circleScale, reduced]);

  // Precompute stagger indices once. Dividers never consume an index, so the
  // cadence stays even no matter how DOCK_MENU_ENTRIES is edited. The trailing
  // "More…" row (no pageId) takes the last index.
  const { menu, moreIndex } = React.useMemo(() => {
    let i = -1;
    const rows = DOCK_MENU_ENTRIES.map((entry) => {
      if (entry.kind === 'divider') return { entry, staggerIndex: -1 };
      i += 1;
      return { entry, staggerIndex: i };
    });
    return { menu: rows, moreIndex: i + 1 };
  }, []);

  return (
    <View className="absolute inset-0" pointerEvents="box-none">
      {/* Scrim — sits above content, below the card. */}
      <Reanimated.View
        pointerEvents={open ? 'auto' : 'none'}
        style={scrimStyle}
        className="absolute inset-0 bg-black">
        <Pressable className="flex-1" onPress={collapse} accessibilityLabel="Close menu" />
      </Reanimated.View>

      <Reanimated.View
        pointerEvents={keyboardUp ? 'none' : 'box-none'}
        style={[dockStyle, { paddingBottom: insets.bottom + 8 }]}
        className="absolute inset-x-0 bottom-0 flex-row items-end gap-2 px-3">
        {/* The pill, which morphs into the menu card. Grows upward from the
            pill because the row is bottom-aligned — the morph's origin.
            px-3 matches SessionChatInput's own px-3 wrapper so the dock and the
            composer above it share one gutter. */}
        <Reanimated.View
          style={cardStyle}
          className="flex-1 overflow-hidden rounded-3xl border border-border bg-card">
          {/* Rows — laid out from the top, measured once for the height animation. */}
          <View
            pointerEvents={open ? 'auto' : 'none'}
            onLayout={(e) => {
              const h = e.nativeEvent.layout.height;
              if (h > 0) cardH.value = h;
            }}
            className="absolute inset-x-0 top-0 py-1.5">
            {menu.map(({ entry, staggerIndex }, i) => {
              if (entry.kind === 'divider') {
                return <Separator key={`divider-${i}`} className="mx-4 my-1" />;
              }
              return (
                <DockRow
                  key={entry.pageId}
                  progress={progress}
                  index={staggerIndex}
                  reduced={reduced}
                  title={entry.label}
                  icon={DOCK_ICONS[entry.icon]}
                  onPress={() => handleNavigate(entry.pageId)}
                />
              );
            })}
            {/* Open change request — an action, not a page, so it lives here
                rather than in DOCK_MENU_ENTRIES. Thread states only. */}
            {onOpenChangeRequest ? (
              <>
                <Separator className="mx-4 my-1" />
                <DockRow
                  progress={progress}
                  index={moreIndex}
                  reduced={reduced}
                  title="Open change request"
                  icon={DOCK_ICONS.changeRequest}
                  onPress={handleChangeRequest}
                />
              </>
            ) : null}
            <DockRow
              progress={progress}
              index={onOpenChangeRequest ? moreIndex + 1 : moreIndex}
              reduced={reduced}
              title="More…"
              icon={DOCK_ICONS.more}
              onPress={handleMore}
            />
          </View>

          {/* Collapsed pill content — pinned to the bottom of the morphing card,
              cross-fading out as the rows stagger in. */}
          <Reanimated.View
            pointerEvents={open ? 'none' : 'auto'}
            style={pillContentStyle}
            className="absolute inset-x-0 bottom-0">
            <Pressable
              onPress={handlePillPress}
              onLongPress={onLongPressLabel ? handleLongPress : undefined}
              delayLongPress={350}
              accessibilityRole="button"
              accessibilityLabel={label}
              accessibilityHint={
                onLongPressLabel ? 'Tap for the project menu, long-press for chat actions' : undefined
              }
              className="h-12 flex-row items-center gap-2 px-4">
              <Text variant="small" numberOfLines={1} className="flex-1">
                {label}
              </Text>
              <Icon as={DOCK_CHEVRON} size={16} className="text-muted-foreground" />
            </Pressable>
          </Reanimated.View>
        </Reanimated.View>

        {/* Detached circle — anchored, never moves during expansion.
            Size lives in className, never in a `style` function: css-interop
            assigns into props.style on a classNamed component, so a function
            style is discarded. Passing the size there collapsed this circle to
            its content. h-12/w-12 must stay equal to PILL_H. Press feedback is
            driven by a shared value for the same reason. */}
        <Reanimated.View style={circleStyle}>
          <Pressable
            onPress={handleNewChat}
            onPressIn={onCirclePressIn}
            onPressOut={onCirclePressOut}
            accessibilityRole="button"
            accessibilityLabel="New chat"
            className="h-12 w-12 items-center justify-center rounded-full border border-border bg-card">
            <Icon as={Plus} size={20} className="text-foreground" />
          </Pressable>
        </Reanimated.View>
      </Reanimated.View>
    </View>
  );
}
