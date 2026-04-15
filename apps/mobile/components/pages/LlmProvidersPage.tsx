/**
 * LlmProvidersPage — Manage LLM provider connections and API keys.
 *
 * API endpoints (via OpenCode server):
 *   GET    {sandboxUrl}/provider         — List all providers + connected status
 *   PUT    {sandboxUrl}/auth/{id}        — Connect provider (set API key)
 *   DELETE {sandboxUrl}/auth/{id}        — Disconnect provider (remove key)
 *   POST   {sandboxUrl}/global/dispose   — Force server reload after changes
 */

import React, { useState, useMemo, useCallback, useRef } from 'react';
import {
  View,
  TouchableOpacity,
  ScrollView,
  Alert,
  RefreshControl,
  ActivityIndicator,
  Platform,
  LayoutAnimation,
} from 'react-native';
import { Text } from '@/components/ui/text';
import {
  Plus,
  Unplug,
  ChevronDown,
  ChevronUp,
  Cpu,
  Check,
} from 'lucide-react-native';
import { useColorScheme } from 'nativewind';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import {
  BottomSheetModal,
  BottomSheetBackdrop,
  BottomSheetView,
  BottomSheetTextInput,
  BottomSheetScrollView,
  TouchableOpacity as BottomSheetTouchable,
} from '@gorhom/bottom-sheet';
import type { BottomSheetBackdropProps } from '@gorhom/bottom-sheet';

import { useSheetBottomPadding } from '@/hooks/useSheetKeyboard';
import { useSandboxContext } from '@/contexts/SandboxContext';
import { useOpenCodeProviders, flattenModels } from '@/lib/opencode/hooks/use-opencode-data';
import type { ProviderInfo, FlatModel } from '@/lib/opencode/hooks/use-opencode-data';
import { getAuthToken } from '@/api/config';
import { log } from '@/lib/logger';
import {
  EMPTY_CUSTOM_FORM,
  validateCustomProviderForm,
  normalizeCustomProviderForm,
  isEnvReference,
  buildCustomProviderConfigUpdate,
  type CustomProviderFormValues,
} from '@/lib/kortix/custom-provider-config';
import { Globe } from 'lucide-react-native';
import { SearchBar } from '@/components/ui/SearchBar';
import type { PageTab } from '@/stores/tab-store';
import { useThemeColors } from '@/lib/theme-colors';

// ─── Provider branding ───────────────────────────────────────────────────────

const PROVIDER_LABELS: Record<string, string> = {
  anthropic: 'Anthropic', openai: 'OpenAI', google: 'Google', xai: 'xAI',
  kortix: 'Kortix', openrouter: 'OpenRouter', 'github-copilot': 'GitHub Copilot',
  vercel: 'Vercel', groq: 'Groq', deepseek: 'DeepSeek', mistral: 'Mistral',
  cohere: 'Cohere', huggingface: 'Hugging Face', cerebras: 'Cerebras',
  togetherai: 'Together AI', fireworks: 'Fireworks', deepinfra: 'DeepInfra',
  nvidia: 'NVIDIA', cloudflare: 'Cloudflare', azure: 'Azure', ollama: 'Ollama',
  perplexity: 'Perplexity', lmstudio: 'LM Studio', bedrock: 'AWS Bedrock',
};

const POPULAR_IDS = new Set(['anthropic', 'openai', 'github-copilot', 'google', 'openrouter', 'vercel']);

function getProviderLabel(id: string, name?: string): string {
  return PROVIDER_LABELS[id] || name || id;
}

// ─── API helpers ─────────────────────────────────────────────────────────────

async function connectProvider(sandboxUrl: string, providerId: string, apiKey: string): Promise<void> {
  const token = await getAuthToken();
  const res = await fetch(`${sandboxUrl}/auth/${encodeURIComponent(providerId)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ type: 'api', key: apiKey }),
  });
  if (!res.ok) throw new Error(`Failed to connect: ${res.status}`);
  // Force server reload
  await fetch(`${sandboxUrl}/global/dispose`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  }).catch(() => {});
}

async function disconnectProvider(sandboxUrl: string, providerId: string): Promise<void> {
  const token = await getAuthToken();
  const res = await fetch(`${sandboxUrl}/auth/${encodeURIComponent(providerId)}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  });
  // Fallback: set empty key if DELETE not supported
  if (res.status === 404 || res.status === 405) {
    await fetch(`${sandboxUrl}/auth/${encodeURIComponent(providerId)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ type: 'api', key: '' }),
    });
  } else if (!res.ok) {
    throw new Error(`Failed to disconnect: ${res.status}`);
  }
  // Force server reload
  await fetch(`${sandboxUrl}/global/dispose`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  }).catch(() => {});
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const monoFont = Platform.OS === 'ios' ? 'Menlo' : 'monospace';

// ─── ProviderRow ─────────────────────────────────────────────────────────────

function ProviderRow({
  provider,
  isConnected,
  isDark,
  onConnect,
  onDisconnect,
}: {
  provider: ProviderInfo;
  isConnected: boolean;
  isDark: boolean;
  onConnect: (provider: ProviderInfo) => void;
  onDisconnect: (provider: ProviderInfo) => void;
}) {
  const [showModels, setShowModels] = useState(false);
  const fgColor = isDark ? '#F8F8F8' : '#121215';
  const mutedColor = isDark ? '#71717a' : '#a1a1aa';
  const borderColor = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)';
  const themeColors = useThemeColors();
  const modelCount = Object.keys(provider.models).length;
  const label = getProviderLabel(provider.id, provider.name);

  const toggleModels = useCallback(() => {
    LayoutAnimation.configureNext({
      duration: 200,
      create: { type: LayoutAnimation.Types.easeInEaseOut, property: LayoutAnimation.Properties.opacity },
      update: { type: LayoutAnimation.Types.easeInEaseOut },
      delete: { type: LayoutAnimation.Types.easeInEaseOut, property: LayoutAnimation.Properties.opacity },
    });
    setShowModels((v) => !v);
  }, []);

  return (
    <View style={{ borderBottomWidth: 1, borderBottomColor: borderColor }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12 }}>
        {/* Icon */}
        <View style={{
          width: 32, height: 32, borderRadius: 8,
          backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)',
          alignItems: 'center', justifyContent: 'center', marginRight: 12,
        }}>
          <Text style={{ fontSize: 14, fontFamily: 'Roobert-SemiBold', color: fgColor }}>
            {label.slice(0, 2).toUpperCase()}
          </Text>
        </View>

        {/* Name + info */}
        <View style={{ flex: 1 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <Text style={{ fontSize: 14, fontFamily: 'Roobert-Medium', color: fgColor }}>{label}</Text>
            {isConnected && (
              <View style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: isDark ? 'rgba(16,185,129,0.12)' : 'rgba(16,185,129,0.08)', borderRadius: 8, paddingHorizontal: 6, paddingVertical: 1 }}>
                <View style={{ width: 5, height: 5, borderRadius: 2.5, backgroundColor: '#10b981', marginRight: 4 }} />
                <Text style={{ fontSize: 9, fontFamily: 'Roobert-Medium', color: '#10b981' }}>connected</Text>
              </View>
            )}
          </View>
          <TouchableOpacity onPress={toggleModels} style={{ flexDirection: 'row', alignItems: 'center', marginTop: 2 }}>
            <Text style={{ fontSize: 11, fontFamily: 'Roobert', color: mutedColor }}>{modelCount} models</Text>
            {modelCount > 0 && (
              showModels
                ? <ChevronUp size={12} color={mutedColor} style={{ marginLeft: 4 }} />
                : <ChevronDown size={12} color={mutedColor} style={{ marginLeft: 4 }} />
            )}
          </TouchableOpacity>
        </View>

        {/* Actions */}
        {isConnected ? (
          <TouchableOpacity
            onPress={() => onDisconnect(provider)}
            style={{ padding: 8 }}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Unplug size={16} color={isDark ? '#f87171' : '#dc2626'} />
          </TouchableOpacity>
        ) : (
          <TouchableOpacity
            onPress={() => onConnect(provider)}
            style={{
              flexDirection: 'row', alignItems: 'center',
              backgroundColor: themeColors.primary, borderRadius: 8,
              paddingHorizontal: 10, paddingVertical: 5,
            }}
          >
            <Plus size={12} color={themeColors.primaryForeground} style={{ marginRight: 3 }} />
            <Text style={{ fontSize: 11, fontFamily: 'Roobert-Medium', color: themeColors.primaryForeground }}>Connect</Text>
          </TouchableOpacity>
        )}
      </View>

      {/* Expanded model list */}
      {showModels && modelCount > 0 && (
        <View style={{ paddingHorizontal: 60, paddingBottom: 10 }}>
          {Object.entries(provider.models).map(([modelId, model]) => (
            <Text key={modelId} numberOfLines={1} style={{ fontSize: 11, fontFamily: monoFont, color: mutedColor, lineHeight: 18 }}>
              {model.name || modelId}
            </Text>
          ))}
        </View>
      )}
    </View>
  );
}

// ─── LlmProvidersPage ────────────────────────────────────────────────────────

interface LlmProvidersPageProps {
  page: PageTab;
  onBack: () => void;
  onOpenDrawer?: () => void;
  onOpenRightDrawer?: () => void;
}

export function LlmProvidersPage({ page, onBack, onOpenDrawer, onOpenRightDrawer }: LlmProvidersPageProps) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const insets = useSafeAreaInsets();
  const sheetPadding = useSheetBottomPadding();
  const { sandboxUrl } = useSandboxContext();

  const fgColor = isDark ? '#F8F8F8' : '#121215';
  const mutedColor = isDark ? '#71717a' : '#a1a1aa';
  const bgColor = isDark ? '#121215' : '#F8F8F8';
  const borderColor = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)';
  const sheetBg = isDark ? '#161618' : '#FFFFFF';
  const inputBorder = isDark ? 'rgba(248,248,248,0.1)' : 'rgba(18,18,21,0.08)';
  const themeColors = useThemeColors();

  const { data: providers, isLoading, refetch } = useOpenCodeProviders(sandboxUrl);

  type Tab = 'providers' | 'connected' | 'models';
  const [activeTab, setActiveTab] = useState<Tab>('providers');

  // State
  const [searchQuery, setSearchQuery] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [isDisconnecting, setIsDisconnecting] = useState(false);
  const [connectTarget, setConnectTarget] = useState<ProviderInfo | null>(null);
  const [disconnectTarget, setDisconnectTarget] = useState<ProviderInfo | null>(null);
  const [apiKey, setApiKey] = useState('');

  // Sheets
  const connectSheetRef = useRef<BottomSheetModal>(null);
  const disconnectSheetRef = useRef<BottomSheetModal>(null);
  const customSheetRef = useRef<BottomSheetModal>(null);

  // Custom provider form state
  const [customForm, setCustomForm] = useState<CustomProviderFormValues>(EMPTY_CUSTOM_FORM);
  const [isCustomSaving, setIsCustomSaving] = useState(false);

  const renderBackdrop = useCallback(
    (props: BottomSheetBackdropProps) => (
      <BottomSheetBackdrop {...props} disappearsOnIndex={-1} appearsOnIndex={0} opacity={0.5} pressBehavior="close" />
    ),
    [],
  );

  const sheetStyles = useMemo(() => ({
    backgroundStyle: { backgroundColor: sheetBg, borderTopLeftRadius: 24, borderTopRightRadius: 24 },
    handleIndicatorStyle: { backgroundColor: isDark ? '#3F3F46' : '#D4D4D8', width: 36, height: 5, borderRadius: 3 },
  }), [sheetBg, isDark]);

  // Derived data
  const connectedSet = useMemo(() => new Set(providers?.connected || []), [providers]);

  const { connectedProviders, popularProviders, otherProviders } = useMemo(() => {
    if (!providers) return { connectedProviders: [], popularProviders: [], otherProviders: [] };
    const q = searchQuery.toLowerCase();
    const filtered = providers.all.filter((p) => {
      const label = getProviderLabel(p.id, p.name).toLowerCase();
      return !q || label.includes(q) || p.id.includes(q);
    });

    const connected = filtered.filter((p) => connectedSet.has(p.id));
    const popular = filtered.filter((p) => !connectedSet.has(p.id) && POPULAR_IDS.has(p.id));
    const other = filtered.filter((p) => !connectedSet.has(p.id) && !POPULAR_IDS.has(p.id));

    return { connectedProviders: connected, popularProviders: popular, otherProviders: other };
  }, [providers, searchQuery, connectedSet]);

  // Models grouped by provider
  const modelsByProvider = useMemo(() => {
    if (!providers) return [];
    const allModels = flattenModels(providers);
    const q = searchQuery.toLowerCase();
    const filtered = q ? allModels.filter((m) =>
      m.modelName.toLowerCase().includes(q) || m.modelID.toLowerCase().includes(q) || m.providerName.toLowerCase().includes(q)
    ) : allModels;

    // Group by provider
    const groups: { providerID: string; providerName: string; models: FlatModel[] }[] = [];
    const map = new Map<string, FlatModel[]>();
    for (const m of filtered) {
      const arr = map.get(m.providerID) || [];
      arr.push(m);
      map.set(m.providerID, arr);
    }
    for (const [pid, models] of map) {
      groups.push({ providerID: pid, providerName: models[0].providerName, models });
    }
    return groups;
  }, [providers, searchQuery]);

  // Connect
  const openConnect = useCallback((provider: ProviderInfo) => {
    setConnectTarget(provider);
    setApiKey('');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    connectSheetRef.current?.present();
  }, []);

  const handleConnect = useCallback(async () => {
    if (!sandboxUrl || !connectTarget || !apiKey.trim()) return;
    setIsSaving(true);
    try {
      await connectProvider(sandboxUrl, connectTarget.id, apiKey.trim());
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      connectSheetRef.current?.dismiss();
      refetch();
    } catch (err: any) {
      Alert.alert('Error', err.message);
    } finally {
      setIsSaving(false);
    }
  }, [sandboxUrl, connectTarget, apiKey, refetch]);

  // Disconnect
  const openDisconnect = useCallback((provider: ProviderInfo) => {
    setDisconnectTarget(provider);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    disconnectSheetRef.current?.present();
  }, []);

  const handleDisconnect = useCallback(async () => {
    if (!sandboxUrl || !disconnectTarget) return;
    setIsDisconnecting(true);
    try {
      await disconnectProvider(sandboxUrl, disconnectTarget.id);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      disconnectSheetRef.current?.dismiss();
      refetch();
    } catch (err: any) {
      Alert.alert('Error', err.message);
    } finally {
      setIsDisconnecting(false);
    }
  }, [sandboxUrl, disconnectTarget, refetch]);

  // Custom provider
  const openCustomSheet = useCallback(() => {
    setCustomForm(EMPTY_CUSTOM_FORM);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    customSheetRef.current?.present();
  }, []);

  const handleCustomConnect = useCallback(async () => {
    if (!sandboxUrl) return;
    const error = validateCustomProviderForm(customForm);
    if (error) {
      Alert.alert('Validation Error', error);
      return;
    }

    setIsCustomSaving(true);
    const form = normalizeCustomProviderForm(customForm);

    try {
      const token = await getAuthToken();
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      };

      // 1. Fetch existing config
      const configRes = await fetch(`${sandboxUrl}/config`, { headers });
      const existingConfig = configRes.ok ? await configRes.json() : {};

      // 2. Build merged config with new provider
      const configUpdate = buildCustomProviderConfigUpdate(existingConfig, form);

      // 3. Write config
      const updateRes = await fetch(`${sandboxUrl}/config`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ config: configUpdate }),
      });
      if (!updateRes.ok) throw new Error(`Config update failed: ${updateRes.status}`);

      // 4. Save API key (unless it's an env reference)
      if (form.apiKey && !isEnvReference(form.apiKey)) {
        await connectProvider(sandboxUrl, form.providerID, form.apiKey);
      } else {
        // Still need to reload
        await fetch(`${sandboxUrl}/global/dispose`, { method: 'POST', headers }).catch(() => {});
      }

      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      customSheetRef.current?.dismiss();
      setCustomForm(EMPTY_CUSTOM_FORM);
      refetch();
    } catch (err: any) {
      Alert.alert('Error', err?.message || 'Failed to add custom provider');
    } finally {
      setIsCustomSaving(false);
    }
  }, [sandboxUrl, customForm, refetch]);

  // Section header
  const SectionHeader = ({ title }: { title: string }) => (
    <View style={{ paddingHorizontal: 16, paddingVertical: 8, backgroundColor: isDark ? 'rgba(255,255,255,0.02)' : 'rgba(0,0,0,0.015)' }}>
      <Text style={{ fontSize: 11, fontFamily: 'Roobert-Medium', color: mutedColor, textTransform: 'uppercase', letterSpacing: 1 }}>{title}</Text>
    </View>
  );

  return (
    <View style={{ flex: 1, backgroundColor: bgColor }}>
      {/* Header */}
      <View style={{ paddingTop: insets.top + 8, paddingBottom: 12, paddingHorizontal: 16, borderBottomWidth: 1, borderBottomColor: borderColor }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            {onOpenDrawer && (
              <TouchableOpacity onPress={onOpenDrawer} style={{ marginRight: 12 }}>
                <Ionicons name="menu" size={24} color={fgColor} />
              </TouchableOpacity>
            )}
            <View>
              <Text style={{ fontSize: 18, fontFamily: 'Roobert-SemiBold', color: fgColor }} numberOfLines={1}>{page.label}</Text>
              <Text style={{ fontSize: 11, fontFamily: 'Roobert', color: mutedColor, marginTop: 1, includeFontPadding: false }}>
                {connectedSet.size} connected
              </Text>
            </View>
          </View>
          {onOpenRightDrawer && (
            <TouchableOpacity onPress={onOpenRightDrawer}>
              <Ionicons name="apps-outline" size={20} color={fgColor} />
            </TouchableOpacity>
          )}
        </View>

        {/* Tabs */}
        <View style={{ flexDirection: 'row', gap: 0, marginTop: 12, borderRadius: 10, backgroundColor: isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.03)', padding: 3 }}>
          {([
            { id: 'providers' as Tab, label: 'Providers' },
            { id: 'connected' as Tab, label: `Connected (${connectedSet.size})` },
            { id: 'models' as Tab, label: 'Models' },
          ]).map((tab) => {
            const active = activeTab === tab.id;
            return (
              <TouchableOpacity
                key={tab.id}
                onPress={() => { setActiveTab(tab.id); setSearchQuery(''); }}
                style={{
                  flex: 1, paddingVertical: 7, borderRadius: 8, alignItems: 'center',
                  backgroundColor: active ? (isDark ? 'rgba(255,255,255,0.1)' : '#FFFFFF') : 'transparent',
                  ...(active ? {
                    shadowColor: '#000',
                    shadowOffset: { width: 0, height: 1 },
                    shadowOpacity: isDark ? 0.3 : 0.08,
                    shadowRadius: 3,
                    elevation: 2,
                  } : {}),
                }}
              >
                <Text style={{ fontSize: 12, fontFamily: active ? 'Roobert-Medium' : 'Roobert', color: active ? fgColor : mutedColor }}>
                  {tab.label}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>

        {/* Search */}
        <View style={{ marginTop: 10 }}>
          <SearchBar
            value={searchQuery}
            onChangeText={setSearchQuery}
            placeholder={activeTab === 'models' ? 'Search models' : 'Search providers'}
            onClear={() => setSearchQuery('')}
          />
        </View>
      </View>

      {/* List */}
      <ScrollView
        style={{ flex: 1 }}
        refreshControl={<RefreshControl refreshing={isLoading} onRefresh={() => refetch()} tintColor={mutedColor} />}
      >
        {isLoading && !providers && (
          <View style={{ padding: 40, alignItems: 'center' }}>
            <ActivityIndicator size="large" color={mutedColor} />
          </View>
        )}

        {/* ── Providers tab ── */}
        {activeTab === 'providers' && (
          <>
            {/* Custom Provider — add any OpenAI-compatible endpoint (matches web) */}
            {(!searchQuery || 'custom'.includes(searchQuery.toLowerCase())) && (
              <TouchableOpacity
                onPress={openCustomSheet}
                activeOpacity={0.7}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  paddingHorizontal: 16,
                  paddingVertical: 14,
                  borderBottomWidth: 1,
                  borderBottomColor: borderColor,
                  gap: 12,
                }}
              >
                <View
                  style={{
                    width: 36,
                    height: 36,
                    borderRadius: 10,
                    backgroundColor: isDark ? 'rgba(96,165,250,0.12)' : 'rgba(37,99,235,0.08)',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <Globe size={18} color={isDark ? '#60a5fa' : '#2563eb'} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 15, fontFamily: 'Roobert-Medium', color: fgColor }}>
                    Custom Provider
                  </Text>
                  <Text style={{ fontSize: 12, fontFamily: 'Roobert', color: mutedColor, marginTop: 1 }}>
                    Add any OpenAI-compatible endpoint
                  </Text>
                </View>
                <Plus size={18} color={themeColors.primary} />
              </TouchableOpacity>
            )}

            {popularProviders.length > 0 && (
              <>
                <SectionHeader title="Popular" />
                {popularProviders.map((p) => (
                  <ProviderRow key={p.id} provider={p} isConnected={false} isDark={isDark} onConnect={openConnect} onDisconnect={openDisconnect} />
                ))}
              </>
            )}
            {otherProviders.length > 0 && (
              <>
                <SectionHeader title="Other" />
                {otherProviders.map((p) => (
                  <ProviderRow key={p.id} provider={p} isConnected={false} isDark={isDark} onConnect={openConnect} onDisconnect={openDisconnect} />
                ))}
              </>
            )}
            {/* Also show connected in providers tab */}
            {connectedProviders.length > 0 && (
              <>
                <SectionHeader title={`Connected (${connectedProviders.length})`} />
                {connectedProviders.map((p) => (
                  <ProviderRow key={p.id} provider={p} isConnected isDark={isDark} onConnect={openConnect} onDisconnect={openDisconnect} />
                ))}
              </>
            )}
            {!isLoading && providers && connectedProviders.length === 0 && popularProviders.length === 0 && otherProviders.length === 0 && (
              <View style={{ padding: 40, alignItems: 'center' }}>
                <Cpu size={32} color={mutedColor} style={{ marginBottom: 12, opacity: 0.5 }} />
                <Text style={{ fontSize: 14, fontFamily: 'Roobert-Medium', color: mutedColor }}>
                  {searchQuery ? 'No providers match your search' : 'No providers available'}
                </Text>
              </View>
            )}
          </>
        )}

        {/* ── Connected tab ── */}
        {activeTab === 'connected' && (
          <>
            {connectedProviders.length > 0 ? (
              connectedProviders.map((p) => (
                <ProviderRow key={p.id} provider={p} isConnected isDark={isDark} onConnect={openConnect} onDisconnect={openDisconnect} />
              ))
            ) : (
              <View style={{ padding: 40, alignItems: 'center' }}>
                <Cpu size={32} color={mutedColor} style={{ marginBottom: 12, opacity: 0.5 }} />
                <Text style={{ fontSize: 14, fontFamily: 'Roobert-Medium', color: mutedColor, marginBottom: 4 }}>
                  {searchQuery ? 'No connected providers match' : 'No providers connected'}
                </Text>
                <Text style={{ fontSize: 12, fontFamily: 'Roobert', color: mutedColor, textAlign: 'center', opacity: 0.7 }}>
                  Connect a provider to start using models
                </Text>
              </View>
            )}
          </>
        )}

        {/* ── Models tab ── */}
        {activeTab === 'models' && (
          <>
            {modelsByProvider.length > 0 ? (
              modelsByProvider.map((group) => (
                <View key={group.providerID}>
                  <SectionHeader title={`${getProviderLabel(group.providerID, group.providerName)} (${group.models.length})`} />
                  {group.models.map((m) => (
                    <View
                      key={`${m.providerID}/${m.modelID}`}
                      style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: borderColor }}
                    >
                      <View style={{ flex: 1 }}>
                        <Text numberOfLines={1} style={{ fontSize: 13, fontFamily: 'Roobert-Medium', color: fgColor }}>{m.modelName}</Text>
                        <Text numberOfLines={1} style={{ fontSize: 10, fontFamily: monoFont, color: mutedColor, marginTop: 1 }}>{m.modelID}</Text>
                      </View>
                      <View style={{ flexDirection: 'row', gap: 6, alignItems: 'center' }}>
                        {m.reasoning && (
                          <View style={{ backgroundColor: isDark ? 'rgba(139,92,246,0.12)' : 'rgba(139,92,246,0.08)', borderRadius: 6, paddingHorizontal: 5, paddingVertical: 1 }}>
                            <Text style={{ fontSize: 8, fontFamily: 'Roobert-Medium', color: '#8b5cf6' }}>reasoning</Text>
                          </View>
                        )}
                        {m.contextWindow && (
                          <Text style={{ fontSize: 10, fontFamily: monoFont, color: mutedColor }}>
                            {m.contextWindow >= 1000000 ? `${(m.contextWindow / 1000000).toFixed(0)}M` : m.contextWindow >= 1000 ? `${Math.round(m.contextWindow / 1000)}k` : m.contextWindow}
                          </Text>
                        )}
                      </View>
                    </View>
                  ))}
                </View>
              ))
            ) : (
              <View style={{ padding: 40, alignItems: 'center' }}>
                <Cpu size={32} color={mutedColor} style={{ marginBottom: 12, opacity: 0.5 }} />
                <Text style={{ fontSize: 14, fontFamily: 'Roobert-Medium', color: mutedColor, marginBottom: 4 }}>
                  {searchQuery ? 'No models match your search' : 'No models available'}
                </Text>
                <Text style={{ fontSize: 12, fontFamily: 'Roobert', color: mutedColor, textAlign: 'center', opacity: 0.7 }}>
                  Connect a provider to see available models
                </Text>
              </View>
            )}
          </>
        )}

        <View style={{ height: insets.bottom + 80 }} />
      </ScrollView>

      {/* ── Connect Sheet ── */}
      <BottomSheetModal
        ref={connectSheetRef}
        enableDynamicSizing
        enablePanDownToClose
        backdropComponent={renderBackdrop}
        keyboardBehavior="interactive"
        keyboardBlurBehavior="restore"
        android_keyboardInputMode="adjustResize"
        onDismiss={() => { setConnectTarget(null); setApiKey(''); }}
        {...sheetStyles}
      >
        <BottomSheetView style={{ paddingHorizontal: 24, paddingTop: 8, paddingBottom: sheetPadding }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 20 }}>
            <View style={{ width: 40, height: 40, borderRadius: 12, backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)', alignItems: 'center', justifyContent: 'center', marginRight: 12 }}>
              <Text style={{ fontSize: 16, fontFamily: 'Roobert-SemiBold', color: fgColor }}>
                {connectTarget ? getProviderLabel(connectTarget.id, connectTarget.name).slice(0, 2).toUpperCase() : ''}
              </Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 18, fontFamily: 'Roobert-SemiBold', color: fgColor }}>
                Connect {connectTarget ? getProviderLabel(connectTarget.id, connectTarget.name) : ''}
              </Text>
              <Text style={{ fontSize: 12, fontFamily: 'Roobert', color: mutedColor, marginTop: 2 }}>Enter your API key</Text>
            </View>
          </View>

          <BottomSheetTextInput
            value={apiKey}
            onChangeText={setApiKey}
            placeholder="sk-..."
            autoFocus
            autoCorrect={false}
            autoCapitalize="none"
            secureTextEntry
            returnKeyType="done"
            onSubmitEditing={handleConnect}
            placeholderTextColor={mutedColor}
            style={{
              borderWidth: 1, borderColor: inputBorder, borderRadius: 14,
              paddingHorizontal: 16, paddingVertical: 14, fontSize: 16,
              fontFamily: monoFont, color: fgColor, marginBottom: 20,
            }}
          />

          <BottomSheetTouchable
            onPress={handleConnect}
            disabled={!apiKey.trim() || isSaving}
            style={{
              backgroundColor: apiKey.trim() ? themeColors.primary : (isDark ? 'rgba(248,248,248,0.08)' : 'rgba(18,18,21,0.06)'),
              borderRadius: 14, paddingVertical: 15, alignItems: 'center',
              opacity: apiKey.trim() && !isSaving ? 1 : 0.5,
            }}
          >
            <Text style={{ fontSize: 16, fontFamily: 'Roobert-SemiBold', color: apiKey.trim() ? themeColors.primaryForeground : mutedColor }}>
              {isSaving ? 'Connecting...' : 'Connect'}
            </Text>
          </BottomSheetTouchable>
        </BottomSheetView>
      </BottomSheetModal>

      {/* ── Disconnect Sheet ── */}
      <BottomSheetModal
        ref={disconnectSheetRef}
        enableDynamicSizing
        enablePanDownToClose
        backdropComponent={renderBackdrop}
        onDismiss={() => setDisconnectTarget(null)}
        {...sheetStyles}
      >
        <BottomSheetView style={{ paddingHorizontal: 24, paddingTop: 8, paddingBottom: sheetPadding }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 20 }}>
            <View style={{ width: 40, height: 40, borderRadius: 12, backgroundColor: isDark ? 'rgba(239,68,68,0.1)' : 'rgba(239,68,68,0.06)', alignItems: 'center', justifyContent: 'center', marginRight: 12 }}>
              <Unplug size={20} color={isDark ? '#f87171' : '#dc2626'} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 18, fontFamily: 'Roobert-SemiBold', color: fgColor }}>Disconnect Provider</Text>
              <Text style={{ fontSize: 12, fontFamily: 'Roobert', color: mutedColor, marginTop: 2 }}>
                {disconnectTarget ? getProviderLabel(disconnectTarget.id, disconnectTarget.name) : ''}
              </Text>
            </View>
          </View>

          <Text style={{ fontSize: 13, fontFamily: 'Roobert', color: mutedColor, lineHeight: 19, marginBottom: 20 }}>
            You'll need to re-enter your API key to use this provider again.
          </Text>

          <View style={{ flexDirection: 'row', gap: 10 }}>
            <BottomSheetTouchable
              onPress={() => disconnectSheetRef.current?.dismiss()}
              style={{ flex: 1, borderRadius: 14, paddingVertical: 15, alignItems: 'center', borderWidth: 1, borderColor }}
            >
              <Text style={{ fontSize: 16, fontFamily: 'Roobert-SemiBold', color: fgColor }}>Cancel</Text>
            </BottomSheetTouchable>
            <BottomSheetTouchable
              onPress={handleDisconnect}
              disabled={isDisconnecting}
              style={{ flex: 1, borderRadius: 14, paddingVertical: 15, alignItems: 'center', backgroundColor: isDark ? '#dc2626' : '#ef4444', opacity: isDisconnecting ? 0.5 : 1 }}
            >
              <Text style={{ fontSize: 16, fontFamily: 'Roobert-SemiBold', color: '#FFFFFF' }}>
                {isDisconnecting ? 'Disconnecting...' : 'Disconnect'}
              </Text>
            </BottomSheetTouchable>
          </View>
        </BottomSheetView>
      </BottomSheetModal>

      {/* ── Custom Provider Sheet ── */}
      <BottomSheetModal
        ref={customSheetRef}
        snapPoints={['80%']}
        enableDynamicSizing={false}
        enablePanDownToClose
        backdropComponent={renderBackdrop}
        keyboardBehavior="interactive"
        keyboardBlurBehavior="restore"
        android_keyboardInputMode="adjustResize"
        onDismiss={() => { setCustomForm(EMPTY_CUSTOM_FORM); setIsCustomSaving(false); }}
        {...sheetStyles}
      >
        <BottomSheetScrollView
          contentContainerStyle={{ paddingHorizontal: 24, paddingTop: 8, paddingBottom: sheetPadding }}
          keyboardShouldPersistTaps="handled"
        >
          {/* Header */}
          <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 20 }}>
            <View style={{ width: 40, height: 40, borderRadius: 12, backgroundColor: isDark ? 'rgba(96,165,250,0.12)' : 'rgba(37,99,235,0.08)', alignItems: 'center', justifyContent: 'center', marginRight: 12 }}>
              <Globe size={20} color={isDark ? '#60a5fa' : '#2563eb'} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 18, fontFamily: 'Roobert-SemiBold', color: fgColor }}>
                Add Custom Provider
              </Text>
              <Text style={{ fontSize: 12, fontFamily: 'Roobert', color: mutedColor, marginTop: 2 }}>
                OpenAI-compatible endpoint
              </Text>
            </View>
          </View>

          {/* Provider ID */}
          <Text style={{ fontSize: 13, fontFamily: 'Roobert-Medium', color: mutedColor, marginBottom: 6 }}>Provider ID</Text>
          <BottomSheetTextInput
            value={customForm.providerID}
            onChangeText={(v) => setCustomForm((f) => ({ ...f, providerID: v }))}
            placeholder="my-provider"
            autoCapitalize="none"
            autoCorrect={false}
            placeholderTextColor={mutedColor}
            style={{
              borderWidth: 1, borderColor: inputBorder, borderRadius: 14,
              paddingHorizontal: 16, paddingVertical: 12, fontSize: 15,
              fontFamily: monoFont, color: fgColor, marginBottom: 14,
            }}
          />

          {/* Display Name */}
          <Text style={{ fontSize: 13, fontFamily: 'Roobert-Medium', color: mutedColor, marginBottom: 6 }}>Display Name</Text>
          <BottomSheetTextInput
            value={customForm.name}
            onChangeText={(v) => setCustomForm((f) => ({ ...f, name: v }))}
            placeholder="My Provider"
            placeholderTextColor={mutedColor}
            style={{
              borderWidth: 1, borderColor: inputBorder, borderRadius: 14,
              paddingHorizontal: 16, paddingVertical: 12, fontSize: 15,
              fontFamily: 'Roobert', color: fgColor, marginBottom: 14,
            }}
          />

          {/* Base URL */}
          <Text style={{ fontSize: 13, fontFamily: 'Roobert-Medium', color: mutedColor, marginBottom: 6 }}>Base URL</Text>
          <BottomSheetTextInput
            value={customForm.baseURL}
            onChangeText={(v) => setCustomForm((f) => ({ ...f, baseURL: v }))}
            placeholder="https://api.example.com/v1"
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            placeholderTextColor={mutedColor}
            style={{
              borderWidth: 1, borderColor: inputBorder, borderRadius: 14,
              paddingHorizontal: 16, paddingVertical: 12, fontSize: 15,
              fontFamily: monoFont, color: fgColor, marginBottom: 14,
            }}
          />

          {/* API Key */}
          <Text style={{ fontSize: 13, fontFamily: 'Roobert-Medium', color: mutedColor, marginBottom: 6 }}>API Key</Text>
          <BottomSheetTextInput
            value={customForm.apiKey}
            onChangeText={(v) => setCustomForm((f) => ({ ...f, apiKey: v }))}
            placeholder="sk-... or {env:MY_API_KEY}"
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry={!customForm.apiKey.startsWith('{env:')}
            placeholderTextColor={mutedColor}
            style={{
              borderWidth: 1, borderColor: inputBorder, borderRadius: 14,
              paddingHorizontal: 16, paddingVertical: 12, fontSize: 15,
              fontFamily: monoFont, color: fgColor, marginBottom: 4,
            }}
          />
          <Text style={{ fontSize: 11, fontFamily: 'Roobert', color: mutedColor, marginBottom: 14 }}>
            Optional. Use {'{env:VAR_NAME}'} to reference an environment variable.
          </Text>

          {/* Model ID + Name (side by side) */}
          <Text style={{ fontSize: 13, fontFamily: 'Roobert-Medium', color: mutedColor, marginBottom: 6 }}>Model</Text>
          <View style={{ flexDirection: 'row', gap: 10, marginBottom: 20 }}>
            <View style={{ flex: 1 }}>
              <BottomSheetTextInput
                value={customForm.modelId}
                onChangeText={(v) => setCustomForm((f) => ({ ...f, modelId: v }))}
                placeholder="gpt-4o"
                autoCapitalize="none"
                autoCorrect={false}
                placeholderTextColor={mutedColor}
                style={{
                  borderWidth: 1, borderColor: inputBorder, borderRadius: 14,
                  paddingHorizontal: 14, paddingVertical: 12, fontSize: 14,
                  fontFamily: monoFont, color: fgColor,
                }}
              />
              <Text style={{ fontSize: 10, fontFamily: 'Roobert', color: mutedColor, marginTop: 4, paddingLeft: 4 }}>Model ID</Text>
            </View>
            <View style={{ flex: 1 }}>
              <BottomSheetTextInput
                value={customForm.modelName}
                onChangeText={(v) => setCustomForm((f) => ({ ...f, modelName: v }))}
                placeholder="GPT-4o"
                placeholderTextColor={mutedColor}
                style={{
                  borderWidth: 1, borderColor: inputBorder, borderRadius: 14,
                  paddingHorizontal: 14, paddingVertical: 12, fontSize: 14,
                  fontFamily: 'Roobert', color: fgColor,
                }}
              />
              <Text style={{ fontSize: 10, fontFamily: 'Roobert', color: mutedColor, marginTop: 4, paddingLeft: 4 }}>Display Name</Text>
            </View>
          </View>

          {/* Submit */}
          <BottomSheetTouchable
            onPress={handleCustomConnect}
            disabled={isCustomSaving || !customForm.providerID.trim() || !customForm.name.trim() || !customForm.baseURL.trim() || !customForm.modelId.trim() || !customForm.modelName.trim()}
            style={{
              backgroundColor: (customForm.providerID.trim() && customForm.name.trim() && customForm.baseURL.trim() && customForm.modelId.trim() && customForm.modelName.trim())
                ? themeColors.primary
                : (isDark ? 'rgba(248,248,248,0.08)' : 'rgba(18,18,21,0.06)'),
              borderRadius: 14,
              paddingVertical: 15,
              alignItems: 'center',
              opacity: isCustomSaving ? 0.5 : 1,
            }}
          >
            <Text style={{
              fontSize: 16,
              fontFamily: 'Roobert-SemiBold',
              color: (customForm.providerID.trim() && customForm.name.trim() && customForm.baseURL.trim() && customForm.modelId.trim() && customForm.modelName.trim())
                ? themeColors.primaryForeground
                : mutedColor,
            }}>
              {isCustomSaving ? 'Adding Provider...' : 'Add Provider'}
            </Text>
          </BottomSheetTouchable>
        </BottomSheetScrollView>
      </BottomSheetModal>
    </View>
  );
}
