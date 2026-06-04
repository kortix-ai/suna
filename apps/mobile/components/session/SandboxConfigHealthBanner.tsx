/**
 * SandboxConfigHealthBanner — mobile port of the web SidebarConfigDegradationNotice
 * (apps/web/src/components/sidebar/sidebar-left.tsx:943).
 *
 * Shows a yellow "Config ignored" / "Runtime healthy" card when the sandbox's
 * /config/status endpoint reports a skipped config source. Exposes "Fix"
 * (start a repair task) and "Prompt" (copy fix prompt to clipboard) actions.
 *
 * Renders nothing when the runtime config is healthy.
 */

import React, { useCallback, useEffect, useRef } from 'react';
import { Animated, Easing, Platform, Pressable, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import { useColorScheme } from 'nativewind';
import { CheckCircle2, Copy, Loader, ShieldAlert, SquarePen } from 'lucide-react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { useToast } from '@/components/ui/toast-provider';
import { useSandboxConfigStatus } from '@/hooks/useSandboxConfigStatus';

export function SandboxConfigHealthBanner() {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const toast = useToast();

  const {
    hasProblem,
    primaryProblem,
    extraProblemsCount,
    configFixProject,
    configFixPrompt,
    startFixTask,
    isStartingFix,
  } = useSandboxConfigStatus();

  const pingAnim = useRef(new Animated.Value(0)).current;
  const spinAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!hasProblem) return;
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
  }, [hasProblem, pingAnim]);

  useEffect(() => {
    if (!isStartingFix) {
      spinAnim.stopAnimation();
      spinAnim.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.timing(spinAnim, {
        toValue: 1,
        duration: 900,
        easing: Easing.linear,
        useNativeDriver: true,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [isStartingFix, spinAnim]);

  const handleFix = useCallback(async () => {
    try {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      const result = await startFixTask();
      toast.success(`Fix task started in ${result.project.name || result.project.path}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to start fix task');
    }
  }, [startFixTask, toast]);

  const handleCopyPrompt = useCallback(async () => {
    if (!configFixPrompt) return;
    try {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      await Clipboard.setStringAsync(configFixPrompt);
      toast.success('Fix prompt copied');
    } catch {
      toast.error('Failed to copy prompt');
    }
  }, [configFixPrompt, toast]);

  if (!hasProblem || !primaryProblem) return null;

  // Tokens mirror the web: amber border/18, sidebar-accent/45 background,
  // emerald pill, foreground-on-background primary button.
  const amber = '#F59E0B';
  const amberSoft = 'rgba(245,158,11,0.8)';
  const borderColor = isDark ? 'rgba(245,158,11,0.22)' : 'rgba(245,158,11,0.28)';
  const cardBg = isDark ? 'rgba(248,248,248,0.04)' : 'rgba(18,18,21,0.025)';
  const emeraldBorder = isDark ? 'rgba(16,185,129,0.25)' : 'rgba(16,185,129,0.3)';
  const emeraldBg = isDark ? 'rgba(16,185,129,0.12)' : 'rgba(16,185,129,0.1)';
  const emeraldFg = isDark ? '#34D399' : '#059669';
  const primaryBg = isDark ? '#F8F8F8' : '#121215';
  const primaryFg = isDark ? '#121215' : '#F8F8F8';
  const outlineBg = isDark ? 'rgba(248,248,248,0.04)' : 'rgba(18,18,21,0.03)';
  const outlineBorder = isDark ? 'rgba(248,248,248,0.12)' : 'rgba(18,18,21,0.12)';

  const pingScale = pingAnim.interpolate({ inputRange: [0, 1], outputRange: [0.9, 2.2] });
  const pingOpacity = pingAnim.interpolate({ inputRange: [0, 1], outputRange: [0.55, 0] });
  const spin = spinAnim.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });

  const taskTargetLabel = configFixProject
    ? `${configFixProject.name || configFixProject.path} (${configFixProject.path})`
    : null;

  return (
    <View
      className="rounded-2xl"
      style={{
        borderWidth: 1,
        borderColor,
        backgroundColor: cardBg,
        paddingHorizontal: 14,
        paddingVertical: 12,
      }}
    >
      <View className="flex-row items-start" style={{ gap: 10 }}>
        {/* Shield + pulsing dot */}
        <View style={{ marginTop: 2, width: 18, height: 18, position: 'relative' }}>
          <Icon as={ShieldAlert} size={16} color={amberSoft} strokeWidth={2} />
          <View
            style={{
              position: 'absolute',
              top: -2,
              right: -2,
              width: 8,
              height: 8,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Animated.View
              style={{
                position: 'absolute',
                width: 8,
                height: 8,
                borderRadius: 4,
                backgroundColor: amber,
                opacity: pingOpacity,
                transform: [{ scale: pingScale }],
              }}
            />
            <View
              style={{
                width: 8,
                height: 8,
                borderRadius: 4,
                backgroundColor: amber,
              }}
            />
          </View>
        </View>

        <View className="flex-1 min-w-0" style={{ gap: 8 }}>
          {/* Title row */}
          <View className="flex-row items-center flex-wrap" style={{ gap: 8 }}>
            <Text className="font-roobert-medium text-[13px] text-foreground">
              Config ignored
            </Text>
            <View
              className="flex-row items-center rounded-full"
              style={{
                borderWidth: 1,
                borderColor: emeraldBorder,
                backgroundColor: emeraldBg,
                paddingHorizontal: 6,
                paddingVertical: 2,
                gap: 3,
              }}
            >
              <Icon as={CheckCircle2} size={10} color={emeraldFg} strokeWidth={2.5} />
              <Text
                className="font-roobert-medium"
                style={{ color: emeraldFg, fontSize: 10 }}
              >
                Runtime healthy
              </Text>
            </View>
          </View>

          {/* Error / source */}
          <View style={{ gap: 3 }}>
            <Text
              className="font-roobert text-[11px] text-muted-foreground"
              style={{ lineHeight: 16 }}
            >
              {primaryProblem.message || 'An invalid config source is being ignored.'}
            </Text>
            <Text
              className="text-muted-foreground/80"
              numberOfLines={1}
              style={{
                fontSize: 10,
                fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }),
              }}
            >
              {primaryProblem.source}
            </Text>
          </View>

          {/* Actions */}
          <View className="flex-row items-center flex-wrap" style={{ gap: 6 }}>
            <Pressable
              onPress={handleFix}
              disabled={isStartingFix}
              className="flex-row items-center rounded-lg active:opacity-85"
              style={{
                backgroundColor: primaryBg,
                paddingHorizontal: 10,
                paddingVertical: 6,
                gap: 6,
                opacity: isStartingFix ? 0.75 : 1,
              }}
            >
              {isStartingFix ? (
                <Animated.View style={{ transform: [{ rotate: spin }] }}>
                  <Icon as={Loader} size={12} color={primaryFg} strokeWidth={2.5} />
                </Animated.View>
              ) : (
                <Icon as={SquarePen} size={12} color={primaryFg} strokeWidth={2.5} />
              )}
              <Text
                className="font-roobert-semibold"
                style={{ color: primaryFg, fontSize: 12 }}
              >
                Fix
              </Text>
            </Pressable>

            <Pressable
              onPress={handleCopyPrompt}
              className="flex-row items-center rounded-lg active:opacity-85"
              style={{
                borderWidth: 1,
                borderColor: outlineBorder,
                backgroundColor: outlineBg,
                paddingHorizontal: 10,
                paddingVertical: 6,
                gap: 6,
              }}
            >
              <Icon as={Copy} size={12} className="text-foreground" strokeWidth={2.2} />
              <Text className="font-roobert-medium text-foreground" style={{ fontSize: 12 }}>
                Prompt
              </Text>
            </Pressable>

            {extraProblemsCount > 0 && (
              <Text className="font-roobert text-muted-foreground" style={{ fontSize: 10 }}>
                +{extraProblemsCount} more source{extraProblemsCount === 1 ? '' : 's'}
              </Text>
            )}
          </View>

          {/* Footer */}
          <Text
            className="font-roobert text-muted-foreground/70"
            style={{ fontSize: 10, lineHeight: 14 }}
          >
            {taskTargetLabel
              ? `Fix task target: ${taskTargetLabel}`
              : 'Fix tasks will create a Workspace project automatically if needed.'}
          </Text>
        </View>
      </View>
    </View>
  );
}
