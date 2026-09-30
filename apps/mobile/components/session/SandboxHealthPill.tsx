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
import { Animated, Easing } from 'react-native';
import { ArrowsLeftRightIcon as ArrowLeftRight, WarningCircleIcon as CircleAlert } from '@/lib/icons';
import { useSandboxContext } from '@/contexts/SandboxContext';
import { THEME } from '@/lib/utils/theme';
import { sessionConnectionLabel } from '@kortix/sdk';
import {
  useElapsedSince,
  useSandboxReachability,
} from '@/hooks/useSandboxReachability';
import { ComposerStatusAction, ComposerStatusPill } from './ComposerStatusPill';

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

  // The composer card, exactly (components/kortix/composer.tsx) — drawn by
  // `ComposerStatusPill` (Jay, 2026-09-23).
  return (
    <ComposerStatusPill
      dotColor={dotColor}
      ping={{ scale: pingScale, opacity: pingOpacity }}
      label={wording?.label}
      elapsed={elapsed}
      actions={
        <>
          {/* Health and Switch help only when the computer is truly unreachable:
              a waking one needs neither. */}
          {faulted && onHealth ? (
            <ComposerStatusAction icon={CircleAlert} label="Health" onPress={onHealth} />
          ) : null}

          {faulted && onSwitch ? (
            <ComposerStatusAction icon={ArrowLeftRight} label="Switch" onPress={onSwitch} />
          ) : null}
        </>
      }
    />
  );
}
