import React, { forwardRef, useMemo } from 'react';
import { ActivityIndicator, Pressable, View, useWindowDimensions } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { BottomSheetModal, BottomSheetScrollView } from '@gorhom/bottom-sheet';
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
import { getToggleTrackBg, getToggleActiveBg, useThemeColors } from '@/lib/theme-colors';
import { THEME, withAlpha } from '@/lib/utils/theme';
import { SheetBackdrop, sheetHandleIndicatorStyle, useSheetBackground } from '@/components/kortix/sheet';

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
  const sheetBg = useSheetBackground();
  const { colorScheme } = useColorScheme();
  const { height: screenHeight } = useWindowDimensions();
  const isDark = colorScheme === 'dark';
  const theme = useThemeColors();
  // Subtle hairline divider — explicit rgba because NativeWind v4 doesn't
  // support `/X` alpha on legacy hsl(var(--border)) tokens.
  const dividerColor = isDark ? withAlpha(THEME.dark.foreground, 0.08) : withAlpha(THEME.light.foreground, 0.08);
  const destructiveColor = isDark ? THEME.dark.destructive : THEME.light.destructive;
  // Theme-toggle pill colors via the shared helper so this matches the
  // appearance settings page and any other toggle in the app.
  const toggleTrackBg = getToggleTrackBg(isDark);
  const toggleActiveBg = getToggleActiveBg(isDark);
  const creatingProgress = useInstanceProgress();
  const { updateAvailable, latestVersion, changelog: latestChangelog, isUpdating, phase: updatePhase, phaseProgress, updateResult, updateError } = useGlobalSandboxUpdate();


  return (
    <BottomSheetModal
      ref={ref}
      enableDynamicSizing
      maxDynamicContentSize={Math.floor(screenHeight * 0.86)}
      enableOverDrag={false}
      enablePanDownToClose
      handleIndicatorStyle={sheetHandleIndicatorStyle(isDark)}
      backgroundStyle={{
        backgroundColor: sheetBg,
        borderTopLeftRadius: 24,
        borderTopRightRadius: 24,
      }}
      backdropComponent={(p) => <SheetBackdrop {...p} opacity={0.35} />}
    >
      <BottomSheetScrollView
        contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 8, paddingBottom: 24 }}
        showsVerticalScrollIndicator={false}
      >
        {/* Instances */}
        <View className="px-1">
          {/* Active instance */}
          <View className="py-3.5">
            <View className="flex-row items-center">
              <View className="h-2.5 w-2.5 rounded-full bg-kortix-green mr-3" />
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
              <View className="rounded-full bg-kortix-green/15 px-2 py-0.5">
                <Text className="text-[10px] font-roobert-medium text-kortix-green">
                  Active
                </Text>
              </View>
            </View>
          </View>

          {/* Creating progress */}
          {creatingProgress && (
            <>
              <View className="py-3.5">
                <View className="flex-row items-center mb-2">
                  <View className="h-2.5 w-2.5 rounded-full mr-3" style={{ backgroundColor: THEME.accent.orange }} />
                  <View className="flex-1">
                    <Text className="font-roobert-medium text-[15px] text-foreground" numberOfLines={1}>
                      Sandbox
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
                  style={{ backgroundColor: isDark ? withAlpha(THEME.dark.foreground, 0.08) : withAlpha(THEME.light.foreground, 0.06) }}
                >
                  <View
                    className="h-full rounded-full"
                    style={{
                      width: `${Math.max(creatingProgress.percent, 2)}%`,
                      backgroundColor: theme.primary,
                    }}
                  />
                </View>
              </View>
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
            <View style={{ height: 1, backgroundColor: dividerColor, marginVertical: 12 }} />
            {isUpdating ? (
              /* Updating — show progress */
              <Pressable onPress={onOpenChangelog} className="rounded-2xl border px-4 py-3.5 active:opacity-90" style={{ borderColor: isDark ? withAlpha(THEME.dark.foreground, 0.08) : withAlpha(THEME.light.foreground, 0.08) }}>
                <View className="flex-row items-center mb-2">
                  <ActivityIndicator size={14} />
                  <Text className="ml-2 font-roobert-medium text-[14px] text-foreground flex-1" numberOfLines={1}>Updating to v{latestVersion}</Text>
                  <Text className="font-roobert text-xs tabular-nums text-muted-foreground">{Math.round(phaseProgress)}%</Text>
                </View>
                <View className="h-1.5 rounded-full overflow-hidden" style={{ backgroundColor: isDark ? withAlpha(THEME.dark.foreground, 0.08) : withAlpha(THEME.light.foreground, 0.06) }}>
                  <View className="h-full rounded-full" style={{ width: `${Math.max(phaseProgress, 2)}%`, backgroundColor: theme.primary }} />
                </View>
              </Pressable>
            ) : updateResult?.success ? (
              /* Success */
              <View className="rounded-2xl border px-4 py-3 border-kortix-green/20 bg-kortix-green/5">
                <View className="flex-row items-center">
                  <Icon as={Check} size={16} color={THEME.accent.green} strokeWidth={2.5} />
                  <Text className="ml-2 font-roobert-medium text-[14px] text-kortix-green flex-1">Updated to v{updateResult.currentVersion}</Text>
                </View>
              </View>
            ) : updateError ? (
              /* Error */
              <Pressable onPress={onOpenChangelog} className="rounded-2xl border px-4 py-3 active:opacity-90" style={{ borderColor: withAlpha(destructiveColor, isDark ? 0.2 : 0.15), backgroundColor: withAlpha(destructiveColor, isDark ? 0.05 : 0.03) }}>
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
                  borderColor: withAlpha(destructiveColor, isDark ? 0.2 : 0.15),
                  backgroundColor: withAlpha(destructiveColor, isDark ? 0.05 : 0.03),
                }}
              >
                <View className="flex-row items-center">
                  <View className="h-2.5 w-2.5 rounded-full mr-3" style={{ backgroundColor: destructiveColor }} />
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
                    style={{ backgroundColor: theme.primary }}
                  >
                    <Icon as={ArrowDownToLine} size={13} color={theme.primaryForeground} strokeWidth={2.5} />
                    <Text className="ml-1.5 font-roobert-semibold text-xs" style={{ color: theme.primaryForeground }}>
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

        <View style={{ height: 1, backgroundColor: dividerColor, marginVertical: 12 }} />

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

          {/* Theme toggle */}
          <View
            className="mt-3 flex-row rounded-full p-1"
            style={{ backgroundColor: toggleTrackBg }}
          >
            {THEME_OPTIONS.map((option) => {
              const active = option.value === activeTheme;
              return (
                <Pressable
                  key={option.value}
                  onPress={() => onSelectTheme(option.value)}
                  className="flex-1 rounded-full active:opacity-85"
                  style={{
                    backgroundColor: active ? toggleActiveBg : 'transparent',
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

        <View style={{ height: 1, backgroundColor: dividerColor, marginVertical: 12 }} />

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
