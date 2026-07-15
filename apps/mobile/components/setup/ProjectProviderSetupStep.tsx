import React, { useCallback, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Linking, Pressable, ScrollView, View } from 'react-native';
import {
  BottomSheetBackdrop,
  BottomSheetModal,
  BottomSheetTextInput,
  BottomSheetView,
} from '@gorhom/bottom-sheet';
import { useQueryClient } from '@tanstack/react-query';
import {
  pollProjectProviderOAuth,
  setActiveHarnessConnection,
  startProjectProviderOAuth,
  upsertProjectSecret,
  type HarnessConnection,
} from '@kortix/sdk';
import { invalidateComposerCapabilityQueries, useHarnessConnections } from '@kortix/sdk/react';
import * as Haptics from 'expo-haptics';
import { Check, ChevronRight, Sparkles } from 'lucide-react-native';

import { Text } from '@/components/ui/text';
import { useSheetBottomPadding } from '@/hooks/useSheetKeyboard';
import {
  compatibleHarnessesWithoutActiveRoute,
  customProviderSecretWrites,
  PROJECT_PROVIDER_CONNECTIONS,
  secretWritesForConnection,
  type ProjectProviderConnectionDefinition,
} from '@/lib/providers/project-provider-auth';
import { getSheetBg } from '@/lib/theme-colors';

const monoFont = 'Menlo';

export function ProjectProviderSetupStep({
  projectId,
  onContinue,
  isDark,
  themeColors,
}: {
  projectId?: string | null;
  onContinue: () => void;
  isDark: boolean;
  themeColors: { primary: string; primaryForeground: string };
}) {
  const sheetPadding = useSheetBottomPadding();
  const queryClient = useQueryClient();
  const connections = useHarnessConnections(projectId);
  const sheetRef = useRef<BottomSheetModal>(null);
  const cancelledRef = useRef(false);
  const [selected, setSelected] = useState<ProjectProviderConnectionDefinition | null>(null);
  const [credential, setCredential] = useState('');
  const [customBaseUrl, setCustomBaseUrl] = useState('');
  const [customModelId, setCustomModelId] = useState('');
  const [customName, setCustomName] = useState('Custom model');
  const [customApiKey, setCustomApiKey] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [oauthCode, setOauthCode] = useState<string | null>(null);
  const [oauthUrl, setOauthUrl] = useState<string | null>(null);
  const fg = isDark ? '#F8F8F8' : '#121215';
  const muted = isDark ? 'rgba(248,248,248,0.5)' : 'rgba(18,18,21,0.5)';
  const border = isDark ? 'rgba(248,248,248,0.08)' : 'rgba(18,18,21,0.08)';
  const card = isDark ? 'rgba(248,248,248,0.03)' : 'rgba(18,18,21,0.02)';
  const choices = useMemo(
    () => PROJECT_PROVIDER_CONNECTIONS.filter((entry) =>
      // A kind compatible with no harness (the parked anthropic_compatible
      // custom endpoint, 2026-07-15) is never offered as a fresh choice.
      ['managed', 'token', 'api-key', 'oauth', 'custom'].includes(entry.mode) &&
      entry.compatibleHarnesses.length > 0,
    ),
    [],
  );
  const serverById = useMemo(
    () => new Map((connections.data?.connections ?? []).map((item) => [item.id, item])),
    [connections.data?.connections],
  );
  const hasProvider = (connections.data?.connections ?? []).some((item) => item.ready);

  const invalidate = useCallback(async () => {
    if (!projectId) return;
    await invalidateComposerCapabilityQueries(queryClient, projectId);
    await connections.refetch();
  }, [connections, projectId, queryClient]);

  const activate = useCallback(async (definition: ProjectProviderConnectionDefinition) => {
    if (!projectId) return;
    await Promise.all(definition.compatibleHarnesses.map((harness) =>
      setActiveHarnessConnection(projectId, harness, definition.id),
    ));
  }, [projectId]);

  const activateUnbound = useCallback(async (definition: ProjectProviderConnectionDefinition) => {
    if (!projectId) return;
    const harnesses = compatibleHarnessesWithoutActiveRoute(
      definition,
      connections.data?.connections ?? [],
    );
    await Promise.all(harnesses.map((harness) =>
      setActiveHarnessConnection(projectId, harness, definition.id),
    ));
  }, [connections.data?.connections, projectId]);

  const saveCredential = useCallback(async () => {
    if (!projectId || !selected) return;
    setConnecting(true);
    setError(null);
    try {
      for (const write of secretWritesForConnection(selected.id, credential)) {
        await upsertProjectSecret(projectId, write);
      }
      await invalidate();
      await activateUnbound(selected);
      await invalidate();
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      sheetRef.current?.dismiss();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Failed to connect provider');
    } finally {
      setConnecting(false);
    }
  }, [activateUnbound, credential, invalidate, projectId, selected]);

  const saveCustom = useCallback(async () => {
    if (!projectId || !selected || selected.mode !== 'custom') return;
    if (!customBaseUrl.trim() || !customModelId.trim()) {
      setError('Base URL and model ID are required.');
      return;
    }
    setConnecting(true);
    setError(null);
    try {
      const protocol = selected.id === 'anthropic_compatible' ? 'anthropic' : 'openai';
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
      await activateUnbound(selected);
      await invalidate();
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      sheetRef.current?.dismiss();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Failed to connect provider');
    } finally {
      setConnecting(false);
    }
  }, [activateUnbound, customApiKey, customBaseUrl, customModelId, customName, invalidate, projectId, selected]);

  const startCodexOAuth = useCallback(async () => {
    if (!projectId || selected?.id !== 'codex_subscription') return;
    cancelledRef.current = false;
    setConnecting(true);
    setError(null);
    try {
      const start = await startProjectProviderOAuth(projectId, 'openai');
      setOauthCode(start.user_code);
      setOauthUrl(start.verification_url);
      if (start.verification_url) await Linking.openURL(start.verification_url);
      const cadence = Math.max(2_000, start.interval_ms || 3_000);
      const deadline = start.expires_at || Date.now() + 10 * 60_000;
      while (!cancelledRef.current && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, cadence));
        if (cancelledRef.current) return;
        const result = await pollProjectProviderOAuth(projectId, 'openai', start.flow_id);
        if (result.status === 'pending') continue;
        if (result.status === 'success') {
          await invalidate();
          await activateUnbound(selected);
          await invalidate();
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          sheetRef.current?.dismiss();
          return;
        }
        throw new Error(result.status === 'failed' ? result.error : 'Authorization expired. Try again.');
      }
      if (!cancelledRef.current) throw new Error('Authorization timed out. Try again.');
    } catch (nextError) {
      if (!cancelledRef.current) setError(nextError instanceof Error ? nextError.message : 'OAuth failed');
    } finally {
      setConnecting(false);
    }
  }, [activateUnbound, invalidate, projectId, selected]);

  const openChoice = useCallback((definition: ProjectProviderConnectionDefinition) => {
    const server = serverById.get(definition.id) as HarnessConnection | undefined;
    if (definition.mode === 'managed' && server?.ready) {
      void activate(definition).then(invalidate);
      return;
    }
    setSelected(definition);
    setCredential('');
    setCustomBaseUrl('');
    setCustomModelId('');
    setCustomName('Custom model');
    setCustomApiKey('');
    setOauthCode(null);
    setOauthUrl(null);
    setError(null);
    cancelledRef.current = false;
    sheetRef.current?.present();
  }, [activate, invalidate, serverById]);

  if (connections.isLoading && projectId) {
    return <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}><ActivityIndicator color={muted} /></View>;
  }

  return (
    <View style={{ width: '100%', flex: 1, justifyContent: 'center' }}>
      <View style={{ alignItems: 'center', gap: 8, marginBottom: 20 }}>
        <View style={{ width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center', backgroundColor: hasProvider ? 'rgba(52,211,153,0.1)' : card }}>
          {hasProvider ? <Check size={22} color="#34d399" /> : <Sparkles size={22} color={muted} />}
        </View>
        <Text style={{ fontSize: 18, fontFamily: 'Roobert-SemiBold', color: fg }}>
          {projectId ? (hasProvider ? 'Model connection ready' : 'Choose authentication') : 'Authentication is project-scoped'}
        </Text>
        <Text style={{ fontSize: 13, fontFamily: 'Roobert', color: muted, textAlign: 'center', lineHeight: 19 }}>
          {projectId
            ? 'Claude and Codex subscriptions stay separate from Anthropic and OpenAI API keys.'
            : 'Open a project after onboarding to configure Claude, Codex, OpenCode, or Pi safely.'}
        </Text>
      </View>

      {projectId ? (
        <ScrollView style={{ maxHeight: 290 }} contentContainerStyle={{ gap: 8 }} showsVerticalScrollIndicator={false}>
          {choices.map((definition) => {
            const connection = serverById.get(definition.id) as HarnessConnection | undefined;
            return (
              <Pressable key={definition.id} onPress={() => openChoice(definition)} style={{ flexDirection: 'row', alignItems: 'center', gap: 12, borderRadius: 12, borderWidth: 1, borderColor: border, backgroundColor: card, paddingHorizontal: 14, paddingVertical: 11 }}>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 14, fontFamily: 'Roobert-Medium', color: fg }}>{definition.label}</Text>
                  <Text numberOfLines={1} style={{ marginTop: 2, fontSize: 11, fontFamily: 'Roobert', color: muted }}>{definition.description}</Text>
                </View>
                {connection?.ready ? <Check size={16} color="#34d399" /> : <ChevronRight size={16} color={muted} />}
              </Pressable>
            );
          })}
        </ScrollView>
      ) : null}

      <Pressable onPress={onContinue} disabled={Boolean(projectId && !hasProvider)} style={{ height: 48, marginTop: 18, borderRadius: 14, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 6, backgroundColor: !projectId || hasProvider ? themeColors.primary : card, opacity: !projectId || hasProvider ? 1 : 0.45 }}>
        <Text style={{ fontSize: 14, fontFamily: 'Roobert-SemiBold', color: !projectId || hasProvider ? themeColors.primaryForeground : muted }}>Continue</Text>
        <ChevronRight size={15} color={!projectId || hasProvider ? themeColors.primaryForeground : muted} />
      </Pressable>

      <BottomSheetModal
        ref={sheetRef}
        enableDynamicSizing
        enablePanDownToClose
        backdropComponent={(props) => <BottomSheetBackdrop {...props} disappearsOnIndex={-1} appearsOnIndex={0} opacity={0.4} />}
        backgroundStyle={{ backgroundColor: getSheetBg(isDark) }}
        handleIndicatorStyle={{ backgroundColor: isDark ? '#52525b' : '#d4d4d8', width: 32 }}
        onDismiss={() => { cancelledRef.current = true; setSelected(null); }}
      >
        <BottomSheetView style={{ paddingHorizontal: 24, paddingTop: 8, paddingBottom: sheetPadding }}>
          <Text style={{ fontSize: 18, fontFamily: 'Roobert-SemiBold', color: fg }}>{selected?.label}</Text>
          <Text style={{ marginTop: 5, fontSize: 12, lineHeight: 18, fontFamily: 'Roobert', color: muted }}>{selected?.description}</Text>
          {selected?.id === 'claude_subscription' ? (
            <Text style={{ marginTop: 12, fontSize: 12, lineHeight: 18, fontFamily: 'Roobert', color: muted }}>Run `claude setup-token` locally, then paste the generated long-lived token.</Text>
          ) : null}
          {selected?.mode === 'oauth' ? (
            <View style={{ marginTop: 16 }}>
              {oauthCode ? <Text style={{ fontFamily: monoFont, fontSize: 20, color: fg }}>{oauthCode}</Text> : null}
              {oauthUrl ? <Pressable onPress={() => Linking.openURL(oauthUrl)}><Text style={{ marginTop: 8, color: themeColors.primary, fontSize: 12 }}>Open authorization page</Text></Pressable> : null}
              <Pressable onPress={startCodexOAuth} disabled={connecting} style={{ height: 48, marginTop: 14, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: themeColors.primary, opacity: connecting ? 0.6 : 1 }}>
                <Text style={{ color: themeColors.primaryForeground, fontFamily: 'Roobert-SemiBold' }}>{connecting ? 'Waiting for authorization…' : 'Connect ChatGPT'}</Text>
              </Pressable>
            </View>
          ) : selected?.mode === 'custom' ? (
            <View style={{ marginTop: 16, gap: 10 }}>
              <BottomSheetTextInput value={customName} onChangeText={setCustomName} placeholder="Display name" placeholderTextColor={muted} autoCapitalize="none" style={{ borderWidth: 1, borderColor: border, borderRadius: 14, paddingHorizontal: 16, paddingVertical: 13, fontFamily: monoFont, color: fg }} />
              <BottomSheetTextInput value={customBaseUrl} onChangeText={setCustomBaseUrl} placeholder="https://api.example.com/v1" placeholderTextColor={muted} autoCapitalize="none" autoCorrect={false} style={{ borderWidth: 1, borderColor: border, borderRadius: 14, paddingHorizontal: 16, paddingVertical: 13, fontFamily: monoFont, color: fg }} />
              <BottomSheetTextInput value={customModelId} onChangeText={setCustomModelId} placeholder="Model ID" placeholderTextColor={muted} autoCapitalize="none" autoCorrect={false} style={{ borderWidth: 1, borderColor: border, borderRadius: 14, paddingHorizontal: 16, paddingVertical: 13, fontFamily: monoFont, color: fg }} />
              <BottomSheetTextInput value={customApiKey} onChangeText={setCustomApiKey} placeholder="API key (optional)" placeholderTextColor={muted} secureTextEntry autoCapitalize="none" autoCorrect={false} style={{ borderWidth: 1, borderColor: border, borderRadius: 14, paddingHorizontal: 16, paddingVertical: 13, fontFamily: monoFont, color: fg }} />
              <Pressable onPress={saveCustom} disabled={!customBaseUrl.trim() || !customModelId.trim() || connecting} style={{ height: 48, marginTop: 4, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: themeColors.primary, opacity: !customBaseUrl.trim() || !customModelId.trim() || connecting ? 0.5 : 1 }}>
                <Text style={{ color: themeColors.primaryForeground, fontFamily: 'Roobert-SemiBold' }}>{connecting ? 'Connecting…' : 'Connect'}</Text>
              </Pressable>
            </View>
          ) : (
            <>
              <BottomSheetTextInput value={credential} onChangeText={setCredential} placeholder={selected?.placeholder ?? 'Paste credential'} placeholderTextColor={muted} secureTextEntry autoCapitalize="none" autoCorrect={false} style={{ marginTop: 16, borderWidth: 1, borderColor: border, borderRadius: 14, paddingHorizontal: 16, paddingVertical: 13, fontFamily: monoFont, color: fg }} />
              <Pressable onPress={saveCredential} disabled={!credential.trim() || connecting} style={{ height: 48, marginTop: 14, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: themeColors.primary, opacity: !credential.trim() || connecting ? 0.5 : 1 }}>
                <Text style={{ color: themeColors.primaryForeground, fontFamily: 'Roobert-SemiBold' }}>{connecting ? 'Connecting…' : 'Connect'}</Text>
              </Pressable>
            </>
          )}
          {error ? <Text style={{ marginTop: 10, color: '#ef4444', fontSize: 12 }}>{error}</Text> : null}
        </BottomSheetView>
      </BottomSheetModal>
    </View>
  );
}
