import * as React from 'react';
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useColorScheme } from 'nativewind';
import { haptics } from '@/lib/haptics';
import {
  Check,
  Server,
} from 'lucide-react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { useSandboxContext } from '@/contexts/SandboxContext';
import {
  useInstances,
  useSandbox,
} from '@/lib/platform/hooks';
import type { SandboxInfo, SandboxProviderName } from '@/lib/platform/client';
import { useGlobalSandboxUpdate } from '@/hooks/useSandboxUpdate';

// ─── Helpers ────────────────────────────────────────────────────────────────

function providerLabel(provider: SandboxProviderName): string {
  switch (provider) {
    case 'local_docker': return 'LOCAL';
    case 'daytona': return 'CLOUD';
  }
}

function statusColor(status: string): string {
  switch (status) {
    case 'running': case 'ready': case 'active': return '#34D399';
    case 'stopped': case 'archived': return '#9CA3AF';
    case 'error': case 'failed': return '#EF4444';
    default: return '#FBBF24';
  }
}

function statusLabel(status: string): string {
  switch (status) {
    case 'running': case 'ready': case 'active': return 'Connected';
    case 'stopped': return 'Stopped';
    case 'archived': return 'Archived';
    case 'error': case 'failed': return 'Error';
    default: return status;
  }
}

// ─── Main Screen ────────────────────────────────────────────────────────────

export default function InstancesScreen() {
  const insets = useSafeAreaInsets();
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const { sandboxId, switchSandbox } = useSandboxContext();

  const { data: rawInstances, isLoading, refetch, isRefetching } = useInstances();
  // Fallback: if the list call returns empty but useSandbox already found a
  // project-session sandbox, surface it so the page never shows "No Instances"
  // while the app's active sandbox is connected.
  const { data: activeData } = useSandbox();
  const instances = React.useMemo<SandboxInfo[] | undefined>(() => {
    if (rawInstances === undefined) return undefined;
    if (rawInstances.length > 0) return rawInstances;
    const fallback = activeData?.sandbox;
    return fallback ? [fallback] : rawInstances;
  }, [rawInstances, activeData?.sandbox]);
  // Live version from /kortix/health for the active instance. The DB's
  // metadata.version is a cache written at create time and only refreshed
  // when an update completes — it can be null for older sandboxes and drifts
  // after an update landed inside the image without a DB write. The running
  // container is authoritative, so prefer this live value for the active row
  // and fall back to the DB cache for inactive ones. Mirrors web 00dad14.
  const { currentVersion: liveActiveVersion } = useGlobalSandboxUpdate();

  // Auto-poll when any instance is provisioning
  const hasProvisioning = React.useMemo(
    () => instances?.some((i) => !['running', 'ready', 'active', 'stopped', 'archived', 'error', 'failed'].includes(i.status)),
    [instances],
  );
  React.useEffect(() => {
    if (!hasProvisioning) return;
    const interval = setInterval(() => refetch(), 5000);
    return () => clearInterval(interval);
  }, [hasProvisioning, refetch]);

  const handleSelect = React.useCallback((instance: SandboxInfo) => {
    if (instance.external_id === sandboxId) return;
    haptics.medium();
    switchSandbox(instance);
  }, [sandboxId, switchSandbox]);

  if (isLoading) {
    return (
      <View className="flex-1 items-center justify-center bg-background">
        <ActivityIndicator size="small" />
      </View>
    );
  }

  return (
    <>
      <ScrollView
        className="flex-1 bg-background"
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
        refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={refetch} />}
      >
        <View className="px-5 pt-1">
          {/* Instances */}
          {instances && instances.length > 0 && (
            <View className="px-1">
              <Text className="mb-2 text-[11px] font-roobert-medium uppercase tracking-wider text-muted-foreground/80">
                Instances
              </Text>
              <View>
                {instances?.map((instance, idx) => {
                  const isActive = instance.external_id === sandboxId;
                  const isLast = idx === (instances?.length ?? 0) - 1;
                  const isProvisioning = !['running', 'ready', 'active', 'stopped', 'archived', 'error', 'failed'].includes(instance.status);
                  // Prefer live /kortix/health version for the active instance;
                  // fall back to the DB cache (instance.version) for others.
                  const effectiveVersion = (isActive ? liveActiveVersion : null) || instance.version || null;
                  return (
                    <View key={instance.sandbox_id}>
                      <Pressable onPress={() => handleSelect(instance)} disabled={isProvisioning} className="py-3.5 active:opacity-85">
                        <View className="flex-row items-center">
                          <View
                            className="h-2.5 w-2.5 rounded-full mr-3"
                            style={{ backgroundColor: isProvisioning ? '#FBBF24' : statusColor(instance.status) }}
                          />
                          <View className="flex-1">
                            <Text className="font-roobert-medium text-[15px] text-foreground" numberOfLines={1}>
                              {instance.name}
                            </Text>
                            <Text className="mt-0.5 font-roobert text-xs text-muted-foreground">
                              {isProvisioning ? 'Provisioning...' : statusLabel(instance.status)}
                              {effectiveVersion ? ` · v${effectiveVersion}` : ''}
                              {` · ${providerLabel(instance.provider)}`}
                            </Text>
                          </View>
                          <View className="flex-row items-center" style={{ gap: 8 }}>
                            {isProvisioning && <ActivityIndicator size="small" />}
                            {isActive && !isProvisioning && (
                              <Icon as={Check} size={16} className="text-primary" strokeWidth={2.7} />
                            )}
                          </View>
                        </View>
                        {isProvisioning && (
                          <View
                            className="mt-2 h-1 rounded-full overflow-hidden"
                            style={{ backgroundColor: isDark ? 'rgba(248,248,248,0.08)' : 'rgba(18,18,21,0.06)' }}
                          >
                            <View
                              className="h-full rounded-full"
                              style={{ width: '30%', backgroundColor: '#FBBF24' }}
                            />
                          </View>
                        )}
                      </Pressable>
                      {!isLast && <View className="h-px bg-border/35" />}
                    </View>
                  );
                })}
              </View>
            </View>
          )}

          {/* Empty state */}
          {!isLoading && (!instances || instances.length === 0) && (
            <View className="items-center justify-center py-12">
              <Icon as={Server} size={32} className="text-muted-foreground/40" strokeWidth={1.5} />
              <Text className="mt-3 font-roobert-medium text-[15px] text-foreground">No Instances</Text>
              <Text className="mt-1 text-center font-roobert text-xs text-muted-foreground">
                No project-session sandboxes found.
              </Text>
            </View>
          )}
        </View>
      </ScrollView>
    </>
  );
}
