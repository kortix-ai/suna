import React, { forwardRef, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, View, useWindowDimensions } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { BottomSheetModal, BottomSheetBackdrop, BottomSheetScrollView } from '@gorhom/bottom-sheet';
import type { BottomSheetBackdropProps } from '@gorhom/bottom-sheet';
import { useColorScheme } from 'nativewind';
import { useInstanceProgress } from '@/stores/instance-progress';
import { useGlobalSandboxUpdate } from '@/hooks/useSandboxUpdate';
import { SandboxConfigHealthBanner } from './SandboxConfigHealthBanner';
import {
  ArrowDownToLine,
  Check,
  ChevronRight,
  LogOut,
  Monitor,
  Moon,
  Settings,
  SlidersHorizontal,
  Sun,
  X,
} from 'lucide-react-native';

type ThemeOption = 'light' | 'dark' | 'system';

interface UserMenuSheetProps {
  sandboxLabel?: string;
  sandboxHost?: string;
  onManageInstances: () => void;
  onAddInstance: () => void;
  onOpenSettings: () => void;
  onOpenChangelog: () => void;
  onSignOut: () => void;
  onSelectTheme: (value: ThemeOption) => void;
  activeTheme: ThemeOption;
  isSigningOut: boolean;
}

const THEME_OPTIONS: { value: ThemeOption; label: string; icon: typeof Sun }[] = [
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'system', label: 'System', icon: Monitor },
];

export const UserMenuSheet = forwardRef<BottomSheetModal, UserMenuSheetProps>(function UserMenuSheet(
  {
    sandboxLabel,
    sandboxHost,
    onManageInstances,
    onAddInstance,
    onOpenSettings,
    onOpenChangelog,
    onSignOut,
    onSelectTheme,
    activeTheme,
    isSigningOut,
  },
  ref,
) {
  const { colorScheme } = useColorScheme();
  const { height: screenHeight } = useWindowDimensions();
  const isDark = colorScheme === 'dark';
  const creatingProgress = useInstanceProgress();
  const { updateAvailable, latestVersion, changelog: latestChangelog, isUpdating, phase: updatePhase, phaseProgress, updateResult, updateError } = useGlobalSandboxUpdate();

  const renderBackdrop = useMemo(
    () => (props: BottomSheetBackdropProps) => (
      <BottomSheetBackdrop {...props} appearsOnIndex={0} disappearsOnIndex={-1} opacity={0.35} />
    ),
    [],
  );

  const [contentHeight, setContentHeight] = useState(0);
  const snapPoints = useMemo(() => {
    const minHeight = 360;
    const maxHeight = Math.floor(screenHeight * 0.86);
    const target = contentHeight > 0 ? Math.ceil(contentHeight + 26) : 420;
    return [Math.max(minHeight, Math.min(target, maxHeight))];
  }, [contentHeight, screenHeight]);

  return (
    <BottomSheetModal
      ref={ref}
      index={0}
      snapPoints={snapPoints}
      enableDynamicSizing={false}
      enableOverDrag={false}
      enablePanDownToClose
      handleIndicatorStyle={{
        backgroundColor: isDark ? '#3F3F46' : '#D4D4D8',
        width: 36,
        height: 5,
        borderRadius: 3,
      }}
      backgroundStyle={{
        backgroundColor: isDark ? '#0D0D0D' : '#FFFFFF',
        borderTopLeftRadius: 24,
        borderTopRightRadius: 24,
      }}
      backdropComponent={renderBackdrop}
    >
      <BottomSheetScrollView
        contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 8, paddingBottom: 24 }}
        showsVerticalScrollIndicator={false}
        onContentSizeChange={(_: number, h: number) => {
          setContentHeight((prev) => (Math.abs(prev - h) < 1 ? prev : h));
        }}
      >
        {/* Instances */}
        <View className="px-1">
          {/* Active instance */}
          <View className="py-3.5">
            <View className="flex-row items-center">
              <View className="h-2.5 w-2.5 rounded-full bg-emerald-400 mr-3" />
              <View className="flex-1">
                <Text className="font-roobert-medium text-[15px] text-foreground" numberOfLines={1}>
                  {sandboxLabel || 'sandbox'}
                </Text>
                {!!sandboxHost && (
                  <Text className="mt-0.5 font-roobert text-xs text-muted-foreground" numberOfLines={1}>
                    {sandboxHost}
                  </Text>
                )}
              </View>
              <View className="rounded-full bg-emerald-400/15 px-2 py-0.5">
                <Text className="text-[10px] font-roobert-medium text-emerald-600 dark:text-emerald-400">
                  Active
                </Text>
              </View>
            </View>
          </View>
          <View className="h-px bg-border/35" />

          {/* Creating progress */}
          {creatingProgress && (
            <>
              <View className="py-3.5">
                <View className="flex-row items-center mb-2">
                  <View className="h-2.5 w-2.5 rounded-full mr-3" style={{ backgroundColor: '#FBBF24' }} />
                  <View className="flex-1">
                    <Text className="font-roobert-medium text-[15px] text-foreground" numberOfLines={1}>
                      Local Docker
                    </Text>
                    <Text className="mt-0.5 font-roobert text-xs text-muted-foreground">
                      {creatingProgress.message}
                    </Text>
                  </View>
                  <Text className="font-roobert text-xs tabular-nums text-muted-foreground">
                    {Math.round(creatingProgress.percent)}%
                  </Text>
                </View>
                <View
                  className="h-1.5 rounded-full overflow-hidden"
                  style={{ backgroundColor: isDark ? 'rgba(248,248,248,0.08)' : 'rgba(18,18,21,0.06)' }}
                >
                  <View
                    className="h-full rounded-full"
                    style={{
                      width: `${Math.max(creatingProgress.percent, 2)}%`,
                      backgroundColor: isDark ? '#F8F8F8' : '#121215',
                    }}
                  />
                </View>
              </View>
              <View className="h-px bg-border/35" />
            </>
          )}

          {/* Manage instances */}
          <Pressable
            onPress={onManageInstances}
            className="py-3.5 active:opacity-85"
          >
            <View className="flex-row items-center">
              <Icon as={SlidersHorizontal} size={16} className="text-muted-foreground mr-3" strokeWidth={2.2} />
              <Text className="font-roobert text-[14px] text-muted-foreground">Manage instances</Text>
            </View>
          </Pressable>
        </View>

        {/* OpenCode config health — sits above the update banner.
            Renders nothing when /config/status is valid. */}
        <View className="mt-2">
          <SandboxConfigHealthBanner />
        </View>

        {/* Update — available / in progress / complete / error */}
        {(updateAvailable || isUpdating || updateResult || updateError) && latestVersion && (
          <>
            <View className="my-3 h-px bg-border/40" />
            {isUpdating ? (
              /* Updating — show progress */
              <Pressable onPress={onOpenChangelog} className="rounded-2xl border px-4 py-3.5 active:opacity-90" style={{ borderColor: isDark ? 'rgba(248,248,248,0.08)' : 'rgba(18,18,21,0.08)' }}>
                <View className="flex-row items-center mb-2">
                  <ActivityIndicator size={14} />
                  <Text className="ml-2 font-roobert-medium text-[14px] text-foreground flex-1" numberOfLines={1}>Updating to v{latestVersion}</Text>
                  <Text className="font-roobert text-xs tabular-nums text-muted-foreground">{Math.round(phaseProgress)}%</Text>
                </View>
                <View className="h-1.5 rounded-full overflow-hidden" style={{ backgroundColor: isDark ? 'rgba(248,248,248,0.08)' : 'rgba(18,18,21,0.06)' }}>
                  <View className="h-full rounded-full" style={{ width: `${Math.max(phaseProgress, 2)}%`, backgroundColor: isDark ? '#F8F8F8' : '#121215' }} />
                </View>
              </Pressable>
            ) : updateResult?.success ? (
              /* Success */
              <View className="rounded-2xl border px-4 py-3 border-emerald-500/20 bg-emerald-500/5">
                <View className="flex-row items-center">
                  <Icon as={Check} size={16} style={{ color: '#10B981' }} strokeWidth={2.5} />
                  <Text className="ml-2 font-roobert-medium text-[14px] text-emerald-500 flex-1">Updated to v{updateResult.currentVersion}</Text>
                </View>
              </View>
            ) : updateError ? (
              /* Error */
              <Pressable onPress={onOpenChangelog} className="rounded-2xl border px-4 py-3 active:opacity-90" style={{ borderColor: isDark ? 'rgba(239,68,68,0.2)' : 'rgba(239,68,68,0.15)', backgroundColor: isDark ? 'rgba(239,68,68,0.05)' : 'rgba(239,68,68,0.03)' }}>
                <View className="flex-row items-center">
                  <Icon as={X} size={16} className="text-destructive" strokeWidth={2.5} />
                  <Text className="ml-2 font-roobert-medium text-[14px] text-destructive flex-1">Update failed</Text>
                  <Text className="font-roobert-medium text-xs text-muted-foreground">Tap for details</Text>
                </View>
              </Pressable>
            ) : (
              /* Available — show banner */
              <View
                className="rounded-2xl border px-4 py-3.5"
                style={{
                  borderColor: isDark ? 'rgba(239,68,68,0.2)' : 'rgba(239,68,68,0.15)',
                  backgroundColor: isDark ? 'rgba(239,68,68,0.05)' : 'rgba(239,68,68,0.03)',
                }}
              >
                <View className="flex-row items-center">
                  <View className="h-2.5 w-2.5 rounded-full mr-3" style={{ backgroundColor: '#EF4444' }} />
                  <View className="flex-1">
                    <View className="flex-row items-center">
                      <Text className="font-roobert-medium text-[15px] text-foreground">
                        New Kortix version
                      </Text>
                      <View className="ml-2 rounded-full bg-muted/60 px-1.5 py-0.5">
                        <Text className="text-[10px] font-roobert-medium text-muted-foreground">v{latestVersion}</Text>
                      </View>
                    </View>
                    {latestChangelog?.changes && latestChangelog.changes.length > 0 && (
                      <View className="mt-1.5" style={{ gap: 2 }}>
                        {latestChangelog.changes.slice(0, 4).map((c, i) => (
                          <Text key={i} className="font-roobert text-xs text-muted-foreground" numberOfLines={1}>
                            {c.text}
                          </Text>
                        ))}
                        {latestChangelog.changes.length > 4 && (
                          <Text className="font-roobert text-[11px] text-muted-foreground/60">
                            +{latestChangelog.changes.length - 4} more
                          </Text>
                        )}
                      </View>
                    )}
                  </View>
                </View>
                <View className="flex-row mt-3" style={{ gap: 8 }}>
                  <Pressable
                    onPress={onOpenChangelog}
                    className="flex-row items-center justify-center rounded-full px-4 py-2 active:opacity-90"
                    style={{ backgroundColor: isDark ? '#F8F8F8' : '#121215' }}
                  >
                    <Icon as={ArrowDownToLine} size={13} className={isDark ? 'text-[#121215]' : 'text-[#F8F8F8]'} strokeWidth={2.5} />
                    <Text className={`ml-1.5 font-roobert-semibold text-xs ${isDark ? 'text-[#121215]' : 'text-[#F8F8F8]'}`}>
                      Update
                    </Text>
                  </Pressable>
                  <Pressable
                    onPress={onOpenChangelog}
                    className="flex-row items-center justify-center rounded-full bg-muted/60 px-4 py-2 active:opacity-80"
                  >
                    <Text className="font-roobert-medium text-xs text-foreground">Details</Text>
                  </Pressable>
                </View>
              </View>
            )}
          </>
        )}

        <View className="my-3 h-px bg-border/40" />

        {/* General */}
        <View className="px-1">
          <Pressable
            onPress={onOpenSettings}
            className="active:opacity-85"
          >
            <View className="py-3.5">
              <View className="flex-row items-center">
                <Icon as={Settings} size={18} className="text-foreground/80" strokeWidth={2.2} />
                <View className="ml-4 flex-1">
                  <Text className="font-roobert-medium text-[15px] text-foreground">Settings</Text>
                </View>
                <Icon as={ChevronRight} size={16} className="text-muted-foreground/50" strokeWidth={2.2} />
              </View>
            </View>
          </Pressable>
          <View className="h-px bg-border/35" />

          {/* Theme toggle */}
          <View className="mt-3 flex-row rounded-full bg-muted/55 p-1">
            {THEME_OPTIONS.map((option) => {
              const active = option.value === activeTheme;
              return (
                <Pressable
                  key={option.value}
                  onPress={() => onSelectTheme(option.value)}
                  className="flex-1 rounded-full active:opacity-85"
                  style={{
                    backgroundColor: active
                      ? isDark ? '#1F1F1F' : '#FFFFFF'
                      : 'transparent',
                  }}
                >
                  <View className="flex-row items-center justify-center px-2 py-2">
                    <Icon
                      as={option.icon}
                      size={14}
                      className={active ? 'text-foreground' : 'text-muted-foreground'}
                      strokeWidth={2.2}
                    />
                    <Text
                      className={`ml-1.5 text-xs font-roobert-medium ${
                        active ? 'text-foreground' : 'text-muted-foreground'
                      }`}
                    >
                      {option.label}
                    </Text>
                  </View>
                </Pressable>
              );
            })}
          </View>
        </View>

        <View className="my-3 h-px bg-border/40" />

        {/* Sign Out */}
        <View className="px-1">
          <Pressable
            onPress={onSignOut}
            disabled={isSigningOut}
            className="active:opacity-85"
          >
            <View className="py-3.5">
              <View className="flex-row items-center">
                <Icon as={LogOut} size={18} className="text-foreground/80" strokeWidth={2.2} />
                <Text
                  className="ml-4 font-roobert-medium text-[15px] text-foreground"
                  style={{ opacity: isSigningOut ? 0.6 : 1 }}
                >
                  {isSigningOut ? 'Signing out...' : 'Log Out'}
                </Text>
              </View>
            </View>
          </Pressable>
        </View>
      </BottomSheetScrollView>
    </BottomSheetModal>
  );
});
