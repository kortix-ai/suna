/**
 * IntegrationsPage — Pipedream integrations management.
 * Lists connected accounts, searchable app catalog, OAuth connect flow.
 */

import React, { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import {
  View,
  FlatList,
  TextInput,
  Pressable,
  Alert,
  ActivityIndicator,
  AppState,
  StyleSheet,
} from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
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
import * as Haptics from 'expo-haptics';
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';

import { SettingsHeader } from './SettingsHeader';
import { AppIcon } from './integrations/AppIcon';
import { ManageConnectionSheet } from './integrations/ManageConnectionSheet';
import { CustomMcpDialog } from './integrations/CustomMcpDialog';
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
import {
  BottomSheetModal,
  BottomSheetBackdrop,
  BottomSheetView,
  BottomSheetTextInput,
} from '@gorhom/bottom-sheet';
import type { BottomSheetBackdropProps } from '@gorhom/bottom-sheet';

import { useSheetBottomPadding } from '@/hooks/useSheetKeyboard';
import {
  useIntegrationApps,
  useIntegrationConnections,
  useCreateConnectToken,
  syncConnections,
  integrationKeys,
  type IntegrationApp,
  type IntegrationConnection,
} from '@/hooks/useIntegrations';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

// ─── Main Page (wrapper) ────────────────────────────────────────────────────

interface IntegrationsPageProps {
  visible: boolean;
  onClose: () => void;
}

export function IntegrationsPage({ visible, onClose }: IntegrationsPageProps) {
  const { t } = useLanguage();
  const router = useRouter();

  const handleClose = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
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
        <SettingsHeader title={t('integrations.title', 'Integrations')} onClose={handleClose} />
        <IntegrationsContent onUpgradePress={handleUpgradePress} />
      </View>
    </View>
  );
}

// Also export the content for standalone use
export { IntegrationsContent as IntegrationsPageContent };

// Legacy export for backward compat (AgentDrawer imports it)
export const AppBubble = React.memo(() => null);

// ─── Content ────────────────────────────────────────────────────────────────

interface IntegrationsContentProps {
  onBack?: () => void;
  noPadding?: boolean;
  onFullScreenChange?: (isFullScreen: boolean) => void;
  onNavigate?: (view: string) => void;
  onUpgradePress?: () => void;
}

function IntegrationsContent({
  onBack,
  noPadding,
  onFullScreenChange,
  onNavigate,
  onUpgradePress,
}: IntegrationsContentProps) {
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
  const [managingConnection, setManagingConnection] = useState<IntegrationConnection | null>(null);

  // ── Pipedream credentials ──
  const { data: credStatus } = usePipedreamCredentialStatus();
  const saveCreds = useSavePipedreamCredentials();
  const deleteCreds = useDeletePipedreamCredentials();
  const credSheetRef = useRef<BottomSheetModal>(null);
  const [credValues, setCredValues] = useState({ client_id: '', client_secret: '', project_id: '' });
  const [showSecrets, setShowSecrets] = useState(false);
  const isCustomCreds = credStatus?.configured && credStatus?.source === 'account';
  const canSaveCreds = credValues.client_id.trim() && credValues.client_secret.trim() && credValues.project_id.trim();

  const renderCredBackdrop = useCallback(
    (props: BottomSheetBackdropProps) => (
      <BottomSheetBackdrop {...props} disappearsOnIndex={-1} appearsOnIndex={0} opacity={0.5} />
    ),
    [],
  );

  const handleSaveCreds = useCallback(async () => {
    if (!canSaveCreds) return;
    await saveCreds.mutateAsync({
      client_id: credValues.client_id.trim(),
      client_secret: credValues.client_secret.trim(),
      project_id: credValues.project_id.trim(),
      environment: 'production',
    });
    setCredValues({ client_id: '', client_secret: '', project_id: '' });
    credSheetRef.current?.dismiss();
  }, [canSaveCreds, credValues, saveCreds]);

  const handleDeleteCreds = useCallback(async () => {
    await deleteCreds.mutateAsync();
    setCredValues({ client_id: '', client_secret: '', project_id: '' });
    credSheetRef.current?.dismiss();
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
  } = useIntegrationApps(debouncedQuery || undefined);

  const {
    data: connections,
    isLoading: connectionsLoading,
  } = useIntegrationConnections();

  const createToken = useCreateConnectToken();

  // Flatten paginated apps
  const apps = useMemo(
    () => appsData?.pages.flatMap((p) => p.apps) ?? [],
    [appsData],
  );

  // Map of app slug → connections
  const connectionsByApp = useMemo(() => {
    const map = new Map<string, IntegrationConnection[]>();
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
        queryClient.invalidateQueries({ queryKey: integrationKeys.connections() });
      }
    });
    return () => sub.remove();
  }, [queryClient]);

  // ── Connect flow ──
  const handleConnect = useCallback(
    async (app: IntegrationApp) => {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      setConnectingApp(app.slug);
      try {
        // Use app deep link scheme so Safari auto-dismisses after OAuth
        const successUri = 'kortix://integrations/success';
        const errorUri = 'kortix://integrations/error';

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
        const authResult = await WebBrowser.openAuthSessionAsync(url, 'kortix://integrations');

        if (authResult.type === 'success') {
          const returnUrl = authResult.url;
          if (returnUrl.includes('error')) {
            Alert.alert('Connection Failed', `Could not connect ${app.name}. Please try again.`);
          }
        }

        // Sync connections from Pipedream — discovers newly connected accounts
        try {
          await syncConnections();
        } catch (e) {
          log.error('[Integrations] Sync failed:', e);
        }
        queryClient.invalidateQueries({ queryKey: integrationKeys.connections() });
      } catch (err: any) {
        log.error('[Integrations] Connect failed:', err?.message);
        Alert.alert('Connection Failed', `Could not connect ${app.name}. Please try again.`);
      } finally {
        setConnectingApp(null);
      }
    },
    [createToken, queryClient],
  );

  // ── Colors ──
  const fg = isDark ? '#f8f8f8' : '#121215';
  const muted = isDark ? 'rgba(248,248,248,0.5)' : 'rgba(18,18,21,0.5)';
  const border = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)';
  const inputBg = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)';

  // ── Sticky search bar (rendered outside FlatList) ──
  const SearchBar = (
    <View style={{ paddingHorizontal: 20, paddingTop: 8, paddingBottom: 8, flexDirection: 'row', alignItems: 'center' }}>
      <View
        style={{
          flex: 1,
          flexDirection: 'row',
          alignItems: 'center',
          backgroundColor: inputBg,
          borderRadius: 12,
          paddingHorizontal: 12,
          height: 42,
        }}
      >
        <Search size={16} color={muted} />
        <TextInput
          value={searchQuery}
          onChangeText={setSearchQuery}
          placeholder="Search 1000+ apps..."
          placeholderTextColor={muted}
          style={{
            flex: 1,
            marginLeft: 8,
            fontSize: 15,
            fontFamily: 'Roobert',
            color: fg,
          }}
          returnKeyType="search"
          autoCorrect={false}
          autoCapitalize="none"
        />
        {searchQuery.length > 0 && (
          <Pressable onPress={() => setSearchQuery('')} hitSlop={8}>
            <X size={16} color={muted} />
          </Pressable>
        )}
      </View>
      {/* Pipedream settings gear */}
      <Pressable
        onPress={() => {
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
          credSheetRef.current?.present();
        }}
        style={{
          width: 42,
          height: 42,
          borderRadius: 12,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: isDark ? 'rgba(248,248,248,0.06)' : 'rgba(18,18,21,0.04)',
          borderWidth: 1,
          borderColor: isDark ? 'rgba(248,248,248,0.08)' : 'rgba(18,18,21,0.06)',
          marginLeft: 8,
        }}
      >
        <Icon as={Settings} size={16} color={muted} />
        {isCustomCreds && (
          <View style={{ position: 'absolute', top: -2, right: -2, width: 10, height: 10, borderRadius: 5, backgroundColor: '#10b981', borderWidth: 2, borderColor: isDark ? '#121215' : '#F8F8F8' }} />
        )}
      </Pressable>
    </View>
  );

  // ── List header (connected accounts + section label) ──
  const ListHeader = () => (
    <View style={{ paddingHorizontal: 20 }}>
      {/* Back button + title when embedded (e.g. AgentDrawer) */}
      {onBack && (
        <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 16 }}>
          <Pressable onPress={onBack} style={{ marginRight: 12 }}>
            <ArrowLeft size={20} color={fg} />
          </Pressable>
          <Text style={{ fontSize: 20, fontFamily: 'Roobert-Semibold', color: fg }}>
            {t('integrations.title', 'Integrations')}
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
              key={conn.integrationId}
              connection={conn}
              imgSrc={appImgMap.get(conn.app)}
              isDark={isDark}
              onPress={() => {
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
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
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
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
              <Text style={{ color: '#ef4444', fontSize: 14, fontFamily: 'Roobert', textAlign: 'center' }}>
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
        backdropComponent={renderCredBackdrop}
        keyboardBehavior="interactive"
        keyboardBlurBehavior="restore"
        android_keyboardInputMode="adjustResize"
        onDismiss={() => { setCredValues({ client_id: '', client_secret: '', project_id: '' }); setShowSecrets(false); }}
        backgroundStyle={{
          backgroundColor: isDark ? '#161618' : '#FFFFFF',
          borderTopLeftRadius: 24,
          borderTopRightRadius: 24,
        }}
        handleIndicatorStyle={{
          backgroundColor: isDark ? '#3F3F46' : '#D4D4D8',
          width: 36,
          height: 5,
          borderRadius: 3,
        }}
      >
        <BottomSheetView style={{ paddingHorizontal: 24, paddingTop: 8, paddingBottom: sheetPadding }}>
          {/* Header */}
          <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 16 }}>
            <View
              style={{
                width: 40, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center', marginRight: 12,
                backgroundColor: isDark ? 'rgba(248,248,248,0.08)' : 'rgba(18,18,21,0.05)',
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
            backgroundColor: isDark ? 'rgba(248,248,248,0.04)' : 'rgba(18,18,21,0.02)',
            borderWidth: 1, borderColor: isDark ? 'rgba(248,248,248,0.08)' : 'rgba(18,18,21,0.06)',
            borderRadius: 12, padding: 12, marginBottom: 16,
          }}>
            <Text style={{ fontSize: 12, fontFamily: 'Roobert', color: muted }}>Current source</Text>
            <View style={{
              flexDirection: 'row', alignItems: 'center',
              backgroundColor: isCustomCreds ? 'rgba(16,185,129,0.12)' : (isDark ? 'rgba(248,248,248,0.06)' : 'rgba(18,18,21,0.04)'),
              paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6,
            }}>
              <Icon as={isCustomCreds ? Check : Shield} size={10} color={isCustomCreds ? '#10b981' : muted} strokeWidth={2} />
              <Text style={{ fontSize: 10, fontFamily: 'Roobert-Medium', color: isCustomCreds ? '#10b981' : muted, marginLeft: 4 }}>
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
                placeholderTextColor={isDark ? 'rgba(248,248,248,0.25)' : 'rgba(18,18,21,0.3)'}
                secureTextEntry={!showSecrets}
                autoCapitalize="none"
                autoCorrect={false}
                style={{
                  backgroundColor: isDark ? 'rgba(248,248,248,0.06)' : 'rgba(18,18,21,0.04)',
                  borderWidth: 1,
                  borderColor: isDark ? 'rgba(248,248,248,0.1)' : 'rgba(18,18,21,0.08)',
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
                backgroundColor: canSaveCreds ? themeColors.primary : (isDark ? 'rgba(248,248,248,0.08)' : 'rgba(18,18,21,0.06)'),
                borderRadius: 12,
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
              onPress={() => setShowSecrets(!showSecrets)}
              style={{
                width: 40, height: 40, borderRadius: 10, alignItems: 'center', justifyContent: 'center',
                backgroundColor: isDark ? 'rgba(248,248,248,0.06)' : 'rgba(18,18,21,0.04)',
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
                  paddingVertical: 8, paddingHorizontal: 12, borderRadius: 10,
                }}
              >
                <Icon as={Trash2} size={14} color="#ef4444" strokeWidth={1.8} />
                <Text style={{ fontSize: 12, fontFamily: 'Roobert-Medium', color: '#ef4444', marginLeft: 4 }}>
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
  connection: IntegrationConnection;
  imgSrc?: string;
  isDark: boolean;
  onPress: () => void;
}) {
  const fg = isDark ? '#f8f8f8' : '#121215';
  const muted = isDark ? 'rgba(248,248,248,0.5)' : 'rgba(18,18,21,0.5)';
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
        borderBottomColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)',
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
              backgroundColor: connection.status === 'active' ? '#34d399' : '#ef4444',
            }}
          />
          <Text style={{ fontSize: 12, fontFamily: 'Roobert', color: muted }}>
            {connection.appName || connection.app}
          </Text>
        </View>
      </View>
      <ChevronRight size={16} color={isDark ? 'rgba(255,255,255,0.25)' : 'rgba(0,0,0,0.2)'} />
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
  app: IntegrationApp;
  connections?: IntegrationConnection[];
  isConnecting: boolean;
  isDark: boolean;
  onConnect: () => void;
  onManage: (conn: IntegrationConnection) => void;
}) {
  const isConnected = connections && connections.length > 0;
  const fg = isDark ? '#f8f8f8' : '#121215';
  const muted = isDark ? 'rgba(248,248,248,0.5)' : 'rgba(18,18,21,0.5)';
  const theme = useThemeColors();
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
          <Check size={14} color="#34d399" strokeWidth={2.5} />
          <Text style={{ fontSize: 13, fontFamily: 'Roobert-Medium', color: '#34d399' }}>
            Connected
          </Text>
        </View>
      ) : (
        <View
          style={{
            paddingHorizontal: 12,
            paddingVertical: 6,
            borderRadius: 8,
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
