/**
 * ChannelsPage — full-screen channels management with setup wizards.
 * Create, list, enable/disable, edit, and delete channels.
 * Includes Telegram (2-step) and Slack (3-step) setup wizards matching frontend.
 */

import React, { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import {
  View,
  FlatList,
  TextInput,
  Pressable,
  Alert,
  ActivityIndicator,
  Switch,
  StyleSheet,
  Keyboard,
  TouchableOpacity,
  ScrollView,
  Linking,
} from 'react-native';
import { Text } from '@/components/ui/text';
import { Text as RNText } from 'react-native';
import {
  Plus,
  Search,
  X,
  ChevronRight,
  Trash2,
  Radio,
  ArrowRight,
  ArrowLeft,
  Check,
  Copy,
  ExternalLink,
} from 'lucide-react-native';
import { useColorScheme } from 'nativewind';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import * as Clipboard from 'expo-clipboard';
import BottomSheet, {
  BottomSheetBackdrop,
  BottomSheetModal,
  BottomSheetView,
  BottomSheetTextInput,
  BottomSheetScrollView,
} from '@gorhom/bottom-sheet';

import { useThemeColors } from '@/lib/theme-colors';
import { useSheetBottomPadding } from '@/hooks/useSheetKeyboard';
import { useSandboxContext } from '@/contexts/SandboxContext';
import type { PageTab } from '@/stores/tab-store';
import { PageHeader } from '@/components/ui/page-header';
import { PageContent } from '@/components/ui/page-content';
import {
  useChannels,
  useUpdateChannel,
  useDeleteChannel,
  useToggleChannel,
  getChannelTypeLabel,
  type ChannelConfig,
  type ChannelType,
} from '@/hooks/useChannels';
import {
  useTelegramVerifyToken,
  useTelegramConnect,
  useSlackGenerateManifest,
  useSlackConnect,
} from '@/hooks/useChannelWizards';
import { useOpenCodeAgents, useOpenCodeProviders, flattenModels, filterToLatestModels } from '@/lib/opencode/hooks/use-opencode-data';

// ─── Channel Type Icons ─────────────────────────────────────────────────────

const CHANNEL_TYPE_ICONS: Record<ChannelType, string> = {
  telegram: 'paper-plane-outline',
  slack: 'logo-slack',
  discord: 'logo-discord',
  whatsapp: 'chatbubble-outline',
  teams: 'people-outline',
  voice: 'mic-outline',
  email: 'mail-outline',
  sms: 'chatbox-outline',
};

function getChannelIcon(type: ChannelType): string {
  return CHANNEL_TYPE_ICONS[type] || 'radio-outline';
}

const SUPPORTED_CHANNEL_TYPES: ChannelType[] = ['telegram', 'slack'];

const ALL_CHANNEL_TYPES: { type: ChannelType; label: string }[] = [
  { type: 'telegram', label: 'Telegram' },
  { type: 'slack', label: 'Slack' },
  { type: 'discord', label: 'Discord' },
  { type: 'whatsapp', label: 'WhatsApp' },
  { type: 'teams', label: 'Teams' },
  { type: 'voice', label: 'Voice' },
  { type: 'email', label: 'Email' },
  { type: 'sms', label: 'SMS' },
];

// ─── Tab Page Wrapper ────────────────────────────────────────────────────────

interface ChannelsTabPageProps {
  page: PageTab;
  onBack: () => void;
  onOpenDrawer?: () => void;
  onOpenRightDrawer?: () => void;
  isDrawerOpen?: boolean;
  isRightDrawerOpen?: boolean;
}

export function ChannelsTabPage({
  page,
  onBack,
  onOpenDrawer,
  onOpenRightDrawer,
  isDrawerOpen,
  isRightDrawerOpen,
}: ChannelsTabPageProps) {
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
        <ChannelsContent />
      </PageContent>
    </View>
  );
}

// ─── Main Content ────────────────────────────────────────────────────────────

function ChannelsContent() {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const insets = useSafeAreaInsets();
  const theme = useThemeColors();
  const { sandboxUrl, sandboxUuid } = useSandboxContext();

  const { data: channels, isLoading, error, refetch } = useChannels();
  const deleteChannelMut = useDeleteChannel();
  const toggleChannel = useToggleChannel();
  const updateChannel = useUpdateChannel();

  const [searchQuery, setSearchQuery] = useState('');
  const [selectedChannel, setSelectedChannel] = useState<ChannelConfig | null>(null);

  const detailSheetRef = useRef<BottomSheetModal>(null);
  const addSheetRef = useRef<BottomSheetModal>(null);

  // Colors
  const fg = isDark ? '#f8f8f8' : '#121215';
  const muted = isDark ? 'rgba(248,248,248,0.5)' : 'rgba(18,18,21,0.5)';
  const inputBg = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)';

  // Filter + sort channels
  const filteredChannels = useMemo(() => {
    if (!channels) return [];
    let list = [...channels];
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      list = list.filter(
        (c) =>
          c.name.toLowerCase().includes(q) ||
          (c.platform || c.channelType!).toLowerCase().includes(q) ||
          getChannelTypeLabel((c.platform || c.channelType!)).toLowerCase().includes(q),
      );
    }
    list.sort((a, b) => {
      if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
      return new Date(b.updated_at || b.updatedAt || 0).getTime() - new Date(a.updated_at || a.updatedAt || 0).getTime();
    });
    return list;
  }, [channels, searchQuery]);

  const handleSelectChannel = useCallback((channel: ChannelConfig) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setSelectedChannel(channel);
    setTimeout(() => {
      detailSheetRef.current?.present();
    }, 100);
  }, []);

  const handleDelete = useCallback(
    (channel: ChannelConfig) => {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      Alert.alert(
        'Remove channel?',
        `This will disconnect ${channel.name} from this instance.`,
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Remove channel',
            style: 'destructive',
            onPress: async () => {
              try {
                await deleteChannelMut.mutateAsync((channel.id || channel.channelConfigId!));
                Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
                detailSheetRef.current?.dismiss();
                setSelectedChannel(null);
              } catch (err: any) {
                Alert.alert('Failed to remove channel', err?.message || 'The sandbox did not remove the channel.');
              }
            },
          },
        ],
      );
    },
    [deleteChannelMut],
  );

  const handleOpenAdd = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    addSheetRef.current?.present();
  }, []);

  const renderBackdrop = useCallback(
    (props: any) => <BottomSheetBackdrop {...props} disappearsOnIndex={-1} appearsOnIndex={0} opacity={0.5} />,
    [],
  );

  const renderItem = useCallback(
    ({ item }: { item: ChannelConfig }) => (
      <ChannelRow channel={item} isDark={isDark} onPress={() => handleSelectChannel(item)} />
    ),
    [isDark, handleSelectChannel],
  );

  return (
    <View style={{ flex: 1 }}>
      {/* Search Bar */}
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingBottom: 8, gap: 10 }}>
        <View
          style={{
            flex: 1,
            flexDirection: 'row',
            alignItems: 'center',
            backgroundColor: inputBg,
            borderRadius: 12,
            paddingHorizontal: 12,
            height: 40,
          }}
        >
          <Search size={16} color={muted} />
          <TextInput
            value={searchQuery}
            onChangeText={setSearchQuery}
            placeholder="Search channels..."
            placeholderTextColor={muted}
            style={{ flex: 1, marginLeft: 8, fontSize: 14, fontFamily: 'Roobert', color: fg, paddingVertical: 0 }}
          />
          {searchQuery.length > 0 && (
            <Pressable onPress={() => setSearchQuery('')} hitSlop={10}>
              <X size={16} color={muted} />
            </Pressable>
          )}
        </View>
        <TouchableOpacity
          onPress={handleOpenAdd}
          activeOpacity={0.8}
          style={{
            width: 40, height: 40, borderRadius: 12,
            backgroundColor: theme.primary,
            alignItems: 'center', justifyContent: 'center',
          }}
        >
          <Plus size={20} color={theme.primaryForeground} />
        </TouchableOpacity>
      </View>

      {/* Channel List */}
      {isLoading ? (
        <View style={{ padding: 60, alignItems: 'center' }}>
          <ActivityIndicator color={muted} />
        </View>
      ) : error ? (
        <View style={{ padding: 40, alignItems: 'center' }}>
          <Radio size={28} color={muted} />
          <Text style={{ fontSize: 14, fontFamily: 'Roobert', color: muted, marginTop: 12, textAlign: 'center' }}>
            Failed to load channels
          </Text>
          <Pressable
            onPress={() => refetch()}
            style={{ marginTop: 12, paddingHorizontal: 16, paddingVertical: 8, borderRadius: 8, backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)' }}
          >
            <Text style={{ fontSize: 13, fontFamily: 'Roobert-Medium', color: fg }}>Try Again</Text>
          </Pressable>
        </View>
      ) : filteredChannels.length === 0 ? (
        <View style={{ padding: 60, alignItems: 'center' }}>
          <Radio size={32} color={muted} />
          <Text style={{ fontSize: 16, fontFamily: 'Roobert-Medium', color: fg, marginTop: 16 }}>
            No channels
          </Text>
          <Text style={{ fontSize: 13, fontFamily: 'Roobert', color: muted, marginTop: 6, textAlign: 'center', lineHeight: 18, paddingHorizontal: 20 }}>
            {searchQuery ? 'No channels match your search.' : 'Connect messaging platforms to receive and respond to messages.'}
          </Text>
        </View>
      ) : (
        <FlatList
          data={filteredChannels}
          keyExtractor={(item) => item.channelConfigId || item.id || item.name}
          renderItem={renderItem}
          contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: insets.bottom + 100 }}
          showsVerticalScrollIndicator={false}
        />
      )}


      {/* Detail Sheet */}
      <ChannelDetailSheet
        sheetRef={detailSheetRef}
        channel={selectedChannel}
        isDark={isDark}
        theme={theme}
        onToggle={async (channel, enabled) => {
          try {
            await toggleChannel.mutateAsync({ id: (channel.id || channel.channelConfigId!), enabled });
            setSelectedChannel((prev) => prev ? { ...prev, enabled } : null);
          } catch {
            Alert.alert('Error', 'Failed to toggle channel');
          }
        }}
        onSave={async (channel, name) => {
          try {
            await updateChannel.mutateAsync({ id: (channel.id || channel.channelConfigId!), data: { name } });
            setSelectedChannel((prev) => prev ? { ...prev, name } : null);
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          } catch {
            Alert.alert('Error', 'Failed to update channel');
          }
        }}
        onDelete={handleDelete}
        onClose={() => { detailSheetRef.current?.dismiss(); setSelectedChannel(null); }}
      />

      {/* Add Channel Sheet */}
      <AddChannelSheet
        sheetRef={addSheetRef}
        isDark={isDark}
        theme={theme}
        renderBackdrop={renderBackdrop}
        sandboxUrl={sandboxUrl}
        sandboxUuid={sandboxUuid}
        onCreate={async () => {
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          addSheetRef.current?.dismiss();
          refetch();
        }}
        onCreated={() => {
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          addSheetRef.current?.dismiss();
          refetch();
        }}
        isCreating={false}
      />
    </View>
  );
}

// ─── Channel Row ─────────────────────────────────────────────────────────────

function ChannelRow({ channel, isDark, onPress }: { channel: ChannelConfig; isDark: boolean; onPress: () => void }) {
  const fg = isDark ? '#f8f8f8' : '#121215';
  const muted = isDark ? 'rgba(248,248,248,0.5)' : 'rgba(18,18,21,0.5)';
  const platform = channel.platform || channel.channelType!;
  const modelShort = channel.default_model ? channel.default_model.split('/').pop() : null;
  const isTelegram = platform === 'telegram';

  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.7}
      style={{
        flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 14, paddingHorizontal: 14,
        marginBottom: 8, borderRadius: 16,
        borderWidth: 1,
        borderColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.05)',
        backgroundColor: isDark ? 'rgba(255,255,255,0.03)' : '#FFFFFF',
      }}
    >
      <View style={{
        width: 42, height: 42, borderRadius: 13,
        backgroundColor: isTelegram ? 'rgba(41,182,246,0.08)' : 'rgba(233,30,99,0.06)',
        alignItems: 'center', justifyContent: 'center',
      }}>
        <Ionicons name={getChannelIcon(platform) as any} size={20} color={isTelegram ? '#29B6F6' : '#E91E63'} />
      </View>
      <View style={{ flex: 1 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Text style={{ fontSize: 15, fontFamily: 'Roobert-Medium', color: fg }} numberOfLines={1}>{channel.name}</Text>
          <View style={{
            paddingHorizontal: 7, paddingVertical: 2, borderRadius: 6,
            backgroundColor: channel.enabled ? 'rgba(52,211,153,0.12)' : (isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)'),
          }}>
            <Text style={{ fontSize: 10, fontFamily: 'Roobert-SemiBold', color: channel.enabled ? '#34d399' : muted }}>{channel.enabled ? 'Live' : 'Off'}</Text>
          </View>
        </View>
        <Text style={{ fontSize: 12, fontFamily: 'Roobert', color: muted, marginTop: 3 }} numberOfLines={1}>
          @{channel.bot_username || '?'}
          {modelShort ? ` · ${modelShort}` : ''}
          {channel.default_agent && channel.default_agent !== 'kortix' ? ` · ${channel.default_agent}` : ''}
        </Text>
      </View>
      <ChevronRight size={18} color={isDark ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.12)'} />
    </TouchableOpacity>
  );
}

// ─── Channel Detail Sheet ────────────────────────────────────────────────────

function ChannelDetailSheet({
  sheetRef, channel, isDark, theme,
  onToggle, onSave, onDelete, onClose,
}: {
  sheetRef: React.RefObject<BottomSheetModal>;
  channel: ChannelConfig | null;
  isDark: boolean;
  theme: ReturnType<typeof useThemeColors>;
  onToggle: (channel: ChannelConfig, enabled: boolean) => void;
  onSave: (channel: ChannelConfig, name: string) => void;
  onDelete: (channel: ChannelConfig) => void;
  onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const sheetPadding = useSheetBottomPadding();
  const { sandboxUrl } = useSandboxContext();
  const updateChannel = useUpdateChannel();

  const [editName, setEditName] = useState('');
  const [agentName, setAgentName] = useState('kortix');
  const [selectedModelIdx, setSelectedModelIdx] = useState(0);
  const [bridgeInstructions, setBridgeInstructions] = useState('');
  const [instructions, setInstructions] = useState('');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [webhookCopied, setWebhookCopied] = useState(false);

  const fg = isDark ? '#f8f8f8' : '#121215';
  const muted = isDark ? 'rgba(248,248,248,0.5)' : 'rgba(18,18,21,0.5)';
  const inputBg = isDark ? 'rgba(248,248,248,0.06)' : 'rgba(18,18,21,0.04)';
  const borderColor = isDark ? 'rgba(248,248,248,0.1)' : 'rgba(18,18,21,0.08)';
  const subtleBg = isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.02)';

  // Load agents & models
  const { data: agents = [] } = useOpenCodeAgents(sandboxUrl);
  const { data: providers } = useOpenCodeProviders(sandboxUrl);
  const models = useMemo(() => (providers ? flattenModels(providers) : []), [providers]);
  const filteredModels = useMemo(() => filterToLatestModels(models), [models]);

  useEffect(() => {
    if (channel) {
      setEditName(channel.name);
      setAgentName(channel.default_agent || channel.agentName || 'kortix');
      setBridgeInstructions((channel as any).bridge_instructions || '');
      setInstructions(channel.instructions || '');
      setDirty(false);
      // Find matching model index
      if (channel.default_model && filteredModels.length > 0) {
        const modelStr = channel.default_model;
        const idx = filteredModels.findIndex(m => `${m.providerID}/${m.modelID}` === modelStr || m.modelID === modelStr);
        setSelectedModelIdx(idx >= 0 ? idx : 0);
      } else {
        setSelectedModelIdx(0);
      }
    }
  }, [channel, filteredModels]);

  const markDirty = () => setDirty(true);

  const handleSave = async () => {
    if (!channel) return;
    setSaving(true);
    const selModel = filteredModels[selectedModelIdx];
    const modelStr = selModel ? `${selModel.providerID}/${selModel.modelID}` : undefined;
    try {
      await updateChannel.mutateAsync({
        id: channel.id || channel.channelConfigId!,
        data: {
          name: editName.trim() || undefined,
          default_agent: agentName || undefined,
          default_model: modelStr,
          bridge_instructions: bridgeInstructions.trim(),
          instructions: instructions.trim(),
        },
      });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setDirty(false);
    } catch (err: any) {
      Alert.alert('Error', err?.message || 'Failed to save channel settings');
    } finally {
      setSaving(false);
    }
  };

  const handleCopyWebhook = async () => {
    const url = channel?.webhook_url || channel?.platformConfig?.webhook_url;
    if (!url) return;
    await Clipboard.setStringAsync(String(url));
    setWebhookCopied(true);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    setTimeout(() => setWebhookCopied(false), 2000);
  };

  const renderBackdrop = useCallback(
    (props: any) => <BottomSheetBackdrop {...props} disappearsOnIndex={-1} appearsOnIndex={0} opacity={0.5} />,
    [],
  );

  const platform = channel ? (channel.platform || channel.channelType!) : 'telegram';
  const webhookUrl = channel?.webhook_url || (channel?.platformConfig?.webhook_url as string) || '';

  return (
    <BottomSheetModal
      ref={sheetRef}
      snapPoints={['85%']}
      enablePanDownToClose
      onDismiss={onClose}
      backdropComponent={renderBackdrop}
      backgroundStyle={{ backgroundColor: isDark ? '#161618' : '#FFFFFF', borderTopLeftRadius: 24, borderTopRightRadius: 24 }}
      handleIndicatorStyle={{ backgroundColor: isDark ? '#3F3F46' : '#D4D4D8', width: 36, height: 5, borderRadius: 3 }}
    >
      {channel ? (
      <BottomSheetScrollView contentContainerStyle={{ paddingHorizontal: 24, paddingBottom: sheetPadding }} showsVerticalScrollIndicator={false}>
        {/* Header */}
        <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 20 }}>
          <View style={{ width: 40, height: 40, borderRadius: 12, backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)', alignItems: 'center', justifyContent: 'center', marginRight: 12 }}>
            <Ionicons name={getChannelIcon(platform) as any} size={20} color={fg} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 18, fontFamily: 'Roobert-Semibold', color: fg }} numberOfLines={1}>{channel.name}</Text>
            <Text style={{ fontSize: 12, fontFamily: 'Roobert', color: muted, marginTop: 1 }}>@{channel.bot_username || '?'} · {platform}</Text>
          </View>
        </View>

        {/* Enabled toggle */}
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderRadius: 14, borderWidth: 1, borderColor, paddingHorizontal: 16, paddingVertical: 14, marginBottom: 20 }}>
          <View>
            <Text style={{ fontSize: 14, fontFamily: 'Roobert-Medium', color: fg }}>Enabled</Text>
            <Text style={{ fontSize: 11, fontFamily: 'Roobert', color: muted, marginTop: 1 }}>Receive and respond to messages</Text>
          </View>
          <Switch
            value={channel.enabled}
            onValueChange={(val) => onToggle(channel, val)}
            trackColor={{ false: isDark ? '#3F3F46' : '#D4D4D8', true: theme.primary }}
            thumbColor="#fff"
          />
        </View>

        {/* Channel Name */}
        <Text style={{ fontSize: 13, fontFamily: 'Roobert-Medium', color: muted, marginBottom: 6 }}>Channel Name</Text>
        <TextInput
          value={editName}
          onChangeText={(text) => { setEditName(text); markDirty(); }}
          placeholder="Channel name"
          placeholderTextColor={isDark ? 'rgba(248,248,248,0.25)' : 'rgba(18,18,21,0.3)'}
          style={{ backgroundColor: inputBg, borderWidth: 1, borderColor, borderRadius: 14, paddingHorizontal: 16, paddingVertical: 12, fontSize: 15, fontFamily: 'Roobert', color: fg, marginBottom: 16 }}
        />

        {/* Agent */}
        <Text style={{ fontSize: 13, fontFamily: 'Roobert-Medium', color: muted, marginBottom: 6 }}>Agent</Text>
        <View style={{ borderRadius: 14, borderWidth: 1, borderColor, backgroundColor: inputBg, marginBottom: 16, overflow: 'hidden' }}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ padding: 8, gap: 6 }}>
            {agents.filter((a) => a.mode !== 'subagent').map((agent) => {
              const active = agentName === agent.name;
              return (
                <Pressable key={agent.name} onPress={() => { setAgentName(agent.name); markDirty(); Haptics.selectionAsync(); }} style={{ paddingHorizontal: 12, paddingVertical: 7, borderRadius: 8, backgroundColor: active ? theme.primary : (isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)') }}>
                  <Text style={{ fontSize: 13, fontFamily: active ? 'Roobert-Medium' : 'Roobert', color: active ? theme.primaryForeground : muted }}>{agent.name}</Text>
                </Pressable>
              );
            })}
          </ScrollView>
        </View>

        {/* Model */}
        <Text style={{ fontSize: 13, fontFamily: 'Roobert-Medium', color: muted, marginBottom: 6 }}>Model</Text>
        <View style={{ borderRadius: 14, borderWidth: 1, borderColor, backgroundColor: inputBg, marginBottom: 16, overflow: 'hidden' }}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ padding: 8, gap: 6 }}>
            {filteredModels.map((m, i) => {
              const active = selectedModelIdx === i;
              return (
                <Pressable key={`${m.providerID}:${m.modelID}`} onPress={() => { setSelectedModelIdx(i); markDirty(); Haptics.selectionAsync(); }} style={{ paddingHorizontal: 12, paddingVertical: 7, borderRadius: 8, backgroundColor: active ? theme.primary : (isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)') }}>
                  <Text style={{ fontSize: 13, fontFamily: active ? 'Roobert-Medium' : 'Roobert', color: active ? theme.primaryForeground : muted }} numberOfLines={1}>{m.modelName}</Text>
                </Pressable>
              );
            })}
          </ScrollView>
        </View>

        {/* Bridge Instructions (ported from web c6b83f1) */}
        <Text style={{ fontSize: 13, fontFamily: 'Roobert-Medium', color: muted, marginBottom: 6 }}>Bridge Instructions</Text>
        <TextInput
          value={bridgeInstructions}
          onChangeText={(text) => { setBridgeInstructions(text); markDirty(); }}
          placeholder="Optional per-channel delivery instructions..."
          placeholderTextColor={isDark ? 'rgba(248,248,248,0.25)' : 'rgba(18,18,21,0.3)'}
          multiline
          numberOfLines={3}
          style={{ backgroundColor: inputBg, borderWidth: 1, borderColor, borderRadius: 14, paddingHorizontal: 16, paddingVertical: 12, fontSize: 14, fontFamily: 'Roobert', color: fg, height: 80, textAlignVertical: 'top', marginBottom: 4 }}
        />
        <Text style={{ fontSize: 11, fontFamily: 'Roobert', color: muted, marginBottom: 16 }}>Appended to the built-in platform bridge instructions on every incoming message.</Text>

        {/* System Instructions */}
        <Text style={{ fontSize: 13, fontFamily: 'Roobert-Medium', color: muted, marginBottom: 6 }}>System Instructions</Text>
        <TextInput
          value={instructions}
          onChangeText={(text) => { setInstructions(text); markDirty(); }}
          placeholder="Optional system prompt for this channel's sessions..."
          placeholderTextColor={isDark ? 'rgba(248,248,248,0.25)' : 'rgba(18,18,21,0.3)'}
          multiline
          numberOfLines={3}
          style={{ backgroundColor: inputBg, borderWidth: 1, borderColor, borderRadius: 14, paddingHorizontal: 16, paddingVertical: 12, fontSize: 14, fontFamily: 'Roobert', color: fg, height: 80, textAlignVertical: 'top', marginBottom: 4 }}
        />
        <Text style={{ fontSize: 11, fontFamily: 'Roobert', color: muted, marginBottom: 16 }}>Used as the system prompt for sessions started from this channel. Saving resets active channel sessions so changes apply on the next message.</Text>

        {/* Webhook URL */}
        <View style={{ borderRadius: 14, backgroundColor: subtleBg, borderWidth: StyleSheet.hairlineWidth, borderColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)', padding: 14, marginBottom: 20 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <ExternalLink size={14} color={muted} />
              <Text style={{ fontSize: 13, fontFamily: 'Roobert-Medium', color: fg }}>Webhook URL</Text>
            </View>
            {!!webhookUrl && (
              <Pressable onPress={handleCopyWebhook} style={{ flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6 }}>
                <Copy size={11} color={webhookCopied ? '#34d399' : muted} />
                <Text style={{ fontSize: 11, fontFamily: 'Roobert-Medium', color: webhookCopied ? '#34d399' : muted }}>{webhookCopied ? 'Copied' : 'Copy'}</Text>
              </Pressable>
            )}
          </View>
          {webhookUrl ? (
            <Text style={{ fontSize: 11, fontFamily: 'monospace', color: muted, lineHeight: 16 }} numberOfLines={2} selectable>{webhookUrl}</Text>
          ) : (
            <Text style={{ fontSize: 11, fontFamily: 'Roobert', color: '#d97706' }}>Public URL not resolved. Set PUBLIC_BASE_URL.</Text>
          )}
          <Text style={{ fontSize: 11, fontFamily: 'Roobert', color: muted, marginTop: 6 }}>
            {platform === 'telegram'
              ? 'Telegram sends webhook events to this URL. It was set during bot setup.'
              : 'Set this as the Request URL in your Slack app → Event Subscriptions.'}
          </Text>
        </View>

        {/* Save button */}
        {dirty && (
          <Pressable
            onPress={handleSave}
            disabled={saving}
            style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 14, borderRadius: 14, backgroundColor: theme.primary, marginBottom: 16 }}
          >
            {saving ? (
              <ActivityIndicator size="small" color={theme.primaryForeground} />
            ) : (
              <Text style={{ fontSize: 15, fontFamily: 'Roobert-Medium', color: theme.primaryForeground }}>Save Settings</Text>
            )}
          </Pressable>
        )}

        {/* Danger Zone */}
        <View style={{ padding: 14, borderRadius: 14, backgroundColor: isDark ? 'rgba(239,68,68,0.08)' : 'rgba(239,68,68,0.04)', borderWidth: StyleSheet.hairlineWidth, borderColor: isDark ? 'rgba(239,68,68,0.2)' : 'rgba(239,68,68,0.15)' }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 14, fontFamily: 'Roobert-Medium', color: '#ef4444' }}>Delete Channel</Text>
              <Text style={{ fontSize: 11, fontFamily: 'Roobert', color: isDark ? 'rgba(239,68,68,0.7)' : 'rgba(239,68,68,0.6)', marginTop: 2 }}>Permanently remove this channel</Text>
            </View>
            <Pressable onPress={() => onDelete(channel)} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 10, backgroundColor: isDark ? 'rgba(239,68,68,0.15)' : 'rgba(239,68,68,0.1)' }}>
              <Trash2 size={14} color="#ef4444" />
              <Text style={{ fontSize: 13, fontFamily: 'Roobert-Medium', color: '#ef4444' }}>Delete</Text>
            </Pressable>
          </View>
        </View>
      </BottomSheetScrollView>
      ) : null}
    </BottomSheetModal>
  );
}

// ─── Detail Row (reusable) ───────────────────────────────────────────────────

function DetailRow({ label, value, isDark, fg, muted, last, mono }: {
  label: string; value: string; isDark: boolean; fg: string; muted: string; last?: boolean; mono?: boolean;
}) {
  return (
    <View style={{
      flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
      paddingHorizontal: 14, paddingVertical: 11,
      borderBottomWidth: last ? 0 : StyleSheet.hairlineWidth,
      borderBottomColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)',
    }}>
      <Text style={{ fontSize: 13, fontFamily: 'Roobert', color: muted }}>{label}</Text>
      <Text style={{ fontSize: 13, fontFamily: mono ? 'monospace' : 'Roobert-Medium', color: fg, maxWidth: '60%' }} numberOfLines={1}>{value}</Text>
    </View>
  );
}

// ─── Add Channel Sheet (with wizard routing) ─────────────────────────────────

type WizardView = 'type-select' | 'telegram-wizard' | 'slack-wizard' | 'generic-config';

function AddChannelSheet({
  sheetRef, isDark, theme, renderBackdrop, sandboxUrl, sandboxUuid,
  onCreate, onCreated, isCreating,
}: {
  sheetRef: React.RefObject<BottomSheetModal>;
  isDark: boolean;
  theme: ReturnType<typeof useThemeColors>;
  renderBackdrop: (props: any) => React.ReactElement;
  sandboxUrl?: string;
  sandboxUuid?: string;
  onCreate: (data: { name: string; channel_type: ChannelType }) => void;
  onCreated: () => void;
  isCreating: boolean;
}) {
  const insets = useSafeAreaInsets();
  const sheetPadding = useSheetBottomPadding();
  const [view, setView] = useState<WizardView>('type-select');
  const [selectedType, setSelectedType] = useState<ChannelType | null>(null);
  const [channelName, setChannelName] = useState('');

  const fg = isDark ? '#f8f8f8' : '#121215';
  const muted = isDark ? 'rgba(248,248,248,0.5)' : 'rgba(18,18,21,0.5)';
  const inputBg = isDark ? 'rgba(248,248,248,0.06)' : 'rgba(18,18,21,0.04)';
  const borderColor = isDark ? 'rgba(248,248,248,0.1)' : 'rgba(18,18,21,0.08)';

  const reset = () => { setView('type-select'); setSelectedType(null); setChannelName(''); };

  const handleTypeSelect = (type: ChannelType) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setSelectedType(type);
    if (type === 'telegram') setView('telegram-wizard');
    else if (type === 'slack') setView('slack-wizard');
    else setView('generic-config');
  };

  const handleCreate = () => {
    if (!selectedType || !channelName.trim()) return;
    Keyboard.dismiss();
    onCreate({ name: channelName.trim(), channel_type: selectedType });
    reset();
  };

  const title = view === 'telegram-wizard' ? 'Connect Telegram'
    : view === 'slack-wizard' ? 'Connect Slack'
    : view === 'generic-config' && selectedType ? `New ${getChannelTypeLabel(selectedType)} Channel`
    : 'Add Channel';

  const subtitle = view === 'telegram-wizard' ? 'Set up a Telegram bot for your instance'
    : view === 'slack-wizard' ? 'Set up a Slack bot for your instance'
    : view === 'generic-config' ? 'Configure your new channel'
    : 'Choose a messaging platform';

  const isWizard = view === 'telegram-wizard' || view === 'slack-wizard';

  return (
    <BottomSheetModal
      ref={sheetRef}
      {...(isWizard ? { snapPoints: ['90%'] } : { enableDynamicSizing: true })}
      enablePanDownToClose
      backdropComponent={renderBackdrop}
      keyboardBehavior="interactive"
      keyboardBlurBehavior="restore"
      android_keyboardInputMode="adjustResize"
      onDismiss={reset}
      backgroundStyle={{ backgroundColor: isDark ? '#161618' : '#FFFFFF', borderTopLeftRadius: 24, borderTopRightRadius: 24 }}
      handleIndicatorStyle={{ backgroundColor: isDark ? '#3F3F46' : '#D4D4D8', width: 36, height: 5, borderRadius: 3 }}
    >
      <BottomSheetScrollView
        contentContainerStyle={{ paddingHorizontal: 24, paddingTop: 8, paddingBottom: sheetPadding }}
        keyboardShouldPersistTaps="handled"
      >
        {/* Header */}
        <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 20 }}>
          <View style={{ width: 40, height: 40, borderRadius: 12, backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)', alignItems: 'center', justifyContent: 'center', marginRight: 12 }}>
            {selectedType ? (
              <Ionicons name={getChannelIcon(selectedType) as any} size={20} color={fg} />
            ) : (
              <Radio size={20} color={fg} />
            )}
          </View>
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 18, fontFamily: 'Roobert-Semibold', color: fg }}>{title}</Text>
            <Text style={{ fontSize: 12, fontFamily: 'Roobert', color: muted, marginTop: 2 }}>{subtitle}</Text>
          </View>
        </View>

        {view === 'type-select' && (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginBottom: 8 }}>
            {ALL_CHANNEL_TYPES.map((ct) => {
              const isSupported = SUPPORTED_CHANNEL_TYPES.includes(ct.type);
              return (
                <Pressable
                  key={ct.type}
                  onPress={() => isSupported && handleTypeSelect(ct.type)}
                  disabled={!isSupported}
                  style={{
                    width: '48%' as any, flexGrow: 1, padding: 14, borderRadius: 14,
                    backgroundColor: isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.02)',
                    borderWidth: StyleSheet.hairlineWidth,
                    borderColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)',
                    alignItems: 'center', gap: 8, opacity: isSupported ? 1 : 0.5,
                  }}
                >
                  <Ionicons name={getChannelIcon(ct.type) as any} size={24} color={isSupported ? fg : muted} />
                  <Text style={{ fontSize: 13, fontFamily: 'Roobert-Medium', color: isSupported ? fg : muted }}>{ct.label}</Text>
                  {!isSupported && (
                    <View style={{ paddingHorizontal: 8, paddingVertical: 2, borderRadius: 6, backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)' }}>
                      <Text style={{ fontSize: 10, fontFamily: 'Roobert', color: muted }}>Coming Soon</Text>
                    </View>
                  )}
                </Pressable>
              );
            })}
          </View>
        )}

        {view === 'telegram-wizard' && (
          <TelegramWizard
            isDark={isDark}
            theme={theme}
            fg={fg}
            muted={muted}
            inputBg={inputBg}
            borderColor={borderColor}
            sandboxUrl={sandboxUrl}
            sandboxId={sandboxUuid || null}
            onBack={() => { setView('type-select'); setSelectedType(null); }}
            onCreated={onCreated}
          />
        )}

        {view === 'slack-wizard' && (
          <SlackWizard
            isDark={isDark}
            theme={theme}
            fg={fg}
            muted={muted}
            inputBg={inputBg}
            borderColor={borderColor}
            sandboxUrl={sandboxUrl}
            sandboxId={sandboxUuid || null}
            onBack={() => { setView('type-select'); setSelectedType(null); }}
            onCreated={onCreated}
          />
        )}

        {view === 'generic-config' && (
          <>
            <Pressable onPress={() => { setView('type-select'); setSelectedType(null); setChannelName(''); }} style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginBottom: 16 }}>
              <Ionicons name="chevron-back" size={16} color={muted} />
              <Text style={{ fontSize: 13, fontFamily: 'Roobert', color: muted }}>Back</Text>
            </Pressable>
            <Text style={{ fontSize: 13, fontFamily: 'Roobert-Medium', color: muted, marginBottom: 6 }}>Channel Name</Text>
            <BottomSheetTextInput
              value={channelName}
              onChangeText={setChannelName}
              placeholder={`e.g. My ${selectedType ? getChannelTypeLabel(selectedType) : ''} Bot`}
              placeholderTextColor={isDark ? 'rgba(248,248,248,0.25)' : 'rgba(18,18,21,0.3)'}
              autoFocus
              style={{ backgroundColor: inputBg, borderWidth: 1, borderColor, borderRadius: 14, paddingHorizontal: 16, paddingVertical: 14, fontSize: 16, fontFamily: 'Roobert', color: fg, marginBottom: 20 }}
            />
            <Pressable
              onPress={handleCreate}
              disabled={!channelName.trim() || isCreating}
              style={{ alignItems: 'center', justifyContent: 'center', paddingVertical: 14, borderRadius: 14, backgroundColor: !channelName.trim() ? (isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)') : theme.primary }}
            >
              {isCreating ? (
                <ActivityIndicator size="small" color={theme.primaryForeground} />
              ) : (
                <Text style={{ fontSize: 16, fontFamily: 'Roobert-Medium', color: !channelName.trim() ? muted : theme.primaryForeground }}>Create Channel</Text>
              )}
            </Pressable>
          </>
        )}
      </BottomSheetScrollView>
    </BottomSheetModal>
  );
}

// ─── Telegram Setup Wizard (2 steps) ─────────────────────────────────────────

function TelegramWizard({
  isDark, theme, fg, muted, inputBg, borderColor,
  sandboxUrl, sandboxId, onBack, onCreated,
}: {
  isDark: boolean;
  theme: ReturnType<typeof useThemeColors>;
  fg: string; muted: string; inputBg: string; borderColor: string;
  sandboxUrl?: string;
  sandboxId: string | null;
  onBack: () => void;
  onCreated: () => void;
}) {
  const [botToken, setBotToken] = useState('');
  const [botInfo, setBotInfo] = useState<{ username: string; firstName: string } | null>(null);
  const [agentName, setAgentName] = useState('kortix');
  const [selectedModelIdx, setSelectedModelIdx] = useState(0);

  const verifyMutation = useTelegramVerifyToken();
  const connectMutation = useTelegramConnect();

  // Load agents & models
  const { data: agents = [] } = useOpenCodeAgents(sandboxUrl);
  const { data: providers } = useOpenCodeProviders(sandboxUrl);
  const models = useMemo(() => (providers ? flattenModels(providers) : []), [providers]);
  const filteredModels = useMemo(() => filterToLatestModels(models), [models]);

  const handleVerify = async () => {
    if (!botToken.trim()) return;
    try {
      const result = await verifyMutation.mutateAsync({ botToken: botToken.trim() });
      if (!result.valid) {
        Alert.alert('Invalid Token', result.error || 'Could not verify token');
        return;
      }
      setBotInfo({ username: result.bot?.username || '', firstName: result.bot?.firstName || '' });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (err: any) {
      Alert.alert('Error', err?.message || 'Failed to verify token');
    }
  };

  const handleConnect = async () => {
    if (!botToken.trim() || !sandboxUrl) return;
    // Auto-verify if not yet verified
    if (!botInfo) {
      try {
        const result = await verifyMutation.mutateAsync({ botToken: botToken.trim() });
        if (!result.valid) {
          Alert.alert('Invalid Token', result.error || 'Could not verify token');
          return;
        }
        setBotInfo({ username: result.bot?.username || '', firstName: result.bot?.firstName || '' });
      } catch (err: any) {
        Alert.alert('Error', err?.message || 'Failed to verify token');
        return;
      }
    }
    const selModel = filteredModels[selectedModelIdx];
    const modelStr = selModel ? `${selModel.providerID}/${selModel.modelID}` : undefined;
    try {
      await connectMutation.mutateAsync({
        sandboxUrl,
        botToken: botToken.trim(),
        defaultAgent: agentName || undefined,
        defaultModel: modelStr,
      });
      onCreated();
    } catch (err: any) {
      Alert.alert('Error', err?.message || 'Failed to connect bot');
    }
  };

  const isWorking = verifyMutation.isPending || connectMutation.isPending;
  const inputStyle = { backgroundColor: inputBg, borderWidth: 1, borderColor, borderRadius: 14, paddingHorizontal: 16, paddingVertical: 14, fontSize: 14, fontFamily: 'Roobert', color: fg };

  return (
    <>
      {/* Instructions */}
      <View style={{ borderRadius: 14, backgroundColor: isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.02)', padding: 14, marginBottom: 16 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginBottom: 6 }}>
          <Text style={{ fontSize: 12, fontFamily: 'Roobert-Medium', color: fg }}>1.</Text>
          <Text style={{ fontSize: 12, fontFamily: 'Roobert', color: muted }}>Open</Text>
          <Pressable onPress={() => Linking.openURL('https://t.me/BotFather')} style={{ flexDirection: 'row', alignItems: 'center', gap: 3 }}>
            <Text style={{ fontSize: 12, fontFamily: 'Roobert-Medium', color: theme.primary }}>@BotFather</Text>
            <ExternalLink size={10} color={theme.primary} />
          </Pressable>
          <Text style={{ fontSize: 12, fontFamily: 'Roobert', color: muted }}>in Telegram</Text>
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginBottom: 6 }}>
          <Text style={{ fontSize: 12, fontFamily: 'Roobert-Medium', color: fg }}>2.</Text>
          <Text style={{ fontSize: 12, fontFamily: 'Roobert', color: muted }}>Send</Text>
          <View style={{ backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.05)', borderRadius: 4, paddingHorizontal: 5, paddingVertical: 1 }}>
            <Text style={{ fontSize: 11, fontFamily: 'monospace', color: fg }}>/newbot</Text>
          </View>
          <Text style={{ fontSize: 12, fontFamily: 'Roobert', color: muted }}>and follow the prompts</Text>
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
          <Text style={{ fontSize: 12, fontFamily: 'Roobert-Medium', color: fg }}>3.</Text>
          <Text style={{ fontSize: 12, fontFamily: 'Roobert', color: muted }}>Copy the bot token and paste it below</Text>
        </View>
      </View>

      {/* Bot Token */}
      <Text style={{ fontSize: 13, fontFamily: 'Roobert-Medium', color: muted, marginBottom: 6 }}>Bot Token</Text>
      <BottomSheetTextInput
        value={botToken}
        onChangeText={(t) => { setBotToken(t); setBotInfo(null); }}
        placeholder="123456789:ABCdefGhIJKlmnOPQRstUVWxyz..."
        placeholderTextColor={isDark ? 'rgba(248,248,248,0.25)' : 'rgba(18,18,21,0.3)'}
        secureTextEntry
        textContentType="none"
        autoComplete="off"
        autoCapitalize="none"
        autoCorrect={false}
        style={{ ...inputStyle, marginBottom: 12 }}
      />

      {/* Verified badge */}
      {botInfo && (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12, borderRadius: 12, borderWidth: 1, borderColor: isDark ? 'rgba(190,24,93,0.15)' : 'rgba(190,24,93,0.1)', backgroundColor: isDark ? 'rgba(190,24,93,0.05)' : 'rgba(190,24,93,0.03)', marginBottom: 16 }}>
          <View style={{ width: 22, height: 22, borderRadius: 11, backgroundColor: isDark ? 'rgba(190,24,93,0.15)' : 'rgba(190,24,93,0.1)', alignItems: 'center', justifyContent: 'center' }}>
            <Check size={12} color={theme.primary} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 13, fontFamily: 'Roobert-Medium', color: fg }}>@{botInfo.username}</Text>
            <Text style={{ fontSize: 11, fontFamily: 'Roobert', color: muted }}>{botInfo.firstName}</Text>
          </View>
          <View style={{ paddingHorizontal: 8, paddingVertical: 2, borderRadius: 6, backgroundColor: isDark ? 'rgba(190,24,93,0.1)' : 'rgba(190,24,93,0.06)' }}>
            <Text style={{ fontSize: 10, fontFamily: 'Roobert-Medium', color: theme.primary }}>Verified</Text>
          </View>
        </View>
      )}

      {/* Agent & Model — shown after verification */}
      {botInfo && (
        <>
          <Text style={{ fontSize: 13, fontFamily: 'Roobert-Medium', color: muted, marginBottom: 6 }}>Agent</Text>
          <View style={{ borderRadius: 14, borderWidth: 1, borderColor, backgroundColor: inputBg, marginBottom: 16, overflow: 'hidden' }}>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ padding: 8, gap: 6 }}>
              {agents.map((agent) => {
                const active = agentName === agent.name;
                return (
                  <Pressable
                    key={agent.name}
                    onPress={() => { setAgentName(agent.name); Haptics.selectionAsync(); }}
                    style={{ paddingHorizontal: 12, paddingVertical: 7, borderRadius: 8, backgroundColor: active ? theme.primary : (isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)') }}
                  >
                    <Text style={{ fontSize: 13, fontFamily: active ? 'Roobert-Medium' : 'Roobert', color: active ? theme.primaryForeground : muted }}>{agent.name}</Text>
                  </Pressable>
                );
              })}
            </ScrollView>
          </View>

          <Text style={{ fontSize: 13, fontFamily: 'Roobert-Medium', color: muted, marginBottom: 6 }}>Model</Text>
          <View style={{ borderRadius: 14, borderWidth: 1, borderColor, backgroundColor: inputBg, marginBottom: 20, overflow: 'hidden' }}>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ padding: 8, gap: 6 }}>
              {filteredModels.map((m, i) => {
                const active = selectedModelIdx === i;
                return (
                  <Pressable
                    key={`${m.providerID}:${m.modelID}`}
                    onPress={() => { setSelectedModelIdx(i); Haptics.selectionAsync(); }}
                    style={{ paddingHorizontal: 12, paddingVertical: 7, borderRadius: 8, backgroundColor: active ? theme.primary : (isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)') }}
                  >
                    <Text style={{ fontSize: 13, fontFamily: active ? 'Roobert-Medium' : 'Roobert', color: active ? theme.primaryForeground : muted }} numberOfLines={1}>{m.modelName}</Text>
                  </Pressable>
                );
              })}
            </ScrollView>
          </View>
        </>
      )}

      {/* Action buttons */}
      <View style={{ flexDirection: 'row', gap: 10, marginTop: 20 }}>
        <Pressable onPress={onBack} style={{ flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 14, borderRadius: 14, borderWidth: 1, borderColor }}>
          <ArrowLeft size={16} color={fg} />
          <Text style={{ fontSize: 14, fontFamily: 'Roobert-Medium', color: fg }}>Back</Text>
        </Pressable>
        {!botInfo ? (
          <Pressable
            onPress={handleVerify}
            disabled={!botToken.trim() || isWorking}
            style={{ flex: 2, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 14, borderRadius: 14, backgroundColor: !botToken.trim() ? (isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)') : theme.primary }}
          >
            {verifyMutation.isPending ? (
              <ActivityIndicator size="small" color={theme.primaryForeground} />
            ) : (
              <Text style={{ fontSize: 14, fontFamily: 'Roobert-Medium', color: !botToken.trim() ? muted : theme.primaryForeground }}>Verify Token</Text>
            )}
          </Pressable>
        ) : (
          <Pressable
            onPress={handleConnect}
            disabled={isWorking}
            style={{ flex: 2, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 14, borderRadius: 14, backgroundColor: theme.primary }}
          >
            {connectMutation.isPending ? (
              <ActivityIndicator size="small" color={theme.primaryForeground} />
            ) : (
              <Text style={{ fontSize: 14, fontFamily: 'Roobert-Medium', color: theme.primaryForeground }}>Connect Bot</Text>
            )}
          </Pressable>
        )}
      </View>
    </>
  );
}

// ─── Slack Setup Wizard (3 steps) ────────────────────────────────────────────

const BOT_NAMES = [
  'Atlas', 'Nova', 'Sage', 'Echo', 'Bolt', 'Iris', 'Dash', 'Cleo',
  'Finn', 'Luna', 'Juno', 'Axel', 'Niko', 'Zara', 'Milo', 'Ruby',
  'Hugo', 'Aria', 'Leo', 'Ivy', 'Rex', 'Mae', 'Kai', 'Pia',
];

function randomBotName(): string {
  return `Kortix ${BOT_NAMES[Math.floor(Math.random() * BOT_NAMES.length)]}`;
}

function SlackWizard({
  isDark, theme, fg, muted, inputBg, borderColor,
  sandboxUrl, sandboxId, onBack, onCreated,
}: {
  isDark: boolean;
  theme: ReturnType<typeof useThemeColors>;
  fg: string; muted: string; inputBg: string; borderColor: string;
  sandboxUrl?: string;
  sandboxId: string | null;
  onBack: () => void;
  onCreated: () => void;
}) {
  const [step, setStep] = useState<1 | 2 | 3>(1);

  // Step 1: Configure
  const [botName, setBotName] = useState(() => randomBotName());
  const [agentName, setAgentName] = useState('kortix');
  const [selectedModelIdx, setSelectedModelIdx] = useState(0);

  // Step 2: Manifest
  const [manifestJson, setManifestJson] = useState('');
  const [copied, setCopied] = useState(false);

  // Step 3: Credentials
  const [botToken, setBotToken] = useState('');
  const [signingSecret, setSigningSecret] = useState('');

  const generateManifest = useSlackGenerateManifest();
  const connectMutation = useSlackConnect();

  // Load agents & models
  const { data: agents = [] } = useOpenCodeAgents(sandboxUrl);
  const { data: providers } = useOpenCodeProviders(sandboxUrl);
  const models = useMemo(() => (providers ? flattenModels(providers) : []), [providers]);
  const filteredModels = useMemo(() => filterToLatestModels(models), [models]);

  const handleGenerateManifest = async () => {
    if (!sandboxUrl) return;
    try {
      const result = await generateManifest.mutateAsync({ publicUrl: '', botName: botName.trim() || undefined });
      setManifestJson(result.manifestJson);
      setStep(2);
    } catch (err: any) {
      Alert.alert('Error', err?.message || 'Failed to generate manifest');
    }
  };

  const handleCopyManifest = async () => {
    await Clipboard.setStringAsync(manifestJson);
    setCopied(true);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleConnect = async () => {
    if (!botToken.trim() || !signingSecret.trim() || !sandboxUrl) return;
    if (!botToken.startsWith('xoxb-')) {
      Alert.alert('Invalid Token', 'Bot token must start with xoxb-');
      return;
    }
    if (signingSecret.trim().length < 10) {
      Alert.alert('Invalid Secret', 'Signing secret must be at least 10 characters');
      return;
    }
    const selModel = filteredModels[selectedModelIdx];
    const modelStr = selModel ? `${selModel.providerID}/${selModel.modelID}` : undefined;
    try {
      await connectMutation.mutateAsync({
        sandboxUrl,
        sandboxId,
        botToken: botToken.trim(),
        signingSecret: signingSecret.trim(),
        publicUrl: '',
        name: botName.trim() || undefined,
        defaultAgent: agentName || undefined,
        defaultModel: modelStr,
      });
      onCreated();
    } catch (err: any) {
      Alert.alert('Error', err?.message || 'Failed to connect Slack');
    }
  };

  const inputStyle = { backgroundColor: inputBg, borderWidth: 1, borderColor, borderRadius: 14, paddingHorizontal: 16, paddingVertical: 14, fontSize: 14, fontFamily: 'Roobert', color: fg };

  return (
    <>
      <StepIndicator steps={['Configure', 'Create App', 'Connect']} current={step} theme={theme} fg={fg} muted={muted} />

      {/* ─── Step 1: Configure ─── */}
      {step === 1 && (
        <>
          {/* Bot Name */}
          <Text style={{ fontSize: 13, fontFamily: 'Roobert-Medium', color: muted, marginBottom: 6 }}>Bot Name</Text>
          <BottomSheetTextInput
            value={botName}
            onChangeText={setBotName}
            placeholder="Kortix Agent"
            placeholderTextColor={isDark ? 'rgba(248,248,248,0.25)' : 'rgba(18,18,21,0.3)'}
            style={{ ...inputStyle, marginBottom: 4 }}
          />
          <Text style={{ fontSize: 11, fontFamily: 'Roobert', color: muted, marginBottom: 16 }}>Display name in Slack.</Text>

          {/* Agent */}
          <Text style={{ fontSize: 13, fontFamily: 'Roobert-Medium', color: muted, marginBottom: 6 }}>Agent</Text>
          <View style={{ borderRadius: 14, borderWidth: 1, borderColor, backgroundColor: inputBg, marginBottom: 16, overflow: 'hidden' }}>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ padding: 8, gap: 6 }}>
              {agents.map((agent) => {
                const active = agentName === agent.name;
                return (
                  <Pressable
                    key={agent.name}
                    onPress={() => { setAgentName(agent.name); Haptics.selectionAsync(); }}
                    style={{
                      paddingHorizontal: 12, paddingVertical: 7, borderRadius: 8,
                      backgroundColor: active ? theme.primary : (isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)'),
                    }}
                  >
                    <Text style={{ fontSize: 13, fontFamily: active ? 'Roobert-Medium' : 'Roobert', color: active ? theme.primaryForeground : muted }}>
                      {agent.name}
                    </Text>
                  </Pressable>
                );
              })}
            </ScrollView>
          </View>

          {/* Model */}
          <Text style={{ fontSize: 13, fontFamily: 'Roobert-Medium', color: muted, marginBottom: 6 }}>Model</Text>
          <View style={{ borderRadius: 14, borderWidth: 1, borderColor, backgroundColor: inputBg, marginBottom: 20, overflow: 'hidden' }}>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ padding: 8, gap: 6 }}>
              {filteredModels.map((m, i) => {
                const active = selectedModelIdx === i;
                return (
                  <Pressable
                    key={`${m.providerID}:${m.modelID}`}
                    onPress={() => { setSelectedModelIdx(i); Haptics.selectionAsync(); }}
                    style={{
                      paddingHorizontal: 12, paddingVertical: 7, borderRadius: 8,
                      backgroundColor: active ? theme.primary : (isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)'),
                    }}
                  >
                    <Text style={{ fontSize: 13, fontFamily: active ? 'Roobert-Medium' : 'Roobert', color: active ? theme.primaryForeground : muted }} numberOfLines={1}>
                      {m.modelName}
                    </Text>
                  </Pressable>
                );
              })}
            </ScrollView>
          </View>

          {/* Generate Manifest */}
          <Pressable
            onPress={handleGenerateManifest}
            disabled={generateManifest.isPending}
            style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 14, borderRadius: 14, backgroundColor: theme.primary, alignSelf: 'flex-end', paddingHorizontal: 20 }}
          >
            {generateManifest.isPending ? (
              <ActivityIndicator size="small" color={theme.primaryForeground} />
            ) : (
              <>
                <ArrowRight size={16} color={theme.primaryForeground} />
                <Text style={{ fontSize: 14, fontFamily: 'Roobert-Medium', color: theme.primaryForeground }}>Generate Manifest</Text>
              </>
            )}
          </Pressable>
        </>
      )}

      {/* ─── Step 2: Create App ─── */}
      {step === 2 && (
        <>
          <View style={{ borderRadius: 14, backgroundColor: isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.02)', padding: 14, marginBottom: 16 }}>
            <Text style={{ fontSize: 13, fontFamily: 'Roobert-Medium', color: fg, marginBottom: 8 }}>Create your Slack app:</Text>
            <Text style={{ fontSize: 12, fontFamily: 'Roobert', color: muted, lineHeight: 20 }}>
              {'1. Go to api.slack.com/apps → Create New App → From an app manifest\n2. Select your workspace, paste the manifest below\n3. After creating, Install to Workspace from OAuth & Permissions'}
            </Text>
            <Pressable onPress={() => Linking.openURL('https://api.slack.com/apps')} style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 8 }}>
              <Text style={{ fontSize: 12, fontFamily: 'Roobert-Medium', color: theme.primary }}>Open Slack API</Text>
              <ExternalLink size={12} color={theme.primary} />
            </Pressable>
          </View>

          <Text style={{ fontSize: 13, fontFamily: 'Roobert-Medium', color: muted, marginBottom: 6 }}>App Manifest (JSON)</Text>
          <View style={{ borderRadius: 12, backgroundColor: isDark ? 'rgba(0,0,0,0.3)' : 'rgba(0,0,0,0.04)', padding: 12, marginBottom: 8, maxHeight: 120 }}>
            <ScrollView horizontal={false} showsVerticalScrollIndicator>
              <Text style={{ fontSize: 11, fontFamily: 'monospace', color: muted }} selectable>{manifestJson}</Text>
            </ScrollView>
          </View>
          <Pressable onPress={handleCopyManifest} style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 10, borderRadius: 10, backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)', marginBottom: 16 }}>
            {copied ? <Check size={14} color="#34d399" /> : <Copy size={14} color={fg} />}
            <Text style={{ fontSize: 13, fontFamily: 'Roobert-Medium', color: copied ? '#34d399' : fg }}>{copied ? 'Copied!' : 'Copy Manifest'}</Text>
          </Pressable>

          <View style={{ flexDirection: 'row', gap: 10 }}>
            <Pressable onPress={() => setStep(1)} style={{ flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 14, borderRadius: 14, borderWidth: 1, borderColor }}>
              <ArrowLeft size={16} color={fg} />
              <Text style={{ fontSize: 14, fontFamily: 'Roobert-Medium', color: fg }}>Back</Text>
            </Pressable>
            <Pressable onPress={() => setStep(3)} style={{ flex: 2, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 14, borderRadius: 14, backgroundColor: theme.primary }}>
              <Text style={{ fontSize: 14, fontFamily: 'Roobert-Medium', color: theme.primaryForeground }}>Next</Text>
              <ArrowRight size={16} color={theme.primaryForeground} />
            </Pressable>
          </View>
        </>
      )}

      {/* ─── Step 3: Connect ─── */}
      {step === 3 && (
        <>
          <View style={{ borderRadius: 14, backgroundColor: isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.02)', padding: 14, marginBottom: 16 }}>
            <Text style={{ fontSize: 12, fontFamily: 'Roobert', color: muted, lineHeight: 18 }}>
              Go to your app on api.slack.com → OAuth & Permissions to find the Bot Token, and Basic Information → Signing Secret.
            </Text>
          </View>

          <Text style={{ fontSize: 13, fontFamily: 'Roobert-Medium', color: muted, marginBottom: 6 }}>Bot User OAuth Token</Text>
          <BottomSheetTextInput
            value={botToken}
            onChangeText={setBotToken}
            placeholder="xoxb-..."
            placeholderTextColor={isDark ? 'rgba(248,248,248,0.25)' : 'rgba(18,18,21,0.3)'}
            secureTextEntry
            textContentType="none"
            autoComplete="off"
            autoCapitalize="none"
            autoCorrect={false}
            style={{ ...inputStyle, marginBottom: 12 }}
          />

          <Text style={{ fontSize: 13, fontFamily: 'Roobert-Medium', color: muted, marginBottom: 6 }}>Signing Secret</Text>
          <BottomSheetTextInput
            value={signingSecret}
            onChangeText={setSigningSecret}
            placeholder="Enter signing secret"
            placeholderTextColor={isDark ? 'rgba(248,248,248,0.25)' : 'rgba(18,18,21,0.3)'}
            secureTextEntry
            textContentType="none"
            autoComplete="off"
            autoCapitalize="none"
            autoCorrect={false}
            style={{ ...inputStyle, marginBottom: 16 }}
          />

          <View style={{ flexDirection: 'row', gap: 10 }}>
            <Pressable onPress={() => setStep(2)} style={{ flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 14, borderRadius: 14, borderWidth: 1, borderColor }}>
              <ArrowLeft size={16} color={fg} />
              <Text style={{ fontSize: 14, fontFamily: 'Roobert-Medium', color: fg }}>Back</Text>
            </Pressable>
            <Pressable
              onPress={handleConnect}
              disabled={!botToken.trim() || !signingSecret.trim() || connectMutation.isPending}
              style={{
                flex: 2, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 14, borderRadius: 14,
                backgroundColor: (!botToken.trim() || !signingSecret.trim()) ? (isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)') : theme.primary,
              }}
            >
              {connectMutation.isPending ? (
                <ActivityIndicator size="small" color={theme.primaryForeground} />
              ) : (
                <Text style={{ fontSize: 14, fontFamily: 'Roobert-Medium', color: (!botToken.trim() || !signingSecret.trim()) ? muted : theme.primaryForeground }}>Connect Bot</Text>
              )}
            </Pressable>
          </View>
        </>
      )}
    </>
  );
}

// ─── Step Indicator ──────────────────────────────────────────────────────────

function StepIndicator({
  steps, current, theme, fg, muted,
}: {
  steps: string[];
  current: number;
  theme: ReturnType<typeof useThemeColors>;
  fg: string;
  muted: string;
}) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 0, marginBottom: 20 }}>
      {steps.map((label, i) => {
        const stepNum = i + 1;
        const isActive = current === stepNum;
        const isComplete = current > stepNum;
        return (
          <React.Fragment key={label}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <View style={{
                width: 24, height: 24, borderRadius: 12,
                backgroundColor: isActive ? theme.primary : isComplete ? `${theme.primary}33` : 'rgba(128,128,128,0.15)',
                alignItems: 'center', justifyContent: 'center',
              }}>
                {isComplete ? (
                  <Check size={12} color={theme.primary} />
                ) : (
                  <Text style={{ fontSize: 11, fontFamily: 'Roobert-Medium', color: isActive ? theme.primaryForeground : muted }}>{stepNum}</Text>
                )}
              </View>
              <Text style={{ fontSize: 11, fontFamily: 'Roobert-Medium', color: isActive ? fg : muted }}>{label}</Text>
            </View>
            {i < steps.length - 1 && (
              <View style={{ width: 20, height: 1, backgroundColor: isComplete ? `${theme.primary}66` : 'rgba(128,128,128,0.15)', marginHorizontal: 6 }} />
            )}
          </React.Fragment>
        );
      })}
    </View>
  );
}
