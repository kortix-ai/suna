import React, { forwardRef, useMemo } from 'react';
import { Pressable, View, useWindowDimensions } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { BottomSheetModal, BottomSheetBackdrop, BottomSheetScrollView } from '@gorhom/bottom-sheet';
import type { BottomSheetBackdropProps } from '@gorhom/bottom-sheet';
import { useColorScheme } from 'nativewind';
import { useInstanceProgress } from '@/stores/instance-progress';
import { SandboxConfigHealthBanner } from './SandboxConfigHealthBanner';
import {
  ChevronRight,
  LogOut,
  Monitor,
  Moon,
  Settings,
  SlidersHorizontal,
  Sun,
} from 'lucide-react-native';
import { getSheetBg, getToggleTrackBg, getToggleActiveBg } from '@/lib/theme-colors';

type ThemeOption = 'light' | 'dark' | 'system';

interface UserMenuSheetProps {
  sandboxLabel?: string;
  sandboxHost?: string;
  onManageInstances: () => void;
  onOpenSettings: () => void;
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
    onOpenSettings,
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
  // Subtle hairline divider — explicit rgba because NativeWind v4 doesn't
  // support `/X` alpha on legacy hsl(var(--border)) tokens.
  const dividerColor = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)';
  // Theme-toggle pill colors via the shared helper so this matches the
  // appearance settings page and any other toggle in the app.
  const toggleTrackBg = getToggleTrackBg(isDark);
  const toggleActiveBg = getToggleActiveBg(isDark);
  const creatingProgress = useInstanceProgress();

  const renderBackdrop = useMemo(
    () => (props: BottomSheetBackdropProps) => (
      <BottomSheetBackdrop {...props} appearsOnIndex={0} disappearsOnIndex={-1} opacity={0.35} />
    ),
    [],
  );

  return (
    <BottomSheetModal
      ref={ref}
      enableDynamicSizing
      maxDynamicContentSize={Math.floor(screenHeight * 0.86)}
      enableOverDrag={false}
      enablePanDownToClose
      handleIndicatorStyle={{
        backgroundColor: isDark ? '#3F3F46' : '#D4D4D8',
        width: 36,
        height: 5,
        borderRadius: 3,
      }}
      backgroundStyle={{
        backgroundColor: getSheetBg(isDark),
        borderTopLeftRadius: 24,
        borderTopRightRadius: 24,
      }}
      backdropComponent={renderBackdrop}
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
