/**
 * Global connectivity banner. Slides down from the top when the backend is
 * unreachable ("No internet connection") and briefly flashes a green
 * "Back online" when it recovers, then slides away. Overlay-positioned so it
 * never disturbs the navigator layout; non-interactive (taps pass through).
 */

import React, { useEffect, useRef, useState } from 'react';
import { Animated, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useColorScheme } from 'nativewind';
import { WifiOff, Wifi } from 'lucide-react-native';
import { Text } from '@/components/ui/text';
import { useOnlineStatus } from '@/lib/network/use-online-status';

type Mode = 'hidden' | 'offline' | 'reconnected';

export function OfflineBanner() {
  const online = useOnlineStatus();
  const insets = useSafeAreaInsets();
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';

  const [mode, setMode] = useState<Mode>('hidden');
  const wasOffline = useRef(false);
  const translateY = useRef(new Animated.Value(-160)).current;

  // Drive the banner state from connectivity transitions.
  useEffect(() => {
    if (!online) {
      wasOffline.current = true;
      setMode('offline');
    } else if (wasOffline.current) {
      wasOffline.current = false;
      setMode('reconnected');
      const t = setTimeout(() => setMode('hidden'), 1800);
      return () => clearTimeout(t);
    }
  }, [online]);

  // Slide in/out.
  useEffect(() => {
    Animated.spring(translateY, {
      toValue: mode === 'hidden' ? -160 : 0,
      useNativeDriver: true,
      damping: 19,
      stiffness: 190,
      mass: 0.75,
    }).start();
  }, [mode, translateY]);

  const offline = mode === 'offline';
  const bg = offline
    ? (isDark ? '#3a1416' : '#fee2e2')
    : (isDark ? '#10301d' : '#dcfce7');
  const fg = offline
    ? (isDark ? '#fca5a5' : '#b91c1c')
    : (isDark ? '#86efac' : '#15803d');

  return (
    <Animated.View
      pointerEvents="none"
      style={{ position: 'absolute', top: 0, left: 0, right: 0, zIndex: 9999, transform: [{ translateY }] }}
    >
      <View style={{ paddingTop: insets.top + 6, paddingBottom: 9, paddingHorizontal: 16, backgroundColor: bg }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7 }}>
          {offline ? <WifiOff size={14} color={fg} /> : <Wifi size={14} color={fg} />}
          <Text style={{ fontSize: 13, fontFamily: 'Roobert-Medium', color: fg }}>
            {offline ? 'No internet connection' : 'Back online'}
          </Text>
        </View>
      </View>
    </Animated.View>
  );
}
