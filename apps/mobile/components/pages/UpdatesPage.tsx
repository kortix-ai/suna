import React, { useCallback, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, View, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useColorScheme } from 'nativewind';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import * as Haptics from 'expo-haptics';
import {
  ArrowDownToLine,
  GitCommit,
  Menu,
  Tag,
} from 'lucide-react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { Button } from '@/components/ui/button';
import { useGlobalSandboxUpdate } from '@/hooks/useSandboxUpdate';
import {
  getAllVersions,
  type VersionEntry,
  type VersionChannel,
} from '@/lib/platform/client';
import { useTabStore, type PageTab } from '@/stores/tab-store';
import { PageHeader } from '@/components/ui/page-header';
import { PageContent } from '@/components/ui/page-content';
import { useThemeColors } from '@/lib/theme-colors';
import { Ionicons } from '@expo/vector-icons';
import { UpdateDialog } from '@/components/updates/UpdateDialog';

// ─── Version type classification ─────────────────────────────────────────

type VersionType = 'major' | 'minor' | 'patch' | 'dev';

function parseVersionType(version: string): VersionType {
  if (version.startsWith('dev-')) return 'dev';
  const parts = version.split('.');
  if (parts.length < 3) return 'patch';
  if (parts[2] === '0' && parts[1] === '0') return 'major';
  if (parts[2] === '0') return 'minor';
  return 'patch';
}

function normalizeReleaseTitle(title: string | undefined, version: string): string | undefined {
  if (!title) return title;
  if (version.startsWith('dev-')) return title;
  const escaped = version.replace(/\./g, '\\.');
  const patterns = [
    new RegExp(`^v${escaped}\\s*[—–:-]\\s*`, 'i'),
    new RegExp(`^${escaped}\\s*[—–:-]\\s*`, 'i'),
    new RegExp(`^v${escaped}\\s+`, 'i'),
    new RegExp(`^${escaped}\\s+`, 'i'),
  ];
  let normalized = title;
  for (const pattern of patterns) {
    normalized = normalized.replace(pattern, '');
  }
  return normalized.trim() || title;
}

function normalizeReleaseBody(body: string | undefined, version: string, title?: string): string | undefined {
  if (!body) return body;
  const normalizedTitle = normalizeReleaseTitle(title, version)?.trim();
  if (!normalizedTitle) return body;

  const lines = body.split('\n');
  const firstLine = lines[0]?.trim() ?? '';
  const firstHeading = firstLine.replace(/^#{1,6}\s*/, '').trim();
  const candidates = new Set<string>([
    normalizedTitle,
    `v${version} — ${normalizedTitle}`,
    `v${version} - ${normalizedTitle}`,
    `${version} — ${normalizedTitle}`,
    `${version} - ${normalizedTitle}`,
  ]);

  if (candidates.has(firstHeading)) {
    return lines.slice(1).join('\n').trim();
  }

  return body;
}

function detectChannel(version: string | undefined): VersionChannel {
  if (!version) return 'stable';
  return version.startsWith('dev-') ? 'dev' : 'stable';
}

// ─── Filter type ─────────────────────────────────────────────────────────

type FilterOption = 'all' | 'stable' | 'dev';

// ─── Component ───────────────────────────────────────────────────────────

interface UpdatesPageProps {
  page: PageTab;
  onBack: () => void;
  onOpenDrawer: () => void;
  onOpenRightDrawer: () => void;
}

export function UpdatesPage({ page, onBack, onOpenDrawer, onOpenRightDrawer }: UpdatesPageProps) {
  const insets = useSafeAreaInsets();
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const themeColors = useThemeColors();
  const queryClient = useQueryClient();

  const {
    updateAvailable,
    currentVersion,
    latestVersion,
    changelog,
    update,
    isUpdating,
    phase,
    phaseLabel,
    phaseProgress,
    phaseMessage,
    updateResult,
    updateError,
    resetStatus,
    refreshCurrentVersion,
  } = useGlobalSandboxUpdate();

  const currentChannel = detectChannel(currentVersion);

  // Filter state
  const [showDev, setShowDev] = useState(currentChannel === 'dev');
  const [filter, setFilter] = useState<FilterOption>('stable');

  // Scroll persistence
  const scrollRef = useRef<ScrollView>(null);
  const savedScrollY = useTabStore((s) => (s.tabStateById[page.id]?.scrollY as number) ?? 0);
  const scrollYRef = useRef(savedScrollY);

  const handleScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    scrollYRef.current = e.nativeEvent.contentOffset.y;
  }, []);

  React.useEffect(() => {
    return () => {
      useTabStore.getState().setTabState(page.id, { scrollY: scrollYRef.current });
    };
  }, [page.id]);

  const handleContentSizeChange = useCallback(() => {
    if (savedScrollY > 0) {
      scrollRef.current?.scrollTo({ y: savedScrollY, animated: false });
    }
  }, [savedScrollY]);

  // Fetch all versions (new API, like web)
  const { data, isLoading, error } = useQuery({
    queryKey: ['sandbox', 'versions', 'all'],
    queryFn: getAllVersions,
    staleTime: 5 * 60 * 1000,
  });

  // Filter
  const filteredVersions = useMemo(() => {
    if (!data?.versions) return [];
    if (filter === 'all') return data.versions;
    return data.versions.filter((v) => v.channel === filter);
  }, [data?.versions, filter]);

  const latestStable = useMemo(() => {
    return data?.versions?.find((v) => v.channel === 'stable')?.version ?? null;
  }, [data?.versions]);

  const latestDev = useMemo(() => {
    return data?.versions?.find((v) => v.channel === 'dev')?.version ?? null;
  }, [data?.versions]);

  const hasDevBuilds = useMemo(() => {
    return Boolean(data?.versions?.some((v) => v.channel === 'dev'));
  }, [data?.versions]);

  // Update dialog state
  const [dialogOpen, setDialogOpen] = useState(false);

  const handleOpenDialog = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setDialogOpen(true);
  }, []);

  const handleDialogClose = useCallback(() => {
    setDialogOpen(false);
    // Refresh version data after dialog closes (covers both success and cancel)
    queryClient.invalidateQueries({ queryKey: ['sandbox', 'versions'] });
    queryClient.invalidateQueries({ queryKey: ['sandbox', 'latest-version'] });
    // Force a fresh read of the running version from the sandbox health
    // endpoint. The sandbox restarts during update and may take a moment to
    // report the new version, so re-fetch immediately and again shortly after.
    refreshCurrentVersion();
    setTimeout(refreshCurrentVersion, 2000);
  }, [queryClient, refreshCurrentVersion]);

  const handleDialogConfirm = useCallback(() => {
    update();
  }, [update]);

  const handleDialogRetry = useCallback(() => {
    resetStatus();
    update();
  }, [resetStatus, update]);

  const toggleDev = useCallback(() => {
    Haptics.selectionAsync();
    setShowDev((prev) => {
      const next = !prev;
      if (!next) setFilter('stable');
      return next;
    });
  }, []);

  const fgColor = isDark ? '#F8F8F8' : '#121215';
  const mutedColor = isDark ? '#888' : '#777';
  const borderColor = isDark ? 'rgba(248,248,248,0.08)' : 'rgba(18,18,21,0.08)';

  return (
    <View className="flex-1 bg-muted">
      <PageHeader
        title="Versions"
        onOpenDrawer={onOpenDrawer}
        onOpenRightDrawer={onOpenRightDrawer}
      />

      <PageContent>
        <ScrollView
          ref={scrollRef}
          className="flex-1"
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
          onScroll={handleScroll}
          scrollEventThrottle={64}
          onContentSizeChange={handleContentSizeChange}
        >
        <View className="px-5 pt-2 pb-4">
          {/* Version info */}
          <View className="flex-row items-start justify-between">
            <View className="flex-1">
              <Text className="font-roobert text-sm text-muted-foreground">
                Running{' '}
                <Text className="font-mono font-roobert-semibold text-foreground">
                  {currentVersion ? (currentVersion.startsWith('dev-') ? currentVersion : `v${currentVersion}`) : '...'}
                </Text>
                {currentChannel === 'dev' && (
                  <Text className="font-roobert-medium text-[10px] text-amber-500"> dev</Text>
                )}
              </Text>
              {latestVersion && currentVersion && latestVersion !== currentVersion && (
                <Text className="font-roobert text-sm text-muted-foreground mt-0.5">
                  Latest:{' '}
                  <Text style={{ color: themeColors.primary }} className="font-mono font-roobert-semibold">
                    {latestVersion.startsWith('dev-') ? latestVersion : `v${latestVersion}`}
                  </Text>
                </Text>
              )}
            </View>

            {/* Dev toggle */}
            {hasDevBuilds && (
              <Pressable onPress={toggleDev} hitSlop={8} className="mt-0.5">
                <Text className="font-roobert text-[12px]" style={{ color: isDark ? '#666' : '#999' }}>
                  {showDev ? 'Hide dev builds' : 'Dev builds'}
                </Text>
              </Pressable>
            )}
          </View>

          {/* Update button — opens dialog */}
          {updateAvailable && latestVersion && (
            <Button
              onPress={handleOpenDialog}
              className="mt-4 self-start"
              style={{ backgroundColor: themeColors.primary }}
            >
              <Icon as={ArrowDownToLine} size={15} style={{ color: themeColors.primaryForeground }} strokeWidth={2.5} />
              <Text className="font-roobert-semibold" style={{ color: themeColors.primaryForeground }}>
                Update to {latestVersion.startsWith('dev-') ? latestVersion : `v${latestVersion}`}
              </Text>
            </Button>
          )}
        </View>

        {/* Filter tabs */}
        {showDev && (
          <View className="px-5 pb-4">
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0 }} contentContainerStyle={{ gap: 6 }}>
              {(['all', 'stable', 'dev'] as FilterOption[]).map((key) => {
                const active = filter === key;
                return (
                  <Pressable
                    key={key}
                    onPress={() => { setFilter(key); Haptics.selectionAsync(); }}
                    style={{
                      backgroundColor: active ? fgColor : isDark ? 'rgba(248,248,248,0.06)' : 'rgba(18,18,21,0.04)',
                      borderRadius: 20,
                      paddingHorizontal: 14,
                      paddingVertical: 6,
                    }}
                  >
                    <Text
                      className="text-[12px] font-roobert-medium"
                      style={{ color: active ? (isDark ? '#121215' : '#f8f8f8') : mutedColor }}
                    >
                      {key.charAt(0).toUpperCase() + key.slice(1)}
                    </Text>
                  </Pressable>
                );
              })}
            </ScrollView>
          </View>
        )}

        {/* Version entries */}
        <View className="px-5" style={{ gap: 12 }}>
          {isLoading && (
            <View className="py-12 items-center">
              <ActivityIndicator size="small" />
            </View>
          )}

          {error && (
            <Text className="py-12 text-center font-roobert text-xs text-muted-foreground">
              Could not load version history. The platform API may be unavailable.
            </Text>
          )}

          {filteredVersions.map((entry) => {
            const isCurrent = currentVersion === entry.version;
            const isLatestInChannel =
              (entry.channel === 'stable' && entry.version === latestStable) ||
              (entry.channel === 'dev' && entry.version === latestDev);
            const versionType = parseVersionType(entry.version);
            const isDev = versionType === 'dev';
            const isMajor = versionType === 'major';

            return (
              <VersionEntryCard
                key={entry.version}
                entry={entry}
                isCurrent={isCurrent}
                isLatestInChannel={isLatestInChannel}
                versionType={versionType}
                isDark={isDark}
                borderColor={borderColor}
                themeColors={themeColors}
              />
            );
          })}

          {!isLoading && !error && data && filteredVersions.length === 0 && (
            <Text className="py-12 text-center font-roobert text-xs text-muted-foreground">
              No {filter === 'all' ? '' : filter + ' '}versions found.
            </Text>
          )}
        </View>
        </ScrollView>
      </PageContent>

      {/* Update dialog */}
      <UpdateDialog
        open={dialogOpen}
        phase={phase}
        phaseMessage={phaseMessage}
        phaseProgress={phaseProgress}
        latestVersion={latestVersion}
        changelog={changelog}
        currentVersion={currentVersion}
        errorMessage={updateError?.message ?? null}
        updateResult={updateResult}
        onClose={handleDialogClose}
        onConfirm={handleDialogConfirm}
        onRetry={handleDialogRetry}
      />
    </View>
  );
}

// ─── Version Entry Card ──────────────────────────────────────────────────

function VersionEntryCard({
  entry,
  isCurrent,
  isLatestInChannel,
  versionType,
  isDark,
  borderColor: defaultBorderColor,
  themeColors,
}: {
  entry: VersionEntry;
  isCurrent: boolean;
  isLatestInChannel: boolean;
  versionType: VersionType;
  isDark: boolean;
  borderColor: string;
  themeColors: { primary: string; primaryForeground: string };
}) {
  const [expanded, setExpanded] = useState(false);

  const isDev = versionType === 'dev';
  const isMajor = versionType === 'major';
  const isMinor = versionType === 'minor';

  const displayVersion = isDev ? entry.version : `v${entry.version}`;
  const displayTitle = normalizeReleaseTitle(entry.title, entry.version);
  const displayBody = normalizeReleaseBody(entry.body, entry.version, entry.title);
  const canExpandBody = Boolean(displayBody && displayBody.length > (isDev ? 220 : 420));

  // Card border/bg based on status
  const cardBorderColor = isMajor
    ? isDark ? 'rgba(139,92,246,0.3)' : 'rgba(139,92,246,0.2)'
    : isCurrent
      ? isDark ? 'rgba(52,211,153,0.3)' : 'rgba(52,211,153,0.2)'
      : isDev && !isLatestInChannel
        ? isDark ? 'rgba(248,248,248,0.04)' : 'rgba(18,18,21,0.05)'
        : defaultBorderColor;

  const cardBgColor = isMajor
    ? isDark ? 'rgba(139,92,246,0.03)' : 'rgba(139,92,246,0.02)'
    : isCurrent
      ? isDark ? 'rgba(52,211,153,0.03)' : 'rgba(52,211,153,0.02)'
      : isDev && !isLatestInChannel
        ? isDark ? 'rgba(248,248,248,0.015)' : 'rgba(18,18,21,0.01)'
        : undefined;

  // Left border accent for major releases
  const leftBorderColor = isMajor ? themeColors.primary : undefined;

  const verticalPadding = isDev ? 12 : isMajor ? 20 : 16;

  return (
    <View
      className="rounded-2xl overflow-hidden"
      style={{
        borderWidth: 1,
        borderColor: cardBorderColor,
        backgroundColor: cardBgColor,
        borderLeftWidth: isMajor ? 4 : 1,
        borderLeftColor: leftBorderColor || cardBorderColor,
      }}
    >
      <View style={{ paddingHorizontal: 16, paddingVertical: verticalPadding }}>
        {/* Header row: icon + version + badges + date */}
        <View className="flex-row items-center" style={{ gap: 6 }}>
          <Icon
            as={isDev ? GitCommit : Tag}
            size={13}
            color={isDark ? 'rgba(248,248,248,0.35)' : 'rgba(18,18,21,0.3)'}
            strokeWidth={2}
          />
          <Text
            className={`font-mono font-roobert-semibold text-foreground ${isMajor ? 'text-[18px]' : isDev ? 'text-[13px]' : 'text-[16px]'}`}
          >
            {displayVersion}
          </Text>

          {/* Channel badge */}
          <View
            className="rounded-full px-1.5 py-0.5"
            style={{
              backgroundColor: entry.channel === 'dev'
                ? isDark ? 'rgba(245,158,11,0.12)' : 'rgba(245,158,11,0.1)'
                : isDark ? 'rgba(52,211,153,0.12)' : 'rgba(52,211,153,0.1)',
            }}
          >
            <Text
              className="text-[9px] font-roobert-semibold"
              style={{
                color: entry.channel === 'dev' ? '#F59E0B' : '#34D399',
              }}
            >
              {entry.channel}
            </Text>
          </View>

          {/* Major badge */}
          {isMajor && (
            <View
              className="rounded-full px-1.5 py-0.5"
              style={{ backgroundColor: isDark ? 'rgba(139,92,246,0.15)' : 'rgba(139,92,246,0.1)' }}
            >
              <Text className="text-[9px] font-roobert-semibold" style={{ color: '#8B5CF6' }}>Major</Text>
            </View>
          )}

          {/* Current badge */}
          {isCurrent && (
            <View className="rounded-full bg-emerald-400/15 px-1.5 py-0.5">
              <Text className="text-[9px] font-roobert-semibold text-emerald-500">Current</Text>
            </View>
          )}

          {/* Latest badge */}
          {isLatestInChannel && !isCurrent && (
            <View
              className="rounded-full px-1.5 py-0.5"
              style={{ backgroundColor: isDark ? 'rgba(96,165,250,0.12)' : 'rgba(96,165,250,0.1)' }}
            >
              <Text className="text-[9px] font-roobert-semibold" style={{ color: '#60A5FA' }}>Latest</Text>
            </View>
          )}

          <View className="flex-1" />

          {/* Date */}
          {!!entry.date && (
            <Text className="font-mono text-[10px] text-muted-foreground/50">{entry.date}</Text>
          )}
        </View>

        {/* Title */}
        {displayTitle && (
          <Text
            className={`font-roobert-medium text-foreground mt-2 ${isMajor ? 'text-[15px]' : 'text-[13px]'}`}
            style={{ lineHeight: isMajor ? 20 : 18 }}
          >
            {displayTitle}
          </Text>
        )}

        {/* Body — rendered as plain text with basic formatting */}
        {displayBody && (
          <View className="mt-2">
            <MarkdownBody
              body={displayBody}
              expanded={expanded || !canExpandBody}
              isDev={isDev}
              isMajor={isMajor}
              isDark={isDark}
            />

            {canExpandBody && (
              <Pressable
                onPress={() => { setExpanded((prev) => !prev); Haptics.selectionAsync(); }}
                className="mt-2"
              >
                <Text className="font-roobert text-[11px] text-muted-foreground">
                  {expanded ? 'Show less' : 'Show full release notes'}
                </Text>
              </Pressable>
            )}
          </View>
        )}

        {/* Dev SHA link */}
        {isDev && entry.sha && (
          <View className="flex-row items-center mt-2" style={{ gap: 4 }}>
            <Icon as={GitCommit} size={11} color={isDark ? 'rgba(248,248,248,0.3)' : 'rgba(18,18,21,0.25)'} strokeWidth={2} />
            <Text className="font-mono text-[11px] text-muted-foreground/50">{entry.sha.substring(0, 8)}</Text>
          </View>
        )}
      </View>
    </View>
  );
}

// ─── Markdown Body (simple text rendering) ───────────────────────────────

function MarkdownBody({
  body,
  expanded,
  isDev,
  isMajor,
  isDark,
}: {
  body: string;
  expanded: boolean;
  isDev: boolean;
  isMajor: boolean;
  isDark: boolean;
}) {
  const maxLines = expanded ? undefined : isDev ? 6 : isMajor ? 16 : 12;
  const lines = body.split('\n');

  return (
    <View>
      {lines.slice(0, maxLines).map((line, i) => {
        const trimmed = line.trim();
        if (!trimmed) return <View key={i} style={{ height: 6 }} />;

        // Heading (### or ##)
        if (trimmed.startsWith('###')) {
          return (
            <Text
              key={i}
              className="font-roobert-medium text-[12px] text-foreground/80"
              style={{ marginTop: i > 0 ? 8 : 0, marginBottom: 2 }}
            >
              {trimmed.replace(/^#{1,6}\s*/, '')}
            </Text>
          );
        }
        if (trimmed.startsWith('##')) {
          return (
            <Text
              key={i}
              className="font-roobert-semibold text-[13px] text-foreground/90"
              style={{ marginTop: i > 0 ? 10 : 0, marginBottom: 3 }}
            >
              {trimmed.replace(/^#{1,6}\s*/, '')}
            </Text>
          );
        }

        // List item
        if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
          const content = trimmed.slice(2);
          return (
            <View key={i} className="flex-row" style={{ paddingLeft: 4, marginVertical: 1.5 }}>
              <Text className="font-roobert text-[11px] text-muted-foreground" style={{ width: 12 }}>{'\u2022'}</Text>
              <Text
                className="flex-1 font-roobert text-[11px] text-muted-foreground"
                style={{ lineHeight: 16 }}
              >
                {formatInlineMarkdown(content)}
              </Text>
            </View>
          );
        }

        // Regular paragraph
        return (
          <Text
            key={i}
            className="font-roobert text-[11px] text-muted-foreground"
            style={{ lineHeight: 16, marginVertical: 1 }}
          >
            {formatInlineMarkdown(trimmed)}
          </Text>
        );
      })}
    </View>
  );
}

function formatInlineMarkdown(text: string): string {
  // Strip markdown bold/italic markers, backtick code
  return text
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/\*(.*?)\*/g, '$1')
    .replace(/`(.*?)`/g, '$1');
}

