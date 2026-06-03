import * as React from 'react';
import { ActivityIndicator, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useColorScheme } from 'nativewind';
import { useQuery } from '@tanstack/react-query';
import {
  AlertTriangle,
  Bug,
  RefreshCw,
  Shield,
  Sparkles,
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
    currentVersion,
    latestVersion,
    changelog: latestChangelog,
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
          {latestVersion && latestVersion !== currentVersion && (
            <Text className="font-roobert text-sm text-muted-foreground">
              {' · Latest: '}<Text className="font-roobert-semibold text-foreground">v{latestVersion}</Text>
            </Text>
          )}
        </View>

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
        <Icon as={ChangeIcon} size={13} color={color} strokeWidth={2.2} />
      </View>
      <Text className="flex-1 font-roobert text-[13px] text-foreground/90 leading-[18px]">
        {change.text}
      </Text>
    </View>
  );
}
