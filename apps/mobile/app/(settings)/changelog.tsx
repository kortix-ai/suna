import * as React from 'react';
import { ActivityIndicator, Pressable, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useColorScheme } from 'nativewind';
import { useQuery } from '@tanstack/react-query';
import { haptics } from '@/lib/haptics';
import {
  AlertTriangle,
  ArrowDownToLine,
  Bug,
  Check,
  RefreshCw,
  Shield,
  Sparkles,
  X,
  Zap,
} from 'lucide-react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { useGlobalSandboxUpdate } from '@/hooks/useSandboxUpdate';
import { getFullChangelog, type ChangelogChange, type ChangelogEntry } from '@/lib/platform/client';

const CHANGE_ICONS: Record<string, typeof Sparkles> = {
  feature: Sparkles,
  fix: Bug,
  improvement: Zap,
  breaking: AlertTriangle,
  upstream: RefreshCw,
  security: Shield,
  deprecation: AlertTriangle,
};

const CHANGE_COLORS: Record<string, string> = {
  feature: '#10B981',
  fix: '#F87171',
  improvement: '#60A5FA',
  breaking: '#F59E0B',
  upstream: '#A78BFA',
  security: '#FB7185',
  deprecation: '#FB923C',
};

export default function ChangelogScreen() {
  const insets = useSafeAreaInsets();
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';

  const {
    updateAvailable,
    currentVersion,
    latestVersion,
    changelog: latestChangelog,
    update,
    isUpdating,
    phaseLabel,
    phaseProgress,
    phaseMessage,
    updateResult,
    updateError,
    resetStatus,
  } = useGlobalSandboxUpdate();

  const { data: fullChangelog, isLoading } = useQuery({
    queryKey: ['sandbox', 'changelog'],
    queryFn: getFullChangelog,
    staleTime: 5 * 60 * 1000,
  });

  // Use full changelog if available, otherwise fall back to the single latest entry
  const changelog = React.useMemo(() => {
    if (fullChangelog && fullChangelog.length > 0) return fullChangelog;
    if (latestChangelog) return [latestChangelog];
    return [];
  }, [fullChangelog, latestChangelog]);

  const handleUpdate = React.useCallback(() => {
    haptics.medium();
    update();
  }, [update]);

  const handleRetry = React.useCallback(() => {
    haptics.tap();
    resetStatus();
  }, [resetStatus]);

  return (
    <ScrollView
      className="flex-1 bg-background"
      showsVerticalScrollIndicator={false}
      contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
    >
      <View className="px-5 pt-2 pb-4">
        {/* Header */}
        <Text className="text-2xl font-roobert-semibold text-foreground">Changelog</Text>
        <View className="mt-1 flex-row items-center">
          <Text className="font-roobert text-sm text-muted-foreground">
            Running <Text className="font-roobert-semibold text-foreground">v{currentVersion || '...'}</Text>
          </Text>
          {latestVersion && updateAvailable && (
            <Text className="font-roobert text-sm text-muted-foreground">
              {' · Latest: '}<Text className="font-roobert-semibold text-foreground">v{latestVersion}</Text>
            </Text>
          )}
        </View>

        {/* Update button */}
        {updateAvailable && !isUpdating && !updateResult && latestVersion && (
          <Pressable
            onPress={handleUpdate}
            className="mt-4 flex-row items-center justify-center self-start rounded-xl px-5 py-2.5 active:opacity-90"
            style={{ backgroundColor: isDark ? '#F8F8F8' : '#121215' }}
          >
            <Icon as={ArrowDownToLine} size={15} className={isDark ? 'text-[#121215]' : 'text-[#F8F8F8]'} strokeWidth={2.5} />
            <Text className={`ml-2 font-roobert-semibold text-sm ${isDark ? 'text-[#121215]' : 'text-[#F8F8F8]'}`}>
              Update to v{latestVersion}
            </Text>
          </Pressable>
        )}

        {/* Update success */}
        {updateResult?.success && (
          <View className="mt-4 flex-row items-center self-start rounded-xl bg-emerald-400/15 px-4 py-2.5">
            <Icon as={Check} size={15} className="text-emerald-500" strokeWidth={2.5} />
            <Text className="ml-2 font-roobert-medium text-sm text-emerald-500">
              Updated to v{updateResult.currentVersion}. Refresh to see changes.
            </Text>
          </View>
        )}

        {/* Update progress */}
        {isUpdating && (
          <View
            className="mt-4 rounded-2xl border px-4 py-3.5"
            style={{
              borderColor: isDark ? 'rgba(248,248,248,0.08)' : 'rgba(18,18,21,0.08)',
            }}
          >
            <View className="flex-row items-center mb-2">
              <ActivityIndicator size="small" />
              <View className="ml-3 flex-1">
                <Text className="font-roobert-medium text-[15px] text-foreground">
                  Updating to v{latestVersion}
                </Text>
                <Text className="mt-0.5 font-roobert text-xs text-muted-foreground">
                  {phaseLabel}{phaseMessage ? ` — ${phaseMessage}` : ''}
                </Text>
              </View>
              <Text className="font-roobert text-xs tabular-nums text-muted-foreground">
                {Math.round(phaseProgress)}%
              </Text>
            </View>
            <View
              className="h-1.5 rounded-full overflow-hidden"
              style={{ backgroundColor: isDark ? 'rgba(248,248,248,0.08)' : 'rgba(18,18,21,0.06)' }}
            >
              <View
                className="h-full rounded-full"
                style={{
                  width: `${Math.max(phaseProgress, 2)}%`,
                  backgroundColor: isDark ? '#F8F8F8' : '#121215',
                }}
              />
            </View>
          </View>
        )}

        {/* Update error */}
        {updateError && (
          <View
            className="mt-4 rounded-2xl border px-4 py-3.5"
            style={{
              borderColor: isDark ? 'rgba(239,68,68,0.2)' : 'rgba(239,68,68,0.15)',
              backgroundColor: isDark ? 'rgba(239,68,68,0.05)' : 'rgba(239,68,68,0.03)',
            }}
          >
            <View className="flex-row items-center">
              <Icon as={X} size={16} className="text-destructive" strokeWidth={2.5} />
              <View className="ml-3 flex-1">
                <Text className="font-roobert-medium text-[15px] text-destructive">Update failed</Text>
                <Text className="mt-0.5 font-roobert text-xs text-muted-foreground">{updateError.message}</Text>
              </View>
              <Pressable onPress={handleRetry} className="active:opacity-70">
                <Text className="font-roobert-medium text-xs text-primary">Try again</Text>
              </Pressable>
            </View>
          </View>
        )}
      </View>

      {/* Changelog entries */}
      <View className="px-5" style={{ gap: 16 }}>
        {isLoading && (
          <View className="py-12 items-center">
            <ActivityIndicator size="small" />
          </View>
        )}

        {changelog?.map((entry) => {
          const isCurrent = currentVersion === entry.version;
          const isLatest = latestVersion === entry.version;
          return (
            <VersionCard
              key={entry.version}
              entry={entry}
              isCurrent={isCurrent}
              isLatest={isLatest && !isCurrent}
              isDark={isDark}
            />
          );
        })}

        {!isLoading && (!changelog || changelog.length === 0) && (
          <Text className="py-8 text-center font-roobert text-xs text-muted-foreground">
            No changelog entries available.
          </Text>
        )}
      </View>
    </ScrollView>
  );
}

function VersionCard({
  entry,
  isCurrent,
  isLatest,
  isDark,
}: {
  entry: ChangelogEntry;
  isCurrent: boolean;
  isLatest: boolean;
  isDark: boolean;
}) {
  const borderColor = isLatest
    ? isDark ? 'rgba(219,39,119,0.35)' : 'rgba(219,39,119,0.25)'
    : isDark ? 'rgba(248,248,248,0.08)' : 'rgba(18,18,21,0.08)';

  const bgColor = isLatest
    ? isDark ? 'rgba(219,39,119,0.04)' : 'rgba(219,39,119,0.02)'
    : undefined;

  return (
    <View
      className="rounded-2xl border px-4 pt-4 pb-3"
      style={{ borderColor, backgroundColor: bgColor }}
    >
      {/* Version header */}
      <View className="flex-row items-center mb-2">
        <Text className="font-roobert-semibold text-lg text-foreground">
          v{entry.version}
        </Text>
        {isCurrent && (
          <View className="ml-2 rounded-full bg-emerald-400/15 px-2 py-0.5">
            <Text className="text-[10px] font-roobert-medium text-emerald-600 dark:text-emerald-400">Current</Text>
          </View>
        )}
        {isLatest && (
          <View className="ml-2 rounded-full bg-primary/15 px-2 py-0.5">
            <Text className="text-[10px] font-roobert-medium text-primary">Latest</Text>
          </View>
        )}
        {!!entry.date && (
          <Text className="ml-auto font-roobert text-[11px] text-muted-foreground/60">
            {entry.date}
          </Text>
        )}
      </View>

      {/* Title */}
      {!!entry.title && (
        <Text className="font-roobert-medium text-[14px] text-foreground mb-1">
          {entry.title}
        </Text>
      )}

      {/* Description */}
      {!!entry.description && (
        <Text className="font-roobert text-xs text-muted-foreground mb-3 leading-[18px]">
          {entry.description}
        </Text>
      )}

      {/* Changes */}
      {entry.changes?.length > 0 && (
        <View style={{ gap: 6 }}>
          {entry.changes.map((change, idx) => (
            <ChangeRow key={idx} change={change} />
          ))}
        </View>
      )}
    </View>
  );
}

function ChangeRow({ change }: { change: ChangelogChange }) {
  const ChangeIcon = CHANGE_ICONS[change.type] || Zap;
  const color = CHANGE_COLORS[change.type] || '#60A5FA';

  return (
    <View className="flex-row items-start py-1">
      <View className="mt-0.5 mr-2.5">
        <Icon as={ChangeIcon} size={13} style={{ color }} strokeWidth={2.2} />
      </View>
      <Text className="flex-1 font-roobert text-[13px] text-foreground/90 leading-[18px]">
        {change.text}
      </Text>
    </View>
  );
}
