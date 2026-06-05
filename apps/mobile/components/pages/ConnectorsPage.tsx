/**
 * ConnectorsPage — the project's tool connectors (web parity:
 * customize/sections connectors-view). Lists connected connectors (Pipedream
 * apps, MCP servers, custom OpenAPI/GraphQL/HTTP), with a Sync action, a detail
 * view of each connector's tools, and delete. Adding/connecting connectors is
 * layered on top in a follow-up.
 *
 * Mobile branding: PageHeader + PageContent chrome, square "thing" avatars,
 * design-system typography + colors.
 */

import React, { useMemo, useState, useCallback, useEffect, useRef } from 'react';
import {
  View,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
  Alert,
  Image,
  TextInput,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import { useColorScheme } from 'nativewind';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useQueryClient } from '@tanstack/react-query';
import * as WebBrowser from 'expo-web-browser';
import {
  BottomSheetModal,
  BottomSheetBackdrop,
  BottomSheetScrollView,
  BottomSheetTextInput,
} from '@gorhom/bottom-sheet';
import {
  Zap,
  Boxes,
  Globe,
  ChevronRight,
  ChevronLeft,
  RefreshCw,
  Trash2,
  Plug,
  Share2,
  Lock,
  Users,
  Check,
  Search,
  Plus,
  X,
  type LucideIcon,
} from 'lucide-react-native';
import { Text } from '@/components/ui/text';
import { PageHeader } from '@/components/ui/page-header';
import { PageContent } from '@/components/ui/page-content';
import { SearchListHeader } from '@/components/ui/search-list-header';
import { useThemeColors, getSheetBg } from '@/lib/theme-colors';
import {
  useConnectors,
  useSyncConnectors,
  useDeleteConnector,
  useSetConnectorSharing,
  useProjectAccess,
  useProjectPolicies,
  useSetProjectPolicies,
  usePipedreamApps,
  projectKeys,
} from '@/lib/projects/hooks';
import {
  createConnector,
  pipedreamConnect,
  pipedreamFinalize,
  setConnectorCredential,
} from '@/lib/projects/projects-client';
import type {
  AdminConnector,
  ConnectorAction,
  ConnectorProvider,
  ConnectorSharing,
  ConnectorDraftInput,
  PipedreamApp,
  PolicyAction,
  PolicyDefaultMode,
} from '@/lib/projects/projects-client';
import { haptics } from '@/lib/haptics';

interface PageTabLike {
  id: string;
  label: string;
  icon: string;
}

interface ConnectorsPageProps {
  page: PageTabLike;
  projectId: string;
  onOpenDrawer?: () => void;
  onOpenRightDrawer?: () => void;
  isDrawerOpen?: boolean;
  isRightDrawerOpen?: boolean;
}

const MONO = 'Menlo';

function providerIcon(provider: ConnectorProvider): LucideIcon {
  if (provider === 'pipedream') return Zap;
  if (provider === 'mcp') return Boxes;
  return Globe; // openapi | graphql | http
}

function providerLabel(provider: ConnectorProvider): string {
  if (provider === 'pipedream') return 'Pipedream';
  if (provider === 'mcp') return 'MCP';
  return provider.toUpperCase();
}

const STATUS_META: Record<AdminConnector['status'], { label: string; color: string }> = {
  active: { label: 'Active', color: '#22C55E' },
  disabled: { label: 'Disabled', color: '#9CA3AF' },
  needs_auth: { label: 'Needs auth', color: '#F59E0B' },
  error: { label: 'Error', color: '#EF4444' },
};

const RISK_COLOR: Record<ConnectorAction['risk'], string> = {
  read: '#9CA3AF',
  write: '#F59E0B',
  destructive: '#EF4444',
};

// ─── Connector detail (tools) ────────────────────────────────────────────────

function ConnectorDetail({
  connector,
  onBack,
  onDelete,
  onEditSharing,
  onSetCredential,
  deleting,
}: {
  connector: AdminConnector;
  onBack: () => void;
  onDelete: () => void;
  onEditSharing: () => void;
  onSetCredential: () => void;
  deleting: boolean;
}) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const insets = useSafeAreaInsets();
  const theme = useThemeColors();

  const fg = isDark ? '#F8F8F8' : '#121215';
  const muted = isDark ? '#9b9b9b' : '#6e6e6e';
  const border = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)';
  const iconBg = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)';

  const Icon = providerIcon(connector.provider);
  const status = STATUS_META[connector.status];
  const needsAuth = !!connector.authSecret && !connector.secretSet;

  return (
    <View style={{ flex: 1 }}>
      <TouchableOpacity
        onPress={() => { haptics.tap(); onBack(); }}
        activeOpacity={0.6}
        style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12, gap: 4 }}
      >
        <ChevronLeft size={18} color={muted} />
        <Text style={{ fontSize: 14, fontFamily: 'Roobert', color: muted }}>Connectors</Text>
      </TouchableOpacity>

      {/* Header */}
      <View style={{ paddingHorizontal: 16, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: border, flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <View style={{ width: 40, height: 40, borderRadius: 11, backgroundColor: iconBg, alignItems: 'center', justifyContent: 'center' }}>
          <Icon size={20} color={muted} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={{ fontSize: 18, fontFamily: 'Roobert-Medium', color: fg }} numberOfLines={1}>
            {connector.name || connector.slug}
          </Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 3 }}>
            <Text style={{ fontSize: 12, fontFamily: 'Roobert', color: muted }}>{providerLabel(connector.provider)}</Text>
            <View style={{ width: 5, height: 5, borderRadius: 2.5, backgroundColor: status.color }} />
            <Text style={{ fontSize: 12, fontFamily: 'Roobert', color: muted }}>{status.label}</Text>
            {connector.credentialMode === 'per_user' && (
              <Text style={{ fontSize: 12, fontFamily: 'Roobert', color: muted }}>· Per-user</Text>
            )}
          </View>
        </View>
      </View>

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 40 }}
        showsVerticalScrollIndicator={false}
      >
        {needsAuth && (
          <View style={{ borderRadius: 12, borderWidth: 1, borderColor: 'rgba(245,158,11,0.3)', backgroundColor: 'rgba(245,158,11,0.08)', padding: 12, marginBottom: 16, flexDirection: 'row', alignItems: 'center', gap: 12 }}>
            <Text style={{ flex: 1, fontSize: 13, color: isDark ? '#fbbf24' : '#b45309' }}>
              This connector needs a credential before it can run.
            </Text>
            <TouchableOpacity
              onPress={() => { haptics.tap(); onSetCredential(); }}
              activeOpacity={0.8}
              style={{ paddingHorizontal: 12, paddingVertical: 8, borderRadius: 999, backgroundColor: theme.primary }}
            >
              <Text style={{ fontSize: 12.5, fontFamily: 'Roobert-Medium', color: theme.primaryForeground }}>Set credential</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* Sharing / access */}
        <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 18 }}>
          <Share2 size={15} color={muted} style={{ marginRight: 10 }} />
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 11, fontFamily: 'Roobert-Medium', color: muted, textTransform: 'uppercase', letterSpacing: 0.5 }}>Access</Text>
            <Text style={{ fontSize: 14, color: fg, marginTop: 1 }}>{sharingLabel(connector.sharing)}</Text>
          </View>
          <TouchableOpacity onPress={() => { haptics.tap(); onEditSharing(); }} activeOpacity={0.7} style={{ paddingHorizontal: 12, paddingVertical: 7, borderRadius: 999, borderWidth: 1, borderColor: border }}>
            <Text style={{ fontSize: 13, fontFamily: 'Roobert-Medium', color: muted }}>Manage</Text>
          </TouchableOpacity>
        </View>

        <Text style={{ fontSize: 11, fontFamily: 'Roobert-Medium', color: muted, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 }}>
          {connector.actions.length} {connector.actions.length === 1 ? 'tool' : 'tools'}
        </Text>

        {connector.actions.length === 0 ? (
          <Text style={{ fontSize: 13, color: muted }}>No tools indexed yet. Try Sync.</Text>
        ) : (
          connector.actions.map((action) => (
            <View key={action.path} style={{ paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: border }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Text style={{ flex: 1, fontSize: 13, fontFamily: MONO, color: fg }} numberOfLines={1}>
                  {action.path}
                </Text>
                <View style={{ paddingHorizontal: 7, paddingVertical: 2, borderRadius: 999, backgroundColor: `${RISK_COLOR[action.risk]}22` }}>
                  <Text style={{ fontSize: 10, fontFamily: 'Roobert-Medium', color: RISK_COLOR[action.risk] }}>{action.risk}</Text>
                </View>
              </View>
              {action.description ? (
                <Text style={{ fontSize: 13, lineHeight: 18, color: muted, marginTop: 3 }}>{action.description}</Text>
              ) : null}
            </View>
          ))
        )}

        {/* Delete */}
        <TouchableOpacity
          onPress={onDelete}
          disabled={deleting}
          activeOpacity={0.7}
          style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, marginTop: 24, paddingVertical: 12, borderRadius: 9999, borderWidth: 1, borderColor: 'rgba(239,68,68,0.4)', opacity: deleting ? 0.5 : 1 }}
        >
          {deleting ? <ActivityIndicator size="small" color="#ef4444" /> : <Trash2 size={15} color="#ef4444" />}
          <Text style={{ fontSize: 14, fontFamily: 'Roobert-Medium', color: '#ef4444' }}>Remove connector</Text>
        </TouchableOpacity>
      </ScrollView>
    </View>
  );
}

// ─── Connector row ───────────────────────────────────────────────────────────

function ConnectorRow({
  connector,
  onPress,
  isDark,
}: {
  connector: AdminConnector;
  onPress: () => void;
  isDark: boolean;
}) {
  const fg = isDark ? '#F8F8F8' : '#121215';
  const muted = isDark ? '#9b9b9b' : '#6e6e6e';
  const iconBg = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)';
  const Icon = providerIcon(connector.provider);
  const status = STATUS_META[connector.status];
  const showStatusDot = connector.status !== 'active';

  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.6}
      style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12, gap: 12 }}
    >
      <View style={{ width: 38, height: 38, borderRadius: 10, backgroundColor: iconBg, alignItems: 'center', justifyContent: 'center' }}>
        <Icon size={19} color={muted} />
      </View>

      <View style={{ flex: 1 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Text style={{ fontSize: 15, fontFamily: 'Roobert-Medium', color: fg }} numberOfLines={1}>
            {connector.name || connector.slug}
          </Text>
          {showStatusDot && <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: status.color }} />}
        </View>
        <Text style={{ fontSize: 13, color: muted, marginTop: 2 }} numberOfLines={1}>
          {providerLabel(connector.provider)} · {connector.actions.length} {connector.actions.length === 1 ? 'tool' : 'tools'}
          {connector.credentialMode === 'per_user' ? ' · Per-user' : ''}
        </Text>
      </View>

      <ChevronRight size={18} color={muted} />
    </TouchableOpacity>
  );
}

// ─── Add connector (Pipedream catalogue + 1-click connect) ───────────────────

function AppCard({
  app,
  connecting,
  onConnect,
  isDark,
}: {
  app: PipedreamApp;
  connecting: boolean;
  onConnect: () => void;
  isDark: boolean;
}) {
  const fg = isDark ? '#F8F8F8' : '#121215';
  const muted = isDark ? '#9b9b9b' : '#6e6e6e';
  const border = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)';
  const iconBg = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)';
  const [imgFailed, setImgFailed] = useState(false);

  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12, gap: 12 }}>
      {app.imgSrc && !imgFailed ? (
        <Image
          source={{ uri: app.imgSrc }}
          resizeMode="contain"
          onError={() => setImgFailed(true)}
          style={{ width: 38, height: 38 }}
        />
      ) : (
        <View style={{ width: 38, height: 38, borderRadius: 10, backgroundColor: iconBg, alignItems: 'center', justifyContent: 'center' }}>
          <Text style={{ fontSize: 16, fontFamily: 'Roobert-Medium', color: muted }}>
            {(app.name || '?').charAt(0).toUpperCase()}
          </Text>
        </View>
      )}
      <View style={{ flex: 1 }}>
        <Text style={{ fontSize: 15, fontFamily: 'Roobert-Medium', color: fg }} numberOfLines={1}>{app.name}</Text>
        {app.description ? (
          <Text style={{ fontSize: 13, lineHeight: 18, color: muted, marginTop: 2 }} numberOfLines={2}>{app.description}</Text>
        ) : null}
      </View>
      <TouchableOpacity
        onPress={onConnect}
        disabled={connecting}
        activeOpacity={0.7}
        style={{ minWidth: 78, alignItems: 'center', paddingHorizontal: 12, paddingVertical: 7, borderRadius: 999, borderWidth: 1, borderColor: border, opacity: connecting ? 0.6 : 1 }}
      >
        {connecting ? <ActivityIndicator size="small" color={muted} /> : (
          <Text style={{ fontSize: 13, fontFamily: 'Roobert-Medium', color: fg }}>Connect</Text>
        )}
      </TouchableOpacity>
    </View>
  );
}

function AddConnectorView({
  projectId,
  onClose,
}: {
  projectId: string;
  onClose: () => void;
}) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();
  const [appSearch, setAppSearch] = useState('');
  const [connectingSlug, setConnectingSlug] = useState<string | null>(null);
  const [tab, setTab] = useState<'apps' | 'custom'>('apps');

  const { data, isLoading, isError, error, refetch, fetchNextPage, hasNextPage, isFetchingNextPage } =
    usePipedreamApps(projectId, appSearch);

  const muted = isDark ? '#9b9b9b' : '#6e6e6e';
  const fg = isDark ? '#F8F8F8' : '#121215';
  const border = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)';
  const searchBg = isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.04)';

  const apps = useMemo(() => (data?.pages ?? []).flatMap((p) => p.apps), [data]);

  const handleConnect = useCallback(async (app: PipedreamApp) => {
    if (connectingSlug) return;
    setConnectingSlug(app.slug);
    try {
      // Register the connector, then run Pipedream's 1-click OAuth in a browser.
      await createConnector(projectId, { slug: app.slug, provider: 'pipedream', app: app.slug });
      const conn = await pipedreamConnect(projectId, app.slug);
      if (!conn.connectUrl) {
        Alert.alert('Cannot connect', 'This app could not start a connect flow on mobile.');
        return;
      }
      haptics.tap();
      await WebBrowser.openBrowserAsync(conn.connectUrl, {
        presentationStyle: WebBrowser.WebBrowserPresentationStyle.FULL_SCREEN,
      });
      const result = await pipedreamFinalize(projectId, app.slug);
      queryClient.invalidateQueries({ queryKey: projectKeys.connectors(projectId) });
      onClose();
      Alert.alert(
        result.connected ? 'Connected' : 'Almost there',
        result.connected
          ? `${app.name} is now connected.`
          : `${app.name} was added but the connection wasn't completed — retry from its row.`,
      );
    } catch (err: any) {
      Alert.alert('Connect failed', err?.message || 'Could not connect this app.');
    } finally {
      setConnectingSlug(null);
    }
  }, [projectId, connectingSlug, queryClient, onClose]);

  return (
    <View style={{ flex: 1 }}>
      {/* Sheet header */}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingTop: 4, paddingBottom: 12 }}>
        <Text style={{ flex: 1, fontSize: 18, fontFamily: 'Roobert-Medium', color: fg }}>Add a connector</Text>
        <TouchableOpacity
          onPress={() => { haptics.tap(); onClose(); }}
          hitSlop={8}
          style={{ width: 30, height: 30, borderRadius: 15, backgroundColor: searchBg, alignItems: 'center', justifyContent: 'center' }}
        >
          <X size={17} color={muted} />
        </TouchableOpacity>
      </View>

      {/* Easy Connect (Pipedream catalogue) vs Custom (MCP / OpenAPI / GraphQL / HTTP) */}
      <View style={{ paddingHorizontal: 16, paddingBottom: 8 }}>
        <Segmented
          isDark={isDark}
          value={tab}
          onChange={setTab}
          options={[{ value: 'apps', label: 'Easy Connect' }, { value: 'custom', label: 'Custom' }]}
        />
      </View>

      {tab === 'custom' ? (
        <CustomConnectorForm projectId={projectId} onAdded={onClose} isDark={isDark} />
      ) : (
        <>
          <View style={{ paddingHorizontal: 16, paddingBottom: 8 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 14, height: 44, borderRadius: 9999, backgroundColor: searchBg }}>
              <Search size={16} color={muted} />
              <BottomSheetTextInput
                value={appSearch}
                onChangeText={setAppSearch}
                placeholder="Search apps to connect"
                placeholderTextColor={muted}
                autoCapitalize="none"
                autoCorrect={false}
                style={{ flex: 1, fontSize: 15, fontFamily: 'Roobert', color: fg, padding: 0 }}
              />
            </View>
          </View>

          <BottomSheetScrollView
            style={{ flex: 1 }}
            contentContainerStyle={{ paddingBottom: insets.bottom + 40 }}
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
            scrollEventThrottle={200}
            onScroll={({ nativeEvent }: NativeSyntheticEvent<NativeScrollEvent>) => {
              const { layoutMeasurement, contentOffset, contentSize } = nativeEvent;
              if (
                layoutMeasurement.height + contentOffset.y >= contentSize.height - 320 &&
                hasNextPage &&
                !isFetchingNextPage
              ) {
                fetchNextPage();
              }
            }}
          >
            {isLoading ? (
              <View style={{ paddingVertical: 48, alignItems: 'center' }}>
                <ActivityIndicator size="small" color={muted} />
              </View>
            ) : isError ? (
              <View style={{ padding: 24, alignItems: 'center', gap: 12 }}>
                <Text style={{ fontSize: 14, color: muted, textAlign: 'center' }}>
                  {(error as Error)?.message ?? 'Failed to load apps'}
                </Text>
                <TouchableOpacity onPress={() => refetch()} style={{ paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999, borderWidth: 1, borderColor: border }}>
                  <Text style={{ fontSize: 13, fontFamily: 'Roobert-Medium', color: fg }}>Retry</Text>
                </TouchableOpacity>
              </View>
            ) : apps.length === 0 ? (
              <View style={{ padding: 40, alignItems: 'center' }}>
                <Text style={{ fontSize: 14, color: muted, textAlign: 'center' }}>No apps found.</Text>
              </View>
            ) : (
              <>
                {apps.map((app, i) => (
                  <View key={app.slug}>
                    <AppCard
                      app={app}
                      connecting={connectingSlug === app.slug}
                      onConnect={() => handleConnect(app)}
                      isDark={isDark}
                    />
                    {i < apps.length - 1 && <View style={{ height: 1, backgroundColor: border, marginLeft: 66 }} />}
                  </View>
                ))}
                {isFetchingNextPage && (
                  <View style={{ paddingVertical: 16, alignItems: 'center' }}>
                    <ActivityIndicator size="small" color={muted} />
                  </View>
                )}
              </>
            )}
          </BottomSheetScrollView>
        </>
      )}
    </View>
  );
}

// ─── Sharing editor (project / private / members) ────────────────────────────

const SHARE_OPTIONS: { mode: 'project' | 'private' | 'members'; label: string; desc: string; icon: LucideIcon }[] = [
  { mode: 'project', label: 'Project-wide', desc: 'Every member of this project', icon: Globe },
  { mode: 'private', label: 'Only me', desc: 'Just you', icon: Lock },
  { mode: 'members', label: 'Select members', desc: 'A chosen list of members', icon: Users },
];

function sharingLabel(sharing: ConnectorSharing | null): string {
  if (!sharing || sharing.mode === 'project') return 'Project-wide';
  if (sharing.mode === 'private') return 'Only me';
  const n = sharing.memberIds?.length ?? 0;
  return n === 1 ? '1 member' : `${n} members`;
}

function ShareOptionRow({
  option,
  selected,
  onPress,
  isDark,
  primary,
  primaryLight,
}: {
  option: (typeof SHARE_OPTIONS)[number];
  selected: boolean;
  onPress: () => void;
  isDark: boolean;
  primary: string;
  primaryLight: string;
}) {
  const fg = isDark ? '#F8F8F8' : '#121215';
  const muted = isDark ? '#9b9b9b' : '#6e6e6e';
  const border = isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)';
  const Icon = option.icon;
  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.7}
      style={{
        flexDirection: 'row', alignItems: 'center', gap: 12,
        paddingHorizontal: 14, paddingVertical: 12, borderRadius: 14, marginBottom: 8,
        borderWidth: 1.5, borderColor: selected ? primary : border,
        backgroundColor: selected ? primaryLight : 'transparent',
      }}
    >
      <Icon size={18} color={selected ? primary : muted} />
      <View style={{ flex: 1 }}>
        <Text style={{ fontSize: 15, fontFamily: 'Roobert-Medium', color: fg }}>{option.label}</Text>
        <Text style={{ fontSize: 12.5, color: muted, marginTop: 1 }}>{option.desc}</Text>
      </View>
      <View style={{ width: 20, height: 20, borderRadius: 10, borderWidth: selected ? 0 : 1.5, borderColor: border, backgroundColor: selected ? primary : 'transparent', alignItems: 'center', justifyContent: 'center' }}>
        {selected && <Check size={13} color="#fff" strokeWidth={3} />}
      </View>
    </TouchableOpacity>
  );
}

function SharingEditor({
  projectId,
  connector,
  onBack,
}: {
  projectId: string;
  connector: AdminConnector;
  onBack: () => void;
}) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const insets = useSafeAreaInsets();
  const theme = useThemeColors();

  const access = useProjectAccess(projectId);
  const saveMutation = useSetConnectorSharing(projectId);

  const initial = connector.sharing;
  const [mode, setMode] = useState<'project' | 'private' | 'members'>(initial?.mode ?? 'project');
  const [memberIds, setMemberIds] = useState<string[]>(
    initial?.mode === 'members' ? (initial.memberIds ?? []) : [],
  );
  const [memberSearch, setMemberSearch] = useState('');

  const fg = isDark ? '#F8F8F8' : '#121215';
  const muted = isDark ? '#9b9b9b' : '#6e6e6e';
  const border = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)';
  const inputBg = isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.04)';

  const members = access.data?.members ?? [];
  const selectedSet = useMemo(() => new Set(memberIds), [memberIds]);
  const filteredMembers = useMemo(() => {
    const q = memberSearch.trim().toLowerCase();
    const list = q ? members.filter((m) => (m.email ?? m.user_id).toLowerCase().includes(q)) : members;
    return [...list].sort((a, b) => {
      const d = (selectedSet.has(a.user_id) ? 0 : 1) - (selectedSet.has(b.user_id) ? 0 : 1);
      return d !== 0 ? d : (a.email ?? a.user_id).localeCompare(b.email ?? b.user_id);
    });
  }, [members, memberSearch, selectedSet]);

  const toggleMember = (id: string) =>
    setMemberIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const incomplete = mode === 'members' && memberIds.length === 0;

  const handleSave = () => {
    if (incomplete || saveMutation.isPending) return;
    const intent: ConnectorSharing =
      mode === 'project'
        ? { mode: 'project' }
        : mode === 'private'
          ? { mode: 'private', ownerId: '' }
          : { mode: 'members', memberIds };
    haptics.tap();
    saveMutation.mutate(
      { slug: connector.slug, intent },
      {
        onSuccess: onBack,
        onError: (err: any) => Alert.alert('Save failed', err?.message || 'Could not update sharing.'),
      },
    );
  };

  return (
    <View style={{ flex: 1 }}>
      <TouchableOpacity
        onPress={() => { haptics.tap(); onBack(); }}
        activeOpacity={0.6}
        style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12, gap: 4 }}
      >
        <ChevronLeft size={18} color={muted} />
        <Text style={{ fontSize: 14, fontFamily: 'Roobert', color: muted }}>{connector.name || connector.slug}</Text>
      </TouchableOpacity>

      <View style={{ paddingHorizontal: 16, paddingBottom: 10, borderBottomWidth: 1, borderBottomColor: border }}>
        <Text style={{ fontSize: 18, fontFamily: 'Roobert-Medium', color: fg }}>Who can use it?</Text>
      </View>

      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16 }} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
        {SHARE_OPTIONS.map((opt) => (
          <ShareOptionRow
            key={opt.mode}
            option={opt}
            selected={mode === opt.mode}
            onPress={() => { haptics.selection(); setMode(opt.mode); }}
            isDark={isDark}
            primary={theme.primary}
            primaryLight={theme.primaryLight}
          />
        ))}

        {mode === 'members' && (
          <View style={{ marginTop: 6, borderRadius: 14, borderWidth: 1, borderColor: border, overflow: 'hidden' }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, height: 42, borderBottomWidth: 1, borderBottomColor: border, backgroundColor: inputBg }}>
              <Search size={15} color={muted} />
              <TextInput
                value={memberSearch}
                onChangeText={setMemberSearch}
                placeholder="Search members…"
                placeholderTextColor={muted}
                autoCapitalize="none"
                autoCorrect={false}
                style={{ flex: 1, fontSize: 14, fontFamily: 'Roobert', color: fg, padding: 0 }}
              />
            </View>
            {access.isLoading ? (
              <View style={{ padding: 20, alignItems: 'center' }}><ActivityIndicator size="small" color={muted} /></View>
            ) : filteredMembers.length === 0 ? (
              <View style={{ padding: 20, alignItems: 'center' }}><Text style={{ fontSize: 13, color: muted }}>No members.</Text></View>
            ) : (
              filteredMembers.map((m) => {
                const on = selectedSet.has(m.user_id);
                return (
                  <TouchableOpacity
                    key={m.user_id}
                    onPress={() => { haptics.selection(); toggleMember(m.user_id); }}
                    activeOpacity={0.6}
                    style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12, paddingVertical: 10 }}
                  >
                    <View style={{ width: 28, height: 28, borderRadius: 14, backgroundColor: theme.primaryLight, alignItems: 'center', justifyContent: 'center' }}>
                      <Text style={{ fontSize: 12, fontFamily: 'Roobert-Medium', color: theme.primary }}>
                        {(m.email ?? m.user_id).charAt(0).toUpperCase()}
                      </Text>
                    </View>
                    <Text style={{ flex: 1, fontSize: 14, color: fg }} numberOfLines={1}>{m.email ?? m.user_id}</Text>
                    <View style={{ width: 20, height: 20, borderRadius: 6, borderWidth: on ? 0 : 1.5, borderColor: border, backgroundColor: on ? theme.primary : 'transparent', alignItems: 'center', justifyContent: 'center' }}>
                      {on && <Check size={13} color="#fff" strokeWidth={3} />}
                    </View>
                  </TouchableOpacity>
                );
              })
            )}
          </View>
        )}
      </ScrollView>

      {/* Sticky Save (primary theme color) */}
      <View style={{ padding: 16, paddingBottom: insets.bottom + 16, borderTopWidth: 1, borderTopColor: border }}>
        <TouchableOpacity
          onPress={handleSave}
          disabled={incomplete || saveMutation.isPending}
          activeOpacity={0.8}
          style={{
            height: 48, borderRadius: 14, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 8,
            backgroundColor: theme.primary, opacity: incomplete || saveMutation.isPending ? 0.5 : 1,
          }}
        >
          {saveMutation.isPending && <ActivityIndicator size="small" color={theme.primaryForeground} />}
          <Text style={{ fontSize: 15, fontFamily: 'Roobert-Medium', color: theme.primaryForeground }}>Save sharing</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

// ─── Custom connector form (MCP / OpenAPI / GraphQL / HTTP) ───────────────────

function Segmented<T extends string>({
  options,
  value,
  onChange,
  isDark,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  isDark: boolean;
}) {
  const fg = isDark ? '#F8F8F8' : '#121215';
  const muted = isDark ? '#9b9b9b' : '#6e6e6e';
  const bg = isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.04)';
  const onBg = isDark ? 'rgba(255,255,255,0.12)' : '#FFFFFF';
  return (
    <View style={{ flexDirection: 'row', backgroundColor: bg, borderRadius: 9999, padding: 3 }}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <TouchableOpacity
            key={o.value}
            onPress={() => { haptics.selection(); onChange(o.value); }}
            activeOpacity={0.7}
            style={{ flex: 1, paddingVertical: 8, borderRadius: 9999, alignItems: 'center', backgroundColor: on ? onBg : 'transparent' }}
          >
            <Text style={{ fontSize: 13, fontFamily: on ? 'Roobert-Medium' : 'Roobert', color: on ? fg : muted }}>{o.label}</Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

function FormField({ label, optional, children, isDark }: { label: string; optional?: boolean; children: React.ReactNode; isDark: boolean }) {
  const muted = isDark ? '#9b9b9b' : '#6e6e6e';
  return (
    <View style={{ marginBottom: 14 }}>
      <Text style={{ fontSize: 12, fontFamily: 'Roobert-Medium', color: muted, marginBottom: 6 }}>
        {label}{optional ? '  ·  optional' : ''}
      </Text>
      {children}
    </View>
  );
}

function CustomConnectorForm({
  projectId,
  onAdded,
  isDark,
}: {
  projectId: string;
  onAdded: () => void;
  isDark: boolean;
}) {
  const theme = useThemeColors();
  const queryClient = useQueryClient();
  const insets = useSafeAreaInsets();

  const [slug, setSlug] = useState('');
  const [provider, setProvider] = useState<Exclude<ConnectorProvider, 'pipedream'>>('openapi');
  const [spec, setSpec] = useState('');
  const [endpoint, setEndpoint] = useState('');
  const [url, setUrl] = useState('');
  const [transport, setTransport] = useState<'http' | 'sse'>('http');
  const [baseUrl, setBaseUrl] = useState('');
  const [authType, setAuthType] = useState<'none' | 'bearer' | 'basic' | 'custom'>('none');
  const [authName, setAuthName] = useState('');
  const [credential, setCredential] = useState<'shared' | 'per_user'>('shared');
  const [saving, setSaving] = useState(false);

  const fg = isDark ? '#F8F8F8' : '#121215';
  const muted = isDark ? '#9b9b9b' : '#6e6e6e';
  const border = isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.12)';
  const inputBg = isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.03)';
  const inputStyle = { height: 44, borderRadius: 11, borderWidth: 1, borderColor: border, backgroundColor: inputBg, paddingHorizontal: 12, fontSize: 14, color: fg, fontFamily: 'Roobert' as const };

  const providerValid =
    (provider === 'openapi' && spec.trim()) ||
    (provider === 'graphql' && endpoint.trim()) ||
    (provider === 'mcp' && url.trim()) ||
    (provider === 'http' && baseUrl.trim());
  const canSave = slug.trim().length > 0 && !!providerValid && !saving;

  const handleSave = async () => {
    if (!canSave) return;
    setSaving(true);
    try {
      const draft: ConnectorDraftInput = {
        slug: slug.trim(),
        provider,
        credential,
        sharing: { mode: 'project' },
        auth: { type: authType, ...(authType === 'custom' ? { name: authName.trim(), in: 'header' } : {}) },
        ...(provider === 'openapi' ? { spec: spec.trim() } : {}),
        ...(provider === 'graphql' ? { endpoint: endpoint.trim(), ...(spec.trim() ? { spec: spec.trim() } : {}) } : {}),
        ...(provider === 'mcp' ? { url: url.trim(), transport } : {}),
        ...(provider === 'http' ? { baseUrl: baseUrl.trim(), ...(spec.trim() ? { spec: spec.trim() } : {}) } : {}),
      };
      await createConnector(projectId, draft);
      queryClient.invalidateQueries({ queryKey: projectKeys.connectors(projectId) });
      haptics.tap();
      onAdded();
    } catch (err: any) {
      Alert.alert('Failed to add', err?.message || 'Could not add connector.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <View style={{ flex: 1 }}>
      <BottomSheetScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16 }} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
        <FormField label="Slug" isDark={isDark}>
          <BottomSheetTextInput
            value={slug}
            onChangeText={(t) => setSlug(t.toLowerCase().replace(/[^a-z0-9_-]/g, '-'))}
            placeholder="my-api"
            placeholderTextColor={muted}
            autoCapitalize="none"
            autoCorrect={false}
            style={[inputStyle, { fontFamily: MONO }]}
          />
        </FormField>

        <FormField label="Provider" isDark={isDark}>
          <Segmented
            isDark={isDark}
            value={provider}
            onChange={setProvider}
            options={[
              { value: 'openapi', label: 'OpenAPI' },
              { value: 'graphql', label: 'GraphQL' },
              { value: 'mcp', label: 'MCP' },
              { value: 'http', label: 'HTTP' },
            ]}
          />
        </FormField>

        {provider === 'openapi' && (
          <FormField label="Spec URL or repo path" isDark={isDark}>
            <BottomSheetTextInput value={spec} onChangeText={setSpec} placeholder="https://…/openapi.json" placeholderTextColor={muted} autoCapitalize="none" autoCorrect={false} style={inputStyle} />
          </FormField>
        )}
        {provider === 'graphql' && (
          <>
            <FormField label="Endpoint" isDark={isDark}>
              <BottomSheetTextInput value={endpoint} onChangeText={setEndpoint} placeholder="https://api/graphql" placeholderTextColor={muted} autoCapitalize="none" autoCorrect={false} style={inputStyle} />
            </FormField>
            <FormField label="SDL spec" optional isDark={isDark}>
              <BottomSheetTextInput value={spec} onChangeText={setSpec} placeholder=".kortix/executor/schema.graphql" placeholderTextColor={muted} autoCapitalize="none" autoCorrect={false} style={inputStyle} />
            </FormField>
          </>
        )}
        {provider === 'mcp' && (
          <>
            <FormField label="URL" isDark={isDark}>
              <BottomSheetTextInput value={url} onChangeText={setUrl} placeholder="https://mcp…/mcp" placeholderTextColor={muted} autoCapitalize="none" autoCorrect={false} style={inputStyle} />
            </FormField>
            <FormField label="Transport" isDark={isDark}>
              <Segmented isDark={isDark} value={transport} onChange={setTransport} options={[{ value: 'http', label: 'http' }, { value: 'sse', label: 'sse' }]} />
            </FormField>
          </>
        )}
        {provider === 'http' && (
          <>
            <FormField label="Base URL" isDark={isDark}>
              <BottomSheetTextInput value={baseUrl} onChangeText={setBaseUrl} placeholder="https://api.internal" placeholderTextColor={muted} autoCapitalize="none" autoCorrect={false} style={inputStyle} />
            </FormField>
            <FormField label="Routes spec" optional isDark={isDark}>
              <BottomSheetTextInput value={spec} onChangeText={setSpec} placeholder=".kortix/executor/routes.toml" placeholderTextColor={muted} autoCapitalize="none" autoCorrect={false} style={inputStyle} />
            </FormField>
          </>
        )}

        <FormField label="Auth" isDark={isDark}>
          <Segmented
            isDark={isDark}
            value={authType}
            onChange={setAuthType}
            options={[
              { value: 'none', label: 'None' },
              { value: 'bearer', label: 'Bearer' },
              { value: 'basic', label: 'Basic' },
              { value: 'custom', label: 'Header' },
            ]}
          />
        </FormField>
        {authType === 'custom' && (
          <FormField label="Header name" isDark={isDark}>
            <BottomSheetTextInput value={authName} onChangeText={setAuthName} placeholder="X-API-Key" placeholderTextColor={muted} autoCapitalize="none" autoCorrect={false} style={inputStyle} />
          </FormField>
        )}
        {authType !== 'none' && (
          <Text style={{ fontSize: 12.5, color: muted, marginTop: -4, marginBottom: 14 }}>
            You'll set the credential value after adding.
          </Text>
        )}

        <FormField label="Credential" isDark={isDark}>
          <Segmented isDark={isDark} value={credential} onChange={setCredential} options={[{ value: 'shared', label: 'Shared' }, { value: 'per_user', label: 'Per-user' }]} />
        </FormField>
        <Text style={{ fontSize: 12.5, color: muted, marginTop: -4 }}>
          {credential === 'shared' ? 'One connection for the whole project.' : 'Each member links their own account.'}
        </Text>
        <Text style={{ fontSize: 12.5, color: muted, marginTop: 14 }}>
          Access is project-wide by default — change it from the connector's Manage screen after adding.
        </Text>
      </BottomSheetScrollView>

      <View style={{ padding: 16, paddingBottom: insets.bottom + 16, borderTopWidth: 1, borderTopColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)' }}>
        <TouchableOpacity
          onPress={handleSave}
          disabled={!canSave}
          activeOpacity={0.8}
          style={{ height: 48, borderRadius: 9999, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 8, backgroundColor: theme.primary, opacity: canSave ? 1 : 0.5 }}
        >
          {saving && <ActivityIndicator size="small" color={theme.primaryForeground} />}
          <Text style={{ fontSize: 15, fontFamily: 'Roobert-Medium', color: theme.primaryForeground }}>Add connector</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

// ─── Set credential (non-Pipedream connectors) ───────────────────────────────

function SetCredentialView({
  projectId,
  connector,
  onBack,
}: {
  projectId: string;
  connector: AdminConnector;
  onBack: () => void;
}) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const insets = useSafeAreaInsets();
  const theme = useThemeColors();
  const queryClient = useQueryClient();
  const [value, setValue] = useState('');
  const [saving, setSaving] = useState(false);

  const fg = isDark ? '#F8F8F8' : '#121215';
  const muted = isDark ? '#9b9b9b' : '#6e6e6e';
  const border = isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.12)';
  const inputBg = isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.03)';

  const handleSave = async () => {
    if (!value.trim() || saving) return;
    setSaving(true);
    try {
      await setConnectorCredential(projectId, connector.slug, value);
      queryClient.invalidateQueries({ queryKey: projectKeys.connectors(projectId) });
      haptics.tap();
      onBack();
    } catch (err: any) {
      Alert.alert('Save failed', err?.message || 'Could not save the credential.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <View style={{ flex: 1 }}>
      <TouchableOpacity
        onPress={() => { haptics.tap(); onBack(); }}
        activeOpacity={0.6}
        style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12, gap: 4 }}
      >
        <ChevronLeft size={18} color={muted} />
        <Text style={{ fontSize: 14, fontFamily: 'Roobert', color: muted }}>{connector.name || connector.slug}</Text>
      </TouchableOpacity>

      <View style={{ paddingHorizontal: 16, paddingBottom: 10, borderBottomWidth: 1, borderBottomColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)' }}>
        <Text style={{ fontSize: 18, fontFamily: 'Roobert-Medium', color: fg }}>Set credential</Text>
      </View>

      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16 }} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
        {connector.authSecret ? (
          <Text style={{ fontSize: 13, color: muted, marginBottom: 14 }}>
            Stored as <Text style={{ fontFamily: MONO, color: fg }}>{connector.authSecret}</Text>.
          </Text>
        ) : null}
        <FormField label="Credential value" isDark={isDark}>
          <TextInput
            value={value}
            onChangeText={setValue}
            placeholder="Paste the secret value…"
            placeholderTextColor={muted}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            style={{ minHeight: 44, borderRadius: 11, borderWidth: 1, borderColor: border, backgroundColor: inputBg, paddingHorizontal: 12, fontSize: 14, color: fg, fontFamily: 'Roobert' }}
          />
        </FormField>
        <Text style={{ fontSize: 12.5, color: muted }}>It's encrypted at rest and never shown again.</Text>
      </ScrollView>

      <View style={{ padding: 16, paddingBottom: insets.bottom + 16, borderTopWidth: 1, borderTopColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)' }}>
        <TouchableOpacity
          onPress={handleSave}
          disabled={!value.trim() || saving}
          activeOpacity={0.8}
          style={{ height: 48, borderRadius: 9999, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 8, backgroundColor: theme.primary, opacity: value.trim() && !saving ? 1 : 0.5 }}
        >
          {saving && <ActivityIndicator size="small" color={theme.primaryForeground} />}
          <Text style={{ fontSize: 15, fontFamily: 'Roobert-Medium', color: theme.primaryForeground }}>Save credential</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

// ─── Policies (tool-approval rules) ──────────────────────────────────────────

const POLICY_ACTIONS: { value: PolicyAction; label: string }[] = [
  { value: 'always_run', label: 'Allow' },
  { value: 'require_approval', label: 'Ask first' },
  { value: 'block', label: 'Block' },
];

const DEFAULT_MODE_OPTIONS: { value: PolicyDefaultMode; label: string; desc: string }[] = [
  { value: 'risk', label: 'Ask before risky actions', desc: 'Write / destructive tools pause for approval' },
  { value: 'allow_all', label: 'Run everything', desc: 'No approval prompts (legacy)' },
];

interface DraftRule { id: string; match: string; action: PolicyAction }
let policyRuleSeq = 0;
const nextRuleId = () => `rule-${++policyRuleSeq}`;

function PoliciesView({ projectId }: { projectId: string }) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const insets = useSafeAreaInsets();
  const theme = useThemeColors();

  const query = useProjectPolicies(projectId);
  const saveMutation = useSetProjectPolicies(projectId);

  const [defaultMode, setDefaultMode] = useState<PolicyDefaultMode>('allow_all');
  const [rules, setRules] = useState<DraftRule[]>([]);
  const [serverSig, setServerSig] = useState('');
  const seededRef = useRef(false);

  useEffect(() => {
    if (!query.data || seededRef.current) return;
    seededRef.current = true;
    setDefaultMode(query.data.defaultMode);
    setRules(query.data.policies.map((p) => ({ id: nextRuleId(), match: p.match, action: p.action })));
    setServerSig(JSON.stringify({ policies: query.data.policies, defaultMode: query.data.defaultMode }));
  }, [query.data]);

  const fg = isDark ? '#F8F8F8' : '#121215';
  const muted = isDark ? '#9b9b9b' : '#6e6e6e';
  const border = isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.12)';
  const inputBg = isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.03)';

  const cleaned = useMemo(
    () => rules.map((r) => ({ match: r.match.trim(), action: r.action })).filter((p) => p.match.length > 0),
    [rules],
  );
  const dirty = JSON.stringify({ policies: cleaned, defaultMode }) !== serverSig;

  const addRule = () => setRules((rows) => [...rows, { id: nextRuleId(), match: '', action: 'require_approval' }]);
  const removeRule = (id: string) => setRules((rows) => rows.filter((r) => r.id !== id));
  const patchRule = (id: string, patch: Partial<DraftRule>) =>
    setRules((rows) => rows.map((r) => (r.id === id ? { ...r, ...patch } : r)));

  const handleSave = () => {
    if (!dirty || saveMutation.isPending) return;
    haptics.tap();
    saveMutation.mutate(
      { policies: cleaned, defaultMode },
      {
        onSuccess: () => setServerSig(JSON.stringify({ policies: cleaned, defaultMode })),
        onError: (err: any) => Alert.alert('Save failed', err?.message || 'Could not save policies.'),
      },
    );
  };

  if (query.isLoading) {
    return <View style={{ paddingVertical: 48, alignItems: 'center' }}><ActivityIndicator size="small" color={muted} /></View>;
  }
  if (query.isError) {
    return (
      <View style={{ padding: 24, alignItems: 'center', gap: 12 }}>
        <Text style={{ fontSize: 14, color: muted, textAlign: 'center' }}>{(query.error as Error)?.message ?? 'Failed to load policies'}</Text>
        <TouchableOpacity onPress={() => query.refetch()} style={{ paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999, borderWidth: 1, borderColor: border }}>
          <Text style={{ fontSize: 13, fontFamily: 'Roobert-Medium', color: fg }}>Retry</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={{ flex: 1 }}>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16 }} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
        <Text style={{ fontSize: 11, fontFamily: 'Roobert-Medium', color: muted, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 }}>Default behavior</Text>
        {DEFAULT_MODE_OPTIONS.map((opt) => {
          const on = defaultMode === opt.value;
          return (
            <TouchableOpacity
              key={opt.value}
              onPress={() => { haptics.selection(); setDefaultMode(opt.value); }}
              activeOpacity={0.7}
              style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, paddingVertical: 12, borderRadius: 14, marginBottom: 8, borderWidth: 1.5, borderColor: on ? theme.primary : border, backgroundColor: on ? theme.primaryLight : 'transparent' }}
            >
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 15, fontFamily: 'Roobert-Medium', color: fg }}>{opt.label}</Text>
                <Text style={{ fontSize: 12.5, color: muted, marginTop: 1 }}>{opt.desc}</Text>
              </View>
              <View style={{ width: 20, height: 20, borderRadius: 10, borderWidth: on ? 0 : 1.5, borderColor: border, backgroundColor: on ? theme.primary : 'transparent', alignItems: 'center', justifyContent: 'center' }}>
                {on && <Check size={13} color="#fff" strokeWidth={3} />}
              </View>
            </TouchableOpacity>
          );
        })}

        <Text style={{ fontSize: 11, fontFamily: 'Roobert-Medium', color: muted, textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 18, marginBottom: 4 }}>Rules</Text>
        <Text style={{ fontSize: 12.5, color: muted, marginBottom: 12 }}>
          Match a tool path (e.g. <Text style={{ fontFamily: MONO, color: fg }}>gmail.*</Text>); first match wins.
        </Text>

        {rules.map((rule) => (
          <View key={rule.id} style={{ borderRadius: 14, borderWidth: 1, borderColor: border, padding: 12, marginBottom: 10 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <TextInput
                value={rule.match}
                onChangeText={(t) => patchRule(rule.id, { match: t })}
                placeholder="match (e.g. gmail.*)"
                placeholderTextColor={muted}
                autoCapitalize="none"
                autoCorrect={false}
                style={{ flex: 1, height: 40, borderRadius: 10, borderWidth: 1, borderColor: border, backgroundColor: inputBg, paddingHorizontal: 10, fontSize: 13, fontFamily: MONO, color: fg }}
              />
              <TouchableOpacity onPress={() => { haptics.medium(); removeRule(rule.id); }} hitSlop={8} style={{ padding: 6 }}>
                <X size={16} color={muted} />
              </TouchableOpacity>
            </View>
            <View style={{ marginTop: 8 }}>
              <Segmented isDark={isDark} value={rule.action} onChange={(v) => patchRule(rule.id, { action: v })} options={POLICY_ACTIONS} />
            </View>
          </View>
        ))}

        <TouchableOpacity
          onPress={() => { haptics.tap(); addRule(); }}
          activeOpacity={0.7}
          style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 11, borderRadius: 9999, borderWidth: 1, borderStyle: 'dashed', borderColor: border, marginTop: 2 }}
        >
          <Plus size={15} color={muted} />
          <Text style={{ fontSize: 13.5, fontFamily: 'Roobert-Medium', color: muted }}>Add rule</Text>
        </TouchableOpacity>
      </ScrollView>

      <View style={{ padding: 16, paddingBottom: insets.bottom + 16, borderTopWidth: 1, borderTopColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)' }}>
        <TouchableOpacity
          onPress={handleSave}
          disabled={!dirty || saveMutation.isPending}
          activeOpacity={0.8}
          style={{ height: 48, borderRadius: 9999, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 8, backgroundColor: theme.primary, opacity: dirty && !saveMutation.isPending ? 1 : 0.5 }}
        >
          {saveMutation.isPending && <ActivityIndicator size="small" color={theme.primaryForeground} />}
          <Text style={{ fontSize: 15, fontFamily: 'Roobert-Medium', color: theme.primaryForeground }}>Save policies</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────

export function ConnectorsPage({
  page,
  projectId,
  onOpenDrawer,
  onOpenRightDrawer,
  isDrawerOpen,
  isRightDrawerOpen,
}: ConnectorsPageProps) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const insets = useSafeAreaInsets();
  const [search, setSearch] = useState('');
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  const [editingSharingSlug, setEditingSharingSlug] = useState<string | null>(null);
  const [credentialSlug, setCredentialSlug] = useState<string | null>(null);
  const [pageTab, setPageTab] = useState<'connectors' | 'policies'>('connectors');
  const addSheetRef = useRef<BottomSheetModal>(null);

  const { data, isLoading, isError, error, refetch } = useConnectors(projectId);
  const syncMutation = useSyncConnectors(projectId);
  const deleteMutation = useDeleteConnector(projectId);

  const bgColor = isDark ? '#090909' : '#FFFFFF';
  const fg = isDark ? '#F8F8F8' : '#121215';
  const muted = isDark ? '#9b9b9b' : '#6e6e6e';
  const border = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)';

  const connectors = data?.connectors ?? [];
  const selected = connectors.find((c) => c.slug === selectedSlug) ?? null;
  const editingSharing = connectors.find((c) => c.slug === editingSharingSlug) ?? null;
  const credentialFor = connectors.find((c) => c.slug === credentialSlug) ?? null;

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return connectors;
    return connectors.filter(
      (c) =>
        c.slug.toLowerCase().includes(q) ||
        c.name.toLowerCase().includes(q) ||
        c.provider.toLowerCase().includes(q),
    );
  }, [connectors, search]);

  const handleSync = useCallback(() => {
    if (syncMutation.isPending) return;
    haptics.tap();
    syncMutation.mutate(undefined, {
      onError: (err: any) => Alert.alert('Sync failed', err?.message || 'Could not sync connectors.'),
    });
  }, [syncMutation]);

  const handleDelete = useCallback((connector: AdminConnector) => {
    Alert.alert(
      'Remove connector',
      `Remove "${connector.name || connector.slug}"? Sessions will lose its tools.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: () => {
            haptics.medium();
            deleteMutation.mutate(connector.slug, {
              onSuccess: () => setSelectedSlug(null),
              onError: (err: any) => Alert.alert('Remove failed', err?.message || 'Could not remove connector.'),
            });
          },
        },
      ],
    );
  }, [deleteMutation]);

  return (
    <View style={{ flex: 1, backgroundColor: bgColor }}>
      <PageHeader
        title={page.label}
        onOpenDrawer={onOpenDrawer}
        onOpenRightDrawer={onOpenRightDrawer}
        isDrawerOpen={isDrawerOpen}
        isRightDrawerOpen={isRightDrawerOpen}
        rightActions={
          !selected && pageTab === 'connectors' ? (
            <TouchableOpacity onPress={handleSync} className="p-1 mr-1" hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              {syncMutation.isPending ? (
                <ActivityIndicator size="small" color={muted} />
              ) : (
                <RefreshCw size={18} color={isDark ? '#F8F8F8' : '#121215'} />
              )}
            </TouchableOpacity>
          ) : undefined
        }
      />

      <PageContent>
        {editingSharing ? (
          <SharingEditor
            projectId={projectId}
            connector={editingSharing}
            onBack={() => setEditingSharingSlug(null)}
          />
        ) : credentialFor ? (
          <SetCredentialView
            projectId={projectId}
            connector={credentialFor}
            onBack={() => setCredentialSlug(null)}
          />
        ) : selected ? (
          <ConnectorDetail
            connector={selected}
            onBack={() => setSelectedSlug(null)}
            onDelete={() => handleDelete(selected)}
            onEditSharing={() => setEditingSharingSlug(selected.slug)}
            onSetCredential={() => setCredentialSlug(selected.slug)}
            deleting={deleteMutation.isPending}
          />
        ) : (
          <>
            <View style={{ paddingHorizontal: 16, paddingTop: 8, paddingBottom: 4 }}>
              <Segmented
                isDark={isDark}
                value={pageTab}
                onChange={setPageTab}
                options={[{ value: 'connectors', label: 'Connectors' }, { value: 'policies', label: 'Policies' }]}
              />
            </View>
            {pageTab === 'policies' ? (
              <PoliciesView projectId={projectId} />
            ) : (
              <>
            <SearchListHeader value={search} onChangeText={setSearch} placeholder="Search connectors" onAdd={() => { haptics.tap(); addSheetRef.current?.present(); }} />

            <ScrollView
              style={{ flex: 1 }}
              contentContainerStyle={{ paddingBottom: insets.bottom + 40 }}
              showsVerticalScrollIndicator={false}
              keyboardShouldPersistTaps="handled"
            >
              {isLoading ? (
                <View style={{ paddingVertical: 48, alignItems: 'center' }}>
                  <ActivityIndicator size="small" color={muted} />
                </View>
              ) : isError ? (
                <View style={{ padding: 24, alignItems: 'center', gap: 12 }}>
                  <Text style={{ fontSize: 14, color: muted, textAlign: 'center' }}>
                    {(error as Error)?.message ?? 'Failed to load connectors'}
                  </Text>
                  <TouchableOpacity onPress={() => refetch()} style={{ paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999, borderWidth: 1, borderColor: border }}>
                    <Text style={{ fontSize: 13, fontFamily: 'Roobert-Medium', color: fg }}>Retry</Text>
                  </TouchableOpacity>
                </View>
              ) : filtered.length === 0 ? (
                <View style={{ padding: 40, alignItems: 'center', gap: 10 }}>
                  <Plug size={26} color={muted} />
                  <Text style={{ fontSize: 14, color: muted, textAlign: 'center' }}>
                    {connectors.length === 0 ? 'No connectors yet.' : 'No connectors match your search.'}
                  </Text>
                </View>
              ) : (
                filtered.map((connector, i) => (
                  <View key={connector.slug}>
                    <ConnectorRow
                      connector={connector}
                      isDark={isDark}
                      onPress={() => { haptics.tap(); setSelectedSlug(connector.slug); }}
                    />
                    {i < filtered.length - 1 && (
                      <View style={{ height: 1, backgroundColor: border, marginLeft: 66 }} />
                    )}
                  </View>
                ))
              )}
            </ScrollView>
              </>
            )}
          </>
        )}
      </PageContent>

      <BottomSheetModal
        ref={addSheetRef}
        snapPoints={['92%']}
        enableDynamicSizing={false}
        backgroundStyle={{ backgroundColor: getSheetBg(isDark) }}
        handleIndicatorStyle={{ backgroundColor: isDark ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.2)' }}
        keyboardBehavior="interactive"
        keyboardBlurBehavior="restore"
        backdropComponent={(props) => (
          <BottomSheetBackdrop {...props} disappearsOnIndex={-1} appearsOnIndex={0} opacity={0.5} />
        )}
      >
        <AddConnectorView projectId={projectId} onClose={() => addSheetRef.current?.dismiss()} />
      </BottomSheetModal>
    </View>
  );
}
