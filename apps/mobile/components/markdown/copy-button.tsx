import * as Clipboard from 'expo-clipboard';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable } from 'react-native';
import Animated, { Easing, Keyframe } from 'react-native-reanimated';

import { Icon } from '@/components/ui/icon';
import { haptics } from '@/lib/haptics';
import { CheckIcon, CopyIcon } from '@/lib/icons';
import { log } from '@/lib/logger';
import { CODE_BLOCK } from '@/lib/markdown/markdown-layout';
import { MOTION } from '@/lib/utils/theme';

/** Spread to the 44pt minimum touch target around the 25.76pt visible button. */
const HIT_SLOP = (44 - CODE_BLOCK.copyButtonSize) / 2;

/**
 * Glyph swap: web springs scale 0.25 → 1 with a 4px blur. React Native has no
 * cheap blur, so the swap scales from 0.6 (no blur to hide a smaller start)
 * and fades; the exit runs at ~75% of the enter.
 */
const EASE_OUT = Easing.bezier(...MOTION.easing.out);
const SWAP_IN = new Keyframe({
  0: { opacity: 0, transform: [{ scale: 0.6 }] },
  100: { opacity: 1, transform: [{ scale: 1 }], easing: EASE_OUT },
}).duration(MOTION.duration.moderate);
const SWAP_OUT = new Keyframe({
  0: { opacity: 1, transform: [{ scale: 1 }] },
  100: { opacity: 0, transform: [{ scale: 0.6 }], easing: EASE_OUT },
}).duration(MOTION.duration.normal);

/**
 * Copies `code` and swaps the copy glyph for a check for 2 s — web's
 * `components/markdown/copy-button.tsx`, `size="md"`.
 *
 * A raw `Pressable`, not `Button`: the code-block caption is 29.5pt tall on
 * web, and the smallest `Button` (`size="icon"`, 40pt) would push it to 40pt.
 * `hitSlop` restores the 44pt touch target without changing the layout.
 */
export function CopyButton({ code, color }: { code: string; color: string }) {
  const [copied, setCopied] = useState(false);
  const reset = useRef<ReturnType<typeof setTimeout> | null>(null);
  // No enter animation when the block mounts, only when a copy swaps the glyph.
  const swapped = useRef(false);

  useEffect(
    () => () => {
      if (reset.current) clearTimeout(reset.current);
    },
    [],
  );

  const onPress = useCallback(async () => {
    try {
      await Clipboard.setStringAsync(code);
      haptics.success();
      swapped.current = true;
      setCopied(true);
      if (reset.current) clearTimeout(reset.current);
      reset.current = setTimeout(() => setCopied(false), CODE_BLOCK.copiedResetMs);
    } catch (error) {
      log.error('Failed to copy code block:', error);
    }
  }, [code]);

  return (
    <Pressable
      onPress={onPress}
      hitSlop={HIT_SLOP}
      accessibilityRole="button"
      accessibilityLabel={copied ? 'Copied' : 'Copy code'}
      className="items-center justify-center rounded-md active:bg-accent"
      style={{ width: CODE_BLOCK.copyButtonSize, height: CODE_BLOCK.copyButtonSize }}
    >
      {/* Absolute, so the outgoing and incoming glyphs overlap instead of stacking. */}
      <Animated.View
        key={copied ? 'check' : 'copy'}
        entering={swapped.current ? SWAP_IN : undefined}
        exiting={SWAP_OUT}
        style={{ position: 'absolute' }}
      >
        <Icon as={copied ? CheckIcon : CopyIcon} size={CODE_BLOCK.copyIconSize} color={color} />
      </Animated.View>
    </Pressable>
  );
}
