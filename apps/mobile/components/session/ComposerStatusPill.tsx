/**
 * ComposerStatusPill — the composer card's status bar, one component for
 * every pill that sits directly above the chat input. It draws the composer
 * card, exactly (`components/kortix/composer.tsx`): the `px-4` edge, the
 * `rounded-3xl border border-border bg-background p-2` row, the dot + label
 * line on the composer's text inset, and the composer's `secondary` `sm`
 * action pills (Jay, 2026-09-23).
 *
 * `SandboxHealthPill` (unreachable computer) and `LiveUpdatesPausedPill`
 * (paused stream) mount it. A new status pill mounts it too, instead of
 * copying the chrome a third time.
 */

import * as React from 'react';
import { Animated, View } from 'react-native';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import type { AppIcon } from '@/lib/icons';

/** The composer's action pill: `secondary` `sm`, rounded-full, 14pt icon. */
export function ComposerStatusAction({
  icon,
  label,
  onPress,
  accessibilityLabel,
}: {
  icon: AppIcon;
  label: string;
  onPress?: () => void;
  accessibilityLabel?: string;
}) {
  return (
    <Button
      variant="secondary"
      size="sm"
      className="rounded-full"
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}>
      <Icon as={icon} size={14} />
      <Text>{label}</Text>
    </Button>
  );
}

interface ComposerStatusPillProps extends React.ComponentPropsWithoutRef<typeof View> {
  /** The dot's fill: `THEME.accent.*`, chosen by the pill's status tone. */
  dotColor: string;
  /** Ping-halo interpolations while the status pulses; absent draws a still dot. */
  ping?: {
    scale: Animated.AnimatedInterpolation<number>;
    opacity: Animated.AnimatedInterpolation<number>;
  };
  /** The status words, already the SDK's (`sessionConnectionLabel`). */
  label: React.ReactNode;
  /** Time since the status started, appended as `· <elapsed>`. */
  elapsed?: string | null;
  /** `ComposerStatusAction`s at the card's right edge. */
  actions?: React.ReactNode;
}

export function ComposerStatusPill({ dotColor, ping, label, elapsed, actions, ...viewProps }: ComposerStatusPillProps) {
  const dot = { width: 8, height: 8, borderRadius: 4, backgroundColor: dotColor };
  return (
    <View className="px-4 pb-2" {...viewProps}>
      <View className="flex-row items-center gap-2 rounded-3xl border border-border bg-background p-2">
        {/* Orange dot with ping halo. `px-2` in the row puts it on the
            composer's text inset (8pt card + 8pt input padding). */}
        <View className="flex-1 flex-row items-center gap-2 px-2">
          {ping ? (
            <View style={{ width: 8, height: 8, alignItems: 'center', justifyContent: 'center' }}>
              <Animated.View
                style={{
                  position: 'absolute',
                  ...dot,
                  opacity: ping.opacity,
                  transform: [{ scale: ping.scale }],
                }}
              />
              <View style={dot} />
            </View>
          ) : (
            <View style={dot} />
          )}
          <Text variant="muted" className="shrink" numberOfLines={1}>
            {label}
            {elapsed ? <Text variant="muted" className="opacity-60">{` · ${elapsed}`}</Text> : null}
          </Text>
        </View>
        {actions}
      </View>
    </View>
  );
}
