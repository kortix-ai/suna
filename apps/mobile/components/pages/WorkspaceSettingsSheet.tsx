/**
 * WorkspaceSettingsSheet — Full OpenCode settings in a bottom sheet.
 *
 * 4 tabs matching frontend: General, Providers, Permissions, MCP Servers.
 * All mutations use the same REST endpoints as the frontend SDK.
 */

import React, { useState, useCallback, useMemo, useRef, useEffect, forwardRef, useImperativeHandle } from 'react';
import {
  View,
  TouchableOpacity,
  TextInput,
  Pressable,
  ScrollView,
  ActivityIndicator,
  Alert,
  Switch,
  Linking,
} from 'react-native';
import { Text as RNText } from 'react-native';
import {
  Settings,
  Zap,
  Shield,
  Server,
  ChevronRight,
  ChevronDown,
  Plus,
  Trash2,
  Power,
  Plug,
  AlertCircle,
  Check,
  X,
  ExternalLink,
} from 'lucide-react-native';
import { useColorScheme } from 'nativewind';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import {
  BottomSheetModal,
  BottomSheetBackdrop,
  BottomSheetScrollView,
} from '@gorhom/bottom-sheet';

import { useThemeColors } from '@/lib/theme-colors';
import { useSandboxContext } from '@/contexts/SandboxContext';
import {
  useOpenCodeConfig,
  useOpenCodeProviders,
  useOpenCodeToolIds,
  useOpenCodeMcpStatus,
  useUpdateOpenCodeConfig,
  useAddMcpServer,
  useConnectMcpServer,
  useDisconnectMcpServer,
  useMcpAuthStart,
  useMcpAuthCallback,
  flattenModels,
  type OpenCodeConfig,
  type McpStatus,
} from '@/lib/opencode/hooks/use-opencode-data';

// ─── Types ──────────────────────────────────────────────────────────────────

type SettingsTab = 'general' | 'providers' | 'permissions' | 'mcp';
type PermissionMode = 'allow' | 'ask' | 'deny';

const PROVIDER_LABELS: Record<string, string> = {
  anthropic: 'Anthropic', openai: 'OpenAI', google: 'Google', xai: 'xAI',
  opencode: 'OpenCode', kortix: 'Kortix', bedrock: 'AWS Bedrock',
  openrouter: 'OpenRouter', copilot: 'GitHub Copilot', vercel: 'Vercel',
};

const PERMISSION_TOOLS = [
  { key: 'read', label: 'Read files' },
  { key: 'edit', label: 'Edit files' },
  { key: 'bash', label: 'Run shell commands' },
  { key: 'glob', label: 'Search files by pattern' },
  { key: 'grep', label: 'Search file contents' },
  { key: 'list', label: 'List directory contents' },
  { key: 'webfetch', label: 'Fetch from web' },
  { key: 'task', label: 'Run sub-agent tasks' },
  { key: 'external_directory', label: 'Access outside project' },
  { key: 'doom_loop', label: 'Re-prompt on failure' },
];

// ─── Ref ────────────────────────────────────────────────────────────────────

export interface WorkspaceSettingsSheetRef {
  present: (tab?: SettingsTab) => void;
}

// ─── Component ──────────────────────────────────────────────────────────────

export const WorkspaceSettingsSheet = forwardRef<WorkspaceSettingsSheetRef, {}>(function WorkspaceSettingsSheet(_, ref) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const insets = useSafeAreaInsets();
  const theme = useThemeColors();
  const { sandboxUrl } = useSandboxContext();

  const fg = isDark ? '#F8F8F8' : '#121215';
  const bg = isDark ? '#121215' : '#F8F8F8';
  const muted = isDark ? 'rgba(255,255,255,0.4)' : 'rgba(0,0,0,0.4)';
  const inputBg = isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.03)';
  const cardBg = isDark ? 'rgba(255,255,255,0.03)' : '#FFFFFF';
  const borderColor = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)';
  const chipBg = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)';

  const sheetRef = useRef<BottomSheetModal>(null);
  const [activeTab, setActiveTab] = useState<SettingsTab>('general');

  // Data
  const { data: config, refetch: refetchConfig } = useOpenCodeConfig(sandboxUrl);
  const { data: providersData } = useOpenCodeProviders(sandboxUrl);
  const { data: toolIds } = useOpenCodeToolIds(sandboxUrl);
  const { data: mcpStatus, refetch: refetchMcp } = useOpenCodeMcpStatus(sandboxUrl);

  // Mutations
  const updateConfig = useUpdateOpenCodeConfig(sandboxUrl);
  const addMcpServer = useAddMcpServer(sandboxUrl);
  const connectMcp = useConnectMcpServer(sandboxUrl);
  const disconnectMcp = useDisconnectMcpServer(sandboxUrl);
  const mcpAuthStart = useMcpAuthStart(sandboxUrl);
  const mcpAuthCallback = useMcpAuthCallback(sandboxUrl);

  // Draft config state
  const [draftInstructions, setDraftInstructions] = useState('');
  const [draftModel, setDraftModel] = useState('');
  const [draftSnapshot, setDraftSnapshot] = useState(false);
  const [draftPermission, setDraftPermission] = useState<string | Record<string, string>>('ask');
  const [draftTools, setDraftTools] = useState<Record<string, boolean>>({});
  const [hasDraft, setHasDraft] = useState(false);

  // MCP add server state
  const [mcpView, setMcpView] = useState<'list' | 'add' | 'auth'>('list');
  const [mcpName, setMcpName] = useState('');
  const [mcpTransport, setMcpTransport] = useState<'local' | 'remote'>('local');
  const [mcpCommand, setMcpCommand] = useState('');
  const [mcpUrl, setMcpUrl] = useState('');
  const [mcpEnvPairs, setMcpEnvPairs] = useState<Array<{ key: string; value: string }>>([]);
  const [mcpError, setMcpError] = useState('');
  const [mcpAuthName, setMcpAuthName] = useState('');
  const [mcpAuthUrl, setMcpAuthUrl] = useState('');
  const [mcpAuthCode, setMcpAuthCode] = useState('');
  const [expandedServers, setExpandedServers] = useState<Set<string>>(new Set());

  // Sync config → draft on open
  useEffect(() => {
    if (config) {
      setDraftInstructions(Array.isArray(config.instructions) ? (config.instructions as string[]).join('\n') : '');
      setDraftModel((config.model as string) || '');
      setDraftSnapshot(!!(config.snapshot));
      setDraftPermission((config.permission as string | Record<string, string>) || 'ask');
      setDraftTools((config.tools as Record<string, boolean>) || {});
      setHasDraft(false);
    }
  }, [config]);

  const allModels = useMemo(() => {
    if (!providersData) return [];
    return flattenModels(providersData);
  }, [providersData]);

  const connectedProviders = useMemo(() => {
    if (!providersData) return [];
    const set = new Set(providersData.connected);
    return providersData.all.filter((p) => set.has(p.id));
  }, [providersData]);

  // Builtin tools (filter out MCP ones)
  const builtinTools = useMemo(() => {
    if (!toolIds) return [];
    return [...new Set(toolIds)].filter((id) => !id.startsWith('mcp_') && !id.startsWith('_mcp_') && !id.startsWith('_') && !id.startsWith('.'));
  }, [toolIds]);

  // MCP server tools mapping
  const serverTools = useMemo(() => {
    const map: Record<string, string[]> = {};
    if (!toolIds) return map;
    toolIds.forEach((id) => {
      const m = id.match(/^mcp_([^_]+)_(.+)$/);
      if (m) {
        if (!map[m[1]]) map[m[1]] = [];
        map[m[1]].push(m[2]);
      }
    });
    return map;
  }, [toolIds]);

  // Permission helpers
  const isPerTool = typeof draftPermission === 'object';
  const globalMode: PermissionMode = typeof draftPermission === 'string' ? (draftPermission as PermissionMode) : 'ask';
  const getToolPermission = (key: string): PermissionMode => {
    if (typeof draftPermission === 'object') return (draftPermission[key] || draftPermission['*'] || 'ask') as PermissionMode;
    return draftPermission as PermissionMode;
  };

  // Handlers
  const markDirty = () => setHasDraft(true);

  const handleSave = useCallback(async () => {
    const update: Partial<OpenCodeConfig> = {};
    const inst = draftInstructions.trim();
    update.instructions = inst ? inst.split('\n').map((s: string) => s.trim()).filter(Boolean) : [];
    update.model = draftModel || undefined;
    update.snapshot = draftSnapshot;
    update.permission = draftPermission;
    update.tools = draftTools;
    try {
      await updateConfig.mutateAsync(update);
      setHasDraft(false);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (err: any) {
      Alert.alert('Error', err?.message || 'Failed to save settings');
    }
  }, [draftInstructions, draftModel, draftSnapshot, draftPermission, draftTools, updateConfig]);

  const handleAddMcpServer = useCallback(async () => {
    if (!mcpName.trim()) { setMcpError('Server name is required'); return; }
    if (mcpTransport === 'local' && !mcpCommand.trim()) { setMcpError('Command is required'); return; }
    if (mcpTransport === 'remote' && !mcpUrl.trim()) { setMcpError('URL is required'); return; }
    setMcpError('');
    try {
      const env: Record<string, string> = {};
      mcpEnvPairs.forEach((p) => { if (p.key.trim()) env[p.key.trim()] = p.value; });
      await addMcpServer.mutateAsync({
        name: mcpName.trim(),
        type: mcpTransport,
        command: mcpTransport === 'local' ? mcpCommand.trim().split(/\s+/) : undefined,
        url: mcpTransport === 'remote' ? mcpUrl.trim() : undefined,
        env: Object.keys(env).length > 0 ? env : undefined,
      });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setMcpView('list');
      setMcpName(''); setMcpCommand(''); setMcpUrl(''); setMcpEnvPairs([]);
    } catch (err: any) {
      setMcpError(err?.message || 'Failed to add server');
    }
  }, [mcpName, mcpTransport, mcpCommand, mcpUrl, mcpEnvPairs, addMcpServer]);

  const handleMcpAuth = useCallback(async (name: string) => {
    setMcpAuthName(name);
    setMcpView('auth');
    setMcpAuthUrl('');
    setMcpAuthCode('');
    try {
      const result = await mcpAuthStart.mutateAsync(name);
      setMcpAuthUrl(result.authorizationUrl);
    } catch (err: any) {
      setMcpError(err?.message || 'Failed to start auth');
    }
  }, [mcpAuthStart]);

  const handleMcpAuthSubmit = useCallback(async () => {
    if (!mcpAuthCode.trim()) return;
    try {
      await mcpAuthCallback.mutateAsync({ name: mcpAuthName, code: mcpAuthCode.trim() });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setMcpView('list');
    } catch (err: any) {
      Alert.alert('Auth Error', err?.message || 'Failed to complete auth');
    }
  }, [mcpAuthName, mcpAuthCode, mcpAuthCallback]);

  useImperativeHandle(ref, () => ({
    present: (tab?: SettingsTab) => {
      if (tab) setActiveTab(tab);
      setMcpView('list');
      sheetRef.current?.present();
    },
  }));

  const renderBackdrop = useCallback(
    (props: any) => <BottomSheetBackdrop {...props} disappearsOnIndex={-1} appearsOnIndex={0} opacity={0.5} />,
    [],
  );

  // ─── Tab bar ──────────────────────────────────────────────────────
  const TABS: Array<{ id: SettingsTab; label: string; Icon: React.ComponentType<any> }> = [
    { id: 'general', label: 'General', Icon: Settings },
    { id: 'providers', label: 'Providers', Icon: Zap },
    { id: 'permissions', label: 'Permissions', Icon: Shield },
    { id: 'mcp', label: 'MCP', Icon: Server },
  ];

  // ─── Permission pill ──────────────────────────────────────────────
  const PermPill = ({ mode, active, onPress }: { mode: PermissionMode; active: boolean; onPress: () => void }) => {
    const colors: Record<PermissionMode, string> = { allow: '#22C55E', ask: '#F59E0B', deny: '#EF4444' };
    const color = colors[mode];
    return (
      <Pressable
        onPress={onPress}
        style={{
          paddingHorizontal: 14, paddingVertical: 7, borderRadius: 8,
          backgroundColor: active ? color : chipBg,
          opacity: active ? 1 : 0.6,
        }}
      >
        <RNText style={{ fontSize: 12, fontFamily: 'Roobert-Medium', color: active ? '#FFFFFF' : fg, textTransform: 'capitalize' }}>
          {mode}
        </RNText>
      </Pressable>
    );
  };

  // ─── Status dot ───────────────────────────────────────────────────
  const StatusDot = ({ status }: { status: string }) => {
    const color = status === 'connected' ? '#22C55E' : status === 'failed' ? '#EF4444' : status === 'needs_auth' || status === 'needs_client_registration' ? '#F59E0B' : muted;
    const label = status === 'connected' ? 'Connected' : status === 'failed' ? 'Error' : status === 'needs_auth' || status === 'needs_client_registration' ? 'Needs auth' : status === 'disabled' ? 'Disconnected' : 'Pending';
    return (
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
        <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: color }} />
        <RNText style={{ fontSize: 11, fontFamily: 'Roobert', color: muted }}>{label}</RNText>
      </View>
    );
  };

  return (
    <BottomSheetModal
      ref={sheetRef}
      snapPoints={['92%']}
      enablePanDownToClose
      backdropComponent={renderBackdrop}
      backgroundStyle={{ backgroundColor: bg, borderRadius: 24 }}
      handleIndicatorStyle={{ backgroundColor: isDark ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.15)', width: 36 }}
    >
      <View style={{ flex: 1 }}>
        {/* Header */}
        <View style={{ paddingHorizontal: 20, paddingBottom: 12 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 14 }}>
            <Settings size={18} color={fg} />
            <RNText style={{ fontSize: 18, fontFamily: 'Roobert-SemiBold', color: fg }}>Settings</RNText>
          </View>

          {/* Tab bar */}
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 2 }}>
            {TABS.map((tab) => {
              const isActive = activeTab === tab.id;
              return (
                <Pressable
                  key={tab.id}
                  onPress={() => { setActiveTab(tab.id); if (tab.id === 'mcp') setMcpView('list'); Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); }}
                  style={{
                    flexDirection: 'row', alignItems: 'center', gap: 6,
                    paddingHorizontal: 14, paddingVertical: 8, borderRadius: 10,
                    backgroundColor: isActive ? theme.primaryLight : 'transparent',
                    borderWidth: isActive ? 1 : 0,
                    borderColor: isActive ? theme.primary + '30' : 'transparent',
                  }}
                >
                  <tab.Icon size={14} color={isActive ? theme.primary : muted} />
                  <RNText style={{ fontSize: 13, fontFamily: 'Roobert-Medium', color: isActive ? theme.primary : muted }}>
                    {tab.label}
                  </RNText>
                </Pressable>
              );
            })}
          </ScrollView>
        </View>

        {/* Content */}
        <BottomSheetScrollView contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: insets.bottom + 80 }}>

          {/* ──── GENERAL TAB ──── */}
          {activeTab === 'general' && (
            <View>
              {/* Custom Instructions */}
              <RNText style={{ fontSize: 11, fontFamily: 'Roobert-SemiBold', color: muted, letterSpacing: 1, textTransform: 'uppercase', marginBottom: 4 }}>
                Custom Instructions
              </RNText>
              <RNText style={{ fontSize: 12, fontFamily: 'Roobert', color: muted, marginBottom: 8 }}>
                Additional instruction file paths, one per line
              </RNText>
              <TextInput
                value={draftInstructions}
                onChangeText={(t) => { setDraftInstructions(t); markDirty(); }}
                placeholder="docs/rules.md"
                placeholderTextColor={isDark ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.2)'}
                multiline
                style={{
                  backgroundColor: inputBg, borderRadius: 12, borderWidth: 1, borderColor,
                  padding: 14, fontSize: 13, fontFamily: 'monospace', color: fg,
                  minHeight: 80, textAlignVertical: 'top',
                }}
              />

              {/* Default Model */}
              <RNText style={{ fontSize: 11, fontFamily: 'Roobert-SemiBold', color: muted, letterSpacing: 1, textTransform: 'uppercase', marginTop: 20, marginBottom: 8 }}>
                Default Model
              </RNText>
              <View style={{ backgroundColor: inputBg, borderRadius: 12, borderWidth: 1, borderColor }}>
                <Pressable
                  onPress={() => {
                    const options = [{ text: 'Auto-detect', value: '' }, ...allModels.map((m) => ({ text: `${m.providerID}/${m.modelID}`, value: `${m.providerID}/${m.modelID}` }))];
                    Alert.alert('Select Model', undefined, [
                      ...options.slice(0, 10).map((o) => ({
                        text: o.text,
                        onPress: () => { setDraftModel(o.value); markDirty(); },
                      })),
                      { text: 'Cancel', style: 'cancel' as const },
                    ]);
                  }}
                  style={{ padding: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}
                >
                  <RNText style={{ fontSize: 13, fontFamily: 'Roobert', color: draftModel ? fg : muted }}>
                    {draftModel || 'Auto-detect'}
                  </RNText>
                  <ChevronDown size={14} color={muted} />
                </Pressable>
              </View>

              {/* Snapshots */}
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 20 }}>
                <View style={{ flex: 1 }}>
                  <RNText style={{ fontSize: 11, fontFamily: 'Roobert-SemiBold', color: muted, letterSpacing: 1, textTransform: 'uppercase' }}>
                    Snapshots
                  </RNText>
                  <RNText style={{ fontSize: 12, fontFamily: 'Roobert', color: muted, marginTop: 2 }}>
                    Git snapshot at each agentic step
                  </RNText>
                </View>
                <Switch
                  value={draftSnapshot}
                  onValueChange={(v) => { setDraftSnapshot(v); markDirty(); }}
                  trackColor={{ false: chipBg, true: theme.primary }}
                  thumbColor="#FFFFFF"
                />
              </View>
            </View>
          )}

          {/* ──── PROVIDERS TAB ──── */}
          {activeTab === 'providers' && (
            <View>
              <RNText style={{ fontSize: 11, fontFamily: 'Roobert-SemiBold', color: muted, letterSpacing: 1, textTransform: 'uppercase', marginBottom: 12 }}>
                Connected Providers ({connectedProviders.length})
              </RNText>
              {connectedProviders.length === 0 ? (
                <View style={{ padding: 24, alignItems: 'center' }}>
                  <RNText style={{ fontSize: 13, fontFamily: 'Roobert', color: muted }}>No providers connected</RNText>
                </View>
              ) : (
                connectedProviders.map((provider) => {
                  const modelCount = Object.keys(provider.models).length;
                  return (
                    <View
                      key={provider.id}
                      style={{
                        flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
                        backgroundColor: cardBg, borderWidth: 1, borderColor,
                        borderRadius: 12, padding: 14, marginBottom: 8,
                      }}
                    >
                      <View>
                        <RNText style={{ fontSize: 14, fontFamily: 'Roobert-Medium', color: fg }}>
                          {PROVIDER_LABELS[provider.id] || provider.name || provider.id}
                        </RNText>
                        <RNText style={{ fontSize: 12, fontFamily: 'Roobert', color: muted, marginTop: 2 }}>
                          {modelCount} model{modelCount !== 1 ? 's' : ''}
                        </RNText>
                      </View>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
                        <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: '#22C55E' }} />
                        <RNText style={{ fontSize: 11, fontFamily: 'Roobert', color: '#22C55E' }}>Connected</RNText>
                      </View>
                    </View>
                  );
                })
              )}
            </View>
          )}

          {/* ──── PERMISSIONS TAB ──── */}
          {activeTab === 'permissions' && (
            <View>
              {/* Global permission mode */}
              <RNText style={{ fontSize: 11, fontFamily: 'Roobert-SemiBold', color: muted, letterSpacing: 1, textTransform: 'uppercase', marginBottom: 10 }}>
                Permission Mode
              </RNText>
              <View style={{ flexDirection: 'row', gap: 8, marginBottom: 20, flexWrap: 'wrap' }}>
                {(['allow', 'ask', 'deny'] as PermissionMode[]).map((mode) => (
                  <PermPill
                    key={mode}
                    mode={mode}
                    active={!isPerTool && globalMode === mode}
                    onPress={() => { setDraftPermission(mode); markDirty(); }}
                  />
                ))}
                <Pressable
                  onPress={() => {
                    setDraftPermission(isPerTool ? 'ask' : { '*': globalMode });
                    markDirty();
                  }}
                  style={{
                    paddingHorizontal: 14, paddingVertical: 7, borderRadius: 8,
                    backgroundColor: isPerTool ? '#3B82F6' : chipBg,
                    opacity: isPerTool ? 1 : 0.6,
                  }}
                >
                  <RNText style={{ fontSize: 12, fontFamily: 'Roobert-Medium', color: isPerTool ? '#FFFFFF' : fg }}>
                    Per-tool
                  </RNText>
                </Pressable>
              </View>

              {/* Per-tool permissions */}
              {isPerTool && (
                <View style={{ marginBottom: 20 }}>
                  <RNText style={{ fontSize: 11, fontFamily: 'Roobert-SemiBold', color: muted, letterSpacing: 1, textTransform: 'uppercase', marginBottom: 10 }}>
                    Tool Permissions
                  </RNText>
                  {PERMISSION_TOOLS.map((tool) => {
                    const current = getToolPermission(tool.key);
                    return (
                      <View
                        key={tool.key}
                        style={{
                          flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
                          backgroundColor: cardBg, borderWidth: 1, borderColor,
                          borderRadius: 12, padding: 12, marginBottom: 6,
                        }}
                      >
                        <RNText style={{ fontSize: 13, fontFamily: 'Roobert', color: fg, flex: 1 }}>{tool.label}</RNText>
                        <View style={{ flexDirection: 'row', gap: 4 }}>
                          {(['allow', 'ask', 'deny'] as PermissionMode[]).map((mode) => (
                            <Pressable
                              key={mode}
                              onPress={() => {
                                const p = { ...(draftPermission as Record<string, string>), [tool.key]: mode };
                                setDraftPermission(p);
                                markDirty();
                              }}
                              style={{
                                paddingHorizontal: 8, paddingVertical: 4, borderRadius: 6,
                                backgroundColor: current === mode
                                  ? (mode === 'allow' ? '#22C55E' : mode === 'ask' ? '#F59E0B' : '#EF4444')
                                  : chipBg,
                              }}
                            >
                              <RNText style={{ fontSize: 10, fontFamily: 'Roobert-Medium', color: current === mode ? '#FFFFFF' : muted, textTransform: 'capitalize' }}>
                                {mode}
                              </RNText>
                            </Pressable>
                          ))}
                        </View>
                      </View>
                    );
                  })}
                </View>
              )}

              {/* Tool overrides */}
              <RNText style={{ fontSize: 11, fontFamily: 'Roobert-SemiBold', color: muted, letterSpacing: 1, textTransform: 'uppercase', marginBottom: 10 }}>
                Tool Overrides
              </RNText>
              {builtinTools.map((toolId) => {
                const enabled = draftTools[toolId] !== false;
                return (
                  <View
                    key={toolId}
                    style={{
                      flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
                      backgroundColor: cardBg, borderWidth: 1, borderColor,
                      borderRadius: 12, padding: 12, marginBottom: 6,
                    }}
                  >
                    <RNText style={{ fontSize: 13, fontFamily: 'monospace', color: fg, flex: 1 }} numberOfLines={1}>{toolId}</RNText>
                    <Switch
                      value={enabled}
                      onValueChange={(v) => {
                        const newTools = { ...draftTools };
                        if (v) { delete newTools[toolId]; } else { newTools[toolId] = false; }
                        setDraftTools(newTools);
                        markDirty();
                      }}
                      trackColor={{ false: chipBg, true: theme.primary }}
                      thumbColor="#FFFFFF"
                    />
                  </View>
                );
              })}
            </View>
          )}

          {/* ──── MCP TAB ──── */}
          {activeTab === 'mcp' && mcpView === 'list' && (
            <View>
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                <RNText style={{ fontSize: 11, fontFamily: 'Roobert-SemiBold', color: muted, letterSpacing: 1, textTransform: 'uppercase' }}>
                  MCP Servers ({mcpStatus ? Object.keys(mcpStatus).length : 0})
                </RNText>
                <Pressable
                  onPress={() => setMcpView('add')}
                  style={{ flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: theme.primary, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 6 }}
                >
                  <Plus size={14} color={theme.primaryForeground} />
                  <RNText style={{ fontSize: 12, fontFamily: 'Roobert-Medium', color: theme.primaryForeground }}>Add</RNText>
                </Pressable>
              </View>

              {mcpStatus && Object.entries(mcpStatus).map(([name, status]) => {
                const isExpanded = expandedServers.has(name);
                const tools = serverTools[name] || [];
                return (
                  <View
                    key={name}
                    style={{ backgroundColor: cardBg, borderWidth: 1, borderColor, borderRadius: 12, marginBottom: 8, overflow: 'hidden' }}
                  >
                    <View style={{ padding: 14 }}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                        <View style={{ flex: 1 }}>
                          <RNText style={{ fontSize: 14, fontFamily: 'Roobert-Medium', color: fg }}>{name}</RNText>
                          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 4 }}>
                            <StatusDot status={status.status} />
                            {tools.length > 0 && (
                              <RNText style={{ fontSize: 11, fontFamily: 'Roobert', color: muted }}>{tools.length} tools</RNText>
                            )}
                          </View>
                        </View>

                        <View style={{ flexDirection: 'row', gap: 8 }}>
                          {(status.status === 'needs_auth' || status.status === 'needs_client_registration') && (
                            <TouchableOpacity onPress={() => handleMcpAuth(name)} style={{ padding: 6 }}>
                              <Plug size={16} color="#F59E0B" />
                            </TouchableOpacity>
                          )}
                          <TouchableOpacity
                            onPress={() => {
                              if (status.status === 'connected') {
                                disconnectMcp.mutate(name);
                              } else if (status.status === 'disabled' || status.status === 'failed') {
                                connectMcp.mutate(name);
                              }
                            }}
                            style={{ padding: 6 }}
                          >
                            <Power size={16} color={status.status === 'connected' ? '#22C55E' : muted} />
                          </TouchableOpacity>
                          {tools.length > 0 && (
                            <TouchableOpacity
                              onPress={() => {
                                const next = new Set(expandedServers);
                                isExpanded ? next.delete(name) : next.add(name);
                                setExpandedServers(next);
                              }}
                              style={{ padding: 6 }}
                            >
                              {isExpanded ? <ChevronDown size={16} color={muted} /> : <ChevronRight size={16} color={muted} />}
                            </TouchableOpacity>
                          )}
                        </View>
                      </View>

                      {status.status === 'failed' && status.error && (
                        <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 6, marginTop: 8, backgroundColor: 'rgba(239,68,68,0.08)', borderRadius: 8, padding: 10 }}>
                          <AlertCircle size={12} color="#EF4444" style={{ marginTop: 1 }} />
                          <RNText style={{ fontSize: 12, fontFamily: 'Roobert', color: '#EF4444', flex: 1 }}>{status.error}</RNText>
                        </View>
                      )}
                    </View>

                    {/* Expanded tools list */}
                    {isExpanded && tools.length > 0 && (
                      <View style={{ borderTopWidth: 1, borderTopColor: borderColor, paddingHorizontal: 14, paddingVertical: 10 }}>
                        {tools.map((tool) => (
                          <RNText key={tool} style={{ fontSize: 12, fontFamily: 'monospace', color: muted, paddingVertical: 2 }}>{tool}</RNText>
                        ))}
                      </View>
                    )}
                  </View>
                );
              })}

              {(!mcpStatus || Object.keys(mcpStatus).length === 0) && (
                <View style={{ padding: 24, alignItems: 'center' }}>
                  <Server size={24} color={isDark ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.12)'} />
                  <RNText style={{ fontSize: 13, fontFamily: 'Roobert', color: muted, marginTop: 8 }}>No MCP servers configured</RNText>
                </View>
              )}
            </View>
          )}

          {/* ──── MCP ADD VIEW ──── */}
          {activeTab === 'mcp' && mcpView === 'add' && (
            <View>
              <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 16 }}>
                <TouchableOpacity onPress={() => { setMcpView('list'); setMcpError(''); }} style={{ marginRight: 12, padding: 4 }}>
                  <X size={18} color={fg} />
                </TouchableOpacity>
                <RNText style={{ fontSize: 15, fontFamily: 'Roobert-SemiBold', color: fg }}>Add MCP Server</RNText>
              </View>

              {/* Name */}
              <RNText style={{ fontSize: 11, fontFamily: 'Roobert-SemiBold', color: muted, letterSpacing: 1, textTransform: 'uppercase', marginBottom: 6 }}>
                Server Name
              </RNText>
              <TextInput
                value={mcpName}
                onChangeText={setMcpName}
                placeholder="my-server"
                placeholderTextColor={isDark ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.2)'}
                style={{ backgroundColor: inputBg, borderRadius: 12, borderWidth: 1, borderColor, padding: 14, fontSize: 13, fontFamily: 'Roobert', color: fg, marginBottom: 16 }}
              />

              {/* Transport */}
              <RNText style={{ fontSize: 11, fontFamily: 'Roobert-SemiBold', color: muted, letterSpacing: 1, textTransform: 'uppercase', marginBottom: 8 }}>
                Transport
              </RNText>
              <View style={{ flexDirection: 'row', gap: 8, marginBottom: 16 }}>
                {(['local', 'remote'] as const).map((t) => (
                  <Pressable
                    key={t}
                    onPress={() => setMcpTransport(t)}
                    style={{
                      flex: 1, paddingVertical: 10, borderRadius: 10, alignItems: 'center',
                      backgroundColor: mcpTransport === t ? theme.primaryLight : chipBg,
                      borderWidth: 1, borderColor: mcpTransport === t ? theme.primary + '40' : borderColor,
                    }}
                  >
                    <RNText style={{ fontSize: 13, fontFamily: 'Roobert-Medium', color: mcpTransport === t ? theme.primary : fg }}>
                      {t === 'local' ? 'Stdio' : 'HTTP'}
                    </RNText>
                  </Pressable>
                ))}
              </View>

              {/* Command or URL */}
              {mcpTransport === 'local' ? (
                <>
                  <RNText style={{ fontSize: 11, fontFamily: 'Roobert-SemiBold', color: muted, letterSpacing: 1, textTransform: 'uppercase', marginBottom: 6 }}>
                    Command
                  </RNText>
                  <TextInput
                    value={mcpCommand}
                    onChangeText={setMcpCommand}
                    placeholder="npx -y @my/server"
                    placeholderTextColor={isDark ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.2)'}
                    style={{ backgroundColor: inputBg, borderRadius: 12, borderWidth: 1, borderColor, padding: 14, fontSize: 13, fontFamily: 'monospace', color: fg, marginBottom: 16 }}
                  />
                </>
              ) : (
                <>
                  <RNText style={{ fontSize: 11, fontFamily: 'Roobert-SemiBold', color: muted, letterSpacing: 1, textTransform: 'uppercase', marginBottom: 6 }}>
                    URL
                  </RNText>
                  <TextInput
                    value={mcpUrl}
                    onChangeText={setMcpUrl}
                    placeholder="https://..."
                    placeholderTextColor={isDark ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.2)'}
                    autoCapitalize="none"
                    keyboardType="url"
                    style={{ backgroundColor: inputBg, borderRadius: 12, borderWidth: 1, borderColor, padding: 14, fontSize: 13, fontFamily: 'Roobert', color: fg, marginBottom: 16 }}
                  />
                </>
              )}

              {/* Env vars */}
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                <RNText style={{ fontSize: 11, fontFamily: 'Roobert-SemiBold', color: muted, letterSpacing: 1, textTransform: 'uppercase' }}>
                  Environment Variables
                </RNText>
                <TouchableOpacity onPress={() => setMcpEnvPairs([...mcpEnvPairs, { key: '', value: '' }])}>
                  <Plus size={16} color={theme.primary} />
                </TouchableOpacity>
              </View>
              {mcpEnvPairs.map((pair, i) => (
                <View key={i} style={{ flexDirection: 'row', gap: 8, marginBottom: 8, alignItems: 'center' }}>
                  <TextInput
                    value={pair.key}
                    onChangeText={(t) => { const n = [...mcpEnvPairs]; n[i] = { ...n[i], key: t }; setMcpEnvPairs(n); }}
                    placeholder="KEY"
                    placeholderTextColor={isDark ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.2)'}
                    autoCapitalize="characters"
                    style={{ flex: 1, backgroundColor: inputBg, borderRadius: 10, borderWidth: 1, borderColor, padding: 10, fontSize: 12, fontFamily: 'monospace', color: fg }}
                  />
                  <TextInput
                    value={pair.value}
                    onChangeText={(t) => { const n = [...mcpEnvPairs]; n[i] = { ...n[i], value: t }; setMcpEnvPairs(n); }}
                    placeholder="value"
                    placeholderTextColor={isDark ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.2)'}
                    secureTextEntry
                    style={{ flex: 1, backgroundColor: inputBg, borderRadius: 10, borderWidth: 1, borderColor, padding: 10, fontSize: 12, fontFamily: 'Roobert', color: fg }}
                  />
                  <TouchableOpacity onPress={() => setMcpEnvPairs(mcpEnvPairs.filter((_, j) => j !== i))} style={{ padding: 4 }}>
                    <Trash2 size={14} color="#EF4444" />
                  </TouchableOpacity>
                </View>
              ))}

              {/* Error */}
              {mcpError ? (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 8, backgroundColor: 'rgba(239,68,68,0.08)', borderRadius: 8, padding: 10 }}>
                  <AlertCircle size={12} color="#EF4444" />
                  <RNText style={{ fontSize: 12, fontFamily: 'Roobert', color: '#EF4444', flex: 1 }}>{mcpError}</RNText>
                </View>
              ) : null}

              {/* Submit */}
              <Pressable
                onPress={handleAddMcpServer}
                disabled={addMcpServer.isPending}
                style={{
                  marginTop: 16, backgroundColor: theme.primary, borderRadius: 9999,
                  paddingVertical: 14, alignItems: 'center',
                  opacity: addMcpServer.isPending ? 0.6 : 1,
                }}
              >
                {addMcpServer.isPending ? (
                  <ActivityIndicator color={theme.primaryForeground} size="small" />
                ) : (
                  <RNText style={{ fontSize: 14, fontFamily: 'Roobert-SemiBold', color: theme.primaryForeground }}>Add Server</RNText>
                )}
              </Pressable>
            </View>
          )}

          {/* ──── MCP AUTH VIEW ──── */}
          {activeTab === 'mcp' && mcpView === 'auth' && (
            <View>
              <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 16 }}>
                <TouchableOpacity onPress={() => setMcpView('list')} style={{ marginRight: 12, padding: 4 }}>
                  <X size={18} color={fg} />
                </TouchableOpacity>
                <RNText style={{ fontSize: 15, fontFamily: 'Roobert-SemiBold', color: fg }}>Authorize: {mcpAuthName}</RNText>
              </View>

              {mcpAuthStart.isPending ? (
                <View style={{ padding: 24, alignItems: 'center' }}>
                  <ActivityIndicator color={theme.primary} />
                  <RNText style={{ fontSize: 13, fontFamily: 'Roobert', color: muted, marginTop: 8 }}>Starting authorization...</RNText>
                </View>
              ) : mcpAuthUrl ? (
                <>
                  <RNText style={{ fontSize: 13, fontFamily: 'Roobert', color: fg, marginBottom: 12 }}>
                    Open this URL to authorize, then paste the redirect URL below:
                  </RNText>
                  <Pressable
                    onPress={() => Linking.openURL(mcpAuthUrl)}
                    style={{ flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: theme.primaryLight, borderRadius: 10, padding: 12, marginBottom: 16 }}
                  >
                    <ExternalLink size={14} color={theme.primary} />
                    <RNText style={{ fontSize: 12, fontFamily: 'Roobert-Medium', color: theme.primary, flex: 1 }} numberOfLines={1}>
                      Open authorization URL
                    </RNText>
                  </Pressable>

                  <RNText style={{ fontSize: 11, fontFamily: 'Roobert-SemiBold', color: muted, letterSpacing: 1, textTransform: 'uppercase', marginBottom: 6 }}>
                    Redirect URL or Code
                  </RNText>
                  <TextInput
                    value={mcpAuthCode}
                    onChangeText={setMcpAuthCode}
                    placeholder="Paste localhost redirect URL..."
                    placeholderTextColor={isDark ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.2)'}
                    autoCapitalize="none"
                    style={{ backgroundColor: inputBg, borderRadius: 12, borderWidth: 1, borderColor, padding: 14, fontSize: 13, fontFamily: 'Roobert', color: fg, marginBottom: 16 }}
                  />

                  <Pressable
                    onPress={handleMcpAuthSubmit}
                    disabled={mcpAuthCallback.isPending || !mcpAuthCode.trim()}
                    style={{
                      backgroundColor: theme.primary, borderRadius: 9999,
                      paddingVertical: 14, alignItems: 'center',
                      opacity: mcpAuthCallback.isPending || !mcpAuthCode.trim() ? 0.6 : 1,
                    }}
                  >
                    {mcpAuthCallback.isPending ? (
                      <ActivityIndicator color={theme.primaryForeground} size="small" />
                    ) : (
                      <RNText style={{ fontSize: 14, fontFamily: 'Roobert-SemiBold', color: theme.primaryForeground }}>Complete Authorization</RNText>
                    )}
                  </Pressable>
                </>
              ) : null}
            </View>
          )}
        </BottomSheetScrollView>

        {/* Save/Discard footer */}
        {hasDraft && (activeTab === 'general' || activeTab === 'permissions') && (
          <View style={{
            position: 'absolute', bottom: 0, left: 0, right: 0,
            paddingHorizontal: 20, paddingBottom: insets.bottom + 12, paddingTop: 12,
            backgroundColor: bg,
            borderTopWidth: 1, borderTopColor: borderColor,
            flexDirection: 'row', gap: 12,
          }}>
            <Pressable
              onPress={() => {
                if (config) {
                  setDraftInstructions(Array.isArray(config.instructions) ? (config.instructions as string[]).join('\n') : '');
                  setDraftModel((config.model as string) || '');
                  setDraftSnapshot(!!(config.snapshot));
                  setDraftPermission((config.permission as string | Record<string, string>) || 'ask');
                  setDraftTools((config.tools as Record<string, boolean>) || {});
                }
                setHasDraft(false);
              }}
              style={{ flex: 1, paddingVertical: 12, borderRadius: 9999, alignItems: 'center', backgroundColor: chipBg }}
            >
              <RNText style={{ fontSize: 14, fontFamily: 'Roobert-Medium', color: fg }}>Discard</RNText>
            </Pressable>
            <Pressable
              onPress={handleSave}
              disabled={updateConfig.isPending}
              style={{ flex: 1, paddingVertical: 12, borderRadius: 9999, alignItems: 'center', backgroundColor: theme.primary, opacity: updateConfig.isPending ? 0.6 : 1 }}
            >
              {updateConfig.isPending ? (
                <ActivityIndicator color={theme.primaryForeground} size="small" />
              ) : (
                <RNText style={{ fontSize: 14, fontFamily: 'Roobert-SemiBold', color: theme.primaryForeground }}>Save</RNText>
              )}
            </Pressable>
          </View>
        )}
      </View>
    </BottomSheetModal>
  );
});
