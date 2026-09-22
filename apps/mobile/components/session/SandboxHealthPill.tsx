/**
 * SandboxHealthPill — a bar directly above the chat input, drawn as the
 * composer card, that appears when the active sandbox is unreachable. Mirrors the web's `ReconnectPill` in
 * apps/web/src/components/dashboard/connecting-screen.tsx (amber dot,
 * "Unreachable · 53s" label, and a Switch action).
 *
 * The pill self-hides as soon as the sandbox is reachable again, so it's
 * safe to mount globally on session-level screens.
 */

import React, { useEffect, useRef } from 'react';
import { Animated, Easing, View } from 'react-native';
import { ArrowsLeftRightIcon as ArrowLeftRight, WarningCircleIcon as CircleAlert } from '@/lib/icons';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { useSandboxContext } from '@/contexts/SandboxContext';
import { THEME } from '@/lib/utils/theme';
import {
  useElapsedSince,
  useSandboxReachability,
} from '@/hooks/useSandboxReachability';

interface SandboxHealthPillProps {
  /** Opens the instances picker (= web's "Switch" target). */
  onSwitch?: () => void;
  /** Optional — opens a detailed health sheet. Hidden when omitted. */
  onHealth?: () => void;
}

export function SandboxHealthPill({ onSwitch, onHealth }: SandboxHealthPillProps) {
  const { sandboxUrl } = useSandboxContext();
  const { reachable, downSince, checked } = useSandboxReachability(sandboxUrl);
  const elapsed = useElapsedSince(downSince);

  const show = checked && !reachable;

  // Amber dot ping animation (mirrors `animate-ping` on web).
  const pingAnim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!show) return;
    const loop = Animated.loop(
      Animated.timing(pingAnim, {
        toValue: 1,
        duration: 1400,
        easing: Easing.out(Easing.quad),
        useNativeDriver: true,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [show, pingAnim]);

  if (!show) return null;

  const pingScale = pingAnim.interpolate({ inputRange: [0, 1], outputRange: [1, 2.2] });
  const pingOpacity = pingAnim.interpolate({ inputRange: [0, 1], outputRange: [0.6, 0] });

  // The composer card, exactly (components/kortix/composer.tsx): `px-4`
  // edge, `rounded-3xl border border-border bg-background p-2`, and the
  // composer's `secondary` `sm` pills for the actions (Jay, 2026-09-23).
  return (
    <View className="px-4 pb-2">
      <View className="flex-row items-center gap-2 rounded-3xl border border-border bg-background p-2">
        {/* Orange dot with ping halo. `px-2` in the row puts it on the
            composer's text inset (8pt card + 8pt input padding). */}
        <View className="flex-1 flex-row items-center gap-2 px-2">
          <View style={{ width: 8, height: 8, alignItems: 'center', justifyContent: 'center' }}>
            <Animated.View
              style={{
                position: 'absolute',
                width: 8,
                height: 8,
                borderRadius: 4,
                backgroundColor: THEME.accent.orange,
                opacity: pingOpacity,
                transform: [{ scale: pingScale }],
              }}
            />
            <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: THEME.accent.orange }} />
          </View>
          <Text variant="muted" className="shrink" numberOfLines={1}>
            Unreachable
            {elapsed ? <Text variant="muted" className="opacity-60">{` · ${elapsed}`}</Text> : null}
          </Text>
        </View>

        {onHealth ? (
          <Button variant="secondary" size="sm" className="rounded-full" onPress={onHealth}>
            <Icon as={CircleAlert} size={14} />
            <Text>Health</Text>
          </Button>
        ) : null}

        {onSwitch ? (
          <Button variant="secondary" size="sm" className="rounded-full" onPress={onSwitch}>
            <Icon as={ArrowLeftRight} size={14} />
            <Text>Switch</Text>
          </Button>
        ) : null}
      </View>
    </View>
  );
}
