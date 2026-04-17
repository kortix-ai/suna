import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Easing,
  Pressable,
  ScrollView,
  View,
  useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useColorScheme } from 'nativewind';
import * as Haptics from 'expo-haptics';
import {
  BottomSheetModal,
  BottomSheetBackdrop,
  BottomSheetView,
} from '@gorhom/bottom-sheet';
import type { BottomSheetBackdropProps } from '@gorhom/bottom-sheet';
import {
  AlertTriangle,
  ArrowDownToLine,
  Bug,
  Check,
  RefreshCw,
  RotateCw,
  Shield,
  Sparkles,
  X,
  XCircle,
  Zap,
} from 'lucide-react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { Button } from '@/components/ui/button';
import { useThemeColors } from '@/lib/theme-colors';
import type { ChangelogChange, ChangelogEntry, UpdatePhase } from '@/lib/platform/client';
import Svg, { Circle } from 'react-native-svg';

type DialogStep = 'confirm' | 'updating' | 'done' | 'failed';

// ── Change type config ───────────────────────────────────────────────────

const CHANGE_TYPE_CONFIG: Record<string, { icon: typeof Sparkles; color: string }> = {
  feature:     { icon: Sparkles,      color: '#10B981' },
  fix:         { icon: Bug,           color: '#F87171' },
  improvement: { icon: Zap,           color: '#60A5FA' },
  breaking:    { icon: AlertTriangle, color: '#F59E0B' },
  upstream:    { icon: RefreshCw,     color: '#A78BFA' },
  security:    { icon: Shield,        color: '#FB7185' },
  deprecation: { icon: AlertTriangle, color: '#FB923C' },
};

// ── Phase labels ─────────────────────────────────────────────────────────

const PHASE_LABEL: Record<string, string> = {
  idle: 'Preparing...',
  pulling: 'Downloading update...',
  stopping: 'Stopping sandbox...',
  removing: 'Preparing files...',
  recreating: 'Installing update...',
  starting: 'Starting sandbox...',
  health_check: 'Verifying update...',
  complete: 'Update complete',
  reconnecting: 'Reconnecting...',
  reconnected: 'Connected',
};

// ── Helpers ──────────────────────────────────────────────────────────────

function formatVersion(version: string | null | undefined): string {
  if (!version) return 'unknown';
  return version.startsWith('dev-') ? version : `v${version}`;
}

// ── Props ────────────────────────────────────────────────────────────────

interface UpdateDialogProps {
  open: boolean;
  phase: string;
  phaseMessage: string;
  phaseProgress: number;
  latestVersion: string | null;
  changelog: ChangelogEntry | null;
  currentVersion: string | null;
  errorMessage: string | null;
  updateResult: { success: boolean; currentVersion: string } | null;
  onClose: () => void;
  onConfirm: () => void;
  onRetry: () => void;
}

// ── Component ────────────────────────────────────────────────────────────

export function UpdateDialog({
  open,
  phase,
  phaseMessage,
  phaseProgress,
  latestVersion,
  changelog,
  currentVersion,
  errorMessage,
  updateResult,
  onClose,
  onConfirm,
  onRetry,
}: UpdateDialogProps) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const insets = useSafeAreaInsets();
  const { height: screenHeight } = useWindowDimensions();
  const themeColors = useThemeColors();
  const [step, setStep] = useState<DialogStep>('confirm');
  const [expanded, setExpanded] = useState(false);

  const sheetRef = useRef<BottomSheetModal>(null);
  const dismissingRef = useRef(false);

  // Sync external `open` prop to imperative sheet API
  useEffect(() => {
    if (open) {
      dismissingRef.current = false;
      sheetRef.current?.present();
    } else {
      dismissingRef.current = true;
      sheetRef.current?.dismiss();
    }
  }, [open]);

  const handleSheetDismiss = useCallback(() => {
    // Only invoke onClose when dismissal originated from user gesture
    // (not when we programmatically dismissed because `open` flipped to false)
    if (!dismissingRef.current) {
      onClose();
    }
    dismissingRef.current = false;
  }, [onClose]);

  const renderBackdrop = useMemo(
    () => (props: BottomSheetBackdropProps) => (
      <BottomSheetBackdrop
        {...props}
        appearsOnIndex={0}
        disappearsOnIndex={-1}
        opacity={0.5}
        pressBehavior={step === 'confirm' || step === 'done' || step === 'failed' ? 'close' : 'none'}
      />
    ),
    [step],
  );

  const isFailed = phase === 'failed';
  const isComplete = phase === 'complete';

  // Track step from phase changes
  useEffect(() => {
    if (!open) return;
    if (phase !== 'idle' && phase !== 'complete' && phase !== 'failed') {
      setStep('updating');
    }
    if (phase === 'failed') {
      setStep('failed');
    }
    if (phase === 'complete') {
      // Brief delay then show done
      const timer = setTimeout(() => setStep('done'), 1000);
      return () => clearTimeout(timer);
    }
  }, [phase, open]);

  // Reset on open
  useEffect(() => {
    if (open) {
      setStep('confirm');
      setExpanded(false);
    }
  }, [open]);

  // Auto-close after done
  useEffect(() => {
    if (step !== 'done') return;
    const timer = setTimeout(onClose, 2500);
    return () => clearTimeout(timer);
  }, [step, onClose]);

  const handleConfirm = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setStep('updating');
    onConfirm();
  }, [onConfirm]);

  const handleRetry = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setStep('updating');
    onRetry();
  }, [onRetry]);

  const changes = changelog?.changes ?? [];
  const visibleChanges = expanded ? changes : changes.slice(0, 4);
  const hasMore = changes.length > 4 && !expanded;

  const bgColor = isDark ? '#0D0D0D' : '#FFFFFF';
  const borderColor = isDark ? 'rgba(248,248,248,0.08)' : 'rgba(18,18,21,0.08)';
  const mutedColor = isDark ? '#888' : '#777';

  const isInteractiveStep = step === 'confirm' || step === 'done' || step === 'failed';

  return (
    <BottomSheetModal
      ref={sheetRef}
      enableDynamicSizing
      maxDynamicContentSize={Math.floor(screenHeight * 0.86)}
      enablePanDownToClose={isInteractiveStep}
      enableOverDrag={false}
      onDismiss={handleSheetDismiss}
      handleIndicatorStyle={{
        backgroundColor: isDark ? '#3F3F46' : '#D4D4D8',
        width: 36,
        height: 5,
        borderRadius: 3,
      }}
      backgroundStyle={{
        backgroundColor: bgColor,
        borderTopLeftRadius: 24,
        borderTopRightRadius: 24,
      }}
      backdropComponent={renderBackdrop}
    >
      <BottomSheetView style={{ paddingBottom: insets.bottom + 8 }}>
        <View>
          {/* ── Confirm Step ── */}
          {step === 'confirm' && (
            <View>
              {/* Header */}
              <View style={{ paddingHorizontal: 20, paddingTop: 20, paddingBottom: 12 }}>
                <View className="flex-row items-center" style={{ gap: 8 }}>
                  <Icon as={ArrowDownToLine} size={18} style={{ color: themeColors.primary }} strokeWidth={2.5} />
                  <Text className="font-roobert-semibold text-[17px] text-foreground">
                    Update to {formatVersion(latestVersion)}
                  </Text>
                </View>
                <Text className="font-roobert text-[13px] text-muted-foreground mt-1.5">
                  {currentVersion
                    ? <>Your sandbox is running <Text className="font-mono font-roobert-medium text-foreground">{formatVersion(currentVersion)}</Text>. </>
                    : 'A new version is available. '}
                  This will restart your sandbox.
                </Text>
              </View>

              {/* Changes list */}
              {changes.length > 0 && (
                <View
                  style={{
                    marginHorizontal: 20,
                    borderRadius: 12,
                    borderWidth: 1,
                    borderColor: isDark ? 'rgba(248,248,248,0.06)' : 'rgba(18,18,21,0.06)',
                    backgroundColor: isDark ? 'rgba(248,248,248,0.02)' : 'rgba(18,18,21,0.015)',
                    overflow: 'hidden',
                  }}
                >
                  <ScrollView
                    style={{ maxHeight: 220, paddingHorizontal: 12, paddingVertical: 10 }}
                    showsVerticalScrollIndicator={false}
                    nestedScrollEnabled
                  >
                    {visibleChanges.map((change, i) => {
                      const config = CHANGE_TYPE_CONFIG[change.type] ?? CHANGE_TYPE_CONFIG.improvement;
                      return (
                        <View key={i} className="flex-row items-start" style={{ paddingVertical: 3, gap: 8 }}>
                          <View style={{ marginTop: 2 }}>
                            <Icon as={config.icon} size={13} style={{ color: config.color }} strokeWidth={2.2} />
                          </View>
                          <Text className="flex-1 font-roobert text-[13px] text-foreground/80" style={{ lineHeight: 18 }}>
                            {change.text}
                          </Text>
                        </View>
                      );
                    })}
                  </ScrollView>
                  {hasMore && (
                    <Pressable
                      onPress={() => setExpanded(true)}
                      style={{
                        borderTopWidth: 1,
                        borderTopColor: isDark ? 'rgba(248,248,248,0.04)' : 'rgba(18,18,21,0.04)',
                        paddingVertical: 8,
                        alignItems: 'center',
                      }}
                    >
                      <Text className="font-roobert text-[12px]" style={{ color: themeColors.primary }}>
                        Show {changes.length - 4} more changes
                      </Text>
                    </Pressable>
                  )}
                </View>
              )}

              {/* Buttons */}
              <View className="flex-row items-center justify-end" style={{ paddingHorizontal: 20, paddingVertical: 16, gap: 10 }}>
                <Button variant="outline" onPress={onClose}>
                  <Text className="font-roobert-medium text-foreground">Cancel</Text>
                </Button>
                <Button onPress={handleConfirm} style={{ backgroundColor: themeColors.primary }}>
                  <Icon as={ArrowDownToLine} size={16} style={{ color: themeColors.primaryForeground }} strokeWidth={2.5} />
                  <Text className="font-roobert-semibold" style={{ color: themeColors.primaryForeground }}>
                    Update now
                  </Text>
                </Button>
              </View>
            </View>
          )}

          {/* ── Updating Step ── */}
          {step === 'updating' && (
            <View style={{ alignItems: 'center', paddingVertical: 40, paddingHorizontal: 20 }}>
              <CircularProgress
                progress={phaseProgress}
                size={120}
                strokeWidth={8}
                primaryColor={themeColors.primary}
                trackColor={isDark ? 'rgba(248,248,248,0.08)' : 'rgba(18,18,21,0.06)'}
                isDark={isDark}
              />

              <View style={{ marginTop: 24, alignItems: 'center', minHeight: 48 }}>
                <Text className="font-roobert-medium text-[15px] text-foreground">
                  {PHASE_LABEL[phase] ?? 'Updating...'}
                </Text>
                <Text className="font-roobert text-[12px] text-muted-foreground mt-1">
                  Updating to {formatVersion(latestVersion)}
                </Text>
              </View>
            </View>
          )}

          {/* ── Done Step ── */}
          {step === 'done' && (
            <View style={{ alignItems: 'center', paddingVertical: 48, paddingHorizontal: 20 }}>
              <SuccessCheckmark />

              <View style={{ marginTop: 16, alignItems: 'center' }}>
                <Text className="font-roobert-semibold text-[16px] text-foreground">Update Complete</Text>
                <Text className="font-roobert text-[13px] text-muted-foreground mt-1">
                  Now running {formatVersion(updateResult?.currentVersion ?? latestVersion)}
                </Text>
              </View>
            </View>
          )}

          {/* ── Failed Step ── */}
          {step === 'failed' && (
            <View style={{ paddingHorizontal: 20, paddingVertical: 20 }}>
              {/* Error icon */}
              <View style={{ alignItems: 'center', paddingVertical: 16 }}>
                <View
                  style={{
                    width: 56,
                    height: 56,
                    borderRadius: 28,
                    backgroundColor: isDark ? 'rgba(239,68,68,0.1)' : 'rgba(239,68,68,0.08)',
                    borderWidth: 2,
                    borderColor: isDark ? 'rgba(239,68,68,0.3)' : 'rgba(239,68,68,0.2)',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <Icon as={XCircle} size={28} style={{ color: '#EF4444' }} strokeWidth={2} />
                </View>
                <Text className="font-roobert-semibold text-[16px] text-foreground mt-4">Update Failed</Text>
              </View>

              {/* Error details */}
              <View
                style={{
                  borderRadius: 12,
                  borderWidth: 1,
                  borderColor: isDark ? 'rgba(239,68,68,0.2)' : 'rgba(239,68,68,0.15)',
                  backgroundColor: isDark ? 'rgba(239,68,68,0.05)' : 'rgba(239,68,68,0.03)',
                  padding: 12,
                }}
              >
                <View className="flex-row items-start" style={{ gap: 8 }}>
                  <Icon as={XCircle} size={14} style={{ color: '#EF4444', marginTop: 1 }} strokeWidth={2} />
                  <Text className="flex-1 font-roobert text-[13px] text-foreground/80" style={{ lineHeight: 18 }}>
                    {phaseMessage || 'Something went wrong during the update.'}
                  </Text>
                </View>
                {errorMessage && (
                  <ScrollView
                    style={{
                      maxHeight: 120,
                      marginTop: 8,
                      borderRadius: 8,
                      backgroundColor: isDark ? 'rgba(248,248,248,0.03)' : 'rgba(18,18,21,0.02)',
                      padding: 8,
                    }}
                    nestedScrollEnabled
                  >
                    <Text className="font-mono text-[11px] text-foreground/60" style={{ lineHeight: 16 }}>
                      {errorMessage}
                    </Text>
                  </ScrollView>
                )}
              </View>

              {/* Buttons */}
              <View className="flex-row items-center justify-end mt-4" style={{ gap: 10 }}>
                <Button variant="outline" onPress={onClose}>
                  <Text className="font-roobert-medium text-foreground">Close</Text>
                </Button>
                <Button onPress={handleRetry} style={{ backgroundColor: themeColors.primary }}>
                  <Icon as={RotateCw} size={16} style={{ color: themeColors.primaryForeground }} strokeWidth={2.5} />
                  <Text className="font-roobert-semibold" style={{ color: themeColors.primaryForeground }}>
                    Retry
                  </Text>
                </Button>
              </View>
            </View>
          )}
        </View>
      </BottomSheetView>
    </BottomSheetModal>
  );
}

// ── Circular Progress ────────────────────────────────────────────────────

function CircularProgress({
  progress,
  size,
  strokeWidth,
  primaryColor,
  trackColor,
  isDark,
}: {
  progress: number;
  size: number;
  strokeWidth: number;
  primaryColor: string;
  trackColor: string;
  isDark: boolean;
}) {
  const animatedValue = useRef(new Animated.Value(0)).current;
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;

  useEffect(() => {
    Animated.timing(animatedValue, {
      toValue: Math.min(progress, 100),
      duration: 500,
      easing: Easing.out(Easing.ease),
      useNativeDriver: false,
    }).start();
  }, [progress, animatedValue]);

  const strokeDashoffset = animatedValue.interpolate({
    inputRange: [0, 100],
    outputRange: [circumference, 0],
  });

  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      <Svg width={size} height={size} style={{ transform: [{ rotate: '-90deg' }] }}>
        {/* Track */}
        <Circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          stroke={trackColor}
          strokeWidth={strokeWidth}
          fill="none"
        />
        {/* Progress */}
        <AnimatedCircle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          stroke={primaryColor}
          strokeWidth={strokeWidth}
          fill="none"
          strokeDasharray={circumference}
          strokeDashoffset={strokeDashoffset}
          strokeLinecap="round"
        />
      </Svg>

      {/* Percentage text */}
      <View style={{ position: 'absolute', alignItems: 'center', justifyContent: 'center' }}>
        <Text
          className="font-roobert-semibold text-foreground"
          style={{ fontSize: size * 0.2 }}
        >
          {Math.round(progress)}%
        </Text>
      </View>
    </View>
  );
}

const AnimatedCircle = Animated.createAnimatedComponent(Circle);

// ── Success Checkmark ────────────────────────────────────────────────────

function SuccessCheckmark() {
  const scale = useRef(new Animated.Value(0)).current;
  const pulseScale = useRef(new Animated.Value(1)).current;
  const pulseOpacity = useRef(new Animated.Value(0.3)).current;

  useEffect(() => {
    // Checkmark bounce in
    Animated.spring(scale, {
      toValue: 1,
      tension: 300,
      friction: 20,
      delay: 100,
      useNativeDriver: true,
    }).start();

    // Pulse ring
    Animated.loop(
      Animated.sequence([
        Animated.parallel([
          Animated.timing(pulseScale, { toValue: 1.5, duration: 1000, easing: Easing.out(Easing.ease), useNativeDriver: true }),
          Animated.timing(pulseOpacity, { toValue: 0, duration: 1000, easing: Easing.out(Easing.ease), useNativeDriver: true }),
        ]),
        Animated.parallel([
          Animated.timing(pulseScale, { toValue: 1, duration: 0, useNativeDriver: true }),
          Animated.timing(pulseOpacity, { toValue: 0.3, duration: 0, useNativeDriver: true }),
        ]),
      ]),
      { iterations: 2 },
    ).start();
  }, [scale, pulseScale, pulseOpacity]);

  return (
    <View style={{ width: 64, height: 64, alignItems: 'center', justifyContent: 'center' }}>
      {/* Pulse ring */}
      <Animated.View
        style={{
          position: 'absolute',
          width: 64,
          height: 64,
          borderRadius: 32,
          backgroundColor: 'rgba(16,185,129,0.2)',
          opacity: pulseOpacity,
          transform: [{ scale: pulseScale }],
        }}
      />
      {/* Main circle */}
      <View
        style={{
          width: 56,
          height: 56,
          borderRadius: 28,
          backgroundColor: '#10B981',
          alignItems: 'center',
          justifyContent: 'center',
          shadowColor: '#10B981',
          shadowOffset: { width: 0, height: 4 },
          shadowOpacity: 0.25,
          shadowRadius: 12,
          elevation: 8,
        }}
      >
        <Animated.View style={{ transform: [{ scale }] }}>
          <Icon as={Check} size={28} style={{ color: '#FFFFFF' }} strokeWidth={3} />
        </Animated.View>
      </View>
    </View>
  );
}
