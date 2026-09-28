/**
 * SandboxHealthPill — a bar directly above the chat input, drawn as the
 * composer card, that appears while the session's computer is not ready. Its
 * words are the SDK's (`sessionConnectionLabel`): a yellow dot and "Waking
 * computer · 53s" for a parked or booting computer; an orange dot, "Can't
 * reach computer · 53s", and the Health and Switch actions only when a dial
 * failed.
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
import { sessionConnectionLabel } from '@kortix/sdk';
import {
  useElapsedSince,
  useSandboxReachability,
} from '@/hooks/useSandboxReachability';

interface SandboxHealthPillProps {
  /** Opens the instances picker (= web's "Switch" target). */
  onSwitch?: () => void;
  /** Optional — opens a detailed health sheet. Hidden when omitted. */
  onHealth?: () => void;
  /** Rendered in this slot while the sandbox is reachable: the thread's
   *  "Live updates paused" pill (COR-144), so the two never stack. */
  whenReachable?: React.ReactNode;
}

export function SandboxHealthPill({ onSwitch, onHealth, whenReachable }: SandboxHealthPillProps) {
  const { sandboxUrl } = useSandboxContext();
  const { reachable, downSince, checked, connection } = useSandboxReachability(sandboxUrl);
  const elapsed = useElapsedSince(downSince);
  // The SDK's words for the computer: "Waking computer" for a parked or
  // booting one, "Can't reach computer" only when a dial failed.
  const wording = sessionConnectionLabel(connection);
  const faulted = wording?.tone === 'danger';
  const dotColor = faulted ? THEME.accent.orange : THEME.accent.yellow;

  const show = checked && !reachable && wording !== null;

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

  if (!show) return whenReachable ? <>{whenReachable}</> : null;

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
                backgroundColor: dotColor,
                opacity: pingOpacity,
                transform: [{ scale: pingScale }],
              }}
            />
            <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: dotColor }} />
          </View>
          <Text variant="muted" className="shrink" numberOfLines={1}>
            {wording?.label}
            {elapsed ? <Text variant="muted" className="opacity-60">{` · ${elapsed}`}</Text> : null}
          </Text>
        </View>

        {/* Health and Switch help only when the computer is truly unreachable:
            a waking one needs neither. */}
        {faulted && onHealth ? (
          <Button variant="secondary" size="sm" className="rounded-full" onPress={onHealth}>
            <Icon as={CircleAlert} size={14} />
            <Text>Health</Text>
          </Button>
        ) : null}

        {faulted && onSwitch ? (
          <Button variant="secondary" size="sm" className="rounded-full" onPress={onSwitch}>
            <Icon as={ArrowLeftRight} size={14} />
            <Text>Switch</Text>
          </Button>
        ) : null}
      </View>
    </View>
  );
}
