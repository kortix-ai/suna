/**
 * SessionConnecting — the middle-pane "starting a session" state.
 *
 * Shown while a project session provisions its sandbox + resolves its OpenCode
 * root. Uses the brand Lottie loader (KortixLoader) and a shimmering status
 * label (ShimmerText) so the wait reads as alive and on-brand, matching the
 * provisioning screen's aesthetic rather than a bare ActivityIndicator.
 */

import React from 'react';
import { View } from 'react-native';
import { Text } from '@/components/ui/text';
import { KortixLoader } from '@/components/ui/kortix-loader';
import { ShimmerText } from '@/components/ui/ShimmerText';

export function SessionConnecting({ statusLabel }: { statusLabel: string }) {
  return (
    <View className="flex-1 items-center justify-center px-8">
      {/* Brand loader */}
      <KortixLoader customSize={64} speed={1.2} />

      {/* Title */}
      <Text className="mt-7 text-[15px] font-roobert-medium text-foreground">
        Starting session
      </Text>

      {/* Live status — shimmers while the sandbox warms up */}
      <View className="mt-1.5">
        <ShimmerText text={statusLabel} size="sm" />
      </View>
    </View>
  );
}
