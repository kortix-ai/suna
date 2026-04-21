import React, { useCallback, useMemo, useRef, useState } from 'react';
import {
  View,
  TouchableOpacity,
  ScrollView,
  RefreshControl,
  ActivityIndicator,
  Platform,
  Alert,
} from 'react-native';
import { Text } from '@/components/ui/text';
import { useColorScheme } from 'nativewind';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { SearchBar } from '@/components/ui/SearchBar';
import { useSandboxContext } from '@/contexts/SandboxContext';
import { getAuthToken } from '@/api/config';
import type { PageTab } from '@/stores/tab-store';
import { PageHeader } from '@/components/ui/page-header';
import { PageContent } from '@/components/ui/page-content';
import { useThemeColors } from '@/lib/theme-colors';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  BottomSheetBackdrop,
  BottomSheetModal,
  BottomSheetScrollView,
  TouchableOpacity as BottomSheetTouchable,
} from '@gorhom/bottom-sheet';
import type { BottomSheetBackdropProps } from '@gorhom/bottom-sheet';
import * as Clipboard from 'expo-clipboard';

type FilterKey = 'all' | 'installed' | 'skills' | 'agents' | 'tools' | 'plugins';

type ComponentType = 'ocx:skill' | 'ocx:agent' | 'ocx:tool' | 'ocx:plugin' | string;

interface RegistryComponent {
  name: string;
  version: string;
  type: ComponentType;
  description: string;
}

interface RegistryComponentVersion extends RegistryComponent {
  files: string[];
}

interface RegistryComponentDetails {
  name: string;
  description: string;
  'dist-tags'?: { latest?: string };
  versions: Record<string, RegistryComponentVersion>;
}

interface RegistryComponentFile {
  path: string;
  content: string;
}

interface RegistryComponentBundle {
  manifest: RegistryComponentDetails;
  version: RegistryComponentVersion;
  files: RegistryComponentFile[];
}

interface RegistryIndex {
  components: RegistryComponent[];
}

interface SkillLike {
  name: string;
}

interface MarketplacePageProps {
  page: PageTab;
  onBack: () => void;
  onOpenDrawer?: () => void;
  onOpenRightDrawer?: () => void;
  isDrawerOpen?: boolean;
  isRightDrawerOpen?: boolean;
}

const REGISTRY_URL = 'https://kortix-registry-6om.pages.dev';

const FILTERS: Array<{ key: FilterKey; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'installed', label: 'Installed' },
  { key: 'skills', label: 'Skills' },
  { key: 'agents', label: 'Agents' },
  { key: 'tools', label: 'Tools' },
  { key: 'plugins', label: 'Plugins' },
];

function getTypeLabel(type: string): string {
  if (type === 'ocx:skill') return 'Skill';
  if (type === 'ocx:agent') return 'Agent';
  if (type === 'ocx:tool') return 'Tool';
  if (type === 'ocx:plugin') return 'Plugin';
  return type.replace('ocx:', '');
}

function getTypeIcon(type: string): string {
  if (type === 'ocx:skill') return 'sparkles-outline';
  if (type === 'ocx:agent') return 'hardware-chip-outline';
  if (type === 'ocx:tool') return 'build-outline';
  if (type === 'ocx:plugin') return 'extension-puzzle-outline';
  return 'cube-outline';
}

function cleanAnsi(text: string): string {
  return text.replace(/[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[a-zA-Z\d]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g, '');
}

function buildWsUrl(sandboxUrl: string, ptyId: string, token: string | null): string {
  let wsBase = sandboxUrl;
  try {
    const parsed = new URL(sandboxUrl);
    parsed.protocol = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
    wsBase = parsed.toString().replace(/\/+$/, '');
  } catch {
    wsBase = sandboxUrl.replace('https://', 'wss://').replace('http://', 'ws://').replace(/\/+$/, '');
  }
  const base = `${wsBase}/pty/${ptyId}/connect`;
  if (!token) return base;
  const sep = base.includes('?') ? '&' : '?';
  return `${base}${sep}token=${encodeURIComponent(token)}`;
}

async function fetchRegistryComponents(): Promise<RegistryComponent[]> {
  const response = await fetch(`${REGISTRY_URL}/index.json`);
  if (!response.ok) {
    throw new Error(`Failed to fetch registry (${response.status})`);
  }
  const data: RegistryIndex = await response.json();
  return data.components || [];
}

async function fetchComponentBundle(componentName: string): Promise<RegistryComponentBundle> {
  const response = await fetch(`${REGISTRY_URL}/components/${componentName}.json`);
  if (!response.ok) {
    throw new Error(`Failed to fetch component details (${response.status})`);
  }

  const manifest: RegistryComponentDetails = await response.json();
  const latestVersion = manifest['dist-tags']?.latest;
  if (!latestVersion) {
    throw new Error('Component does not declare a latest version');
  }

  const version = manifest.versions[latestVersion];
  if (!version) {
    throw new Error(`Missing version payload for ${latestVersion}`);
  }

  const files = await Promise.all(
    (version.files || []).map(async (path) => {
      const fileResponse = await fetch(`${REGISTRY_URL}/components/${componentName}/${path}`);
      if (!fileResponse.ok) {
        return { path, content: `Unable to load file (${fileResponse.status})` };
      }
      return { path, content: await fileResponse.text() };
    }),
  );

  return { manifest, version, files };
}

async function fetchInstalledSkills(sandboxUrl: string): Promise<Set<string>> {
  const token = await getAuthToken();
  const res = await fetch(`${sandboxUrl}/skill`, {
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  if (!res.ok) throw new Error(`Failed to fetch installed skills (${res.status})`);
  const data = (await res.json()) as SkillLike[];
  const installed = new Set<string>();
  for (const skill of data || []) {
    const name = (skill?.name || '').toLowerCase();
    if (!name) continue;
    installed.add(name);
    installed.add(`skill-${name}`);
  }
  return installed;
}

async function runPtyCommand(sandboxUrl: string, command: string): Promise<string> {
  const token = await getAuthToken();
  const headers = {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };

  const createdRes = await fetch(`${sandboxUrl}/pty`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      command: '/bin/sh',
      args: ['-c', command],
      title: '__marketplace-install__',
    }),
  });

  if (!createdRes.ok) {
    const text = await createdRes.text().catch(() => '');
    throw new Error(`Failed to create PTY (${createdRes.status}): ${text || createdRes.statusText}`);
  }

  const created = await createdRes.json();
  const ptyId: string | undefined = created?.id || created?.ptyID || created?.data?.id;
  if (!ptyId) throw new Error('PTY created but no ID returned');

  const wsUrl = buildWsUrl(sandboxUrl, ptyId, token);

  const output = await new Promise<string>((resolve) => {
    const chunks: string[] = [];
    let settled = false;
    const ws = new WebSocket(wsUrl);

    const finish = () => {
      if (settled) return;
      settled = true;
      resolve(chunks.join(''));
    };

    const timeout = setTimeout(() => {
      try { ws.close(); } catch {}
      finish();
    }, 60_000);

    ws.onmessage = (event) => {
      try {
        if (typeof event.data === 'string') {
          chunks.push(event.data);
          return;
        }
        if (event.data instanceof ArrayBuffer) {
          chunks.push(new TextDecoder().decode(event.data));
          return;
        }
        chunks.push(String(event.data));
      } catch {
        chunks.push(String(event.data));
      }
    };

    ws.onclose = () => {
      clearTimeout(timeout);
      finish();
    };

    ws.onerror = () => {
      clearTimeout(timeout);
      finish();
    };
  });

  fetch(`${sandboxUrl}/pty/${encodeURIComponent(ptyId)}`, {
    method: 'DELETE',
    headers,
  }).catch(() => {});

  return output;
}

async function installComponentWithOcx(sandboxUrl: string, componentName: string): Promise<void> {
  const output = await runPtyCommand(
    sandboxUrl,
    `cd /workspace && ocx init -q 2>/dev/null && ocx registry add https://kortix-registry-6om.pages.dev --name kortix -q 2>/dev/null; ocx add kortix/${componentName} 2>&1`,
  );
  const normalized = output.toLowerCase();
  const looksInstalled = normalized.includes('installed') || normalized.includes('done');
  if (!looksInstalled && (normalized.includes('error') || normalized.includes('failed') || normalized.includes('not found'))) {
    throw new Error(cleanAnsi(output).trim() || 'Install failed');
  }

  const token = await getAuthToken();
  fetch(`${sandboxUrl}/global/dispose`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  }).catch(() => {});
}

function fileLabel(path: string): string {
  const parts = path.split('/').filter(Boolean);
  return parts[parts.length - 1] || path;
}

function isMarkdownPath(path: string): boolean {
  return /\.(md|mdx|markdown)$/i.test(path);
}

function MetaPill({
  label,
  isDark,
  active = false,
}: {
  label: string;
  isDark: boolean;
  active?: boolean;
}) {
  return (
    <View
      style={{
        borderRadius: 999,
        paddingHorizontal: 10,
        paddingVertical: 5,
        borderWidth: 1,
        borderColor: active ? 'transparent' : (isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.08)'),
        backgroundColor: active
          ? (isDark ? 'rgba(16,185,129,0.2)' : 'rgba(16,185,129,0.12)')
          : (isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.03)'),
      }}
    >
      <Text style={{ fontSize: 11, fontFamily: 'Roobert-Medium', color: active ? '#10b981' : (isDark ? '#d4d4d8' : '#4b5563') }}>
        {label}
      </Text>
    </View>
  );
}

function MarketplaceCard({
  component,
  isInstalled,
  isInstalling,
  isDark,
  onOpen,
  onInstall,
}: {
  component: RegistryComponent;
  isInstalled: boolean;
  isInstalling: boolean;
  isDark: boolean;
  onOpen: (component: RegistryComponent) => void;
  onInstall: (component: RegistryComponent) => void;
}) {
  const fgColor = isDark ? '#F8F8F8' : '#121215';
  const mutedColor = isDark ? '#71717a' : '#6b7280';
  const borderColor = isDark ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.08)';
  const cardBg = isDark ? '#161618' : '#FFFFFF';
  const themeColors = useThemeColors();
  const typeLabel = getTypeLabel(component.type);
  const iconName = getTypeIcon(component.type);

  return (
    <TouchableOpacity
      activeOpacity={0.7}
      onPress={() => onOpen(component)}
      style={{
        backgroundColor: cardBg,
        borderWidth: 1,
        borderColor,
        borderRadius: 16,
        padding: 14,
        marginBottom: 10,
        ...(isDark ? {} : {
          shadowColor: '#000',
          shadowOffset: { width: 0, height: 1 },
          shadowOpacity: 0.04,
          shadowRadius: 3,
          elevation: 1,
        }),
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
        <View
          style={{
            width: 38,
            height: 38,
            borderRadius: 12,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)',
            borderWidth: 1,
            borderColor,
            marginRight: 12,
          }}
        >
          <Ionicons name={iconName as any} size={18} color={fgColor} />
        </View>
        <View style={{ flex: 1 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <Text style={{ fontSize: 15, fontFamily: 'Roobert-SemiBold', color: fgColor }}>{component.name}</Text>
            {isInstalled && (
              <View
                style={{
                  marginLeft: 8,
                  paddingHorizontal: 7,
                  paddingVertical: 2,
                  borderRadius: 999,
                  backgroundColor: isDark ? 'rgba(16,185,129,0.15)' : 'rgba(16,185,129,0.1)',
                }}
              >
                <Text style={{ fontSize: 10, fontFamily: 'Roobert-Medium', color: '#10b981' }}>Installed</Text>
              </View>
            )}
          </View>
          <Text style={{ fontSize: 11, fontFamily: 'Roobert', color: mutedColor, marginTop: 1 }}>{typeLabel} · v{component.version}</Text>
        </View>
      </View>

      <Text style={{ marginTop: 10, fontSize: 13, lineHeight: 19, fontFamily: 'Roobert', color: mutedColor }} numberOfLines={2}>
        {component.description || 'No description available.'}
      </Text>

      <View style={{ flexDirection: 'row', justifyContent: 'flex-end', marginTop: 12 }}>
        <TouchableOpacity
          onPress={(e) => {
            e.stopPropagation();
            if (!isInstalled) onInstall(component);
          }}
          disabled={isInstalling || isInstalled}
          style={{
            borderRadius: 10,
            paddingHorizontal: 14,
            paddingVertical: 8,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 5,
            backgroundColor: isInstalled
              ? 'transparent'
              : themeColors.primary,
            borderWidth: isInstalled ? 1 : 0,
            borderColor: borderColor,
            opacity: isInstalling ? 0.6 : 1,
          }}
        >
          {!isInstalled && !isInstalling && (
            <Ionicons name="download-outline" size={13} color={themeColors.primaryForeground} />
          )}
          {isInstalling && (
            <ActivityIndicator size={12} color={themeColors.primaryForeground} />
          )}
          <Text style={{
            fontSize: 12,
            fontFamily: 'Roobert-Medium',
            color: isInstalled ? mutedColor : themeColors.primaryForeground,
          }}>
            {isInstalling ? 'Installing...' : isInstalled ? 'View' : 'Install'}
          </Text>
        </TouchableOpacity>
      </View>
    </TouchableOpacity>
  );
}

export function MarketplacePage({ page, onBack, onOpenDrawer, onOpenRightDrawer, isDrawerOpen, isRightDrawerOpen }: MarketplacePageProps) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const insets = useSafeAreaInsets();
  const { sandboxUrl } = useSandboxContext();
  const queryClient = useQueryClient();

  const fgColor = isDark ? '#F8F8F8' : '#121215';
  const mutedColor = isDark ? '#71717a' : '#6b7280';
  const bgColor = isDark ? '#121215' : '#F8F8F8';
  const borderColor = isDark ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.08)';
  const sheetBg = isDark ? '#161618' : '#FFFFFF';
  const monoFont = Platform.OS === 'ios' ? 'Menlo' : 'monospace';

  const [search, setSearch] = useState('');
  const [activeFilter, setActiveFilter] = useState<FilterKey>('all');
  const [selectedComponent, setSelectedComponent] = useState<RegistryComponent | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [installingNames, setInstallingNames] = useState<string[]>([]);

  const detailSheetRef = useRef<BottomSheetModal>(null);
  const detailSnapPoints = useMemo(() => ['90%'], []);

  const componentsQuery = useQuery({
    queryKey: ['marketplace', 'components'],
    queryFn: fetchRegistryComponents,
    staleTime: 5 * 60 * 1000,
  });

  const installedQuery = useQuery({
    queryKey: ['marketplace', 'installed', sandboxUrl || ''],
    queryFn: () => fetchInstalledSkills(sandboxUrl || ''),
    enabled: !!sandboxUrl,
    staleTime: 30 * 1000,
  });

  const bundleQuery = useQuery({
    queryKey: ['marketplace', 'bundle', selectedComponent?.name || ''],
    queryFn: () => fetchComponentBundle(selectedComponent?.name || ''),
    enabled: !!selectedComponent,
    staleTime: 5 * 60 * 1000,
  });

  const installedSet = installedQuery.data || new Set<string>();

  const counts = useMemo(() => {
    const list = componentsQuery.data || [];
    return {
      all: list.length,
      installed: list.filter((c) => installedSet.has(c.name.toLowerCase())).length,
      skills: list.filter((c) => c.type === 'ocx:skill').length,
      agents: list.filter((c) => c.type === 'ocx:agent').length,
      tools: list.filter((c) => c.type === 'ocx:tool').length,
      plugins: list.filter((c) => c.type === 'ocx:plugin').length,
    };
  }, [componentsQuery.data, installedSet]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (componentsQuery.data || []).filter((c) => {
      const matchesSearch = !q || c.name.toLowerCase().includes(q) || c.description.toLowerCase().includes(q);
      if (!matchesSearch) return false;

      if (activeFilter === 'installed') return installedSet.has(c.name.toLowerCase());
      if (activeFilter === 'skills') return c.type === 'ocx:skill';
      if (activeFilter === 'agents') return c.type === 'ocx:agent';
      if (activeFilter === 'tools') return c.type === 'ocx:tool';
      if (activeFilter === 'plugins') return c.type === 'ocx:plugin';
      return true;
    });
  }, [activeFilter, componentsQuery.data, installedSet, search]);

  const activeFile = useMemo(() => {
    const bundle = bundleQuery.data;
    if (!bundle) return null;
    if (selectedPath) {
      const found = bundle.files.find((file) => file.path === selectedPath);
      if (found) return found;
    }
    return bundle.files[0] || null;
  }, [bundleQuery.data, selectedPath]);

  const isInstalling = useCallback((name: string) => installingNames.includes(name), [installingNames]);

  const handleInstall = useCallback(async (component: RegistryComponent) => {
    if (!sandboxUrl) {
      Alert.alert('Unavailable', 'Sandbox is not connected yet.');
      return;
    }
    setInstallingNames((prev) => (prev.includes(component.name) ? prev : [...prev, component.name]));
    try {
      await installComponentWithOcx(sandboxUrl, component.name);
      await queryClient.invalidateQueries({ queryKey: ['marketplace', 'installed', sandboxUrl] });
      Alert.alert('Installed', `${component.name} was installed successfully.`);
    } catch (error: any) {
      Alert.alert('Install failed', error?.message || 'Unable to install component.');
    } finally {
      setInstallingNames((prev) => prev.filter((name) => name !== component.name));
    }
  }, [queryClient, sandboxUrl]);

  const handleOpenDetail = useCallback((component: RegistryComponent) => {
    setSelectedComponent(component);
    setSelectedPath(null);
    detailSheetRef.current?.present();
  }, []);

  const handleRefresh = useCallback(() => {
    componentsQuery.refetch();
    installedQuery.refetch();
    if (selectedComponent) bundleQuery.refetch();
  }, [bundleQuery, componentsQuery, installedQuery, selectedComponent]);

  const renderBackdrop = useCallback(
    (props: BottomSheetBackdropProps) => (
      <BottomSheetBackdrop {...props} disappearsOnIndex={-1} appearsOnIndex={0} opacity={0.5} pressBehavior="close" />
    ),
    [],
  );

  const selectedInstalled = selectedComponent
    ? installedSet.has(selectedComponent.name.toLowerCase())
    : false;

  return (
    <View style={{ flex: 1, backgroundColor: bgColor }}>
      <PageHeader
        title={
          <View style={{ flex: 1 }}>
            <Text
              className="text-base font-medium text-muted-foreground"
              numberOfLines={1}
            >
              {page.label}
            </Text>
            <Text style={{ fontSize: 11, fontFamily: 'Roobert', color: mutedColor, marginTop: 1, includeFontPadding: false }}>
              {counts.all} components available
            </Text>
          </View>
        }
        onOpenDrawer={onOpenDrawer}
        onOpenRightDrawer={onOpenRightDrawer}
        isDrawerOpen={isDrawerOpen}
        isRightDrawerOpen={isRightDrawerOpen}
      />
      <PageContent>
      <View style={{ paddingHorizontal: 16, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: borderColor }}>
        <View>
          <SearchBar
            value={search}
            onChangeText={setSearch}
            placeholder="Search components"
            onClear={() => setSearch('')}
          />
        </View>

        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingTop: 10 }}>
          {FILTERS.map((filter) => {
            const active = filter.key === activeFilter;
            const count = counts[filter.key];
            return (
              <TouchableOpacity
                key={filter.key}
                onPress={() => setActiveFilter(filter.key)}
                style={{
                  borderRadius: 999,
                  paddingHorizontal: 12,
                  paddingVertical: 6,
                  backgroundColor: active ? fgColor : 'transparent',
                  borderWidth: active ? 0 : 1,
                  borderColor,
                }}
              >
                <Text style={{
                  fontSize: 12,
                  fontFamily: 'Roobert-Medium',
                  color: active ? (isDark ? '#121215' : '#FFFFFF') : mutedColor,
                }}>
                  {filter.label} {count > 0 ? `(${count})` : ''}
                </Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      </View>

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: 12, paddingBottom: insets.bottom + 84 }}
        refreshControl={
          <RefreshControl
            refreshing={componentsQuery.isFetching || installedQuery.isFetching}
            onRefresh={handleRefresh}
            tintColor={mutedColor}
          />
        }
      >
        {componentsQuery.isLoading ? (
          <View style={{ paddingVertical: 48, alignItems: 'center' }}>
            <ActivityIndicator size="large" color={mutedColor} />
          </View>
        ) : componentsQuery.error ? (
          <View style={{ padding: 20, alignItems: 'center' }}>
            <Text style={{ fontSize: 13, fontFamily: 'Roobert-Medium', color: isDark ? '#f87171' : '#dc2626' }}>
              Failed to load marketplace
            </Text>
            <Text style={{ marginTop: 4, fontSize: 12, fontFamily: 'Roobert', color: mutedColor, textAlign: 'center' }}>
              {componentsQuery.error instanceof Error ? componentsQuery.error.message : 'Unknown error'}
            </Text>
          </View>
        ) : filtered.length === 0 ? (
          <View
            style={{
              marginTop: 20,
              borderWidth: 1,
              borderStyle: 'dashed',
              borderColor,
              borderRadius: 16,
              padding: 24,
              alignItems: 'center',
              backgroundColor: isDark ? 'rgba(255,255,255,0.02)' : 'rgba(0,0,0,0.015)',
            }}
          >
            <Ionicons name="sparkles-outline" size={22} color={mutedColor} style={{ marginBottom: 8 }} />
            <Text style={{ fontSize: 14, fontFamily: 'Roobert-SemiBold', color: fgColor }}>
              {search ? 'No matching components' : activeFilter === 'installed' ? 'Nothing installed yet' : 'No components found'}
            </Text>
            <Text style={{ marginTop: 4, fontSize: 12, fontFamily: 'Roobert', color: mutedColor, textAlign: 'center' }}>
              {search ? `No components matching "${search}".` : 'Try another filter or install from the full list.'}
            </Text>
          </View>
        ) : (
          <>
            <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 10 }}>
              <Text style={{ fontSize: 11, fontFamily: 'Roobert-Medium', color: mutedColor, textTransform: 'uppercase', letterSpacing: 1 }}>
                {activeFilter === 'all' ? 'All Components' : activeFilter}
              </Text>
              <View
                style={{
                  marginLeft: 6,
                  borderRadius: 999,
                  backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)',
                  paddingHorizontal: 7,
                  paddingVertical: 1,
                }}
              >
                <Text style={{ fontSize: 10, fontFamily: 'Roobert-Medium', color: mutedColor }}>{filtered.length}</Text>
              </View>
            </View>

            {filtered.map((component) => (
              <MarketplaceCard
                key={component.name}
                component={component}
                isDark={isDark}
                isInstalled={installedSet.has(component.name.toLowerCase())}
                isInstalling={isInstalling(component.name)}
                onOpen={handleOpenDetail}
                onInstall={handleInstall}
              />
            ))}
          </>
        )}
      </ScrollView>

      <BottomSheetModal
        ref={detailSheetRef}
        snapPoints={detailSnapPoints}
        enablePanDownToClose
        enableDynamicSizing={false}
        enableContentPanningGesture={false}
        backdropComponent={renderBackdrop}
        onDismiss={() => {
          setSelectedComponent(null);
          setSelectedPath(null);
        }}
        backgroundStyle={{ backgroundColor: sheetBg, borderTopLeftRadius: 24, borderTopRightRadius: 24 }}
        handleIndicatorStyle={{ backgroundColor: isDark ? '#3f3f46' : '#d4d4d8', width: 36, height: 5, borderRadius: 3 }}
      >
        {selectedComponent && (
          <View style={{ flex: 1 }}>
            {/* ── Header (non-scrollable, swipe here dismisses sheet) ── */}
            <View style={{ paddingHorizontal: 20, paddingTop: 4, paddingBottom: 16, borderBottomWidth: 1, borderBottomColor: borderColor }}>
              {/* Close button row */}
              <View style={{ flexDirection: 'row', justifyContent: 'flex-end', marginBottom: 12 }}>
                <BottomSheetTouchable
                  onPress={() => detailSheetRef.current?.dismiss()}
                  style={{
                    width: 30,
                    height: 30,
                    borderRadius: 999,
                    alignItems: 'center',
                    justifyContent: 'center',
                    backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)',
                  }}
                >
                  <Ionicons name="close" size={18} color={mutedColor} />
                </BottomSheetTouchable>
              </View>

              {/* Icon + name */}
              <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 12 }}>
                <View
                  style={{
                    width: 44,
                    height: 44,
                    borderRadius: 14,
                    alignItems: 'center',
                    justifyContent: 'center',
                    marginRight: 14,
                    backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)',
                    borderWidth: 1,
                    borderColor,
                  }}
                >
                  <Ionicons name={getTypeIcon(selectedComponent.type) as any} size={22} color={fgColor} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 20, fontFamily: 'Roobert-SemiBold', color: fgColor, lineHeight: 24 }}>
                    {selectedComponent.name}
                  </Text>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 6 }}>
                    <MetaPill label={getTypeLabel(selectedComponent.type)} isDark={isDark} />
                    <MetaPill label={`v${selectedComponent.version}`} isDark={isDark} />
                    {selectedInstalled && <MetaPill label="Installed" isDark={isDark} active />}
                  </View>
                </View>
              </View>

              {/* Description */}
              <Text style={{ fontSize: 13, lineHeight: 20, fontFamily: 'Roobert', color: mutedColor, marginBottom: 16 }}>
                {selectedComponent.description || 'No description available.'}
              </Text>

              {/* Action buttons */}
              <View style={{ flexDirection: 'row', gap: 8 }}>
                <BottomSheetTouchable
                  onPress={() => handleInstall(selectedComponent)}
                  disabled={isInstalling(selectedComponent.name) || selectedInstalled}
                  style={{
                    height: 32,
                    borderRadius: 8,
                    paddingHorizontal: 12,
                    alignItems: 'center',
                    justifyContent: 'center',
                    flexDirection: 'row',
                    gap: 5,
                    backgroundColor: selectedInstalled
                      ? (isDark ? 'rgba(16,185,129,0.12)' : 'rgba(16,185,129,0.08)')
                      : fgColor,
                    opacity: isInstalling(selectedComponent.name) ? 0.65 : 1,
                  }}
                >
                  <Ionicons
                    name={selectedInstalled ? 'checkmark-circle' : isInstalling(selectedComponent.name) ? 'hourglass-outline' : 'download-outline'}
                    size={13}
                    color={selectedInstalled ? '#10b981' : (isDark ? '#121215' : '#FFFFFF')}
                  />
                  <Text
                    style={{
                      fontSize: 12,
                      fontFamily: 'Roobert-Medium',
                      color: selectedInstalled ? '#10b981' : (isDark ? '#121215' : '#FFFFFF'),
                    }}
                  >
                    {isInstalling(selectedComponent.name) ? 'Installing...' : selectedInstalled ? 'Installed' : 'Install'}
                  </Text>
                </BottomSheetTouchable>

                <BottomSheetTouchable
                  onPress={() => Clipboard.setStringAsync(selectedComponent.name)}
                  style={{
                    height: 32,
                    borderRadius: 8,
                    paddingHorizontal: 10,
                    alignItems: 'center',
                    justifyContent: 'center',
                    flexDirection: 'row',
                    gap: 5,
                    borderWidth: 1,
                    borderColor,
                  }}
                >
                  <Ionicons name="copy-outline" size={13} color={mutedColor} />
                  <Text style={{ fontSize: 12, fontFamily: 'Roobert-Medium', color: mutedColor }}>Copy</Text>
                </BottomSheetTouchable>
              </View>
            </View>

            {/* ── File tabs (non-scrollable) ── */}
            {!bundleQuery.isLoading && !bundleQuery.error && (bundleQuery.data?.files?.length ?? 0) > 0 && (
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={{ paddingHorizontal: 16, paddingVertical: 10, gap: 6, alignItems: 'center' }}
                style={{ flexGrow: 0, borderBottomWidth: 1, borderBottomColor: borderColor }}
              >
                {(bundleQuery.data?.files || []).map((file) => {
                  const active = activeFile?.path === file.path;
                  return (
                    <BottomSheetTouchable
                      key={file.path}
                      onPress={() => setSelectedPath(file.path)}
                      style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        height: 36,
                        minHeight: 36,
                        maxHeight: 36,
                        paddingHorizontal: 12,
                        borderRadius: 10,
                        gap: 6,
                        backgroundColor: active
                          ? (isDark ? fgColor : '#121215')
                          : (isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.04)'),
                        borderWidth: active ? 0 : 1,
                        borderColor: active ? 'transparent' : borderColor,
                      }}
                    >
                      <Ionicons
                        name="document-text-outline"
                        size={13}
                        color={active ? (isDark ? '#121215' : '#FFFFFF') : mutedColor}
                      />
                      <Text
                        numberOfLines={1}
                        style={{
                          fontSize: 12,
                          fontFamily: active ? 'Roobert-Medium' : 'Roobert',
                          color: active ? (isDark ? '#121215' : '#FFFFFF') : mutedColor,
                        }}
                      >
                        {fileLabel(file.path)}
                      </Text>
                    </BottomSheetTouchable>
                  );
                })}
              </ScrollView>
            )}

            {/* ── Scrollable file content ── */}
            {bundleQuery.isLoading ? (
              <View style={{ paddingVertical: 40, alignItems: 'center' }}>
                <ActivityIndicator size="small" color={mutedColor} />
                <Text style={{ marginTop: 10, fontSize: 12, fontFamily: 'Roobert', color: mutedColor }}>Loading files...</Text>
              </View>
            ) : bundleQuery.error ? (
              <View style={{ margin: 16, padding: 14, borderRadius: 12, borderWidth: 1, borderColor, backgroundColor: isDark ? 'rgba(248,113,113,0.06)' : 'rgba(220,38,38,0.04)' }}>
                <Text style={{ fontSize: 12, fontFamily: 'Roobert', color: isDark ? '#f87171' : '#dc2626' }}>
                  {bundleQuery.error instanceof Error ? bundleQuery.error.message : 'Failed to load files'}
                </Text>
              </View>
            ) : (bundleQuery.data?.files?.length ?? 0) > 0 ? (
              <BottomSheetScrollView
                style={{ flex: 1 }}
                contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 28 }}
                showsVerticalScrollIndicator
              >
                {activeFile ? (
                  <View
                    style={{
                      borderRadius: 12,
                      padding: 14,
                      backgroundColor: isDark ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.02)',
                      borderWidth: 1,
                      borderColor,
                    }}
                  >
                    <Text
                      selectable
                      style={{
                        fontSize: isMarkdownPath(activeFile.path) ? 14 : 12,
                        lineHeight: isMarkdownPath(activeFile.path) ? 24 : 20,
                        fontFamily: isMarkdownPath(activeFile.path) ? 'Roobert' : monoFont,
                        color: fgColor,
                      }}
                    >
                      {activeFile.content}
                    </Text>
                  </View>
                ) : (
                  <View style={{ paddingVertical: 32, alignItems: 'center' }}>
                    <Ionicons name="document-text-outline" size={28} color={isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.08)'} />
                    <Text style={{ marginTop: 8, fontSize: 13, fontFamily: 'Roobert', color: mutedColor }}>Select a file to preview</Text>
                  </View>
                )}
              </BottomSheetScrollView>
            ) : (
              <View style={{ paddingVertical: 40, alignItems: 'center' }}>
                <Ionicons name="folder-open-outline" size={28} color={isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.08)'} />
                <Text style={{ marginTop: 8, fontSize: 13, fontFamily: 'Roobert', color: mutedColor }}>No files in this component</Text>
              </View>
            )}
          </View>
        )}
      </BottomSheetModal>
      </PageContent>
    </View>
  );
}
