import React, { useCallback, useRef, useState, useMemo } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  RefreshControl,
  ScrollView,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useColorScheme } from 'nativewind';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import * as Haptics from 'expo-haptics';
import {
  Menu,
  Play,
  RefreshCw,
  RotateCcw,
  Server,
  Square,
  Trash2,
  FileText,
} from 'lucide-react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { Ionicons } from '@expo/vector-icons';
import { useSandboxContext } from '@/contexts/SandboxContext';
import {
  getSandboxServices,
  sandboxServiceAction,
  getSandboxServiceLogs,
  reconcileSandboxServices,
  type SandboxService,
  type ServiceAction,
} from '@/lib/platform/client';
import { useTabStore, type PageTab } from '@/stores/tab-store';
import { PageHeader } from '@/components/ui/page-header';
import { PageContent } from '@/components/ui/page-content';
import { useThemeColors } from '@/lib/theme-colors';

// ─── Types ──────────────────────────────────────────────────────────────────

type ServiceFilter = 'all' | 'managed' | 'projects' | 'system';

// ─── Helpers ────────────────────────────────────────────────────────────────

function formatTimeAgo(isoDate: string | undefined): string {
  if (!isoDate) return '';
  try {
    const diff = Date.now() - new Date(isoDate).getTime();
    if (diff < 0) return '';
    if (diff < 60_000) return 'just now';
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
    return `${Math.floor(diff / 86_400_000)}d ago`;
  } catch {
    return '';
  }
}

function shortenPath(path: string | undefined): string {
  if (!path) return '';
  return path.replace(/^\/workspace\/?/, '') || '/';
}

const FILTER_LABELS: Record<ServiceFilter, string> = {
  all: 'All',
  managed: 'Managed',
  projects: 'Projects',
  system: 'System',
};

// ─── Component ──────────────────────────────────────────────────────────────

interface RunningServicesPageProps {
  page: PageTab;
  onBack: () => void;
  onOpenDrawer: () => void;
  onOpenRightDrawer: () => void;
  isDrawerOpen?: boolean;
  isRightDrawerOpen?: boolean;
}

export function RunningServicesPage({ page, onBack, onOpenDrawer, onOpenRightDrawer, isDrawerOpen, isRightDrawerOpen }: RunningServicesPageProps) {
  const insets = useSafeAreaInsets();
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const themeColors = useThemeColors();
  const { sandboxUrl } = useSandboxContext();
  const queryClient = useQueryClient();

  const [filter, setFilter] = useState<ServiceFilter>('all');
  const [expandedLogs, setExpandedLogs] = useState<string | null>(null);

  // Scroll state persistence
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

  // Fetch services — include all (managed + unmanaged)
  const [manualRefreshing, setManualRefreshing] = useState(false);
  const { data: services, isLoading, refetch: refetchServices } = useQuery({
    queryKey: ['sandbox', 'services'],
    queryFn: () => getSandboxServices(sandboxUrl!, true),
    enabled: !!sandboxUrl,
    staleTime: 5000,
    refetchInterval: 5000,
  });

  const handleManualRefresh = useCallback(async () => {
    setManualRefreshing(true);
    await refetchServices();
    setManualRefreshing(false);
  }, [refetchServices]);

  // Pending action tracking
  const [pendingAction, setPendingAction] = useState<string | null>(null);

  const handleAction = useCallback(async (service: SandboxService, action: ServiceAction) => {
    if (!sandboxUrl) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

    if (action === 'delete') {
      Alert.alert('Delete Service', `Remove "${service.name}" from service manager?`, [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            setPendingAction(`${service.id}:delete`);
            await sandboxServiceAction(sandboxUrl, service.id, 'delete');
            queryClient.invalidateQueries({ queryKey: ['sandbox', 'services'] });
            setPendingAction(null);
          },
        },
      ]);
      return;
    }

    setPendingAction(`${service.id}:${action}`);
    const success = await sandboxServiceAction(sandboxUrl, service.id, action);
    if (!success) {
      Alert.alert('Error', `Failed to ${action} "${service.name}"`);
    }
    queryClient.invalidateQueries({ queryKey: ['sandbox', 'services'] });
    setPendingAction(null);
  }, [sandboxUrl, queryClient]);

  // Reconcile
  const handleReconcile = useCallback(async () => {
    if (!sandboxUrl) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    await reconcileSandboxServices(sandboxUrl, true);
    queryClient.invalidateQueries({ queryKey: ['sandbox', 'services'] });
  }, [sandboxUrl, queryClient]);

  // Filtering
  const filteredServices = useMemo(() => {
    if (!services) return [];
    return services.filter((s) => {
      if (filter === 'all') return true;
      if (filter === 'managed') return s.managed;
      if (filter === 'projects') return s.scope === 'project' || s.scope === 'session';
      if (filter === 'system') return s.scope === 'bootstrap' || s.scope === 'core';
      return true;
    });
  }, [services, filter]);

  const runningCount = filteredServices.filter((s) => s.status === 'running' || s.status === 'starting').length;
  const totalCount = filteredServices.length;

  const fgColor = isDark ? '#F8F8F8' : '#121215';
  const mutedColor = isDark ? '#888' : '#777';
  const borderColor = isDark ? 'rgba(248,248,248,0.08)' : 'rgba(18,18,21,0.08)';

  return (
    <View className="flex-1 bg-muted">
      <PageHeader
        title={
          <View style={{ flex: 1 }}>
            <Text className="text-base font-medium text-muted-foreground" numberOfLines={1}>
              Service Manager
            </Text>
            <Text className="font-roobert text-[11px] text-muted-foreground" style={{ marginTop: -1, includeFontPadding: false }}>
              {isLoading ? 'Loading...' : `${runningCount}/${totalCount} running`}
            </Text>
          </View>
        }
        onOpenDrawer={onOpenDrawer}
        onOpenRightDrawer={onOpenRightDrawer}
        isDrawerOpen={isDrawerOpen}
        isRightDrawerOpen={isRightDrawerOpen}
        rightActions={
          <Pressable onPress={handleReconcile} hitSlop={8} className="p-1">
            <Icon as={RefreshCw} size={18} color={mutedColor} strokeWidth={2} />
          </Pressable>
        }
      />

      <PageContent>
      {/* Filter chips */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={{ flexGrow: 0 }}
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 8, gap: 8 }}
      >
        {(Object.keys(FILTER_LABELS) as ServiceFilter[]).map((key) => {
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
                {FILTER_LABELS[key]}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>

      <ScrollView
        ref={scrollRef}
        className="flex-1"
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
        onScroll={handleScroll}
        scrollEventThrottle={64}
        onContentSizeChange={handleContentSizeChange}
        refreshControl={<RefreshControl refreshing={manualRefreshing} onRefresh={handleManualRefresh} />}
      >
        <View className="px-4 pt-2">
          {/* Loading */}
          {isLoading && (
            <View className="py-12 items-center">
              <ActivityIndicator size="small" />
            </View>
          )}

          {/* Items list */}
          {!isLoading && filteredServices.length > 0 && (
            <View style={{ gap: 10 }}>
              {filteredServices.map((service) => (
                <ServiceCard
                  key={service.id}
                  service={service}
                  isDark={isDark}
                  fgColor={fgColor}
                  mutedColor={mutedColor}
                  borderColor={borderColor}
                  themeColors={themeColors}
                  sandboxUrl={sandboxUrl}
                  pendingAction={pendingAction}
                  expandedLogs={expandedLogs}
                  onToggleLogs={(id) => setExpandedLogs(expandedLogs === id ? null : id)}
                  onAction={handleAction}
                />
              ))}
            </View>
          )}

          {/* Empty state */}
          {!isLoading && filteredServices.length === 0 && (
            <View className="items-center justify-center py-16">
              <Icon as={Server} size={32} className="text-muted-foreground/40" strokeWidth={1.5} />
              <Text className="mt-3 font-roobert-medium text-[15px] text-foreground">No Services</Text>
              <Text className="mt-1 text-center font-roobert text-xs text-muted-foreground">
                {filter === 'all'
                  ? 'Start a dev server or register a service to see it here.'
                  : `No ${FILTER_LABELS[filter].toLowerCase()} services found.`}
              </Text>
            </View>
          )}
        </View>
      </ScrollView>
      </PageContent>
    </View>
  );
}

// ─── Service Card ───────────────────────────────────────────────────────────

function ServiceCard({
  service,
  isDark,
  fgColor,
  mutedColor,
  borderColor,
  themeColors,
  sandboxUrl,
  pendingAction,
  expandedLogs,
  onToggleLogs,
  onAction,
}: {
  service: SandboxService;
  isDark: boolean;
  fgColor: string;
  mutedColor: string;
  borderColor: string;
  themeColors: { primary: string; primaryForeground: string };
  sandboxUrl: string | undefined;
  pendingAction: string | null;
  expandedLogs: string | null;
  onToggleLogs: (id: string) => void;
  onAction: (s: SandboxService, a: ServiceAction) => void;
}) {
  const isRunning = service.status === 'running' || service.status === 'starting';
  const isFailed = service.status === 'failed' || service.status === 'backoff';
  const showLogs = expandedLogs === service.id;
  const busy = (a: string) => pendingAction === `${service.id}:${a}`;

  // Logs query — only when expanded
  const { data: logs } = useQuery({
    queryKey: ['sandbox', 'service-logs', service.id],
    queryFn: () => getSandboxServiceLogs(sandboxUrl!, service.id),
    enabled: showLogs && !!sandboxUrl,
    staleTime: 3000,
    refetchInterval: showLogs ? 3000 : false,
  });

  const statusColor = isRunning
    ? '#34D399'
    : isFailed
      ? '#EF4444'
      : isDark ? 'rgba(248,248,248,0.3)' : 'rgba(18,18,21,0.3)';

  const statusLabel = service.status === 'running'
    ? 'Running'
    : service.status === 'starting'
      ? 'Starting'
      : service.status === 'failed'
        ? 'Failed'
        : service.status === 'backoff'
          ? 'Backoff'
          : 'Stopped';

  const cardBorderColor = isRunning
    ? isDark ? 'rgba(52,211,153,0.15)' : 'rgba(52,211,153,0.12)'
    : isFailed
      ? isDark ? 'rgba(239,68,68,0.2)' : 'rgba(239,68,68,0.15)'
      : borderColor;

  return (
    <View className="rounded-2xl border overflow-hidden" style={{ borderColor: cardBorderColor }}>
      <View className="px-4 py-3.5">
        {/* Top row: icon + name + status */}
        <View className="flex-row items-center">
          <View className="relative">
            <View
              className="w-8 h-8 rounded-[10px] items-center justify-center"
              style={{ backgroundColor: isDark ? 'rgba(248,248,248,0.06)' : 'rgba(18,18,21,0.04)' }}
            >
              <Icon as={Server} size={16} color={fgColor} strokeWidth={1.8} />
            </View>
            {isRunning && (
              <View className="absolute -bottom-0.5 -right-0.5">
                <View className="h-2.5 w-2.5 rounded-full bg-emerald-400 border-2 border-background" />
              </View>
            )}
          </View>
          <View className="ml-3 flex-1">
            <View className="flex-row items-center" style={{ gap: 6 }}>
              <Text className="font-roobert-semibold text-[14px] text-foreground" numberOfLines={1}>
                {service.name}
              </Text>
              <View
                className="rounded-full px-1.5 py-0.5"
                style={{
                  backgroundColor: isRunning
                    ? isDark ? 'rgba(52,211,153,0.12)' : 'rgba(52,211,153,0.1)'
                    : isFailed
                      ? isDark ? 'rgba(239,68,68,0.12)' : 'rgba(239,68,68,0.1)'
                      : isDark ? 'rgba(248,248,248,0.06)' : 'rgba(18,18,21,0.05)',
                }}
              >
                <Text
                  className="text-[10px] font-roobert-medium"
                  style={{ color: statusColor }}
                >
                  {statusLabel}
                </Text>
              </View>
            </View>
            <View className="flex-row items-center mt-0.5" style={{ gap: 6 }}>
              {service.adapter && (
                <Text className="text-[11px] font-roobert text-muted-foreground">{service.adapter}</Text>
              )}
              {service.port > 0 && (
                <Text className="text-[11px] font-mono text-muted-foreground/50">:{service.port}</Text>
              )}
              {service.scope && (
                <Text className="text-[11px] font-roobert text-muted-foreground/50">{service.scope}</Text>
              )}
            </View>
          </View>
        </View>

        {/* Source path */}
        {service.sourcePath ? (
          <Text className="mt-2 text-[11px] font-roobert text-muted-foreground/60" numberOfLines={1}>
            {shortenPath(service.sourcePath)}
          </Text>
        ) : null}

        {/* Action buttons */}
        <View className="flex-row items-center mt-3" style={{ gap: 8 }}>
          {/* Start / Stop */}
          {isRunning ? (
            <ActionButton
              icon={Square}
              label={busy('stop') ? 'Stopping...' : 'Stop'}
              onPress={() => onAction(service, 'stop')}
              disabled={!!pendingAction}
              variant="destructive"
              isDark={isDark}
            />
          ) : (
            <ActionButton
              icon={Play}
              label={busy('start') ? 'Starting...' : 'Start'}
              onPress={() => onAction(service, 'start')}
              disabled={!!pendingAction}
              variant="primary"
              isDark={isDark}
              themeColors={themeColors}
            />
          )}

          {/* Restart */}
          <ActionButton
            icon={RotateCcw}
            label={busy('restart') ? '...' : 'Restart'}
            onPress={() => onAction(service, 'restart')}
            disabled={!!pendingAction}
            variant="default"
            isDark={isDark}
          />

          {/* Logs */}
          <ActionButton
            icon={FileText}
            label="Logs"
            onPress={() => onToggleLogs(service.id)}
            disabled={false}
            variant={showLogs ? 'active' : 'default'}
            isDark={isDark}
          />

          <View className="flex-1" />

          {/* Delete (only non-builtin) */}
          {!service.builtin && (
            <ActionButton
              icon={Trash2}
              label=""
              onPress={() => onAction(service, 'delete')}
              disabled={!!pendingAction}
              variant="ghost-destructive"
              isDark={isDark}
            />
          )}

          {/* Time */}
          {service.startedAt ? (
            <Text className="text-[10px] font-roobert text-muted-foreground/40">
              {formatTimeAgo(service.startedAt)}
            </Text>
          ) : null}
        </View>
      </View>

      {/* Logs panel */}
      {showLogs && (
        <View
          style={{
            backgroundColor: isDark ? '#0D0D0F' : '#F5F5F5',
            borderTopWidth: 1,
            borderTopColor: isDark ? 'rgba(248,248,248,0.06)' : 'rgba(18,18,21,0.06)',
            maxHeight: 200,
          }}
        >
          <ScrollView
            style={{ padding: 12 }}
            showsVerticalScrollIndicator
            nestedScrollEnabled
          >
            {logs && logs.length > 0 ? (
              logs.map((line, i) => (
                <Text
                  key={i}
                  className="text-[11px] font-mono"
                  style={{ color: isDark ? '#BBB' : '#555', lineHeight: 16 }}
                  selectable
                >
                  {line}
                </Text>
              ))
            ) : (
              <Text className="text-[11px] font-roobert text-muted-foreground/40 text-center py-4">
                No logs available
              </Text>
            )}
          </ScrollView>
        </View>
      )}
    </View>
  );
}

// ─── Action Button ──────────────────────────────────────────────────────────

function ActionButton({
  icon: IconComponent,
  label,
  onPress,
  disabled,
  variant,
  isDark,
  themeColors,
}: {
  icon: any;
  label: string;
  onPress: () => void;
  disabled: boolean;
  variant: 'primary' | 'destructive' | 'default' | 'active' | 'ghost-destructive';
  isDark: boolean;
  themeColors?: { primary: string; primaryForeground: string };
}) {
  let bgColor: string;
  let textColor: string;

  switch (variant) {
    case 'primary':
      bgColor = themeColors?.primary ?? (isDark ? '#F8F8F8' : '#121215');
      textColor = themeColors?.primaryForeground ?? (isDark ? '#121215' : '#F8F8F8');
      break;
    case 'destructive':
      bgColor = isDark ? 'rgba(239,68,68,0.12)' : 'rgba(239,68,68,0.1)';
      textColor = '#EF4444';
      break;
    case 'active':
      bgColor = isDark ? 'rgba(248,248,248,0.1)' : 'rgba(18,18,21,0.08)';
      textColor = isDark ? '#F8F8F8' : '#121215';
      break;
    case 'ghost-destructive':
      bgColor = 'transparent';
      textColor = isDark ? 'rgba(239,68,68,0.6)' : 'rgba(239,68,68,0.7)';
      break;
    default:
      bgColor = isDark ? 'rgba(248,248,248,0.06)' : 'rgba(18,18,21,0.04)';
      textColor = isDark ? '#AAA' : '#666';
  }

  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      className="flex-row items-center rounded-lg active:opacity-70"
      style={{
        backgroundColor: bgColor,
        paddingHorizontal: label ? 10 : 8,
        paddingVertical: 6,
        opacity: disabled ? 0.5 : 1,
        gap: label ? 4 : 0,
      }}
    >
      <Icon as={IconComponent} size={12} color={textColor} strokeWidth={2.2} />
      {label ? (
        <Text className="text-[11px] font-roobert-medium" style={{ color: textColor }}>
          {label}
        </Text>
      ) : null}
    </Pressable>
  );
}
