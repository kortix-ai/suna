/**
 * SetupWizard — Instance setup flow for first-time configuration.
 *
 * Mirrors the frontend's SetupWizard (setup-wizard.tsx):
 *   Step 1: Connect an LLM provider (required for agent to work)
 *   Step 2: Default model selection (choose which model to use)
 *   Step 3: Tool API keys (optional — web search, scraping, etc.)
 *   Step 4: Pipedream integrations (optional — 3,000+ app integrations)
 *   Step 5: Get started — confirmation before onboarding chat
 *
 * After completion, writes INSTANCE_SETUP_COMPLETE=true to sandbox env.
 */

import React, { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import {
  View,
  ScrollView,
  Pressable,
  TextInput,
  ActivityIndicator,
  Linking,
  KeyboardAvoidingView,
  Platform,
  PanResponder,
} from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withRepeat,
  withTiming,
  Easing,
} from 'react-native-reanimated';
import { Text } from '@/components/ui/text';
import { useColorScheme } from 'nativewind';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import {
  Check,
  ChevronRight,
  Search,
  Flame,
  ImageIcon,
  BookOpen,
  Mic,
  ExternalLink,
  Loader2,
  Link,
  ChevronLeft,
  Bot,
  MessageSquare,
  ArrowLeft,
} from 'lucide-react-native';
import { useRouter } from 'expo-router';
import { useComposerModelCatalog, useProjectConfig } from '@kortix/sdk/react';

import { KortixLogo } from '@/components/ui/KortixLogo';
import { useSandboxContext } from '@/contexts/SandboxContext';
import { useLocalConfigStore } from '@/lib/runtime/hooks/use-local-config';
import { useThemeColors } from '@/lib/theme-colors';
import { getAuthToken } from '@/api/config';
import { useTabStore } from '@/stores/tab-store';
import { log } from '@/lib/logger';
import { ProjectProviderSetupStep } from './ProjectProviderSetupStep';

// ─── Spinning loader (Loader2 doesn't animate on its own in RN) ─────────────

function SpinningLoader({ size, color }: { size: number; color: string }) {
  const rotation = useSharedValue(0);

  useEffect(() => {
    rotation.value = withRepeat(
      withTiming(360, { duration: 1000, easing: Easing.linear }),
      -1,
      false,
    );
  }, []);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${rotation.value}deg` }],
  }));

  return (
    <Animated.View style={animatedStyle}>
      <Loader2 size={size} color={color} />
    </Animated.View>
  );
}

// ─── Types ───────────────────────────────────────────────────────────────────

interface SetupWizardProps {
  projectId?: string | null;
  onComplete: () => void;
}

interface StepProps {
  isDark: boolean;
  themeColors: { primary: string; primaryForeground: string };
}

// ─── Tool secrets definition (matches frontend) ─────────────────────────────

const TOOL_SECRETS = [
  { key: 'TAVILY_API_KEY', label: 'Tavily', description: 'Web search — lets the agent search the internet', icon: Search, signupUrl: 'https://tavily.com' },
  { key: 'FIRECRAWL_API_KEY', label: 'Firecrawl', description: 'Web scraping — read and extract web page content', icon: Flame, signupUrl: 'https://firecrawl.dev' },
  { key: 'SERPER_API_KEY', label: 'Serper', description: 'Google image search for finding visual content', icon: ImageIcon, signupUrl: 'https://serper.dev' },
  { key: 'REPLICATE_API_TOKEN', label: 'Replicate', description: 'AI image & video generation', icon: ImageIcon, signupUrl: 'https://replicate.com' },
  { key: 'CONTEXT7_API_KEY', label: 'Context7', description: 'Documentation search for coding libraries', icon: BookOpen, signupUrl: 'https://context7.com' },
  { key: 'ELEVENLABS_API_KEY', label: 'ElevenLabs', description: 'Text-to-speech and voice generation', icon: Mic, signupUrl: 'https://elevenlabs.io' },
] as const;

const PIPEDREAM_KEYS = [
  { key: 'PIPEDREAM_CLIENT_ID', label: 'Client ID', placeholder: 'e.g. z8PKSGuQdorPj4UErE…', secret: false },
  { key: 'PIPEDREAM_CLIENT_SECRET', label: 'Client Secret', placeholder: 'e.g. UeZCz2PeNdOeHJfw…', secret: true },
  { key: 'PIPEDREAM_PROJECT_ID', label: 'Project ID', placeholder: 'e.g. proj_x9s97z5', secret: false },
] as const;

// ─── Helper: authenticated fetch to sandbox ──────────────────────────────────

async function sandboxFetch(sandboxUrl: string, path: string, options?: RequestInit): Promise<Response> {
  const token = await getAuthToken();
  return fetch(`${sandboxUrl}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options?.headers || {}),
    },
  });
}

// ─── Shared colors helper ────────────────────────────────────────────────────

function useStepColors(isDark: boolean) {
  return useMemo(() => ({
    fg: isDark ? '#F8F8F8' : '#121215',
    muted: isDark ? 'rgba(248,248,248,0.5)' : 'rgba(18,18,21,0.5)',
    cardBg: isDark ? 'rgba(248,248,248,0.03)' : 'rgba(18,18,21,0.02)',
    cardBorder: isDark ? 'rgba(248,248,248,0.06)' : 'rgba(18,18,21,0.06)',
    inputBg: isDark ? 'rgba(248,248,248,0.04)' : 'rgba(18,18,21,0.03)',
    inputBorder: isDark ? 'rgba(248,248,248,0.08)' : 'rgba(18,18,21,0.08)',
  }), [isDark]);
}

// ─── Step Indicator ──────────────────────────────────────────────────────────

function StepIndicator({ currentStep, totalSteps, isDark, onStepPress }: {
  currentStep: number;
  totalSteps: number;
  isDark: boolean;
  onStepPress?: (step: number) => void;
}) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, marginBottom: 24 }}>
      {Array.from({ length: totalSteps }, (_, i) => {
        const step = i + 1;
        const isActive = step === currentStep;
        const isDone = step < currentStep;
        return (
          <Pressable
            key={step}
            disabled={!isDone || !onStepPress}
            onPress={() => isDone && onStepPress?.(step)}
            style={{
              width: isActive ? 24 : 6,
              height: 6,
              borderRadius: 3,
              backgroundColor: isActive
                ? (isDark ? '#F8F8F8' : '#121215')
                : isDone
                  ? (isDark ? 'rgba(248,248,248,0.4)' : 'rgba(18,18,21,0.4)')
                  : (isDark ? 'rgba(248,248,248,0.15)' : 'rgba(18,18,21,0.15)'),
            }}
          />
        );
      })}
    </View>
  );
}

function DefaultModelStep({ projectId, onContinue, onBack, isDark, themeColors }: StepProps & { projectId?: string | null; onContinue: () => void; onBack: () => void }) {
  const projectConfig = useProjectConfig(projectId);
  const agent = projectConfig?.agents.find((entry) => entry.name === projectConfig.runtime_default_agent)
    ?? projectConfig?.agents.find((entry) => entry.enabled !== false)
    ?? null;
  const agentName = agent?.name ?? null;
  const catalog = useComposerModelCatalog(projectId, agentName);
  const store = useLocalConfigStore();
  const colors = useStepColors(isDark);
  const [selected, setSelected] = useState<string | null>(null);
  const [customModel, setCustomModel] = useState('');
  const models = catalog.data?.models ?? [];
  const defaultAllowed = catalog.data?.default_allowed === true;
  const customAllowed = catalog.data?.custom_allowed !== false;
  const harness = agent?.harness ?? 'runtime';

  const persistSelection = useCallback((modelId: string) => {
    if (!agentName) return;
    const slash = modelId.indexOf('/');
    const providerID = slash > 0 ? modelId.slice(0, slash) : harness;
    const modelID = slash > 0 ? modelId.slice(slash + 1) : modelId;
    store.setModelForAgent(agentName, { providerID, modelID });
    setSelected(modelId);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  }, [agentName, harness, store]);

  const clearSelection = useCallback(() => {
    if (!agentName) return;
    store.clearModelForAgent(agentName);
    setSelected(null);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  }, [agentName, store]);

  if (catalog.isLoading || !projectConfig) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 48 }}>
        <ActivityIndicator size="small" color={themeColors.primary} />
        <Text style={{ marginTop: 12, fontSize: 12, fontFamily: 'Roobert', color: colors.muted }}>Loading models…</Text>
      </View>
    );
  }

  return (
    <View style={{ flex: 1 }}>
      {/* Header — fixed above scrollable list */}
      <View style={{ alignItems: 'center', marginBottom: 24 }}>
        <View style={{ width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center', backgroundColor: isDark ? 'rgba(248,248,248,0.06)' : 'rgba(18,18,21,0.04)', marginBottom: 16 }}>
          <Bot size={22} color={colors.muted} strokeWidth={1.8} />
        </View>
        <Text style={{ fontSize: 18, fontFamily: 'Roobert-SemiBold', color: colors.fg, marginBottom: 6 }}>Model for {agentName ?? 'agent'}</Text>
        <Text style={{ fontSize: 13, fontFamily: 'Roobert', color: colors.muted, textAlign: 'center', lineHeight: 18, maxWidth: 280 }}>
          {agent ? `${agent.harness ?? 'ACP'} controls the authoritative model choices for this agent.` : 'Declare a default agent in kortix.yaml to choose a model.'}
        </Text>
      </View>

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 16 }} style={{ flex: 1 }}>
        {defaultAllowed ? (
          <Pressable onPress={clearSelection} style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 10, borderRadius: 12, borderWidth: 1, borderColor: selected === null ? (isDark ? 'rgba(248,248,248,0.2)' : 'rgba(18,18,21,0.2)') : colors.cardBorder, backgroundColor: colors.cardBg, marginBottom: 6 }}>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 13, fontFamily: 'Roobert-Medium', color: colors.fg }}>Harness default</Text>
              <Text style={{ fontSize: 10, fontFamily: 'Roobert', color: colors.muted, marginTop: 1 }}>Let {agent?.harness ?? 'the ACP harness'} choose its native default.</Text>
            </View>
            {selected === null ? <Check size={16} color="#34D399" strokeWidth={2.5} /> : null}
          </Pressable>
        ) : null}
        {models.map((model) => (
          <Pressable key={model.id} onPress={() => persistSelection(model.id)} style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 10, borderRadius: 12, borderWidth: 1, borderColor: selected === model.id ? (isDark ? 'rgba(248,248,248,0.2)' : 'rgba(18,18,21,0.2)') : colors.cardBorder, backgroundColor: colors.cardBg, marginBottom: 6 }}>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 13, fontFamily: 'Roobert-Medium', color: colors.fg }} numberOfLines={1}>{model.name}</Text>
              <Text style={{ fontSize: 10, fontFamily: 'Roobert', color: colors.muted, marginTop: 1 }} numberOfLines={1}>{model.id} · {model.source}</Text>
            </View>
            {selected === model.id ? <Check size={16} color="#34D399" strokeWidth={2.5} /> : null}
          </Pressable>
        ))}
        {customAllowed ? (
          <View style={{ marginTop: 10 }}>
            <Text style={{ fontSize: 11, fontFamily: 'Roobert-Medium', color: colors.muted, marginBottom: 6 }}>CUSTOM MODEL ID</Text>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <TextInput value={customModel} onChangeText={setCustomModel} placeholder="provider/model or model-id" placeholderTextColor={colors.muted} autoCapitalize="none" autoCorrect={false} style={{ flex: 1, borderWidth: 1, borderColor: colors.cardBorder, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10, color: colors.fg, fontFamily: 'Menlo', fontSize: 12 }} />
              <Pressable onPress={() => customModel.trim() && persistSelection(customModel.trim())} disabled={!customModel.trim()} style={{ minWidth: 68, alignItems: 'center', justifyContent: 'center', borderRadius: 12, backgroundColor: themeColors.primary, opacity: customModel.trim() ? 1 : 0.45 }}>
                <Text style={{ color: themeColors.primaryForeground, fontFamily: 'Roobert-SemiBold', fontSize: 12 }}>Use</Text>
              </Pressable>
            </View>
          </View>
        ) : null}
      </ScrollView>

      {/* Bottom buttons — sits below scroll area */}
      <View style={{ gap: 10, paddingTop: 10 }}>
        <Pressable
          onPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); onContinue(); }}
          style={{
            backgroundColor: themeColors.primary,
            borderRadius: 14,
            paddingVertical: 15,
            alignItems: 'center',
            flexDirection: 'row',
            justifyContent: 'center',
            gap: 6,
          }}
        >
          <Text style={{ fontSize: 15, fontFamily: 'Roobert-SemiBold', color: themeColors.primaryForeground }}>
            Continue
          </Text>
          <ChevronRight size={16} color={themeColors.primaryForeground} strokeWidth={2} />
        </Pressable>
        <Pressable
          onPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); onBack(); }}
          style={{ alignItems: 'center', flexDirection: 'row', justifyContent: 'center', gap: 4, paddingVertical: 4 }}
        >
          <ChevronLeft size={14} color={colors.muted} strokeWidth={2} />
          <Text style={{ fontSize: 12, fontFamily: 'Roobert', color: colors.muted }}>Back</Text>
        </Pressable>
      </View>
    </View>
  );
}

// ─── Step 3: Tool Secrets ────────────────────────────────────────────────────

function ToolSecretsStep({ onContinue, isDark, themeColors }: StepProps & { onContinue: () => void }) {
  const { sandboxUrl } = useSandboxContext();
  const [values, setValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const colors = useStepColors(isDark);
  const filledCount = Object.values(values).filter((v) => v.trim()).length;

  const handleSave = useCallback(async () => {
    if (!sandboxUrl) return;
    const toSave = Object.entries(values).filter(([, v]) => v.trim());
    if (toSave.length === 0) { onContinue(); return; }

    setSaving(true);
    try {
      for (const [key, value] of toSave) {
        await sandboxFetch(sandboxUrl, `/env/${encodeURIComponent(key)}`, {
          method: 'PUT', body: JSON.stringify({ value: value.trim() }),
        });
      }
    } catch { /* Continue anyway */ }
    setSaving(false);
    onContinue();
  }, [sandboxUrl, values, onContinue]);

  return (
    <View style={{ width: '100%', flex: 1 }}>
      {/* Header */}
      <View style={{ alignItems: 'center', gap: 4, marginBottom: 16 }}>
        <Text style={{ fontSize: 15, fontFamily: 'Roobert-Medium', color: colors.fg, textAlign: 'center' }}>Add tool keys</Text>
        <Text style={{ fontSize: 12, fontFamily: 'Roobert', color: colors.muted, textAlign: 'center' }}>Optional API keys for agent capabilities</Text>
      </View>

      {/* Cards — fill available space */}
      <ScrollView style={{ flex: 1 }} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: 10, paddingBottom: 4 }}>
        {TOOL_SECRETS.map((secret) => {
          const Icon = secret.icon;
          const hasValue = !!(values[secret.key] || '').trim();
          return (
            <View
              key={secret.key}
              style={{
                borderRadius: 16,
                borderWidth: 1,
                borderColor: hasValue
                  ? (isDark ? 'rgba(52,211,153,0.2)' : 'rgba(52,211,153,0.15)')
                  : (isDark ? 'rgba(248,248,248,0.06)' : 'rgba(18,18,21,0.06)'),
                backgroundColor: isDark ? 'rgba(248,248,248,0.02)' : 'rgba(18,18,21,0.015)',
                overflow: 'hidden',
              }}
            >
              {/* Top row: icon + label + description + link */}
              <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingTop: 12, paddingBottom: 8, gap: 10 }}>
                <View style={{
                  width: 34,
                  height: 34,
                  borderRadius: 10,
                  alignItems: 'center',
                  justifyContent: 'center',
                  backgroundColor: isDark ? 'rgba(248,248,248,0.05)' : 'rgba(18,18,21,0.035)',
                }}>
                  <Icon size={15} color={isDark ? 'rgba(248,248,248,0.45)' : 'rgba(18,18,21,0.4)'} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 14, fontFamily: 'Roobert-Medium', color: isDark ? '#F8F8F8' : '#121215' }}>
                    {secret.label}
                  </Text>
                  <Text style={{ fontSize: 11, fontFamily: 'Roobert', color: isDark ? 'rgba(248,248,248,0.4)' : 'rgba(18,18,21,0.4)', marginTop: 1, lineHeight: 15 }}>
                    {secret.description}
                  </Text>
                </View>
                <Pressable onPress={() => Linking.openURL(secret.signupUrl)} hitSlop={12} style={{ padding: 4 }}>
                  <ExternalLink size={13} color={isDark ? 'rgba(248,248,248,0.2)' : 'rgba(18,18,21,0.2)'} />
                </Pressable>
              </View>
              {/* Input row */}
              <View style={{ paddingHorizontal: 14, paddingBottom: 12 }}>
                <TextInput
                  secureTextEntry
                  placeholder={secret.key}
                  placeholderTextColor={isDark ? 'rgba(248,248,248,0.15)' : 'rgba(18,18,21,0.15)'}
                  value={values[secret.key] || ''}
                  onChangeText={(text) => setValues((prev) => ({ ...prev, [secret.key]: text }))}
                  autoCapitalize="none"
                  autoCorrect={false}
                  textAlignVertical="center"
                  style={{
                    height: 36,
                    borderRadius: 10,
                    paddingHorizontal: 12,
                    paddingVertical: 0,
                    fontSize: 12,
                    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace' }),
                    color: colors.fg,
                    backgroundColor: isDark ? 'rgba(248,248,248,0.04)' : 'rgba(18,18,21,0.03)',
                    borderWidth: 1,
                    borderColor: isDark ? 'rgba(248,248,248,0.06)' : 'rgba(18,18,21,0.06)',
                    includeFontPadding: false,
                  }}
                />
              </View>
            </View>
          );
        })}
      </ScrollView>

      {/* Footer — sticky bottom */}
      <View style={{ paddingTop: 12 }}>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Pressable onPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); onContinue(); }} disabled={saving} style={{ flex: 1, height: 44, borderRadius: 12, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: colors.cardBorder }}>
            <Text style={{ fontSize: 13, fontFamily: 'Roobert-Medium', color: colors.muted }}>Skip for now</Text>
          </Pressable>
          <Pressable onPress={handleSave} disabled={saving} style={{ flex: 1, height: 44, borderRadius: 12, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 6, backgroundColor: themeColors.primary }}>
            {saving ? (
              <><SpinningLoader size={14} color={themeColors.primaryForeground} /><Text style={{ fontSize: 13, fontFamily: 'Roobert-Medium', color: themeColors.primaryForeground }}>Saving…</Text></>
            ) : (
              <Text style={{ fontSize: 13, fontFamily: 'Roobert-Medium', color: themeColors.primaryForeground }}>{filledCount > 0 ? 'Save & continue' : 'Continue'}</Text>
            )}
          </Pressable>
        </View>
        <Text style={{ fontSize: 11, fontFamily: 'Roobert', color: isDark ? 'rgba(248,248,248,0.2)' : 'rgba(18,18,21,0.2)', textAlign: 'center', marginTop: 10 }}>
          You can add or change keys later in Settings.
        </Text>
      </View>
    </View>
  );
}

// ─── Step 3: Pipedream ───────────────────────────────────────────────────────

function PipedreamStep({ onComplete, completing, isDark, themeColors }: StepProps & { onComplete: () => void; completing: boolean }) {
  const { sandboxUrl } = useSandboxContext();
  const [values, setValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const colors = useStepColors(isDark);
  const allFilled = PIPEDREAM_KEYS.every((k) => (values[k.key] || '').trim());

  const handleSave = useCallback(async () => {
    if (!sandboxUrl || !allFilled) { onComplete(); return; }

    setSaving(true);
    try {
      const entries = [
        ...PIPEDREAM_KEYS.map((k) => [k.key, (values[k.key] || '').trim()] as const),
        ['PIPEDREAM_ENVIRONMENT', 'production'] as const,
      ];
      for (const [key, value] of entries) {
        if (!value) continue;
        await sandboxFetch(sandboxUrl, `/env/${encodeURIComponent(key)}`, {
          method: 'PUT', body: JSON.stringify({ value }),
        });
      }
    } catch { /* Continue anyway */ }
    setSaving(false);
    onComplete();
  }, [sandboxUrl, values, allFilled, onComplete]);

  const busy = saving || completing;

  return (
    <View style={{ width: '100%', flex: 1 }}>
      {/* Header */}
      <View style={{ alignItems: 'center', gap: 8, marginBottom: 20 }}>
        <View style={{ width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: isDark ? 'rgba(248,248,248,0.06)' : 'rgba(18,18,21,0.04)' }}>
          <Link size={20} color={isDark ? 'rgba(248,248,248,0.5)' : 'rgba(18,18,21,0.4)'} />
        </View>
        <Text style={{ fontSize: 15, fontFamily: 'Roobert-Medium', color: colors.fg, textAlign: 'center' }}>
          Third-party integrations
        </Text>
        <Text style={{ fontSize: 12, fontFamily: 'Roobert', color: colors.muted, textAlign: 'center', lineHeight: 18, paddingHorizontal: 8 }}>
          Connect to 3,000+ apps via Pipedream Connect. Optional — you can add this later in Settings.
        </Text>
      </View>

      {/* Fields — centered in remaining space */}
      <View style={{ flex: 1, justifyContent: 'center' }}>
        <View style={{ gap: 14 }}>
          {PIPEDREAM_KEYS.map((field) => (
            <View key={field.key} style={{ gap: 5 }}>
              <Text style={{ fontSize: 12, fontFamily: 'Roobert-Medium', color: isDark ? 'rgba(248,248,248,0.6)' : 'rgba(18,18,21,0.6)' }}>
                {field.label}
              </Text>
              <TextInput
                secureTextEntry={field.secret}
                placeholder={field.placeholder}
                placeholderTextColor={isDark ? 'rgba(248,248,248,0.2)' : 'rgba(18,18,21,0.2)'}
                value={values[field.key] || ''}
                onChangeText={(text) => setValues((prev) => ({ ...prev, [field.key]: text }))}
                autoCapitalize="none"
                autoCorrect={false}
                textAlignVertical="center"
                style={{ height: 40, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 0, fontSize: 13, fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace' }), color: colors.fg, backgroundColor: colors.inputBg, borderWidth: 1, borderColor: colors.inputBorder, includeFontPadding: false }}
              />
            </View>
          ))}
        </View>
      </View>

      {/* Footer — sticky bottom */}
      <View style={{ paddingTop: 12 }}>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Pressable onPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); onComplete(); }} disabled={busy} style={{ flex: 1, height: 44, borderRadius: 12, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 6, borderWidth: 1, borderColor: colors.cardBorder }}>
            {completing ? (
              <><SpinningLoader size={14} color={colors.muted} /><Text style={{ fontSize: 13, fontFamily: 'Roobert-Medium', color: colors.muted }}>Finishing…</Text></>
            ) : (
              <Text style={{ fontSize: 13, fontFamily: 'Roobert-Medium', color: colors.muted }}>Skip for now</Text>
            )}
          </Pressable>
          <Pressable onPress={handleSave} disabled={busy || !allFilled} style={{ flex: 1, height: 44, borderRadius: 12, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 6, backgroundColor: themeColors.primary, opacity: allFilled ? 1 : 0.5 }}>
            {busy ? (
            <><SpinningLoader size={14} color={themeColors.primaryForeground} /><Text style={{ fontSize: 13, fontFamily: 'Roobert-Medium', color: themeColors.primaryForeground }}>{saving ? 'Saving…' : 'Finishing…'}</Text></>
          ) : (
            <Text style={{ fontSize: 13, fontFamily: 'Roobert-Medium', color: themeColors.primaryForeground }}>Save & finish</Text>
          )}
          </Pressable>
        </View>
        <Pressable onPress={() => Linking.openURL('https://pipedream.com/connect')} style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4, marginTop: 10 }}>
          <Text style={{ fontSize: 11, fontFamily: 'Roobert', color: isDark ? 'rgba(248,248,248,0.3)' : 'rgba(18,18,21,0.3)' }}>
            Get your credentials at
          </Text>
          <Text style={{ fontSize: 11, fontFamily: 'Roobert-Medium', color: isDark ? 'rgba(248,248,248,0.4)' : 'rgba(18,18,21,0.4)', textDecorationLine: 'underline' }}>
            pipedream.com/connect
          </Text>
          <ExternalLink size={10} color={isDark ? 'rgba(248,248,248,0.3)' : 'rgba(18,18,21,0.3)'} />
        </Pressable>
      </View>
    </View>
  );
}

// ─── Step 5: Get Started ─────────────────────────────────────────────────────

function GetStartedStep({ onComplete, completing, isDark, themeColors }: StepProps & { onComplete: () => void; completing: boolean }) {
  const colors = useStepColors(isDark);

  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
      <View style={{ alignItems: 'center', marginBottom: 32 }}>
        <View style={{ width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center', backgroundColor: `${themeColors.primary}18`, marginBottom: 16 }}>
          <MessageSquare size={22} color={themeColors.primary} strokeWidth={1.8} />
        </View>
        <Text style={{ fontSize: 18, fontFamily: 'Roobert-SemiBold', color: colors.fg, marginBottom: 6 }}>
          You're all set
        </Text>
        <Text style={{ fontSize: 13, fontFamily: 'Roobert', color: colors.muted, textAlign: 'center', lineHeight: 18, maxWidth: 280 }}>
          Your Kortix agent is configured and ready. We'll walk you through the basics in a quick guided conversation.
        </Text>
      </View>

      <Pressable
        onPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium); onComplete(); }}
        disabled={completing}
        style={{
          backgroundColor: themeColors.primary,
          borderRadius: 14,
          paddingVertical: 15,
          paddingHorizontal: 32,
          alignItems: 'center',
          flexDirection: 'row',
          justifyContent: 'center',
          gap: 6,
          width: '100%',
          opacity: completing ? 0.6 : 1,
        }}
      >
        <Text style={{ fontSize: 15, fontFamily: 'Roobert-SemiBold', color: themeColors.primaryForeground }}>
          {completing ? 'Starting…' : 'Start onboarding'}
        </Text>
        {!completing && <ChevronRight size={16} color={themeColors.primaryForeground} strokeWidth={2} />}
      </Pressable>
    </View>
  );
}

// ─── Main SetupWizard ────────────────────────────────────────────────────────

export function SetupWizard({ projectId, onComplete }: SetupWizardProps) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const insets = useSafeAreaInsets();
  const themeColors = useThemeColors();
  const { sandboxUrl } = useSandboxContext();
  const router = useRouter();

  const [step, setStep] = useState<1 | 2 | 3 | 4 | 5>(1);
  const [completing, setCompleting] = useState(false);
  const stepRef = useRef(step);
  stepRef.current = step;

  const totalSteps = 5;

  // Swipe right to go back to previous step
  const panResponder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, gestureState) => {
        // Only activate for horizontal swipes (right) with enough velocity
        return gestureState.dx > 30 && Math.abs(gestureState.dy) < 50;
      },
      onPanResponderRelease: (_, gestureState) => {
        if (gestureState.dx > 80 && stepRef.current > 1) {
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
          setStep((prev) => (prev > 1 ? (prev - 1) as 1 | 2 | 3 | 4 | 5 : prev));
        }
      },
    }),
  ).current;

  const markSetupComplete = useCallback(async () => {
    if (!sandboxUrl) {
      log.error('[SetupWizard] markSetupComplete: no sandboxUrl');
      onComplete();
      return;
    }
    setCompleting(true);
    try {
      const res = await sandboxFetch(sandboxUrl, '/env/INSTANCE_SETUP_COMPLETE', {
        method: 'PUT',
        body: JSON.stringify({ value: 'true' }),
      });
      if (!res.ok) {
        log.error('[SetupWizard] Failed to write INSTANCE_SETUP_COMPLETE:', res.status, await res.text().catch(() => ''));
      } else {
        log.log('[SetupWizard] INSTANCE_SETUP_COMPLETE written successfully');
      }
    } catch (err: any) {
      log.error('[SetupWizard] markSetupComplete error:', err?.message || err);
    }
    onComplete();
  }, [sandboxUrl, onComplete]);

  const handleStepPress = useCallback((s: number) => {
    if (s < step) setStep(s as 1 | 2 | 3 | 4 | 5);
  }, [step]);

  const bg = isDark ? '#09090b' : '#FFFFFF';

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      style={{ flex: 1, backgroundColor: bg }}
      {...panResponder.panHandlers}
    >
      <View style={{ flex: 1, paddingTop: insets.top + 24, paddingBottom: insets.bottom + 16, paddingHorizontal: 28 }}>
        {/* Back to Instances — only on the first step, mirrors web 962b8a4. */}
        {step === 1 && (
          <Pressable
            onPress={() => {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              router.push('/(settings)/instances');
            }}
            hitSlop={8}
            style={{
              position: 'absolute',
              top: insets.top + 12,
              left: 16,
              zIndex: 10,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 4,
              paddingHorizontal: 10,
              paddingVertical: 6,
              borderRadius: 999,
              backgroundColor: isDark ? 'rgba(248,248,248,0.06)' : 'rgba(18,18,21,0.04)',
            }}
          >
            <ArrowLeft size={12} color={isDark ? 'rgba(248,248,248,0.7)' : 'rgba(18,18,21,0.7)'} />
            <Text style={{ fontSize: 11, fontFamily: 'Roobert-Medium', color: isDark ? 'rgba(248,248,248,0.7)' : 'rgba(18,18,21,0.7)' }}>
              Back to Instances
            </Text>
          </Pressable>
        )}

        {/* ── Fixed header ── */}
        <View style={{ alignItems: 'center', marginBottom: 16 }}>
          <KortixLogo size={28} variant="symbol" color={isDark ? 'dark' : 'light'} />
          <Text style={{ fontSize: 10, fontFamily: 'Roobert-Medium', color: isDark ? 'rgba(248,248,248,0.3)' : 'rgba(18,18,21,0.3)', letterSpacing: 2, textTransform: 'uppercase', marginTop: 12, marginBottom: 4 }}>
            Instance Setup
          </Text>
          <Text style={{ fontSize: 10, fontFamily: 'Roobert', color: isDark ? 'rgba(248,248,248,0.2)' : 'rgba(18,18,21,0.2)', letterSpacing: 1.5, textTransform: 'uppercase', marginBottom: 16 }}>
            Self-Hosted Setup
          </Text>
          <StepIndicator currentStep={step} totalSteps={totalSteps} isDark={isDark} onStepPress={handleStepPress} />
        </View>

        {/* ── Step content ── */}
        <View style={{ flex: 1, width: '100%', maxWidth: 380, alignSelf: 'center' }}>
          {step === 1 && <ProjectProviderSetupStep projectId={projectId} onContinue={() => setStep(2)} isDark={isDark} themeColors={themeColors} />}
          {step === 2 && <DefaultModelStep projectId={projectId} onContinue={() => setStep(3)} onBack={() => setStep(1)} isDark={isDark} themeColors={themeColors} />}
          {step === 3 && <ToolSecretsStep onContinue={() => setStep(4)} isDark={isDark} themeColors={themeColors} />}
          {step === 4 && <PipedreamStep onComplete={() => setStep(5)} completing={false} isDark={isDark} themeColors={themeColors} />}
          {step === 5 && <GetStartedStep onComplete={markSetupComplete} completing={completing} isDark={isDark} themeColors={themeColors} />}
        </View>
      </View>

      {completing && (
        <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center', zIndex: 100, backgroundColor: isDark ? 'rgba(0,0,0,0.6)' : 'rgba(255,255,255,0.6)' }}>
          <ActivityIndicator size="small" color={themeColors.primary} />
          <Text style={{ marginTop: 12, fontSize: 13, fontFamily: 'Roobert-Medium', color: isDark ? '#F8F8F8' : '#121215' }}>
            Finishing setup…
          </Text>
        </View>
      )}
    </KeyboardAvoidingView>
  );
}
