/**
 * Where a tool row is drawn, and the card its expanded payload sits in.
 *
 * Mirrors apps/web `tool/shared/surface.tsx` + `ToolOutputCard` /
 * `ToolResultCard`:
 * - `ToolRowVariantContext` — a row inside a chain of thought (`activity-step`)
 *   uses `gap-3`, `text-sm leading-[1.5]`, and a 1.75rem card indent; every
 *   other surface keeps `gap-1.5` and 1.375rem. One context carries the gap
 *   and the indent together so they cannot drift apart (web `--tool-indent`).
 * - `ToolCardFrame` — `border bg-popover rounded-md`, `mt-1.5`, indented to the
 *   row's text column, body capped at `max-h-96` and scrollable, an optional
 *   floating copy button with the `pr-11` reserve.
 */

import {
  createContext,
  isValidElement,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import { ScrollView, View } from 'react-native';
import Animated, { Easing, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import * as Clipboard from 'expo-clipboard';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { CaretRightIcon, CheckIcon, CopyIcon, type AppIcon } from '@/lib/icons';
import { MOTION } from '@/lib/utils/theme';
import { TURN_SPACE, useTurnPalette } from './styles';

/**
 * Which surface a tool view is drawn on (web `surface.tsx`). Mobile has only
 * the inline transcript — there is no side panel — so every provider in the
 * app leaves this at `'inline'`. The value shape is kept so a renderer ported
 * from web can read it unchanged, and the hooks below honour `'panel'` the way
 * web does if a host ever supplies it.
 */
export type ToolSurface = 'inline' | 'panel';

export const ToolSurfaceContext = createContext<ToolSurface>('inline');

export interface ToolRowVariant {
  /** The row is a step in a chain of thought. */
  chain: boolean;
  /** A bare step hides the tool's leading icon (never the outcome mark). */
  hideIcon: boolean;
}

export const ToolRowVariantContext = createContext<ToolRowVariant>({ chain: false, hideIcon: false });

export function useToolRowVariant(): ToolRowVariant {
  return useContext(ToolRowVariantContext);
}

/** Web `TOOL_INDENT` default: `--tool-indent` 1.375rem (22px). */
export const TOOL_INDENT = TURN_SPACE.toolIndent;

/**
 * Left offset of a card under a tool row: the row's text column. Web returns a
 * class (`ml-[var(--tool-indent)]` or `''`); mobile returns points (`0` on the
 * panel surface). Pair it with the `mt-1.5` seam web gates on the same value:
 * `{ marginLeft: indent, marginTop: indent ? TURN_SPACE.gap1_5 : 0 }`.
 */
export function useToolIndent(): number {
  const surface = useContext(ToolSurfaceContext);
  const { chain } = useToolRowVariant();
  if (surface !== 'inline') return 0;
  return chain ? TURN_SPACE.toolIndentChain : TURN_SPACE.toolIndent;
}

export interface ToolCardFrameStyle {
  borderWidth: number;
  borderColor: string;
  backgroundColor: string;
  borderRadius: number;
}

/**
 * Web `useToolCardFrame`: `border-border bg-popover rounded-md border` on the
 * inline surface, nothing on the panel. Spread the result into a style.
 */
export function useToolCardFrame(): ToolCardFrameStyle | null {
  const surface = useContext(ToolSurfaceContext);
  const palette = useTurnPalette();
  if (surface !== 'inline') return null;
  return {
    borderWidth: 1,
    borderColor: palette.border,
    backgroundColor: palette.popover,
    borderRadius: TURN_SPACE.radiusMd,
  };
}

/** Web `useToolCardPad`: `p-3` inline, `0` on the panel. */
export function useToolCardPad(): number {
  return useContext(ToolSurfaceContext) === 'inline' ? TURN_SPACE.cardPad : 0;
}

export function ToolCopyButton({ text }: { text: string }) {
  const palette = useTurnPalette();
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const onPress = useCallback(() => {
    void Clipboard.setStringAsync(text);
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 2000);
  }, [text]);

  return (
    <Button
      variant="ghost"
      size="icon"
      accessibilityLabel={copied ? 'Copied' : 'Copy output'}
      onPress={onPress}
      style={{ position: 'absolute', top: TURN_SPACE.copyInset, right: TURN_SPACE.copyInset, zIndex: 10 }}
    >
      <Icon
        as={copied ? CheckIcon : CopyIcon}
        size={TURN_SPACE.icon}
        color={copied ? palette.success : palette.muted60}
      />
    </Button>
  );
}

/**
 * The hairline card under an expanded tool row.
 *
 * `padded` applies web's `p-3` (+ `pr-11` when copyable). Mobile's per-tool
 * renderers (`tool/tools/*`) still bring their own insets, so they are hosted
 * with `padded={false}` until each is ported.
 */
export function ToolCardFrame({
  children,
  copyText,
  padded = true,
  scroll = true,
  tone = 'default',
  framePad = 0,
}: {
  children: ReactNode;
  copyText?: string;
  padded?: boolean;
  scroll?: boolean;
  /** `destructive` is web `ToolResultCard tone="destructive"`: `border-destructive/40 bg-destructive/10`. */
  tone?: 'default' | 'destructive';
  /** `ToolResultCard` keeps a `p-1` gutter on the frame itself. */
  framePad?: number;
}) {
  const palette = useTurnPalette();
  const indent = useToolIndent();
  const pad = padded ? TURN_SPACE.cardPad : 0;
  const bodyStyle = {
    padding: pad,
    paddingRight: copyText ? TURN_SPACE.copyReserve : pad,
  };

  return (
    <View
      style={{
        marginTop: TURN_SPACE.gap1_5,
        marginLeft: indent,
        padding: framePad,
        borderWidth: 1,
        borderRadius: TURN_SPACE.radiusMd,
        borderColor: tone === 'destructive' ? palette.destructive40 : palette.border,
        backgroundColor: tone === 'destructive' ? palette.destructive10 : palette.popover,
        overflow: 'hidden',
      }}
    >
      {scroll ? (
        <ScrollView
          style={{ maxHeight: TURN_SPACE.outputMaxHeight }} bounces={false} overScrollMode="never"
          contentContainerStyle={bodyStyle}
          nestedScrollEnabled
          showsVerticalScrollIndicator
        >
          {children}
        </ScrollView>
      ) : (
        <View style={bodyStyle}>{children}</View>
      )}
      {copyText ? <ToolCopyButton text={copyText} /> : null}
    </View>
  );
}

/** Tailwind `transition-transform` default: 150ms, cubic-bezier(0.4, 0, 0.2, 1). */
const TOOL_CARET_TIMING = { duration: MOTION.duration.normal, easing: Easing.bezier(...MOTION.easing.inOut) };

/**
 * The disclosure mark every tool fold uses (web `CaretRightIcon` +
 * `transition-transform`, `rotate-90` when open), at any size — `size-3` in
 * `FoldedSection` / `StructuredOutput`, `size-3.5` in `ToolListRow`.
 */
export function ToolCaret({ open, color, size }: { open: boolean; color: string; size: number }) {
  const rotation = useSharedValue(open ? 90 : 0);
  useEffect(() => {
    rotation.value = withTiming(open ? 90 : 0, TOOL_CARET_TIMING);
  }, [open, rotation]);
  const style = useAnimatedStyle(() => ({ transform: [{ rotate: `${rotation.value}deg` }] }));
  return (
    <Animated.View style={[{ flexShrink: 0 }, style]}>
      <CaretRightIcon size={size} color={color} />
    </Animated.View>
  );
}

/**
 * An icon passed as a value. Web renderers pass a node (`icon={<GlobeIcon />}`);
 * mobile rows take an `AppIcon` component so the row can size and tint it. A
 * node is rendered as given.
 */
export type ToolIcon = AppIcon | ReactElement;

export function ToolIconSlot({ icon, size, color }: { icon: ToolIcon | undefined; size: number; color: string }) {
  if (!icon) return null;
  if (isValidElement(icon)) return icon;
  const Glyph = icon as AppIcon;
  return <Glyph size={size} color={color} />;
}
