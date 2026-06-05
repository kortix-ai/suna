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

import React, { useMemo, useState, useCallback } from 'react';
import {
  View,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { useColorScheme } from 'nativewind';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  Zap,
  Boxes,
  Globe,
  ChevronRight,
  ChevronLeft,
  RefreshCw,
  Trash2,
  Plug,
  type LucideIcon,
} from 'lucide-react-native';
import { Text } from '@/components/ui/text';
import { PageHeader } from '@/components/ui/page-header';
import { PageContent } from '@/components/ui/page-content';
import { SearchListHeader } from '@/components/ui/search-list-header';
import { useConnectors, useSyncConnectors, useDeleteConnector } from '@/lib/projects/hooks';
import type { AdminConnector, ConnectorAction, ConnectorProvider } from '@/lib/projects/projects-client';
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
  deleting,
}: {
  connector: AdminConnector;
  onBack: () => void;
  onDelete: () => void;
  deleting: boolean;
}) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const insets = useSafeAreaInsets();

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
          <View style={{ borderRadius: 12, borderWidth: 1, borderColor: 'rgba(245,158,11,0.3)', backgroundColor: 'rgba(245,158,11,0.08)', padding: 12, marginBottom: 16 }}>
            <Text style={{ fontSize: 13, color: isDark ? '#fbbf24' : '#b45309' }}>
              This connector needs a credential before it can run.
            </Text>
          </View>
        )}

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
          style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, marginTop: 24, paddingVertical: 12, borderRadius: 12, borderWidth: 1, borderColor: 'rgba(239,68,68,0.4)', opacity: deleting ? 0.5 : 1 }}
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

  const { data, isLoading, isError, error, refetch } = useConnectors(projectId);
  const syncMutation = useSyncConnectors(projectId);
  const deleteMutation = useDeleteConnector(projectId);

  const bgColor = isDark ? '#090909' : '#FFFFFF';
  const fg = isDark ? '#F8F8F8' : '#121215';
  const muted = isDark ? '#9b9b9b' : '#6e6e6e';
  const border = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)';

  const connectors = data?.connectors ?? [];
  const selected = connectors.find((c) => c.slug === selectedSlug) ?? null;

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
          !selected ? (
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
        {selected ? (
          <ConnectorDetail
            connector={selected}
            onBack={() => setSelectedSlug(null)}
            onDelete={() => handleDelete(selected)}
            deleting={deleteMutation.isPending}
          />
        ) : (
          <>
            <SearchListHeader value={search} onChangeText={setSearch} placeholder="Search connectors" />

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
      </PageContent>
    </View>
  );
}
