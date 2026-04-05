/**
 * ProvisioningProgress — full-screen provisioning progress view for mobile.
 *
 * Mirrors the web frontend's provisioning-progress.tsx:
 * - Circular SVG progress ring with animated percentage
 * - Current stage label
 * - Stage list with scroll animation
 * - "First boot" help text
 */

import React, { useEffect, useMemo } from 'react';
import { View } from 'react-native';
import Svg, { Circle } from 'react-native-svg';
import Animated, {
  useSharedValue,
  useAnimatedProps,
  withTiming,
  Easing,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useColorScheme } from 'nativewind';
import { CheckCircle2, Loader2 } from 'lucide-react-native';

import { Text } from '@/components/ui/text';
import { KortixLogo } from '@/components/ui/KortixLogo';
import { STAGE_LABELS, type ProvisioningStageInfo } from '@/lib/platform/provisioning-stages';

const AnimatedCircle = Animated.createAnimatedComponent(Circle);

// ─── Circular Progress ───────────────────────────────────────────────────────

interface CircularProgressProps {
  progress: number;
  size?: number;
  strokeWidth?: number;
}

function CircularProgress({ progress, size = 144, strokeWidth = 6 }: CircularProgressProps) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';

  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const center = size / 2;

  const animatedProgress = useSharedValue(0);

  useEffect(() => {
    animatedProgress.value = withTiming(progress / 100, {
      duration: 600,
      easing: Easing.out(Easing.cubic),
    });
  }, [progress, animatedProgress]);

  const animatedProps = useAnimatedProps(() => {
    const offset = circumference * (1 - animatedProgress.value);
    return {
      strokeDashoffset: offset,
    };
  });

  const primaryColor = isDark ? '#e84d8a' : '#d6336c';
  const trackColor = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)';

  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      <Svg width={size} height={size} style={{ transform: [{ rotate: '-90deg' }] }}>
        {/* Track */}
        <Circle
          cx={center}
          cy={center}
          r={radius}
          stroke={trackColor}
          strokeWidth={strokeWidth}
          fill="none"
        />
        {/* Progress arc */}
        <AnimatedCircle
          cx={center}
          cy={center}
          r={radius}
          stroke={primaryColor}
          strokeWidth={strokeWidth}
          fill="none"
          strokeDasharray={circumference}
          animatedProps={animatedProps}
          strokeLinecap="round"
        />
      </Svg>
      {/* Percentage text in center */}
      <View style={{ position: 'absolute', alignItems: 'center', justifyContent: 'center' }}>
        <Text className="text-2xl font-roobert-light text-foreground/90" style={{ fontVariant: ['tabular-nums'] }}>
          {`${Math.round(progress)}%`}
        </Text>
      </View>
    </View>
  );
}

// ─── Stage List Item ─────────────────────────────────────────────────────────

function StageItem({
  stage,
  isDone,
  isActive,
}: {
  stage: ProvisioningStageInfo;
  isDone: boolean;
  isActive: boolean;
}) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const primaryColor = isDark ? '#e84d8a' : '#d6336c';
  const mutedColor = isDark ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.15)';
  const doneColor = isDark ? 'rgba(232,77,138,0.5)' : 'rgba(214,51,108,0.5)';

  return (
    <View className="flex-row items-center justify-center gap-3" style={{ height: 36 }}>
      <View style={{ width: 16, height: 16, alignItems: 'center', justifyContent: 'center' }}>
        {isDone ? (
          <CheckCircle2 size={14} color={doneColor} />
        ) : isActive ? (
          <Loader2 size={14} color={primaryColor} />
        ) : (
          <View style={{ width: 4, height: 4, borderRadius: 2, backgroundColor: mutedColor }} />
        )}
      </View>
      <Text
        className={`text-[13px] ${
          isActive
            ? 'text-foreground/90 font-roobert-medium'
            : isDone
              ? 'text-foreground/25 font-roobert'
              : 'text-foreground/15 font-roobert'
        }`}
      >
        {stage.message}
      </Text>
    </View>
  );
}

// ─── Main Component ──────────────────────────────────────────────────────────

export interface ProvisioningProgressProps {
  progress: number;
  stages: ProvisioningStageInfo[] | null;
  currentStage: string | null;
  stageMessage: string | null;
  machineInfo: { ip: string; serverType: string; location: string } | null;
  error: string | null;
}

export function ProvisioningProgress({
  progress,
  stages,
  currentStage,
  stageMessage,
  machineInfo,
  error,
}: ProvisioningProgressProps) {
  const insets = useSafeAreaInsets();
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';

  const stageCount = stages?.length || 0;
  const currentStageIdx = stages?.findIndex((s) => s.id === currentStage) ?? -1;
  const completedCount = Math.max(0, currentStageIdx);

  const stageDisplayText = useMemo(() => {
    if (error) return error;
    // Prefer backend message (e.g. "Pulling sandbox image...") over static labels
    if (stageMessage) return stageMessage;
    if (!currentStage) return 'Preparing your workspace';
    return STAGE_LABELS[currentStage] || 'Preparing your workspace';
  }, [currentStage, stageMessage, error]);

  const primaryColor = isDark ? '#e84d8a' : '#d6336c';
  const primaryColorFaint = isDark ? 'rgba(232,77,138,0.5)' : 'rgba(214,51,108,0.5)';

  return (
    <View
      className="flex-1 bg-background"
      style={{ paddingTop: insets.top, paddingBottom: insets.bottom }}
    >
      <View className="flex-1 items-center justify-center px-8">
        {/* Logo */}
        <View className="mb-10">
          <KortixLogo size={28} variant="symbol" color={isDark ? 'dark' : 'light'} />
        </View>

        {/* Title */}
        <Text className="text-xs font-roobert-medium text-foreground/30 tracking-[3px] uppercase mb-8">
          Creating Workspace
        </Text>

        {/* Circular progress */}
        <CircularProgress progress={progress} />

        {/* Progress bar (linear, below circle) */}
        <View className="mt-6 w-full" style={{ maxWidth: 280 }}>
          <View
            className="h-[3px] rounded-full overflow-hidden"
            style={{ backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)' }}
          >
            <View
              className="h-full rounded-full"
              style={{
                width: `${Math.min(progress, 100)}%`,
                backgroundColor: primaryColor,
              }}
            />
          </View>
          <Text className="text-xs font-roobert text-foreground/30 text-center mt-2">
            {stageMessage ? stageDisplayText : `${stageDisplayText}... ${Math.round(progress)}%`}
          </Text>
        </View>

        {/* Help text */}
        <Text className="mt-6 text-xs font-roobert text-foreground/20 text-center">
          First boot can take a few minutes while the image is pulled.
        </Text>

        {/* Dot progress indicators */}
        {stageCount > 0 && (
          <View className="mt-6 flex-row items-center" style={{ gap: 6 }}>
            {stages!.map((ps, i) => {
              const isDone = i < completedCount;
              const isActive = i === completedCount;

              return (
                <View
                  key={ps.id}
                  style={{
                    width: isActive ? 7 : 5,
                    height: isActive ? 7 : 5,
                    borderRadius: isActive ? 3.5 : 2.5,
                    backgroundColor: isDone
                      ? primaryColorFaint
                      : isActive
                        ? primaryColor + 'CC'
                        : isDark
                          ? 'rgba(255,255,255,0.06)'
                          : 'rgba(0,0,0,0.06)',
                  }}
                />
              );
            })}
          </View>
        )}

        {/* Machine info badge */}
        {machineInfo?.ip && (
          <View
            className="mt-5 flex-row items-center px-3 py-1.5 rounded-full"
            style={{
              backgroundColor: isDark ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.03)',
              borderWidth: 1,
              borderColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)',
              gap: 8,
            }}
          >
            <View
              style={{
                width: 6,
                height: 6,
                borderRadius: 3,
                backgroundColor: primaryColorFaint,
              }}
            />
            <Text className="text-[11px] font-roobert text-foreground/30" style={{ fontFamily: 'monospace', letterSpacing: 0.5 }}>
              {machineInfo.location?.toLowerCase().includes('us') || machineInfo.location?.toLowerCase().includes('hil')
                ? 'US'
                : 'EU'}{' '}
              · {machineInfo.ip}
            </Text>
          </View>
        )}

        {/* Error state */}
        {error && (
          <View className="mt-4 px-4 py-3 rounded-xl bg-red-500/10">
            <Text className="text-sm font-roobert text-red-400 text-center">
              {error}
            </Text>
          </View>
        )}
      </View>
    </View>
  );
}
