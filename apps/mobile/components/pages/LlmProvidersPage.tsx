/**
 * Project-scoped harness credentials and model catalog.
 *
 * All reads and writes go through @kortix/sdk. The screen never addresses a
 * sandbox or a harness-native provider API; readiness and active routing are
 * authoritative on the Kortix project control plane.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Linking,
  RefreshControl,
  ScrollView,
  TouchableOpacity,
  View,
} from 'react-native';
import {
  BottomSheetBackdrop,
  BottomSheetModal,
  BottomSheetScrollView,
  BottomSheetTextInput,
  BottomSheetView,
  TouchableOpacity as BottomSheetTouchable,
} from '@gorhom/bottom-sheet';
import type { BottomSheetBackdropProps } from '@gorhom/bottom-sheet';
import { useQueryClient } from '@tanstack/react-query';
import {
  deleteProjectSecret,
  pollProjectProviderOAuth,
  setActiveHarnessConnection,
  startProjectProviderOAuth,
  upsertProjectSecret,
  type HarnessAuthKind,
  type HarnessConnection,
  type HarnessId,
} from '@kortix/sdk';
import {
  invalidateComposerCapabilityQueries,
  useComposerModelCatalog,
  useHarnessConnections,
  useRuntimeAgents,
} from '@kortix/sdk/react';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useColorScheme } from 'nativewind';
import { Check, Cpu, ExternalLink, KeyRound, Plus, Unplug } from 'lucide-react-native';

import { ProviderLogo } from '@/components/providers/ProviderLogo';
import { PageContent } from '@/components/ui/page-content';
import { PageHeader } from '@/components/ui/page-header';
import { SearchBar } from '@/components/ui/SearchBar';
import { Text } from '@/components/ui/text';
import { useSheetBottomPadding } from '@/hooks/useSheetKeyboard';
import { haptics } from '@/lib/haptics';
import {
  compatibleHarnessesWithoutActiveRoute,
  customProviderSecretWrites,
  PROJECT_PROVIDER_CONNECTION_BY_ID,
  PROJECT_PROVIDER_CONNECTIONS,
  secretWritesForConnection,
  type ProjectProviderConnectionDefinition,
} from '@/lib/providers/project-provider-auth';
import { getSheetBg, getToggleActiveBg, getToggleTrackBg, useThemeColors } from '@/lib/theme-colors';
import type { PageTab } from '@/stores/tab-store';

interface LlmProvidersPageProps {
  page: PageTab;
  projectId?: string | null;
  onBack: () => void;
  onOpenDrawer?: () => void;
  onOpenRightDrawer?: () => void;
  isDrawerOpen?: boolean;
  isRightDrawerOpen?: boolean;
}

type Tab = 'providers' | 'connected' | 'models';

interface ProviderRowModel {
  definition: ProjectProviderConnectionDefinition;
  connection: HarnessConnection | null;
}

const monoFont = 'Menlo';

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function harnessLabel(harness: HarnessId) {
  if (harness === 'opencode') return 'OpenCode';
  if (harness === 'pi') return 'Pi';
  return `${harness[0].toUpperCase()}${harness.slice(1)}`;
}

function connectionStatus(row: ProviderRowModel) {
  if (row.connection?.ready) return 'Connected';
  if (row.connection?.configured) return row.connection.reason || 'Needs attention';
  return 'Not connected';
}

function ProviderRow({
  row,
  isDark,
  onConnect,
  onDisconnect,
  onActivate,
}: {
  row: ProviderRowModel;
  isDark: boolean;
  onConnect: (row: ProviderRowModel) => void;
  onDisconnect: (row: ProviderRowModel) => void;
  onActivate: (row: ProviderRowModel) => void;
}) {
  const theme = useThemeColors();
  const fg = isDark ? '#F8F8F8' : '#121215';
  const muted = isDark ? '#71717a' : '#71717a';
  const border = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)';
  const ready = row.connection?.ready === true;
  const activeFor = row.connection?.active_for ?? [];
  const allActive = row.definition.compatibleHarnesses.every((harness) => activeFor.includes(harness));

  return (
    <View style={{ borderBottomWidth: 1, borderBottomColor: border, paddingHorizontal: 16, paddingVertical: 13 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <ProviderLogo providerID={row.definition.providerId} name={row.definition.label} size={38} />
        <View style={{ minWidth: 0, flex: 1 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <Text numberOfLines={1} style={{ flexShrink: 1, color: fg, fontFamily: 'Roobert-Medium', fontSize: 14 }}>
              {row.definition.label}
            </Text>
            {ready ? <Check size={14} color="#34d399" strokeWidth={2.5} /> : null}
          </View>
          <Text style={{ marginTop: 2, color: muted, fontFamily: 'Roobert', fontSize: 11 }}>
            {connectionStatus(row)} · {row.definition.compatibleHarnesses.map(harnessLabel).join(', ')}
          </Text>
          <Text numberOfLines={2} style={{ marginTop: 3, color: muted, fontFamily: 'Roobert', fontSize: 11, lineHeight: 15 }}>
            {row.definition.description}
          </Text>
        </View>
      </View>

      <View style={{ marginTop: 10, flexDirection: 'row', justifyContent: 'flex-end', gap: 8 }}>
        {ready && !allActive ? (
          <TouchableOpacity
            onPress={() => onActivate(row)}
            style={{ borderRadius: 9999, borderWidth: 1, borderColor: border, paddingHorizontal: 12, paddingVertical: 7 }}
          >
            <Text style={{ color: fg, fontFamily: 'Roobert-Medium', fontSize: 11 }}>Use for harnesses</Text>
          </TouchableOpacity>
        ) : null}
        {ready && row.definition.mode !== 'managed' ? (
          <TouchableOpacity
            onPress={() => onDisconnect(row)}
            style={{ flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 10, paddingVertical: 7 }}
          >
            <Unplug size={13} color={isDark ? '#f87171' : '#dc2626'} />
            <Text style={{ color: isDark ? '#f87171' : '#dc2626', fontFamily: 'Roobert-Medium', fontSize: 11 }}>
              Disconnect
            </Text>
          </TouchableOpacity>
        ) : row.definition.mode !== 'managed' && row.definition.mode !== 'native' ? (
          <TouchableOpacity
            onPress={() => onConnect(row)}
            style={{ flexDirection: 'row', alignItems: 'center', borderRadius: 9999, backgroundColor: theme.primary, paddingHorizontal: 12, paddingVertical: 7 }}
          >
            <Plus size={12} color={theme.primaryForeground} style={{ marginRight: 4 }} />
            <Text style={{ color: theme.primaryForeground, fontFamily: 'Roobert-Medium', fontSize: 11 }}>Connect</Text>
          </TouchableOpacity>
        ) : null}
      </View>
    </View>
  );
}

export function LlmProvidersPage({
  page,
  projectId,
  onBack,
  onOpenDrawer,
  onOpenRightDrawer,
  isDrawerOpen,
  isRightDrawerOpen,
}: LlmProvidersPageProps) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const insets = useSafeAreaInsets();
  const sheetPadding = useSheetBottomPadding();
  const queryClient = useQueryClient();
  const theme = useThemeColors();
  const fg = isDark ? '#F8F8F8' : '#121215';
  const muted = isDark ? '#71717a' : '#71717a';
  const border = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)';
  const sheetBg = getSheetBg(isDark);
  const inputBorder = isDark ? 'rgba(248,248,248,0.1)' : 'rgba(18,18,21,0.08)';

  const connectionsQuery = useHarnessConnections(projectId);
  const agentsQuery = useRuntimeAgents({ projectId });
  const [selectedAgentName, setSelectedAgentName] = useState<string | null>(null);
  useEffect(() => {
    const visible = (agentsQuery.data ?? []).filter((agent) => !agent.hidden);
    if (!visible.length) return;
    if (!selectedAgentName || !visible.some((agent) => agent.name === selectedAgentName)) {
      setSelectedAgentName(visible[0].name);
    }
  }, [agentsQuery.data, selectedAgentName]);
  const modelCatalogQuery = useComposerModelCatalog(projectId, selectedAgentName);

  const rows = useMemo<ProviderRowModel[]>(() => {
    const server = new Map((connectionsQuery.data?.connections ?? []).map((item) => [item.id, item]));
    return PROJECT_PROVIDER_CONNECTIONS.map((definition) => ({
      definition,
      connection: server.get(definition.id) ?? null,
    })).filter((row) => row.connection || row.definition.mode !== 'native');
  }, [connectionsQuery.data?.connections]);

  const [activeTab, setActiveTab] = useState<Tab>('providers');
  const [searchQuery, setSearchQuery] = useState('');
  const [target, setTarget] = useState<ProviderRowModel | null>(null);
  const [credential, setCredential] = useState('');
  const [saving, setSaving] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [oauthCode, setOauthCode] = useState<string | null>(null);
  const [oauthUrl, setOauthUrl] = useState<string | null>(null);
  const oauthCancelledRef = useRef(false);
  const connectSheetRef = useRef<BottomSheetModal>(null);
  const disconnectSheetRef = useRef<BottomSheetModal>(null);
  const customSheetRef = useRef<BottomSheetModal>(null);
  const [customBaseUrl, setCustomBaseUrl] = useState('');
  const [customModelId, setCustomModelId] = useState('');
  const [customName, setCustomName] = useState('Custom model');
  const [customApiKey, setCustomApiKey] = useState('');

  const invalidate = useCallback(async () => {
    if (!projectId) return;
    await invalidateComposerCapabilityQueries(queryClient, projectId);
    await connectionsQuery.refetch();
    await modelCatalogQuery.refetch();
  }, [connectionsQuery, modelCatalogQuery, projectId, queryClient]);

  const activate = useCallback(async (row: ProviderRowModel) => {
    if (!projectId || !row.connection?.ready) return;
    try {
      await Promise.all(
        row.definition.compatibleHarnesses.map((harness) =>
          setActiveHarnessConnection(projectId, harness, row.definition.id),
        ),
      );
      haptics.success();
      await invalidate();
    } catch (error) {
      haptics.warning();
      Alert.alert('Could not activate connection', error instanceof Error ? error.message : 'Unknown error');
    }
  }, [invalidate, projectId]);

  const openConnect = useCallback((row: ProviderRowModel) => {
    setTarget(row);
    setCredential('');
    setOauthCode(null);
    setOauthUrl(null);
    oauthCancelledRef.current = false;
    haptics.medium();
    if (row.definition.mode === 'custom') customSheetRef.current?.present();
    else connectSheetRef.current?.present();
  }, []);

  const saveCredential = useCallback(async () => {
    if (!projectId || !target) return;
    setSaving(true);
    try {
      for (const write of secretWritesForConnection(target.definition.id, credential)) {
        await upsertProjectSecret(projectId, write);
      }
      await invalidate();
      const refreshed = PROJECT_PROVIDER_CONNECTION_BY_ID.get(target.definition.id);
      if (refreshed) {
        const harnesses = compatibleHarnessesWithoutActiveRoute(
          refreshed,
          connectionsQuery.data?.connections ?? [],
        );
        await Promise.all(
          harnesses.map((harness) =>
            setActiveHarnessConnection(projectId, harness, refreshed.id),
          ),
        );
      }
      haptics.success();
      connectSheetRef.current?.dismiss();
      await invalidate();
    } catch (error) {
      haptics.warning();
      Alert.alert('Could not connect provider', error instanceof Error ? error.message : 'Unknown error');
    } finally {
      setSaving(false);
    }
  }, [connectionsQuery.data?.connections, credential, invalidate, projectId, target]);

  const startCodexOAuth = useCallback(async () => {
    if (!projectId || target?.definition.id !== 'codex_subscription') return;
    setSaving(true);
    oauthCancelledRef.current = false;
    try {
      const start = await startProjectProviderOAuth(projectId, 'openai');
      setOauthCode(start.user_code);
      setOauthUrl(start.verification_url);
      if (start.verification_url) await Linking.openURL(start.verification_url);
      const cadence = Math.max(2_000, start.interval_ms || 3_000);
      const deadline = start.expires_at || Date.now() + 10 * 60_000;
      while (!oauthCancelledRef.current && Date.now() < deadline) {
        await sleep(cadence);
        if (oauthCancelledRef.current) return;
        const result = await pollProjectProviderOAuth(projectId, 'openai', start.flow_id);
        if (result.status === 'pending') continue;
        if (result.status === 'success') {
          await invalidate();
          const codexUnbound = compatibleHarnessesWithoutActiveRoute(
            PROJECT_PROVIDER_CONNECTION_BY_ID.get('codex_subscription')!,
            connectionsQuery.data?.connections ?? [],
          );
          if (codexUnbound.includes('codex')) {
            await setActiveHarnessConnection(projectId, 'codex', 'codex_subscription');
          }
          haptics.success();
          connectSheetRef.current?.dismiss();
          await invalidate();
          return;
        }
        throw new Error(result.status === 'failed' ? result.error : 'Authorization expired. Try again.');
      }
      if (!oauthCancelledRef.current) throw new Error('Authorization timed out. Try again.');
    } catch (error) {
      if (!oauthCancelledRef.current) {
        haptics.warning();
        Alert.alert('Could not connect Codex', error instanceof Error ? error.message : 'Unknown error');
      }
    } finally {
      setSaving(false);
    }
  }, [connectionsQuery.data?.connections, invalidate, projectId, target?.definition.id]);

  const disconnect = useCallback(async () => {
    if (!projectId || !target) return;
    setDisconnecting(true);
    try {
      for (const secretName of target.definition.secretNames) {
        await deleteProjectSecret(projectId, secretName).catch(() => undefined);
      }
      for (const harness of target.connection?.active_for ?? []) {
        await setActiveHarnessConnection(projectId, harness, null);
      }
      haptics.success();
      disconnectSheetRef.current?.dismiss();
      await invalidate();
    } catch (error) {
      haptics.warning();
      Alert.alert('Could not disconnect provider', error instanceof Error ? error.message : 'Unknown error');
    } finally {
      setDisconnecting(false);
    }
  }, [invalidate, projectId, target]);

  const saveCustom = useCallback(async () => {
    if (!projectId || !target) return;
    if (!customBaseUrl.trim() || !customModelId.trim()) {
      Alert.alert('Missing fields', 'Base URL and model ID are required.');
      return;
    }
    setSaving(true);
    try {
      const protocol = target.definition.id === 'anthropic_compatible' ? 'anthropic' : 'openai';
      for (const write of customProviderSecretWrites({
        protocol,
        baseUrl: customBaseUrl,
        apiKey: customApiKey,
        modelId: customModelId,
        name: customName || 'Custom model',
      })) {
        await upsertProjectSecret(projectId, write);
      }
      await invalidate();
      const harnesses = compatibleHarnessesWithoutActiveRoute(
        target.definition,
        connectionsQuery.data?.connections ?? [],
      );
      await Promise.all(
        harnesses.map((harness) =>
          setActiveHarnessConnection(projectId, harness, target.definition.id),
        ),
      );
      haptics.success();
      customSheetRef.current?.dismiss();
      await invalidate();
    } catch (error) {
      haptics.warning();
      Alert.alert('Could not save custom provider', error instanceof Error ? error.message : 'Unknown error');
    } finally {
      setSaving(false);
    }
  }, [connectionsQuery.data?.connections, customApiKey, customBaseUrl, customModelId, customName, invalidate, projectId, target]);

  const renderBackdrop = useCallback((props: BottomSheetBackdropProps) => (
    <BottomSheetBackdrop {...props} disappearsOnIndex={-1} appearsOnIndex={0} opacity={0.5} pressBehavior="close" />
  ), []);
  const sheetStyles = useMemo(() => ({
    backgroundStyle: { backgroundColor: sheetBg },
    handleIndicatorStyle: { backgroundColor: isDark ? '#52525b' : '#d4d4d8', width: 32 },
  }), [isDark, sheetBg]);

  const filteredRows = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    const source = activeTab === 'connected' ? rows.filter((row) => row.connection?.ready) : rows;
    if (!query) return source;
    return source.filter((row) =>
      `${row.definition.label} ${row.definition.description} ${row.definition.compatibleHarnesses.join(' ')}`
        .toLowerCase()
        .includes(query),
    );
  }, [activeTab, rows, searchQuery]);
  const readyCount = rows.filter((row) => row.connection?.ready).length;
  const models = modelCatalogQuery.data?.models ?? [];

  return (
    <View style={{ flex: 1 }}>
      <PageHeader
        title="Models & authentication"
        onOpenDrawer={onOpenDrawer}
        onOpenRightDrawer={onOpenRightDrawer}
        isDrawerOpen={isDrawerOpen}
        isRightDrawerOpen={isRightDrawerOpen}
      />
      <PageContent>
        {!projectId ? (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32 }}>
            <KeyRound size={32} color={muted} style={{ marginBottom: 12 }} />
            <Text style={{ color: fg, fontFamily: 'Roobert-Medium', fontSize: 15 }}>Open a project to manage models</Text>
            <Text style={{ marginTop: 6, textAlign: 'center', color: muted, fontFamily: 'Roobert', fontSize: 12, lineHeight: 18 }}>
              Provider credentials and harness routing are project-scoped. Select a project first so nothing is written to an unrelated sandbox.
            </Text>
          </View>
        ) : (
          <>
            <View style={{ marginTop: -8, borderBottomWidth: 1, borderBottomColor: border, paddingHorizontal: 16, paddingBottom: 12 }}>
              <View style={{ flexDirection: 'row', borderRadius: 9999, backgroundColor: getToggleTrackBg(isDark), padding: 3 }}>
                {([
                  { id: 'providers' as Tab, label: 'Connections' },
                  { id: 'connected' as Tab, label: `Connected (${readyCount})` },
                  { id: 'models' as Tab, label: 'Models' },
                ]).map((tab) => {
                  const active = tab.id === activeTab;
                  return (
                    <TouchableOpacity
                      key={tab.id}
                      onPress={() => { haptics.selection(); setActiveTab(tab.id); setSearchQuery(''); }}
                      style={{ flex: 1, alignItems: 'center', borderRadius: 9999, backgroundColor: active ? getToggleActiveBg(isDark) : 'transparent', paddingVertical: 7 }}
                    >
                      <Text style={{ color: active ? fg : muted, fontFamily: active ? 'Roobert-Medium' : 'Roobert', fontSize: 12 }}>{tab.label}</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
              {activeTab !== 'models' ? (
                <View style={{ marginTop: 10 }}>
                  <SearchBar value={searchQuery} onChangeText={setSearchQuery} placeholder="Search connections" onClear={() => setSearchQuery('')} />
                </View>
              ) : null}
            </View>

            {activeTab === 'models' ? (
              <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 80 }} refreshControl={<RefreshControl refreshing={modelCatalogQuery.isFetching} onRefresh={() => modelCatalogQuery.refetch()} tintColor={muted} />}>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingHorizontal: 16, paddingVertical: 12 }}>
                  {(agentsQuery.data ?? []).filter((agent) => !agent.hidden).map((agent) => {
                    const selected = selectedAgentName === agent.name;
                    return (
                      <TouchableOpacity
                        key={agent.name}
                        onPress={() => setSelectedAgentName(agent.name)}
                        style={{ borderRadius: 9999, borderWidth: 1, borderColor: selected ? theme.primary : border, backgroundColor: selected ? getToggleActiveBg(isDark) : 'transparent', paddingHorizontal: 12, paddingVertical: 7 }}
                      >
                        <Text style={{ color: selected ? fg : muted, fontFamily: 'Roobert-Medium', fontSize: 11 }}>
                          {agent.name} · {agent.harness ?? agent.runtime ?? 'runtime'}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </ScrollView>
                {modelCatalogQuery.isLoading ? (
                  <View style={{ alignItems: 'center', padding: 40 }}><ActivityIndicator color={muted} /></View>
                ) : models.length ? models.map((model) => (
                  <View key={model.id} style={{ borderBottomWidth: 1, borderBottomColor: border, paddingHorizontal: 16, paddingVertical: 11 }}>
                    <Text style={{ color: fg, fontFamily: 'Roobert-Medium', fontSize: 13 }}>{model.name}</Text>
                    <Text style={{ marginTop: 2, color: muted, fontFamily: monoFont, fontSize: 10 }}>{model.id} · {model.source}</Text>
                  </View>
                )) : (
                  <View style={{ alignItems: 'center', padding: 40 }}>
                    <Cpu size={30} color={muted} style={{ marginBottom: 10 }} />
                    <Text style={{ color: fg, fontFamily: 'Roobert-Medium', fontSize: 14 }}>No preset models for this route</Text>
                    <Text style={{ marginTop: 5, textAlign: 'center', color: muted, fontFamily: 'Roobert', fontSize: 12 }}>
                      This harness may accept a custom model ID at session creation.
                    </Text>
                  </View>
                )}
              </ScrollView>
            ) : (
              <ScrollView
                refreshControl={<RefreshControl refreshing={connectionsQuery.isFetching} onRefresh={() => connectionsQuery.refetch()} tintColor={muted} />}
                contentContainerStyle={{ paddingBottom: insets.bottom + 80 }}
              >
                {connectionsQuery.isLoading ? (
                  <View style={{ alignItems: 'center', padding: 40 }}><ActivityIndicator color={muted} /></View>
                ) : filteredRows.length ? filteredRows.map((row) => (
                  <ProviderRow
                    key={row.definition.id}
                    row={row}
                    isDark={isDark}
                    onConnect={openConnect}
                    onDisconnect={(next) => { setTarget(next); disconnectSheetRef.current?.present(); }}
                    onActivate={activate}
                  />
                )) : (
                  <View style={{ alignItems: 'center', padding: 40 }}>
                    <Cpu size={30} color={muted} style={{ marginBottom: 10 }} />
                    <Text style={{ color: fg, fontFamily: 'Roobert-Medium', fontSize: 14 }}>
                      {searchQuery ? 'No connections match' : 'No connected providers'}
                    </Text>
                  </View>
                )}
              </ScrollView>
            )}
          </>
        )}
      </PageContent>

      <BottomSheetModal
        ref={connectSheetRef}
        enableDynamicSizing
        enablePanDownToClose
        backdropComponent={renderBackdrop}
        keyboardBehavior="interactive"
        keyboardBlurBehavior="restore"
        android_keyboardInputMode="adjustResize"
        onDismiss={() => { oauthCancelledRef.current = true; setTarget(null); setCredential(''); setOauthCode(null); setOauthUrl(null); }}
        {...sheetStyles}
      >
        <BottomSheetView style={{ paddingHorizontal: 24, paddingTop: 8, paddingBottom: sheetPadding }}>
          <Text style={{ color: fg, fontFamily: 'Roobert-SemiBold', fontSize: 18 }}>{target?.definition.label ?? 'Connect provider'}</Text>
          <Text style={{ marginTop: 5, color: muted, fontFamily: 'Roobert', fontSize: 12, lineHeight: 18 }}>{target?.definition.description}</Text>
          {target?.definition.id === 'claude_subscription' ? (
            <Text style={{ marginTop: 12, color: muted, fontFamily: 'Roobert', fontSize: 12, lineHeight: 18 }}>
              Run `claude setup-token` locally and paste the long-lived token. It is encrypted and never shown again.
            </Text>
          ) : null}
          {target?.definition.mode === 'oauth' ? (
            <View style={{ marginTop: 16 }}>
              {oauthCode ? (
                <View style={{ borderRadius: 10, borderWidth: 1, borderColor: border, padding: 14 }}>
                  <Text style={{ color: muted, fontFamily: 'Roobert', fontSize: 11 }}>Enter this code in the browser</Text>
                  <Text style={{ marginTop: 6, color: fg, fontFamily: monoFont, fontSize: 20 }}>{oauthCode}</Text>
                  {oauthUrl ? (
                    <TouchableOpacity onPress={() => Linking.openURL(oauthUrl)} style={{ marginTop: 10, flexDirection: 'row', alignItems: 'center', gap: 5 }}>
                      <ExternalLink size={13} color={theme.primary} />
                      <Text style={{ color: theme.primary, fontFamily: 'Roobert-Medium', fontSize: 12 }}>Open authorization page</Text>
                    </TouchableOpacity>
                  ) : null}
                </View>
              ) : null}
              <BottomSheetTouchable
                onPress={startCodexOAuth}
                disabled={saving}
                style={{ marginTop: 14, alignItems: 'center', borderRadius: 9999, backgroundColor: theme.primary, paddingVertical: 14, opacity: saving ? 0.6 : 1 }}
              >
                <Text style={{ color: theme.primaryForeground, fontFamily: 'Roobert-SemiBold', fontSize: 15 }}>{saving ? 'Waiting for authorization…' : 'Connect ChatGPT'}</Text>
              </BottomSheetTouchable>
            </View>
          ) : (
            <>
              <BottomSheetTextInput
                value={credential}
                onChangeText={setCredential}
                placeholder={target?.definition.placeholder ?? 'Paste credential'}
                placeholderTextColor={muted}
                autoCapitalize="none"
                autoCorrect={false}
                secureTextEntry
                style={{ marginTop: 16, marginBottom: 16, borderRadius: 14, borderWidth: 1, borderColor: inputBorder, paddingHorizontal: 16, paddingVertical: 13, color: fg, fontFamily: monoFont, fontSize: 14 }}
              />
              <BottomSheetTouchable
                onPress={saveCredential}
                disabled={!credential.trim() || saving}
                style={{ alignItems: 'center', borderRadius: 9999, backgroundColor: credential.trim() ? theme.primary : getToggleTrackBg(isDark), paddingVertical: 14, opacity: saving ? 0.6 : 1 }}
              >
                <Text style={{ color: credential.trim() ? theme.primaryForeground : muted, fontFamily: 'Roobert-SemiBold', fontSize: 15 }}>{saving ? 'Connecting…' : 'Connect'}</Text>
              </BottomSheetTouchable>
            </>
          )}
          {target?.definition.helpUrl ? (
            <TouchableOpacity onPress={() => Linking.openURL(target.definition.helpUrl!)} style={{ marginTop: 14, flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 5 }}>
              <ExternalLink size={13} color={muted} />
              <Text style={{ color: muted, fontFamily: 'Roobert', fontSize: 12 }}>Authentication documentation</Text>
            </TouchableOpacity>
          ) : null}
        </BottomSheetView>
      </BottomSheetModal>

      <BottomSheetModal ref={disconnectSheetRef} enableDynamicSizing enablePanDownToClose backdropComponent={renderBackdrop} {...sheetStyles}>
        <BottomSheetView style={{ paddingHorizontal: 24, paddingTop: 8, paddingBottom: sheetPadding }}>
          <Text style={{ color: fg, fontFamily: 'Roobert-SemiBold', fontSize: 18 }}>Disconnect {target?.definition.label ?? 'provider'}?</Text>
          <Text style={{ marginTop: 8, color: muted, fontFamily: 'Roobert', fontSize: 12, lineHeight: 18 }}>
            Project credentials will be removed and active harness routes using this connection will be cleared.
          </Text>
          <View style={{ marginTop: 18, flexDirection: 'row', gap: 10 }}>
            <BottomSheetTouchable onPress={() => disconnectSheetRef.current?.dismiss()} style={{ flex: 1, alignItems: 'center', borderRadius: 9999, borderWidth: 1, borderColor: border, paddingVertical: 13 }}>
              <Text style={{ color: fg, fontFamily: 'Roobert-SemiBold', fontSize: 14 }}>Cancel</Text>
            </BottomSheetTouchable>
            <BottomSheetTouchable onPress={disconnect} disabled={disconnecting} style={{ flex: 1, alignItems: 'center', borderRadius: 9999, backgroundColor: isDark ? '#dc2626' : '#ef4444', paddingVertical: 13, opacity: disconnecting ? 0.6 : 1 }}>
              <Text style={{ color: '#FFFFFF', fontFamily: 'Roobert-SemiBold', fontSize: 14 }}>{disconnecting ? 'Disconnecting…' : 'Disconnect'}</Text>
            </BottomSheetTouchable>
          </View>
        </BottomSheetView>
      </BottomSheetModal>

      <BottomSheetModal ref={customSheetRef} snapPoints={['78%']} enableDynamicSizing={false} enablePanDownToClose backdropComponent={renderBackdrop} keyboardBehavior="interactive" {...sheetStyles}>
        <BottomSheetScrollView contentContainerStyle={{ paddingHorizontal: 24, paddingTop: 8, paddingBottom: sheetPadding }} keyboardShouldPersistTaps="handled">
          <Text style={{ color: fg, fontFamily: 'Roobert-SemiBold', fontSize: 18 }}>{target?.definition.label ?? 'Custom provider'}</Text>
          <Text style={{ marginTop: 5, marginBottom: 16, color: muted, fontFamily: 'Roobert', fontSize: 12 }}>Stored project-wide and available to compatible harnesses.</Text>
          {[
            { label: 'Display name', value: customName, set: setCustomName, placeholder: 'Custom model', secure: false },
            { label: 'Base URL', value: customBaseUrl, set: setCustomBaseUrl, placeholder: 'https://api.example.com/v1', secure: false },
            { label: 'Model ID', value: customModelId, set: setCustomModelId, placeholder: 'model-name', secure: false },
            { label: 'API key', value: customApiKey, set: setCustomApiKey, placeholder: 'Optional', secure: true },
          ].map((field) => (
            <View key={field.label} style={{ marginBottom: 14 }}>
              <Text style={{ marginBottom: 6, color: muted, fontFamily: 'Roobert-Medium', fontSize: 12 }}>{field.label}</Text>
              <BottomSheetTextInput
                value={field.value}
                onChangeText={field.set}
                placeholder={field.placeholder}
                placeholderTextColor={muted}
                autoCapitalize="none"
                autoCorrect={false}
                secureTextEntry={field.secure}
                style={{ borderRadius: 14, borderWidth: 1, borderColor: inputBorder, paddingHorizontal: 16, paddingVertical: 12, color: fg, fontFamily: field.label === 'Display name' ? 'Roobert' : monoFont, fontSize: 14 }}
              />
            </View>
          ))}
          <BottomSheetTouchable onPress={saveCustom} disabled={!customBaseUrl.trim() || !customModelId.trim() || saving} style={{ marginTop: 6, alignItems: 'center', borderRadius: 9999, backgroundColor: theme.primary, paddingVertical: 14, opacity: !customBaseUrl.trim() || !customModelId.trim() || saving ? 0.5 : 1 }}>
            <Text style={{ color: theme.primaryForeground, fontFamily: 'Roobert-SemiBold', fontSize: 15 }}>{saving ? 'Saving…' : 'Save custom provider'}</Text>
          </BottomSheetTouchable>
        </BottomSheetScrollView>
      </BottomSheetModal>
    </View>
  );
}
