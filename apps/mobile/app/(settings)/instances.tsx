import * as React from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  RefreshControl,
  ScrollView,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useColorScheme } from 'nativewind';
import { haptics } from '@/lib/haptics';
import {
  BottomSheetBackdrop,
  BottomSheetModal,
  BottomSheetView,
  type BottomSheetBackdropProps,
} from '@gorhom/bottom-sheet';
import {
  Check,
  Monitor,
  Plus,
  Server,
} from 'lucide-react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { useSandboxContext } from '@/contexts/SandboxContext';
import {
  useInstances,
  useProviders,
  useCreateLocalInstance,
  useSandbox,
} from '@/lib/platform/hooks';
import type { SandboxInfo, SandboxProviderName } from '@/lib/platform/client';
import { setInstanceProgress, useInstanceProgress } from '@/stores/instance-progress';
import { useThemeColors, getSheetBg } from '@/lib/theme-colors';
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
  // Fallback: if `/sandbox/list` returns empty (e.g. local-bridge discovery
  // failed) but the user actually has an active sandbox known via
  // `/sandbox`, surface it so the page never shows "No Instances" while the
  // app's active sandbox is connected. Mirrors what useSandbox already does
  // internally for the dashboard.
  const { data: activeData } = useSandbox();
  const instances = React.useMemo<SandboxInfo[] | undefined>(() => {
    if (rawInstances === undefined) return undefined;
    if (rawInstances.length > 0) return rawInstances;
    const fallback = activeData?.sandbox;
    return fallback ? [fallback] : rawInstances;
  }, [rawInstances, activeData?.sandbox]);
  const themeColors = useThemeColors();

  // Live version from /kortix/health for the active instance. The DB's
  // metadata.version is a cache written at create time and only refreshed
  // when an update completes — it can be null for older sandboxes and drifts
  // after an update landed inside the image without a DB write. The running
  // container is authoritative, so prefer this live value for the active row
  // and fall back to the DB cache for inactive ones. Mirrors web 00dad14.
  const { currentVersion: liveActiveVersion } = useGlobalSandboxUpdate();

  const addSheetRef = React.useRef<BottomSheetModal>(null);
  const creatingProgress = useInstanceProgress();

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

  const openAddSheet = React.useCallback(() => {
    haptics.medium();
    addSheetRef.current?.present();
  }, []);

  const onInstanceAdded = React.useCallback(() => {
    addSheetRef.current?.dismiss();
    refetch();
  }, [refetch]);

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
        contentContainerStyle={{ paddingBottom: insets.bottom + 80 }}
        refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={refetch} />}
      >
        <View className="px-5 pt-1">
          {/* Instances */}
          {((instances && instances.length > 0) || creatingProgress) && (
            <View className="px-1">
              <Text className="mb-2 text-[11px] font-roobert-medium uppercase tracking-wider text-muted-foreground/80">
                Instances
              </Text>
              <View>
                {/* Creating row — appears at the top of the list */}
                {creatingProgress && (
                  <>
                    <View className="py-3.5">
                      <View className="flex-row items-center mb-2">
                        <View className="h-2.5 w-2.5 rounded-full mr-3" style={{ backgroundColor: '#FBBF24' }} />
                        <View className="flex-1">
                          <Text className="font-roobert-medium text-[15px] text-foreground">Local Docker</Text>
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
                    {instances && instances.length > 0 && <View className="h-px bg-border/35" />}
                  </>
                )}

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
          {!isLoading && (!instances || instances.length === 0) && !creatingProgress && (
            <View className="items-center justify-center py-12">
              <Icon as={Server} size={32} className="text-muted-foreground/40" strokeWidth={1.5} />
              <Text className="mt-3 font-roobert-medium text-[15px] text-foreground">No Instances</Text>
              <Text className="mt-1 text-center font-roobert text-xs text-muted-foreground">
                Tap the button below to add one.
              </Text>
            </View>
          )}
        </View>
      </ScrollView>

      {/* New Instance button */}
      <View style={{ position: 'absolute', bottom: insets.bottom + 16, left: 20, right: 20 }}>
        <Pressable
          onPress={openAddSheet}
          className="flex-row items-center justify-center rounded-full py-3.5 active:opacity-90"
          style={{ backgroundColor: themeColors.primary }}
        >
          <Icon as={Plus} size={16} color={themeColors.primaryForeground} strokeWidth={2.5} />
          <Text className="ml-2 font-roobert-semibold text-[15px]" style={{ color: themeColors.primaryForeground }}>
            New Instance
          </Text>
        </Pressable>
      </View>

      <AddInstanceSheet ref={addSheetRef} isDark={isDark} onCreated={onInstanceAdded} onProgress={setInstanceProgress} />
    </>
  );
}

// ─── Add Instance Bottom Sheet ──────────────────────────────────────────────

const AddInstanceSheet = React.forwardRef<
  BottomSheetModal,
  { isDark: boolean; onCreated: () => void; onProgress: (p: { percent: number; message: string } | null) => void }
>(function AddInstanceSheet({ isDark, onCreated, onProgress }, ref) {
  const insets = useSafeAreaInsets();
  const [isCreating, setIsCreating] = React.useState(false);
  const [progress, setProgress] = React.useState<{ percent: number; message: string } | null>(null);

  const { data: providers } = useProviders();
  const createLocalMutation = useCreateLocalInstance();

  const hasLocalDocker = Array.isArray(providers) && providers.includes('local_docker');

  const snapPoints = React.useMemo(() => {
    if (isCreating && progress) return [300];
    return [260];
  }, [isCreating, progress]);

  const renderBackdrop = React.useCallback(
    (props: BottomSheetBackdropProps) => (
      <BottomSheetBackdrop {...props} appearsOnIndex={0} disappearsOnIndex={-1} opacity={0.35} />
    ),
    [],
  );

  const resetState = React.useCallback(() => {
    setIsCreating(false);
    setProgress(null);
  }, []);

  const handleLocalDocker = React.useCallback(() => {
    haptics.medium();
    setIsCreating(true);
    const initial = { percent: 0, message: 'Initializing...' };
    setProgress(initial);
    onProgress(initial);
    createLocalMutation.mutate(
      {
        onProgress: (p) => {
          const update = { percent: p.progress, message: p.message };
          setProgress(update);
          onProgress(update);
        },
      },
      {
        onSuccess: () => {
          setIsCreating(false);
          setProgress(null);
          onProgress(null);
          haptics.success();
          onCreated();
          resetState();
        },
        onError: (err: any) => {
          setIsCreating(false);
          setProgress(null);
          onProgress(null);
          haptics.warning();
          Alert.alert('Error', err?.message || 'Failed to create local instance');
        },
      },
    );
  }, [createLocalMutation, onCreated, onProgress, resetState]);

  return (
    <BottomSheetModal
      ref={ref}
      index={0}
      snapPoints={snapPoints}
      enablePanDownToClose={!isCreating}
      backdropComponent={renderBackdrop}
      onDismiss={resetState}
      handleIndicatorStyle={{
        backgroundColor: isDark ? '#3F3F46' : '#D4D4D8',
        width: 36, height: 5, borderRadius: 3,
      }}
      backgroundStyle={{
        backgroundColor: getSheetBg(isDark),
        borderTopLeftRadius: 24, borderTopRightRadius: 24,
      }}
    >
      <BottomSheetView style={{ paddingHorizontal: 20, paddingTop: 4, paddingBottom: Math.max(insets.bottom, 20) + 16 }}>
        {isCreating && progress ? (
          <View className="px-1">
            <Text className="mb-2 text-[11px] font-roobert-medium uppercase tracking-wider text-muted-foreground/80">
              Creating Instance
            </Text>
            <View className="py-4">
              <View className="flex-row items-center mb-3">
                <Icon as={Monitor} size={18} className="text-foreground/80" strokeWidth={2.2} />
                <View className="ml-4 flex-1">
                  <Text className="font-roobert-medium text-[15px] text-foreground">Local Docker</Text>
                  <Text className="mt-0.5 font-roobert text-xs text-muted-foreground">{progress.message}</Text>
                </View>
                <Text className="font-roobert text-xs tabular-nums text-muted-foreground">
                  {Math.round(progress.percent)}%
                </Text>
              </View>
              <View
                className="h-1.5 rounded-full overflow-hidden"
                style={{ backgroundColor: isDark ? 'rgba(248,248,248,0.08)' : 'rgba(18,18,21,0.06)' }}
              >
                <View
                  className="h-full rounded-full"
                  style={{
                    width: `${Math.max(progress.percent, 2)}%`,
                    backgroundColor: isDark ? '#F8F8F8' : '#121215',
                  }}
                />
              </View>
            </View>
          </View>
        ) : (
          <View className="px-1">
            <Text className="mb-2 text-[11px] font-roobert-medium uppercase tracking-wider text-muted-foreground/80">
              New Instance
            </Text>
            <Text className="mb-3 font-roobert text-xs text-muted-foreground">
              Choose how to connect.
            </Text>

            <View>
              {hasLocalDocker ? (
                <>
                  <Pressable
                    onPress={handleLocalDocker}
                    disabled={isCreating}
                    className="py-3.5 active:opacity-85"
                  >
                    <View className="flex-row items-center">
                      <Icon as={Monitor} size={18} className="text-foreground/80" strokeWidth={2.2} />
                      <View className="ml-4 flex-1">
                        <Text className="font-roobert-medium text-[15px] text-foreground">Local Docker</Text>
                        <Text className="mt-0.5 font-roobert text-xs text-muted-foreground">Runs on your machine via Docker</Text>
                      </View>
                      {isCreating && createLocalMutation.isPending && <ActivityIndicator size="small" />}
                    </View>
                  </Pressable>
                </>
              ) : (
                <View className="py-5">
                  <Text className="font-roobert-medium text-[15px] text-foreground">No local provider available</Text>
                  <Text className="mt-1 font-roobert text-xs text-muted-foreground">
                    Local Docker is not available for this app configuration.
                  </Text>
                </View>
              )}
            </View>
          </View>
        )}
      </BottomSheetView>
    </BottomSheetModal>
  );
});
