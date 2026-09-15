/**
 * SandboxHealthPill — floating bottom-right chip that appears when the
 * active sandbox is unreachable. Mirrors the web's `ReconnectPill` in
 * apps/web/src/components/dashboard/connecting-screen.tsx (amber dot,
 * "Unreachable · 53s" label, and a Switch action).
 *
 * The pill self-hides as soon as the sandbox is reachable again, so it's
 * safe to mount globally on session-level screens.
 */

import React, { useEffect, useRef } from 'react';
import { Animated, Easing, Pressable, View } from 'react-native';
import { useColorScheme } from 'nativewind';
import { ArrowLeftRight, CircleAlert } from 'lucide-react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { useSandboxContext } from '@/contexts/SandboxContext';
import { THEME, withAlpha } from '@/lib/utils/theme';
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
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';

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

  const bg = isDark ? withAlpha(THEME.dark.popover, 0.95) : withAlpha(THEME.light.popover, 0.95);
  const border = isDark ? withAlpha(THEME.dark.foreground, 0.08) : withAlpha(THEME.light.foreground, 0.08);
  const fg = isDark ? THEME.dark.foreground : THEME.light.foreground;
  const muted = isDark ? withAlpha(THEME.dark.foreground, 0.55) : withAlpha(THEME.light.foreground, 0.55);
  const mutedFaint = isDark ? withAlpha(THEME.dark.foreground, 0.3) : withAlpha(THEME.light.foreground, 0.3);
  const buttonBg = isDark ? withAlpha(THEME.dark.foreground, 0.08) : withAlpha(THEME.light.foreground, 0.05);

  const pingScale = pingAnim.interpolate({ inputRange: [0, 1], outputRange: [1, 2.2] });
  const pingOpacity = pingAnim.interpolate({ inputRange: [0, 1], outputRange: [0.6, 0] });

  return (
    <View style={{ paddingHorizontal: 12, paddingBottom: 8 }}>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          paddingLeft: 14,
          paddingRight: 6,
          paddingVertical: 6,
          borderRadius: 9999,
          borderWidth: 1,
          borderColor: border,
          backgroundColor: bg,
          shadowColor: '#000', // hex-allowlist: universal shadow ink, not a themed surface color
          shadowOffset: { width: 0, height: 4 },
          shadowOpacity: isDark ? 0.25 : 0.1,
          shadowRadius: 12,
          elevation: 4,
        }}
      >
      {/* Amber dot with ping halo */}
      <View
        style={{
          width: 8,
          height: 8,
          alignItems: 'center',
          justifyContent: 'center',
          marginRight: 8,
        }}
      >
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
        <View
          style={{
            width: 8,
            height: 8,
            borderRadius: 4,
            backgroundColor: THEME.accent.orange,
          }}
        />
      </View>

      {/* Label + elapsed — flex:1 so it takes remaining space and pushes
          the action buttons to the right edge. */}
      <Text
        style={{
          flex: 1,
          fontSize: 12,
          fontFamily: 'Roobert',
          color: muted,
        }}
        numberOfLines={1}
      >
        Unreachable
        {elapsed ? (
          <Text style={{ color: mutedFaint }}>{` · ${elapsed}`}</Text>
        ) : null}
      </Text>

      {/* Health action (optional) */}
      {onHealth && (
        <Pressable
          onPress={onHealth}
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            paddingHorizontal: 10,
            paddingVertical: 5,
            borderRadius: 9999,
            backgroundColor: buttonBg,
            marginLeft: 6,
          }}
        >
          <Icon
            as={CircleAlert}
            size={12}
            color={fg}
            strokeWidth={2.2}
            style={{ marginRight: 4 }}
          />
          <Text style={{ fontSize: 12, fontFamily: 'Roobert-Medium', color: fg }}>
            Health
          </Text>
        </Pressable>
      )}

      {/* Switch action — always present */}
      {onSwitch && (
        <Pressable
          onPress={onSwitch}
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            paddingHorizontal: 10,
            paddingVertical: 5,
            borderRadius: 9999,
            backgroundColor: buttonBg,
            marginLeft: 6,
          }}
        >
          <Icon
            as={ArrowLeftRight}
            size={12}
            color={fg}
            strokeWidth={2.2}
            style={{ marginRight: 4 }}
          />
          <Text style={{ fontSize: 12, fontFamily: 'Roobert-Medium', color: fg }}>
            Switch
          </Text>
        </Pressable>
      )}
      </View>
    </View>
  );
}
