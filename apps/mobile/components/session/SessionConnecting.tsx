/**
 * SessionConnecting — the middle-pane "starting a session" state.
 *
 * Shown while a project session provisions its sandbox + resolves its OpenCode
 * root. Uses the brand Lottie loader (KortixLoader) and a shimmering status
 * label (ShimmerText) so the wait reads as alive and on-brand, matching the
 * provisioning screen's aesthetic rather than a bare ActivityIndicator.
 *
 * When the runtime fails to boot (e.g. a repo-materialization / git-clone
 * failure surfaced via /kortix/health `boot_error`), it instead renders an
 * inline error with the failure detail + a Restart button — web parity with
 * the dashboard's "OpenCode runtime is not ready" screen
 * (apps/web/.../sessions/[sessionId]/page.tsx InlineSessionError).
 */

import React from 'react';
import { View, ActivityIndicator } from 'react-native';
import { useColorScheme } from 'nativewind';
import { RotateCcw } from 'lucide-react-native';
import { Text } from '@/components/ui/text';
import { Button } from '@/components/ui/button';
import { KortixLoader } from '@/components/kortix/kortix-loader';
import { ShimmerText } from '@/components/kortix/ShimmerText';
import { THEME } from '@/lib/utils/theme';

export interface SessionConnectError {
  title: string;
  message: string;
  /** Raw runtime failure detail (e.g. the git clone error). Shown verbatim. */
  detail?: string;
}

export function SessionConnecting({
  statusLabel,
  error,
  onRestart,
  restarting,
}: {
  statusLabel: string;
  /** When set, render the failure state instead of the loader. */
  error?: SessionConnectError | null;
  onRestart?: () => void;
  restarting?: boolean;
}) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';

  if (error) {
    return (
      <View className="flex-1 items-center justify-center px-8">
        <View className="w-full max-w-md items-center" style={{ gap: 12 }}>
          <Text className="text-[15px] font-roobert-medium text-foreground text-center">
            {error.title}
          </Text>
          <Text className="text-[13px] leading-5 text-muted-foreground text-center">
            {error.message}
          </Text>
          {error.detail ? (
            <View className="w-full rounded-2xl border border-border bg-muted/40 px-3 py-2">
              <Text className="font-mono text-[12px] leading-5 text-muted-foreground">
                {error.detail}
              </Text>
            </View>
          ) : null}
          {onRestart ? (
            <Button
              variant="ghost"
              onPress={onRestart}
              disabled={restarting}
              className="mt-1 h-auto flex-row items-center gap-2 rounded-full border border-border px-4 py-2.5 active:bg-transparent active:opacity-70"
            >
              {restarting ? (
                <ActivityIndicator size="small" color={isDark ? THEME.dark.foreground : THEME.light.foreground} />
              ) : (
                <RotateCcw size={15} color={isDark ? THEME.dark.foreground : THEME.light.foreground} />
              )}
              <Text className="text-[13px] font-roobert-medium text-foreground">
                {restarting ? 'Restarting…' : 'Restart session'}
              </Text>
            </Button>
          ) : null}
        </View>
      </View>
    );
  }

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
