/**
 * TunnelPage — full-screen tunnel connection management.
 * Create, list, manage, and delete tunnel connections.
 * Matches frontend /tunnel functionality.
 */

import React, { useState, useCallback, useMemo, useRef } from 'react';
import {
  View,
  FlatList,
  Pressable,
  Alert,
  ActivityIndicator,
  TouchableOpacity,
  RefreshControl,
} from 'react-native';
import { Text } from '@/components/ui/text';
import { Text as RNText } from 'react-native';
import {
  Plus,
  Trash2,
  Copy,
  Check,
  Shield,
  Cable,
  Wifi,
  WifiOff,
  Monitor,
  Terminal,
  HardDrive,
  ChevronRight,
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  RefreshCw,
} from 'lucide-react-native';
import { useColorScheme } from 'nativewind';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import * as Clipboard from 'expo-clipboard';
import {
  BottomSheetModal,
  BottomSheetView,
  BottomSheetBackdrop,
  BottomSheetScrollView,
} from '@gorhom/bottom-sheet';

import { useThemeColors } from '@/lib/theme-colors';
import type { PageTab } from '@/stores/tab-store';
import { PageHeader } from '@/components/ui/page-header';
import { PageContent } from '@/components/ui/page-content';
import {
  useTunnelConnections,
  useTunnelConnection,
  useDeleteTunnelConnection,
  useGrantTunnelPermission,
  useTunnelPermissions,
  useRevokeTunnelPermission,
  useTunnelAuditLogs,
  SCOPE_REGISTRY,
  formatRelativeTime,
  formatTunnelDate,
  type TunnelConnection,
  type ScopeInfo,
} from '@/hooks/useTunnel';
import { API_URL } from '@/api/config';

// ─── Tab Page Wrapper ────────────────────────────────────────────────────────

interface TunnelTabPageProps {
  page: PageTab;
  onBack: () => void;
  onOpenDrawer?: () => void;
  onOpenRightDrawer?: () => void;
  isDrawerOpen?: boolean;
  isRightDrawerOpen?: boolean;
}

export function TunnelTabPage({
  page,
  onBack,
  onOpenDrawer,
  onOpenRightDrawer,
}: TunnelTabPageProps) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const insets = useSafeAreaInsets();
  const fgColor = isDark ? '#F8F8F8' : '#121215';

  return (
    <View style={{ flex: 1, backgroundColor: isDark ? '#121215' : '#F8F8F8' }}>
      <PageHeader
        title={page.label}
        onOpenDrawer={onOpenDrawer}
        onOpenRightDrawer={onOpenRightDrawer}
        isDrawerOpen={isDrawerOpen}
        isRightDrawerOpen={isRightDrawerOpen}
        isDrawerOpen={isDrawerOpen}
        isRightDrawerOpen={isRightDrawerOpen}
      />
      <PageContent>
        <TunnelContent />
      </PageContent>
    </View>
  );
}

// ─── Scope helpers ──────────────────────────────────────────────────────────

function groupBy<T>(arr: T[], fn: (item: T) => string): Record<string, T[]> {
  const result: Record<string, T[]> = {};
  for (const item of arr) {
    const key = fn(item);
    (result[key] ||= []).push(item);
  }
  return result;
}

const SCOPE_GROUPS = groupBy(SCOPE_REGISTRY, (s) => s.category);

// ─── Main Content ───────────────────────────────────────────────────────────

function TunnelContent() {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const insets = useSafeAreaInsets();
  const theme = useThemeColors();

  const { data: connections = [], isLoading, refetch } = useTunnelConnections();
  const deleteMutation = useDeleteTunnelConnection();

  const [selectedTunnel, setSelectedTunnel] = useState<TunnelConnection | null>(null);

  const createSheetRef = useRef<BottomSheetModal>(null);
  const detailSheetRef = useRef<BottomSheetModal>(null);

  const fg = isDark ? '#f8f8f8' : '#121215';
  const muted = isDark ? 'rgba(248,248,248,0.5)' : 'rgba(18,18,21,0.5)';
  const subtleBg = isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.02)';
  const borderColor = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)';
  const cardBg = isDark ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.01)';
  const accent = theme.primary;
  const accentBg = theme.primaryLight;

  const renderBackdrop = useCallback(
    (props: any) => <BottomSheetBackdrop {...props} disappearsOnIndex={-1} appearsOnIndex={0} opacity={0.5} />,
    [],
  );

  const handleOpenCreate = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    createSheetRef.current?.present();
  }, []);

  const handleOpenDetail = useCallback((tunnel: TunnelConnection) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setSelectedTunnel(tunnel);
    requestAnimationFrame(() => {
      detailSheetRef.current?.present();
    });
  }, []);

  const handleDelete = useCallback((tunnel: TunnelConnection) => {
    Alert.alert(
      'Delete Connection',
      `Delete "${tunnel.name}"? This will remove all permissions and audit logs.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            try {
              await deleteMutation.mutateAsync(tunnel.tunnelId);
              Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
              detailSheetRef.current?.dismiss();
            } catch (err) {
              Alert.alert('Error', err instanceof Error ? err.message : 'Failed to delete');
            }
          },
        },
      ],
    );
  }, [deleteMutation]);

  const sorted = useMemo(() => {
    return [...connections].sort((a, b) => {
      const aOnline = a.isLive ?? a.status === 'online';
      const bOnline = b.isLive ?? b.status === 'online';
      if (aOnline && !bOnline) return -1;
      if (bOnline && !aOnline) return 1;
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });
  }, [connections]);

  if (isLoading) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
        <ActivityIndicator size="small" color={fg} />
      </View>
    );
  }

  return (
    <View style={{ flex: 1 }}>
      {/* Add Connection button */}
      {sorted.length > 0 && (
        <View style={{ flexDirection: 'row', justifyContent: 'flex-end', paddingHorizontal: 20, paddingBottom: 8 }}>
          <Pressable
            onPress={handleOpenCreate}
            style={{
              flexDirection: 'row', alignItems: 'center', gap: 6,
              paddingHorizontal: 12, paddingVertical: 8, borderRadius: 10,
              backgroundColor: theme.primary,
            }}
          >
            <Plus size={16} color={theme.primaryForeground} />
            <RNText style={{ fontSize: 13, fontFamily: 'Roobert-Medium', color: theme.primaryForeground }}>Add Connection</RNText>
          </Pressable>
        </View>
      )}
      <FlatList
        data={sorted}
        keyExtractor={(item) => item.tunnelId}
        contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: insets.bottom + 24 }}
        refreshControl={<RefreshControl refreshing={false} onRefresh={refetch} tintColor={fg} />}
        ListEmptyComponent={
          <View style={{ paddingVertical: 40, alignItems: 'center' }}>
            <View
              style={{
                width: 64,
                height: 64,
                borderRadius: 20,
                backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)',
                alignItems: 'center',
                justifyContent: 'center',
                marginBottom: 16,
              }}
            >
              <Cable size={28} color={muted} />
            </View>
            <RNText style={{ fontSize: 17, fontFamily: 'Roobert-Medium', color: fg, marginBottom: 6 }}>
              Connect your machine
            </RNText>
            <RNText style={{ fontSize: 13, fontFamily: 'Roobert', color: muted, textAlign: 'center', lineHeight: 20, paddingHorizontal: 20, marginBottom: 20 }}>
              Run this command on any machine to connect it to Kortix. You'll approve the connection in your browser.
            </RNText>
            <Pressable
              onPress={() => createSheetRef.current?.present()}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 8,
                paddingHorizontal: 20,
                paddingVertical: 12,
                borderRadius: 12,
                backgroundColor: theme.primary,
              }}
            >
              <Plus size={16} color={theme.primaryForeground} />
              <RNText style={{ fontSize: 14, fontFamily: 'Roobert-Medium', color: theme.primaryForeground }}>Add Connection</RNText>
            </Pressable>
          </View>
        }
        renderItem={({ item }) => (
          <Pressable
            onPress={() => handleOpenDetail(item)}
            style={{
              backgroundColor: cardBg,
              borderWidth: 1,
              borderColor,
              borderRadius: 16,
              padding: 16,
              marginBottom: 12,
            }}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 10 }}>
              <View
                style={{
                  width: 36,
                  height: 36,
                  borderRadius: 10,
                  backgroundColor: (item.isLive ?? item.status === 'online') ? accentBg : (isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)'),
                  alignItems: 'center',
                  justifyContent: 'center',
                  marginRight: 12,
                }}
              >
                <Monitor size={18} color={(item.isLive ?? item.status === 'online') ? accent : muted} />
              </View>
              <View style={{ flex: 1 }}>
                <RNText style={{ fontSize: 15, fontFamily: 'Roobert-SemiBold', color: fg }} numberOfLines={1}>
                  {item.name}
                </RNText>
                <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 2 }}>
                  <View
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: 3,
                      backgroundColor: (item.isLive ?? item.status === 'online') ? accent : muted,
                      marginRight: 6,
                    }}
                  />
                  <RNText style={{ fontSize: 12, fontFamily: 'Roobert', color: (item.isLive ?? item.status === 'online') ? accent : muted }}>
                    {(item.isLive ?? item.status === 'online') ? 'Online' : 'Offline'}
                  </RNText>
                </View>
              </View>
              <ChevronRight size={16} color={muted} />
            </View>

            {/* Machine info */}
            {item.machineInfo && (
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                {item.machineInfo.hostname && (
                  <View style={{ backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)', borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3 }}>
                    <RNText style={{ fontSize: 11, fontFamily: 'Roobert', color: muted }}>
                      {String(item.machineInfo.hostname)}
                    </RNText>
                  </View>
                )}
                {item.machineInfo.platform && (
                  <View style={{ backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)', borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3 }}>
                    <RNText style={{ fontSize: 11, fontFamily: 'Roobert', color: muted }}>
                      {String(item.machineInfo.platform)}
                    </RNText>
                  </View>
                )}
                {item.lastHeartbeatAt && (
                  <View style={{ backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)', borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3 }}>
                    <RNText style={{ fontSize: 11, fontFamily: 'Roobert', color: muted }}>
                      {formatRelativeTime(item.lastHeartbeatAt)}
                    </RNText>
                  </View>
                )}
              </View>
            )}
          </Pressable>
        )}
      />


      {/* Create Sheet */}
      <CreateTunnelSheet ref={createSheetRef} renderBackdrop={renderBackdrop} />

      {/* Detail Sheet */}
      <TunnelDetailSheet
        ref={detailSheetRef}
        tunnel={selectedTunnel}
        renderBackdrop={renderBackdrop}
        onDelete={handleDelete}
        onDismiss={() => setSelectedTunnel(null)}
      />
    </View>
  );
}

// ─── Create Tunnel Sheet ────────────────────────────────────────────────────

const CreateTunnelSheet = React.forwardRef<
  BottomSheetModal,
  { renderBackdrop: (props: any) => JSX.Element }
>(function CreateTunnelSheet({ renderBackdrop }, ref) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const insets = useSafeAreaInsets();
  const theme = useThemeColors();

  const fg = isDark ? '#f8f8f8' : '#121215';
  const muted = isDark ? 'rgba(248,248,248,0.5)' : 'rgba(18,18,21,0.5)';
  const borderColor = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)';
  const sheetBg = isDark ? '#161618' : '#FFFFFF';

  const [copied, setCopied] = useState(false);

  const apiUrl = `${API_URL}/tunnel`;
  const command = `npx @kortix/agent-tunnel connect --api-url ${apiUrl}`;

  const handleCopy = useCallback(async () => {
    await Clipboard.setStringAsync(command);
    setCopied(true);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    setTimeout(() => setCopied(false), 2500);
  }, [command]);

  return (
    <BottomSheetModal
      ref={ref}
      enableDynamicSizing
      enablePanDownToClose
      backdropComponent={renderBackdrop}
      onDismiss={() => setCopied(false)}
      backgroundStyle={{ backgroundColor: sheetBg, borderTopLeftRadius: 24, borderTopRightRadius: 24 }}
      handleIndicatorStyle={{ backgroundColor: isDark ? '#3F3F46' : '#D4D4D8', width: 36, height: 5, borderRadius: 3 }}
    >
      <BottomSheetView style={{ paddingHorizontal: 24, paddingTop: 8, paddingBottom: Math.max(insets.bottom, 20) + 16 }}>
        {/* Header */}
        <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 20 }}>
          <View style={{ width: 40, height: 40, borderRadius: 12, backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)', alignItems: 'center', justifyContent: 'center', marginRight: 12 }}>
            <Terminal size={20} color={fg} />
          </View>
          <View style={{ flex: 1 }}>
            <RNText style={{ fontSize: 18, fontFamily: 'Roobert-Semibold', color: fg }}>Connect a machine</RNText>
            <RNText style={{ fontSize: 12, fontFamily: 'Roobert', color: muted, marginTop: 2 }}>Run this command on the machine you want to connect.</RNText>
          </View>
        </View>

        {/* Command box */}
        <Pressable
          onPress={handleCopy}
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            backgroundColor: isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.03)',
            borderWidth: 1,
            borderColor,
            borderRadius: 12,
            padding: 14,
            marginBottom: 16,
            gap: 10,
          }}
        >
          <RNText style={{ flex: 1, fontSize: 11, fontFamily: 'monospace', color: isDark ? 'rgba(248,248,248,0.8)' : 'rgba(18,18,21,0.8)', lineHeight: 16 }} selectable>
            {command}
          </RNText>
          {copied ? (
            <Check size={16} color="#34d399" />
          ) : (
            <Copy size={16} color={muted} />
          )}
        </Pressable>

        {/* Steps */}
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 16, marginBottom: 20 }}>
          <RNText style={{ fontSize: 12, fontFamily: 'Roobert', color: muted }}>1. Run the command</RNText>
          <RNText style={{ fontSize: 12, color: isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)' }}>|</RNText>
          <RNText style={{ fontSize: 12, fontFamily: 'Roobert', color: muted }}>2. Approve in browser</RNText>
          <RNText style={{ fontSize: 12, color: isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)' }}>|</RNText>
          <RNText style={{ fontSize: 12, fontFamily: 'Roobert', color: muted }}>3. Connected</RNText>
        </View>

        {/* Copy button */}
        <Pressable
          onPress={handleCopy}
          style={{
            alignItems: 'center',
            justifyContent: 'center',
            flexDirection: 'row',
            paddingVertical: 14,
            borderRadius: 14,
            backgroundColor: theme.primary,
            gap: 8,
          }}
        >
          {copied ? (
            <>
              <Check size={16} color={theme.primaryForeground} />
              <RNText style={{ fontSize: 16, fontFamily: 'Roobert-Medium', color: theme.primaryForeground }}>Copied!</RNText>
            </>
          ) : (
            <>
              <Copy size={16} color={theme.primaryForeground} />
              <RNText style={{ fontSize: 16, fontFamily: 'Roobert-Medium', color: theme.primaryForeground }}>Copy Command</RNText>
            </>
          )}
        </Pressable>
      </BottomSheetView>
    </BottomSheetModal>
  );
});

// ─── Tunnel Detail Sheet ────────────────────────────────────────────────────

type DetailTab = 'permissions' | 'audit' | 'connection';

interface TunnelDetailSheetProps {
  tunnel: TunnelConnection | null;
  renderBackdrop: (props: any) => JSX.Element;
  onDelete: (tunnel: TunnelConnection) => void;
  onDismiss: () => void;
}

const TunnelDetailSheet = React.forwardRef<BottomSheetModal, TunnelDetailSheetProps>(
  function TunnelDetailSheet({ tunnel, renderBackdrop, onDelete, onDismiss }, ref) {
    const { colorScheme } = useColorScheme();
    const isDark = colorScheme === 'dark';
    const insets = useSafeAreaInsets();
    const theme = useThemeColors();

    const fg = isDark ? '#f8f8f8' : '#121215';
    const muted = isDark ? 'rgba(248,248,248,0.5)' : 'rgba(18,18,21,0.5)';
    const borderColor = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)';
    const sheetBg = isDark ? '#161618' : '#FFFFFF';
    const accent = theme.primary;
    const accentBg = theme.primaryLight;
    const dangerBg = isDark ? 'rgba(239,68,68,0.08)' : 'rgba(239,68,68,0.05)';
    const dangerBorder = isDark ? 'rgba(239,68,68,0.2)' : 'rgba(239,68,68,0.15)';
    const tabActiveBg = isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.06)';
    const tabBg = isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.03)';
    const rowBg = isDark ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.02)';

    const [activeTab, setActiveTab] = useState<DetailTab>('permissions');
    const [copiedId, setCopiedId] = useState(false);

    const { data: liveData } = useTunnelConnection(tunnel?.tunnelId ?? '');
    const conn = liveData || tunnel;

    const { data: permissions = [] } = useTunnelPermissions(conn?.tunnelId ?? '');
    const grantMutation = useGrantTunnelPermission();
    const revokeMutation = useRevokeTunnelPermission();

    const [auditPage, setAuditPage] = useState(1);
    const { data: auditData } = useTunnelAuditLogs(conn?.tunnelId ?? '', auditPage, 20);

    const activeScopeMap = useMemo(() => {
      const map = new Map<string, string>();
      for (const p of permissions) {
        if (p.status !== 'active') continue;
        const scopeKey = (p.scope as Record<string, unknown>)?.scope as string | undefined;
        if (scopeKey) map.set(scopeKey, p.permissionId);
      }
      return map;
    }, [permissions]);

    const handleToggleScope = useCallback(async (scope: ScopeInfo) => {
      if (!conn) return;
      const permissionId = activeScopeMap.get(scope.key);
      if (permissionId) {
        await revokeMutation.mutateAsync({ tunnelId: conn.tunnelId, permissionId });
      } else {
        await grantMutation.mutateAsync({
          tunnelId: conn.tunnelId,
          capability: scope.capability,
          scope: { scope: scope.key },
        });
      }
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }, [conn, activeScopeMap, grantMutation, revokeMutation]);

    const handleCopyId = useCallback(async () => {
      if (!conn) return;
      await Clipboard.setStringAsync(conn.tunnelId);
      setCopiedId(true);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setTimeout(() => setCopiedId(false), 2000);
    }, [conn]);

    if (!conn) return null;

    const isOnline = conn.isLive ?? conn.status === 'online';
    const machineInfo = conn.machineInfo as Record<string, string> | undefined;

    const TABS: { key: DetailTab; label: string; icon: typeof Shield }[] = [
      { key: 'permissions', label: 'Permissions', icon: Shield },
      { key: 'audit', label: 'Audit Log', icon: Terminal },
      { key: 'connection', label: 'Connection', icon: Monitor },
    ];

    return (
      <BottomSheetModal
        ref={ref}
        snapPoints={['85%']}
        enablePanDownToClose
        backdropComponent={renderBackdrop}
        onDismiss={() => { setActiveTab('permissions'); setAuditPage(1); onDismiss(); }}
        backgroundStyle={{ backgroundColor: sheetBg, borderTopLeftRadius: 24, borderTopRightRadius: 24 }}
        handleIndicatorStyle={{ backgroundColor: isDark ? '#3F3F46' : '#D4D4D8', width: 36, height: 5, borderRadius: 3 }}
      >
        <View style={{ paddingHorizontal: 24, paddingTop: 4 }}>
          {/* Header */}
          <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 16 }}>
            <View
              style={{
                width: 44, height: 44, borderRadius: 14, marginRight: 14,
                backgroundColor: isOnline ? accentBg : (isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)'),
                borderWidth: 1, borderColor: isOnline ? accent + '30' : borderColor,
                alignItems: 'center', justifyContent: 'center',
              }}
            >
              <Monitor size={22} color={isOnline ? accent : muted} />
            </View>
            <View style={{ flex: 1 }}>
              <RNText style={{ fontSize: 17, fontFamily: 'Roobert-SemiBold', color: fg }}>{conn.name}</RNText>
              <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 3 }}>
                {isOnline ? <Wifi size={12} color={accent} /> : <WifiOff size={12} color={muted} />}
                <RNText style={{ fontSize: 12, fontFamily: 'Roobert', color: isOnline ? accent : muted, marginLeft: 4 }}>
                  {isOnline ? 'Online' : 'Offline'}
                </RNText>
                {machineInfo?.hostname && (
                  <RNText style={{ fontSize: 12, fontFamily: 'Roobert', color: muted }}> · {machineInfo.hostname}</RNText>
                )}
              </View>
            </View>
            {/* Online badge */}
            <View style={{
              flexDirection: 'row', alignItems: 'center', gap: 5,
              paddingHorizontal: 10, paddingVertical: 5, borderRadius: 8,
              borderWidth: 1,
              backgroundColor: isOnline ? accentBg : (isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.02)'),
              borderColor: isOnline ? accent + '40' : borderColor,
            }}>
              <View style={{ width: 5, height: 5, borderRadius: 3, backgroundColor: isOnline ? accent : muted }} />
              <RNText style={{ fontSize: 11, fontFamily: 'Roobert-Medium', color: isOnline ? accent : muted }}>
                {isOnline ? 'Online' : 'Offline'}
              </RNText>
            </View>
          </View>

          {/* Tab bar */}
          <View style={{
            flexDirection: 'row', backgroundColor: tabBg,
            borderRadius: 10, padding: 3, marginBottom: 16,
          }}>
            {TABS.map(({ key, label, icon: TabIcon }) => {
              const active = activeTab === key;
              return (
                <Pressable
                  key={key}
                  onPress={() => { setActiveTab(key); Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); }}
                  style={{
                    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5,
                    paddingVertical: 8, borderRadius: 8,
                    backgroundColor: active ? tabActiveBg : 'transparent',
                  }}
                >
                  <TabIcon size={13} color={active ? fg : muted} />
                  <RNText style={{ fontSize: 12, fontFamily: active ? 'Roobert-Medium' : 'Roobert', color: active ? fg : muted }}>
                    {label}
                  </RNText>
                </Pressable>
              );
            })}
          </View>
        </View>

        <BottomSheetScrollView contentContainerStyle={{ paddingHorizontal: 24, paddingBottom: Math.max(insets.bottom, 20) + 16 }}>

          {/* ─── Permissions Tab ──────────────────────────────────── */}
          {activeTab === 'permissions' && (
            <View>
              {Object.entries(SCOPE_GROUPS).map(([category, scopes]) => (
                <View key={category} style={{ marginBottom: 16 }}>
                  <RNText style={{ fontSize: 11, fontFamily: 'Roobert-SemiBold', color: muted, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8 }}>
                    {category}
                  </RNText>
                  {scopes.map((scope) => {
                    const isActive = activeScopeMap.has(scope.key);
                    const isPending = grantMutation.isPending || revokeMutation.isPending;
                    return (
                      <Pressable
                        key={scope.key}
                        onPress={() => handleToggleScope(scope)}
                        disabled={isPending}
                        style={{
                          flexDirection: 'row', alignItems: 'center',
                          paddingVertical: 12, paddingHorizontal: 14, borderRadius: 12, marginBottom: 4,
                          backgroundColor: isActive ? accentBg : rowBg,
                          borderWidth: 1,
                          borderColor: isActive ? accent + '25' : borderColor,
                          opacity: isPending ? 0.5 : 1,
                        }}
                      >
                        {/* Toggle circle */}
                        <View style={{
                          width: 22, height: 22, borderRadius: 11, marginRight: 12,
                          backgroundColor: isActive ? accent : 'transparent',
                          borderWidth: 2,
                          borderColor: isActive ? accent : (isDark ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.15)'),
                          alignItems: 'center', justifyContent: 'center',
                        }}>
                          {isActive && <Check size={12} color={theme.primaryForeground} />}
                        </View>
                        <View style={{ flex: 1 }}>
                          <RNText style={{ fontSize: 13, fontFamily: 'monospace', color: fg }}>{scope.key}</RNText>
                          <RNText style={{ fontSize: 11, fontFamily: 'Roobert', color: muted, marginTop: 1 }}>{scope.description}</RNText>
                        </View>
                        {isActive && (
                          <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: accent }} />
                        )}
                      </Pressable>
                    );
                  })}
                </View>
              ))}

              {/* Delete in permissions tab */}
              <View style={{ backgroundColor: dangerBg, borderWidth: 1, borderColor: dangerBorder, borderRadius: 14, padding: 14, marginTop: 8 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 10 }}>
                  <AlertTriangle size={14} color="#ef4444" style={{ marginRight: 8 }} />
                  <RNText style={{ fontSize: 13, fontFamily: 'Roobert-SemiBold', color: '#ef4444' }}>Danger Zone</RNText>
                </View>
                <Pressable
                  onPress={() => onDelete(conn)}
                  style={{
                    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
                    paddingVertical: 10, borderRadius: 10,
                    backgroundColor: isDark ? 'rgba(239,68,68,0.15)' : 'rgba(239,68,68,0.1)',
                  }}
                >
                  <Trash2 size={14} color="#ef4444" style={{ marginRight: 6 }} />
                  <RNText style={{ fontSize: 14, fontFamily: 'Roobert-Medium', color: '#ef4444' }}>Delete Connection</RNText>
                </Pressable>
              </View>
            </View>
          )}

          {/* ─── Audit Log Tab ────────────────────────────────────── */}
          {activeTab === 'audit' && (
            <View>
              {!auditData || auditData.data.length === 0 ? (
                <RNText style={{ fontSize: 13, fontFamily: 'Roobert', color: muted, textAlign: 'center', paddingVertical: 24 }}>
                  No audit logs yet.
                </RNText>
              ) : (
                <>
                  {auditData.data.map((log) => (
                    <View
                      key={log.logId}
                      style={{
                        flexDirection: 'row', alignItems: 'center', gap: 10,
                        paddingVertical: 10, paddingHorizontal: 12, borderRadius: 10, marginBottom: 4,
                        borderWidth: 1,
                        borderColor: log.success ? borderColor : (isDark ? 'rgba(239,68,68,0.2)' : 'rgba(239,68,68,0.15)'),
                        backgroundColor: log.success ? rowBg : dangerBg,
                      }}
                    >
                      {log.success ? (
                        <Check size={14} color={accent} />
                      ) : (
                        <AlertTriangle size={14} color="#ef4444" />
                      )}
                      <View style={{ flex: 1 }}>
                        <RNText style={{ fontSize: 12, fontFamily: 'monospace', color: fg }} numberOfLines={1}>{log.operation}</RNText>
                        {log.durationMs != null && (
                          <RNText style={{ fontSize: 11, fontFamily: 'Roobert', color: muted, marginTop: 2 }}>{log.durationMs}ms</RNText>
                        )}
                      </View>
                      <View style={{ backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)', borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2 }}>
                        <RNText style={{ fontSize: 10, fontFamily: 'Roobert-Medium', color: muted }}>{log.capability}</RNText>
                      </View>
                      <RNText style={{ fontSize: 10, fontFamily: 'Roobert', color: muted }}>
                        {new Date(log.createdAt).toLocaleTimeString()}
                      </RNText>
                    </View>
                  ))}
                  {/* Pagination */}
                  {auditData.pagination.totalPages > 1 && (
                    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 12 }}>
                      <RNText style={{ fontSize: 11, fontFamily: 'Roobert', color: muted }}>
                        Page {auditData.pagination.page} of {auditData.pagination.totalPages}
                      </RNText>
                      <View style={{ flexDirection: 'row', gap: 8 }}>
                        <Pressable
                          onPress={() => setAuditPage((p) => Math.max(1, p - 1))}
                          disabled={auditPage <= 1}
                          style={{ paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8, borderWidth: 1, borderColor, opacity: auditPage <= 1 ? 0.3 : 1 }}
                        >
                          <RNText style={{ fontSize: 12, fontFamily: 'Roobert-Medium', color: fg }}>Prev</RNText>
                        </Pressable>
                        <Pressable
                          onPress={() => setAuditPage((p) => Math.min(auditData.pagination.totalPages, p + 1))}
                          disabled={auditPage >= auditData.pagination.totalPages}
                          style={{ paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8, borderWidth: 1, borderColor, opacity: auditPage >= auditData.pagination.totalPages ? 0.3 : 1 }}
                        >
                          <RNText style={{ fontSize: 12, fontFamily: 'Roobert-Medium', color: fg }}>Next</RNText>
                        </Pressable>
                      </View>
                    </View>
                  )}
                </>
              )}
            </View>
          )}

          {/* ─── Connection Tab ────────────────────────────────────── */}
          {activeTab === 'connection' && (() => {
            const rows: { label: string; value: string; mono?: boolean; copyable?: boolean; status?: boolean; caps?: boolean }[] = [
              { label: 'Tunnel ID', value: conn.tunnelId, mono: true, copyable: true },
              { label: 'Status', value: isOnline ? 'Online' : 'Offline', status: true },
              { label: 'Hostname', value: machineInfo?.hostname || 'Unknown' },
              { label: 'Platform', value: machineInfo?.platform ? `${machineInfo.platform} ${machineInfo.arch || ''}`.trim() : 'Unknown' },
              { label: 'OS Version', value: machineInfo?.osVersion || 'Unknown' },
              { label: 'Agent Version', value: machineInfo?.agentVersion || 'Unknown' },
              { label: 'Capabilities', value: conn.capabilities?.join(', ') || 'None', caps: true },
              { label: 'Created', value: new Date(conn.createdAt).toLocaleString() },
              ...(conn.lastHeartbeatAt ? [{ label: 'Last Heartbeat', value: new Date(conn.lastHeartbeatAt).toLocaleString() }] : []),
            ];

            return (
              <View style={{
                borderRadius: 16, overflow: 'hidden',
                borderWidth: 1, borderColor,
                backgroundColor: isDark ? '#1a1a1c' : '#FFFFFF',
              }}>
                {rows.map((row, i) => (
                  <View key={row.label}>
                    {i > 0 && (
                      <View style={{ height: 1, backgroundColor: borderColor, marginLeft: 16 }} />
                    )}
                    <View
                      style={{
                        flexDirection: 'row', alignItems: 'center',
                        paddingVertical: 14, paddingHorizontal: 16,
                        minHeight: 48,
                      }}
                    >
                      <RNText style={{ fontSize: 14, fontFamily: 'Roobert', color: fg, width: 120 }}>
                        {row.label}
                      </RNText>
                      <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 8 }}>
                        {row.status ? (
                          <View style={{
                            flexDirection: 'row', alignItems: 'center', gap: 6,
                            paddingHorizontal: 10, paddingVertical: 4, borderRadius: 8,
                            backgroundColor: isOnline ? accentBg : (isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.02)'),
                          }}>
                            {isOnline ? <Wifi size={12} color={accent} /> : <WifiOff size={12} color={muted} />}
                            <RNText style={{ fontSize: 13, fontFamily: 'Roobert-SemiBold', color: isOnline ? accent : muted }}>
                              {row.value}
                            </RNText>
                          </View>
                        ) : row.caps ? (
                          <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 6 }}>
                            {conn.capabilities.length > 0 ? conn.capabilities.map((cap) => (
                              <View key={cap} style={{
                                backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.05)',
                                borderRadius: 8, paddingHorizontal: 10, paddingVertical: 4,
                              }}>
                                <RNText style={{ fontSize: 12, fontFamily: 'Roobert-Medium', color: fg }}>{cap}</RNText>
                              </View>
                            )) : (
                              <RNText style={{ fontSize: 14, fontFamily: 'Roobert', color: muted }}>None</RNText>
                            )}
                          </View>
                        ) : (
                          <RNText
                            style={{
                              fontSize: 14,
                              fontFamily: row.mono ? 'monospace' : 'Roobert-SemiBold',
                              color: fg,
                              flexShrink: 1,
                            }}
                            numberOfLines={1}
                          >
                            {row.value}
                          </RNText>
                        )}
                        {row.copyable && (
                          <Pressable
                            onPress={handleCopyId}
                            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                            style={{
                              width: 30, height: 30, borderRadius: 8,
                              alignItems: 'center', justifyContent: 'center',
                              backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)',
                            }}
                          >
                            {copiedId ? <Check size={14} color={accent} /> : <Copy size={14} color={muted} />}
                          </Pressable>
                        )}
                      </View>
                    </View>
                  </View>
                ))}
              </View>
            );
          })()}
        </BottomSheetScrollView>
      </BottomSheetModal>
    );
  },
);
