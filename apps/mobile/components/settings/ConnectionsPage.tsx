/**
 * ConnectionsPage — Pipedream connections management.
 * Lists connected accounts, searchable app catalog, OAuth connect flow.
 */

import React, { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import {
  View,
  FlatList,
  Pressable,
  Alert,
  ActivityIndicator,
  AppState,
  StyleSheet,
} from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { SearchListHeader } from '@/components/kortix/search-list-header';
import {
  ArrowLeft,
  Search,
  X,
  ChevronRight,
  Check,
  Plug,
  Globe,
  Zap,
  Settings,
  KeyRound,
  Eye,
  EyeOff,
  Trash2,
  Shield,
} from 'lucide-react-native';
import { useColorScheme } from 'nativewind';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useQueryClient } from '@tanstack/react-query';
import * as WebBrowser from 'expo-web-browser';
import { haptics } from '@/lib/haptics';
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';

import { SettingsHeader } from './SettingsHeader';
import { AppIcon } from './connections/AppIcon';
import { ManageConnectionSheet } from './connections/ManageConnectionSheet';
import { AnimatedPageWrapper } from '@/components/shared/AnimatedPageWrapper';
import { useLanguage } from '@/contexts';
import { useRouter } from 'expo-router';
import { useThemeColors } from '@/lib/theme-colors';
import { log } from '@/lib/logger';
import {
  usePipedreamCredentialStatus,
  useSavePipedreamCredentials,
  useDeletePipedreamCredentials,
} from '@/hooks/usePipedreamCredentials';
import { BottomSheetModal, BottomSheetView, BottomSheetTextInput } from '@gorhom/bottom-sheet';

import { useSheetBottomPadding } from '@/hooks/useSheetKeyboard';
import {
  useConnectorApps,
  useConnectorConnections,
  useCreateConnectToken,
  syncConnections,
  connectionKeys,
  type ConnectorApp,
  type ConnectorConnection,
} from '@/hooks/useConnections';
import { SheetBackdrop, sheetHandleIndicatorStyle, useSheetBackground } from '@/components/kortix/sheet';
import { THEME, withAlpha } from '@/lib/utils/theme';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);


// ─── Main Page (wrapper) ────────────────────────────────────────────────────

interface ConnectionsPageProps {
  visible: boolean;
  onClose: () => void;
}

export function ConnectionsPage({ visible, onClose }: ConnectionsPageProps) {
  const { t } = useLanguage();
  const router = useRouter();

  const handleClose = useCallback(() => {
    haptics.tap();
    onClose();
  }, [onClose]);

  const handleUpgradePress = useCallback(() => {
    onClose();
    setTimeout(() => router.push('/plans'), 100);
  }, [onClose, router]);

  if (!visible) return null;

  return (
    <View className="absolute inset-0 z-50">
      <Pressable onPress={handleClose} className="absolute inset-0 bg-black/50" />
      <View className="absolute bottom-0 left-0 right-0 top-0 bg-background">
        <SettingsHeader title={t('connections.title', 'Connections')} onClose={handleClose} />
        <ConnectionsContent onUpgradePress={handleUpgradePress} />
      </View>
    </View>
  );
}

// Also export the content for standalone use
export { ConnectionsContent as ConnectionsPageContent };

// Legacy export for backward compat (AgentDrawer imports it)
export const AppBubble = React.memo(() => null);

// ─── Content ────────────────────────────────────────────────────────────────

interface ConnectionsContentProps {
  onBack?: () => void;
  noPadding?: boolean;
  onFullScreenChange?: (isFullScreen: boolean) => void;
  onNavigate?: (view: string) => void;
  onUpgradePress?: () => void;
}

function ConnectionsContent({
  onBack,
  noPadding,
  onFullScreenChange,
  onNavigate,
  onUpgradePress,
}: ConnectionsContentProps) {
  const sheetBg = useSheetBackground();
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const insets = useSafeAreaInsets();
  const sheetPadding = useSheetBottomPadding();
  const queryClient = useQueryClient();
  const { t } = useLanguage();
  const themeColors = useThemeColors();

  // ── State ──
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [connectingApp, setConnectingApp] = useState<string | null>(null);
  const [managingConnection, setManagingConnection] = useState<ConnectorConnection | null>(null);

  // ── Pipedream credentials ──
  const { data: credStatus } = usePipedreamCredentialStatus();
  const saveCreds = useSavePipedreamCredentials();
  const deleteCreds = useDeletePipedreamCredentials();
  const credSheetRef = useRef<BottomSheetModal>(null);
  const [credValues, setCredValues] = useState({ client_id: '', client_secret: '', project_id: '' });
  const [showSecrets, setShowSecrets] = useState(false);
  const isCustomCreds = credStatus?.configured && credStatus?.source === 'account';
  const canSaveCreds = credValues.client_id.trim() && credValues.client_secret.trim() && credValues.project_id.trim();


  const handleSaveCreds = useCallback(async () => {
    if (!canSaveCreds) return;
    haptics.tap();
    try {
      await saveCreds.mutateAsync({
        client_id: credValues.client_id.trim(),
        client_secret: credValues.client_secret.trim(),
        project_id: credValues.project_id.trim(),
        environment: 'production',
      });
      haptics.success();
      setCredValues({ client_id: '', client_secret: '', project_id: '' });
      credSheetRef.current?.dismiss();
    } catch {
      haptics.warning();
    }
  }, [canSaveCreds, credValues, saveCreds]);

  const handleDeleteCreds = useCallback(async () => {
    // Acknowledge the destructive tap (revert to defaults) before the network
    // round-trip.
    haptics.medium();
    try {
      await deleteCreds.mutateAsync();
      haptics.success();
      setCredValues({ client_id: '', client_secret: '', project_id: '' });
      credSheetRef.current?.dismiss();
    } catch {
      haptics.warning();
    }
  }, [deleteCreds]);

  // Debounce search
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(searchQuery), 300);
    return () => clearTimeout(t);
  }, [searchQuery]);

  // ── Data ──
  const {
    data: appsData,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    isLoading: appsLoading,
    isError: appsError,
  } = useConnectorApps(debouncedQuery || undefined);

  const {
    data: connections,
    isLoading: connectionsLoading,
  } = useConnectorConnections();

  const createToken = useCreateConnectToken();

  // Flatten paginated apps
  const apps = useMemo(
    () => appsData?.pages.flatMap((p) => p.apps) ?? [],
    [appsData],
  );

  // Map of app slug → connections
  const connectionsByApp = useMemo(() => {
    const map = new Map<string, ConnectorConnection[]>();
    for (const c of connections ?? []) {
      const existing = map.get(c.app) ?? [];
      existing.push(c);
      map.set(c.app, existing);
    }
    return map;
  }, [connections]);

  // Map of app slug → imgSrc for icon lookup
  const appImgMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const a of apps) {
      if (a.imgSrc) map.set(a.slug, a.imgSrc);
    }
    return map;
  }, [apps]);

  // ── Refetch connections when app comes to foreground (after OAuth) ──
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        queryClient.invalidateQueries({ queryKey: connectionKeys.connections() });
      }
    });
    return () => sub.remove();
  }, [queryClient]);

  // ── Connect flow ──
  const handleConnect = useCallback(
    async (app: ConnectorApp) => {
      haptics.tap();
      setConnectingApp(app.slug);
      try {
        // Use app deep link scheme so Safari auto-dismisses after OAuth
        const successUri = 'kortix://connections/success';
        const errorUri = 'kortix://connections/error';

        const result = await createToken.mutateAsync({
          app: app.slug,
          successRedirectUri: successUri,
          errorRedirectUri: errorUri,
        });
        let url = result.connectUrl;
        if (!url) throw new Error('No connect URL returned');

        // Pipedream connect link needs the app slug as a query param
        const separator = url.includes('?') ? '&' : '?';
        url = `${url}${separator}app=${encodeURIComponent(app.slug)}`;

        // openAuthSessionAsync auto-dismisses when redirected to our app scheme
        const authResult = await WebBrowser.openAuthSessionAsync(url, 'kortix://connections');

        if (authResult.type === 'success') {
          const returnUrl = authResult.url;
          if (returnUrl.includes('error')) {
            haptics.warning();
            Alert.alert('Connection Failed', `Could not connect ${app.name}. Please try again.`);
            return;
          }
          haptics.success();
        }

        // Sync connections from Pipedream — discovers newly connected accounts
        try {
          await syncConnections();
        } catch (e) {
          log.error('[Connections] Sync failed:', e);
        }
        queryClient.invalidateQueries({ queryKey: connectionKeys.connections() });
      } catch (err: any) {
        haptics.warning();
        log.error('[Connections] Connect failed:', err?.message);
        Alert.alert('Connection Failed', `Could not connect ${app.name}. Please try again.`);
      } finally {
        setConnectingApp(null);
      }
    },
    [createToken, queryClient],
  );

  // ── Colors ──
  // fg/muted mirror the app-wide "old near-black-on-white / near-white-on-black"
  // literal pair — same derivation as lib/theme-colors.ts's `theme.primary`
  // (light -> THEME.light.primary, dark -> THEME.dark.foreground, NOT
  // THEME.dark.primary, which would visibly dim this text/icon in dark mode).
  const fg = themeColors.primary;
  const muted = withAlpha(themeColors.primary, 0.5);
  const hoverBg = isDark ? THEME.dark.hover : THEME.light.hover;
  const activeBg = isDark ? THEME.dark.active : THEME.light.active;
  const destructiveColor = isDark ? THEME.dark.destructive : THEME.light.destructive;

  // ── Sticky search bar (rendered outside FlatList) ──
  const SearchBar = (
    <SearchListHeader
      value={searchQuery}
      onChangeText={setSearchQuery}
      placeholder="Search 1000+ apps..."
      rightAction={(
        <Pressable
          onPress={() => {
            haptics.medium();
            credSheetRef.current?.present();
          }}
          style={{
            width: 42,
            height: 42,
            borderRadius: 9999,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: hoverBg,
            borderWidth: 1,
            borderColor: activeBg,
          }}
        >
          <Icon as={Settings} size={16} color={muted} />
          {isCustomCreds && (
            <View
              style={{
                position: 'absolute',
                top: -2,
                right: -2,
                width: 10,
                height: 10,
                borderRadius: 5,
                backgroundColor: THEME.accent.green,
                borderWidth: 2,
                borderColor: isDark ? THEME.dark.background : THEME.light.background,
              }}
            />
          )}
        </Pressable>
      )}
    />
  );

  // ── List header (connected accounts + section label) ──
  const ListHeader = () => (
    <View style={{ paddingHorizontal: 20 }}>
      {/* Back button + title when embedded (e.g. AgentDrawer) */}
      {onBack && (
        <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 16 }}>
          <Pressable onPress={onBack} style={{ marginRight: 12 }}>
            <Icon as={ArrowLeft} size={20} color={fg} />
          </Pressable>
          <Text style={{ fontSize: 20, fontFamily: 'Roobert-Semibold', color: fg }}>
            {t('connections.title', 'Connections')}
          </Text>
        </View>
      )}

      {/* Connected accounts */}
      {(connections?.length ?? 0) > 0 && (
        <View style={{ marginBottom: 20 }}>
          <Text
            style={{
              fontSize: 12,
              fontFamily: 'Roobert-Medium',
              color: muted,
              textTransform: 'uppercase',
              letterSpacing: 1,
              marginBottom: 10,
            }}
          >
            Connected
          </Text>
          {connections!.map((conn) => (
            <ConnectedRow
              key={conn.connectionId}
              connection={conn}
              imgSrc={appImgMap.get(conn.app)}
              isDark={isDark}
              onPress={() => {
                haptics.medium();
                setManagingConnection(conn);
              }}
            />
          ))}
        </View>
      )}

      {/* Available apps header */}
      <Text
        style={{
          fontSize: 12,
          fontFamily: 'Roobert-Medium',
          color: muted,
          textTransform: 'uppercase',
          letterSpacing: 1,
          marginBottom: 8,
        }}
      >
        Available Apps
      </Text>
    </View>
  );

  // ── List footer (loading) ──
  const ListFooter = () => (
    <View style={{ paddingHorizontal: 20, paddingBottom: insets.bottom + 40 }}>
      {isFetchingNextPage && (
        <ActivityIndicator style={{ marginVertical: 16 }} color={muted} />
      )}
    </View>
  );

  return (
    <>
      {SearchBar}
      <FlatList
        data={apps}
        keyExtractor={(item) => item.slug}
        ListHeaderComponent={ListHeader}
        ListFooterComponent={ListFooter}
        renderItem={({ item }) => (
          <AppRow
            app={item}
            connections={connectionsByApp.get(item.slug)}
            isConnecting={connectingApp === item.slug}
            isDark={isDark}
            onConnect={() => handleConnect(item)}
            onManage={(conn) => {
              haptics.medium();
              setManagingConnection(conn);
            }}
          />
        )}
        onEndReached={() => {
          if (hasNextPage && !isFetchingNextPage) fetchNextPage();
        }}
        onEndReachedThreshold={0.5}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingTop: 8 }}
        ListEmptyComponent={
          appsLoading ? (
            <View style={{ padding: 40, alignItems: 'center' }}>
              <ActivityIndicator color={muted} />
            </View>
          ) : appsError ? (
            <View style={{ padding: 40, alignItems: 'center' }}>
              <Text style={{ color: destructiveColor, fontSize: 14, fontFamily: 'Roobert', textAlign: 'center' }}>
                Failed to load apps. Check that Pipedream credentials are configured.
              </Text>
            </View>
          ) : (
            <View style={{ padding: 40, alignItems: 'center' }}>
              <Text style={{ color: muted, fontSize: 14, fontFamily: 'Roobert' }}>
                No apps found
              </Text>
            </View>
          )
        }
      />

      {/* Manage connection sheet */}
      <ManageConnectionSheet
        connection={managingConnection}
        appImgSrc={managingConnection ? appImgMap.get(managingConnection.app) : undefined}
        onDismiss={() => setManagingConnection(null)}
      />

      {/* Pipedream Credentials Sheet */}
      <BottomSheetModal
        ref={credSheetRef}
        enableDynamicSizing
        enablePanDownToClose
        backdropComponent={SheetBackdrop}
        keyboardBehavior="interactive"
        keyboardBlurBehavior="restore"
        android_keyboardInputMode="adjustResize"
        onDismiss={() => { setCredValues({ client_id: '', client_secret: '', project_id: '' }); setShowSecrets(false); }}
        backgroundStyle={{
          backgroundColor: sheetBg,
          borderTopLeftRadius: 24,
          borderTopRightRadius: 24,
        }}
        handleIndicatorStyle={sheetHandleIndicatorStyle(isDark)}
      >
        <BottomSheetView style={{ paddingHorizontal: 24, paddingTop: 8, paddingBottom: sheetPadding }}>
          {/* Header */}
          <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 16 }}>
            <View
              style={{
                width: 40, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center', marginRight: 12,
                backgroundColor: hoverBg,
              }}
            >
              <Icon as={KeyRound} size={20} color={fg} strokeWidth={1.8} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 18, fontFamily: 'Roobert-SemiBold', color: fg }}>Pipedream Credentials</Text>
              <Text style={{ fontSize: 12, fontFamily: 'Roobert', color: muted, marginTop: 2 }}>
                {isCustomCreds ? 'Using your own Pipedream project' : 'Using Kortix defaults'}
              </Text>
            </View>
          </View>

          {/* Status badge */}
          <View style={{
            flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
            backgroundColor: hoverBg,
            borderWidth: 1, borderColor: activeBg,
            borderRadius: 12, padding: 12, marginBottom: 16,
          }}>
            <Text style={{ fontSize: 12, fontFamily: 'Roobert', color: muted }}>Current source</Text>
            <View style={{
              flexDirection: 'row', alignItems: 'center',
              backgroundColor: isCustomCreds ? withAlpha(THEME.accent.green, 0.12) : hoverBg,
              paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6,
            }}>
              <Icon as={isCustomCreds ? Check : Shield} size={10} color={isCustomCreds ? THEME.accent.green : muted} strokeWidth={2} />
              <Text style={{ fontSize: 10, fontFamily: 'Roobert-Medium', color: isCustomCreds ? THEME.accent.green : muted, marginLeft: 4 }}>
                {isCustomCreds ? 'Your credentials' : 'Kortix Default'}
              </Text>
            </View>
          </View>

          {/* Credential fields */}
          {([
            { key: 'client_id' as const, label: 'Client ID', placeholder: 'e.g. z8PKS...' },
            { key: 'client_secret' as const, label: 'Client Secret', placeholder: 'e.g. UeZCz...' },
            { key: 'project_id' as const, label: 'Project ID', placeholder: 'e.g. proj_xxxxx' },
          ]).map((field) => (
            <View key={field.key} style={{ marginBottom: 12 }}>
              <Text style={{ fontSize: 12, fontFamily: 'Roobert-Medium', color: muted, marginBottom: 6 }}>
                {field.label}
              </Text>
              <BottomSheetTextInput
                value={credValues[field.key]}
                onChangeText={(text) => setCredValues((v) => ({ ...v, [field.key]: text }))}
                placeholder={isCustomCreds ? '••••••••  (keep existing)' : field.placeholder}
                placeholderTextColor={withAlpha(themeColors.primary, isDark ? 0.25 : 0.3)}
                secureTextEntry={!showSecrets}
                autoCapitalize="none"
                autoCorrect={false}
                style={{
                  backgroundColor: hoverBg,
                  borderWidth: 1,
                  borderColor: activeBg,
                  borderRadius: 12,
                  paddingHorizontal: 14,
                  paddingVertical: 12,
                  fontSize: 14,
                  fontFamily: 'Roobert',
                  color: fg,
                }}
              />
            </View>
          ))}

          {/* Actions row */}
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8 }}>
            <Pressable
              onPress={handleSaveCreds}
              disabled={!canSaveCreds || saveCreds.isPending}
              style={{
                backgroundColor: canSaveCreds ? themeColors.primary : hoverBg,
                borderRadius: 9999,
                paddingVertical: 12,
                paddingHorizontal: 20,
                opacity: canSaveCreds ? 1 : 0.5,
              }}
            >
              <Text style={{ fontSize: 14, fontFamily: 'Roobert-SemiBold', color: canSaveCreds ? themeColors.primaryForeground : muted }}>
                {saveCreds.isPending ? 'Saving...' : isCustomCreds ? 'Update' : 'Save'}
              </Text>
            </Pressable>

            <Pressable
              onPress={() => { haptics.selection(); setShowSecrets(!showSecrets); }}
              style={{
                width: 40, height: 40, borderRadius: 9999, alignItems: 'center', justifyContent: 'center',
                backgroundColor: hoverBg,
              }}
            >
              <Icon as={showSecrets ? EyeOff : Eye} size={16} color={muted} />
            </Pressable>

            {isCustomCreds && (
              <Pressable
                onPress={handleDeleteCreds}
                disabled={deleteCreds.isPending}
                style={{
                  flexDirection: 'row', alignItems: 'center', marginLeft: 'auto',
                  paddingVertical: 8, paddingHorizontal: 14, borderRadius: 9999,
                }}
              >
                <Icon as={Trash2} size={14} color={destructiveColor} strokeWidth={1.8} />
                <Text style={{ fontSize: 12, fontFamily: 'Roobert-Medium', color: destructiveColor, marginLeft: 4 }}>
                  {deleteCreds.isPending ? 'Reverting...' : 'Revert'}
                </Text>
              </Pressable>
            )}
          </View>
        </BottomSheetView>
      </BottomSheetModal>

    </>
  );
}

// ─── Connected Row ──────────────────────────────────────────────────────────

function ConnectedRow({
  connection,
  imgSrc,
  isDark,
  onPress,
}: {
  connection: ConnectorConnection;
  imgSrc?: string;
  isDark: boolean;
  onPress: () => void;
}) {
  const theme = useThemeColors();
  const fg = theme.primary;
  const muted = withAlpha(theme.primary, 0.5);
  const faint = withAlpha(theme.primary, isDark ? 0.25 : 0.2);
  const hoverBg = isDark ? THEME.dark.hover : THEME.light.hover;
  const destructiveColor = isDark ? THEME.dark.destructive : THEME.light.destructive;
  const iconUrl = imgSrc || (connection.metadata as any)?.imgSrc;

  return (
    <Pressable
      onPress={onPress}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: 12,
        gap: 12,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: hoverBg,
      }}
    >
      <AppIcon
        name={connection.appName || connection.app}
        imgSrc={iconUrl}
        size={36}
      />
      <View style={{ flex: 1 }}>
        <Text style={{ fontSize: 16, fontFamily: 'Roobert-Medium', color: fg }}>
          {connection.label || connection.appName || connection.app}
        </Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 2 }}>
          <View
            style={{
              width: 6,
              height: 6,
              borderRadius: 3,
              backgroundColor: connection.status === 'active' ? THEME.accent.green : destructiveColor,
            }}
          />
          <Text style={{ fontSize: 12, fontFamily: 'Roobert', color: muted }}>
            {connection.appName || connection.app}
          </Text>
        </View>
      </View>
      <Icon as={ChevronRight} size={16} color={faint} />
    </Pressable>
  );
}

// ─── App Row ────────────────────────────────────────────────────────────────

function AppRow({
  app,
  connections,
  isConnecting,
  isDark,
  onConnect,
  onManage,
}: {
  app: ConnectorApp;
  connections?: ConnectorConnection[];
  isConnecting: boolean;
  isDark: boolean;
  onConnect: () => void;
  onManage: (conn: ConnectorConnection) => void;
}) {
  const isConnected = connections && connections.length > 0;
  const theme = useThemeColors();
  const fg = theme.primary;
  const muted = withAlpha(theme.primary, 0.5);
  const categoryText = app.categories?.slice(0, 2).join(' · ') || '';

  return (
    <Pressable
      onPress={isConnected ? () => onManage(connections![0]) : onConnect}
      disabled={isConnecting}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: 12,
        paddingHorizontal: 20,
        gap: 12,
        opacity: isConnecting ? 0.5 : 1,
      }}
    >
      <AppIcon name={app.name} imgSrc={app.imgSrc} size={40} />
      <View style={{ flex: 1 }}>
        <Text style={{ fontSize: 16, fontFamily: 'Roobert-Medium', color: fg }}>
          {app.name}
        </Text>
        {categoryText ? (
          <Text style={{ fontSize: 12, fontFamily: 'Roobert', color: muted, marginTop: 1 }}>
            {categoryText}
          </Text>
        ) : null}
      </View>

      {isConnecting ? (
        <ActivityIndicator size="small" color={fg} />
      ) : isConnected ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Icon as={Check} size={14} color={THEME.accent.green} strokeWidth={2.5} />
          <Text style={{ fontSize: 13, fontFamily: 'Roobert-Medium', color: THEME.accent.green }}>
            Connected
          </Text>
        </View>
      ) : (
        <View
          style={{
            paddingHorizontal: 12,
            paddingVertical: 6,
            borderRadius: 9999,
            backgroundColor: theme.primary,
          }}
        >
          <Text style={{ fontSize: 13, fontFamily: 'Roobert-Medium', color: theme.primaryForeground }}>
            Connect
          </Text>
        </View>
      )}
    </Pressable>
  );
}

// ─── Legacy Section Row ─────────────────────────────────────────────────────

function LegacySection({
  icon: IconComponent,
  title,
  description,
  isDark,
  onPress,
}: {
  icon: typeof Globe;
  title: string;
  description: string;
  isDark: boolean;
  onPress: () => void;
}) {
  const scale = useSharedValue(1);
  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  return (
    <AnimatedPressable
      onPress={onPress}
      onPressIn={() => { scale.value = withSpring(0.98, { damping: 15, stiffness: 400 }); }}
      onPressOut={() => { scale.value = withSpring(1, { damping: 15, stiffness: 400 }); }}
      style={animatedStyle}
      className="mb-3 rounded-2xl bg-primary/5 p-4"
    >
      <View className="flex-row items-center justify-between">
        <View className="flex-1 flex-row items-center gap-3">
          <View className="h-10 w-10 items-center justify-center rounded-xl bg-primary/10">
            <Icon as={IconComponent} size={20} className="text-primary" strokeWidth={2} />
          </View>
          <View className="flex-1">
            <Text className="font-roobert-medium text-base text-foreground">{title}</Text>
            <Text className="font-roobert text-xs text-muted-foreground">{description}</Text>
          </View>
        </View>
        <Icon as={ChevronRight} size={16} className="text-foreground/40" strokeWidth={2} />
      </View>
    </AnimatedPressable>
  );
}
