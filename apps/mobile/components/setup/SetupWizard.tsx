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
  StyleSheet,
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
  Sparkles,
  Check,
  ChevronRight,
  Search,
  Flame,
  ImageIcon,
  BookOpen,
  Mic,
  ExternalLink,
  Settings2,
  Loader2,
  Link,
  ChevronLeft,
  Bot,
  MessageSquare,
} from 'lucide-react-native';

import {
  BottomSheetModal,
  BottomSheetBackdrop,
  BottomSheetView,
  BottomSheetScrollView,
  BottomSheetTextInput,
} from '@gorhom/bottom-sheet';
import type { BottomSheetBackdropProps } from '@gorhom/bottom-sheet';

import { KortixLogo } from '@/components/ui/KortixLogo';
import AnthropicIcon from '@/assets/images/models/Anthropic.svg';
import OAIIcon from '@/assets/images/models/OAI.svg';
import GeminiIcon from '@/assets/images/models/Gemini.svg';
import GrokIcon from '@/assets/images/models/Grok.svg';
import MoonshotIcon from '@/assets/images/models/Moonshot.svg';
import type { SvgProps } from 'react-native-svg';
import { useSandboxContext } from '@/contexts/SandboxContext';
import { useOpenCodeProviders, flattenModels, type FlatModel } from '@/lib/opencode/hooks/use-opencode-data';
import { useLocalConfigStore } from '@/lib/opencode/hooks/use-local-config';
import { useThemeColors } from '@/lib/theme-colors';
import { getAuthToken } from '@/api/config';
import { useTabStore } from '@/stores/tab-store';
import { log } from '@/lib/logger';

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

// LLM provider IDs that count as "connected"
const LLM_PROVIDER_IDS = new Set([
  'anthropic', 'openai', 'openrouter', 'google', 'groq', 'xai',
  'deepseek', 'mistral', 'cerebras', 'togetherai', 'fireworks',
]);

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

// ─── Provider icons ──────────────────────────────────────────────────────────

const PROVIDER_ICON_MAP: Record<string, React.FC<SvgProps>> = {
  anthropic: AnthropicIcon,
  openai: OAIIcon,
  google: GeminiIcon,
  xai: GrokIcon,
  moonshotai: MoonshotIcon,
};

const PROVIDER_INITIALS: Record<string, string> = {
  openrouter: 'OR',
  groq: 'GQ',
  deepseek: 'DS',
  mistral: 'MI',
  cerebras: 'CE',
};

function ProviderIcon({ providerId, size = 20, isDark }: { providerId: string; size?: number; isDark: boolean }) {
  const SvgIcon = PROVIDER_ICON_MAP[providerId];
  const iconColor = isDark ? '#F8F8F8' : '#121215';

  if (SvgIcon) {
    return <SvgIcon width={size} height={size} fill={iconColor} color={iconColor} />;
  }

  // Fallback to initials
  const initials = PROVIDER_INITIALS[providerId] || (PROVIDER_LABELS[providerId] || providerId).slice(0, 2).toUpperCase();
  return (
    <Text style={{ fontSize: size * 0.5, fontFamily: 'Roobert-SemiBold', color: isDark ? 'rgba(248,248,248,0.6)' : 'rgba(18,18,21,0.5)' }}>
      {initials}
    </Text>
  );
}

// ─── Provider connection helpers ──────────────────────────────────────────────

const PROVIDER_LABELS: Record<string, string> = {
  anthropic: 'Anthropic', openai: 'OpenAI', google: 'Google', xai: 'xAI',
  openrouter: 'OpenRouter', groq: 'Groq', deepseek: 'DeepSeek', mistral: 'Mistral',
};

const POPULAR_PROVIDER_ORDER = ['anthropic', 'openai', 'openrouter', 'google', 'groq', 'xai', 'deepseek', 'mistral'];

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

// ─── Provider Row (reusable in bottom sheet) ─────────────────────────────────

function ProviderRow({ id, idx, total, isConnected, isDark, colors, onPress }: {
  id: string; idx: number; total: number; isConnected: boolean; isDark: boolean;
  colors: ReturnType<typeof useStepColors>; onPress: (id: string) => void;
}) {
  return (
    <Pressable
      onPress={() => onPress(id)}
      style={{
        flexDirection: 'row', alignItems: 'center', gap: 12,
        paddingVertical: 11, paddingHorizontal: 4,
        borderBottomWidth: idx < total - 1 ? StyleSheet.hairlineWidth : 0,
        borderBottomColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)',
      }}
    >
      <View style={{ width: 24, alignItems: 'center' }}>
        {isConnected ? <Check size={18} color="#34d399" strokeWidth={2.5} /> : <ProviderIcon providerId={id} size={20} isDark={isDark} />}
      </View>
      <View style={{ flex: 1 }}>
        <Text style={{ fontSize: 15, fontFamily: 'Roobert', color: colors.fg }}>
          {PROVIDER_LABELS[id] || id}
        </Text>
        {isConnected && (
          <Text style={{ fontSize: 11, fontFamily: 'Roobert', color: '#34d399', marginTop: 1 }}>Connected</Text>
        )}
      </View>
      <ChevronRight size={16} color={isConnected ? '#34d399' : (isDark ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.15)')} strokeWidth={2} />
    </Pressable>
  );
}

// ─── Step 1: Provider ────────────────────────────────────────────────────────

// ─── Auth method helpers (matches web) ───────────────────────────────────────

interface AuthMethod { type: string; label: string }

function getMethodIcon(method: AuthMethod) {
  const label = method.label.toLowerCase();
  if (method.type === 'api' || label.includes('api key') || label.includes('manually')) return Settings2;
  if (label.includes('pro') || label.includes('max') || label.includes('plus')) return Sparkles;
  return Sparkles;
}

function getMethodDescription(method: AuthMethod) {
  const label = method.label.toLowerCase();
  if (label.includes('pro') && label.includes('max')) return 'Use your Claude Pro or Max subscription';
  if (label.includes('pro') && label.includes('plus')) return 'Use your ChatGPT Pro or Plus subscription';
  if (label.includes('create') && label.includes('api')) return 'Automatically create and connect an API key';
  if (method.type === 'api') return 'Manually enter an existing API key';
  if (label.includes('copilot') || label.includes('github')) return 'Login with your GitHub account';
  return undefined;
}

function getMethodLabel(method: AuthMethod) {
  if (method.type === 'api') return 'API key';
  return method.label || 'OAuth';
}

async function fetchAuthMethods(sandboxUrl: string, providerId: string): Promise<AuthMethod[]> {
  try {
    const res = await sandboxFetch(sandboxUrl, '/provider/auth');
    if (!res.ok) return [{ type: 'api', label: 'API Key' }];
    const data = await res.json();
    const methods = data?.[providerId];
    if (methods && methods.length > 0) return methods;
    return [{ type: 'api', label: 'API Key' }];
  } catch {
    return [{ type: 'api', label: 'API Key' }];
  }
}

async function startOAuth(sandboxUrl: string, providerId: string, methodIndex: number): Promise<{ url: string; method: 'code' | 'auto'; instructions: string }> {
  const res = await sandboxFetch(sandboxUrl, `/provider/${encodeURIComponent(providerId)}/oauth/authorize`, {
    method: 'POST',
    body: JSON.stringify({ method: methodIndex }),
  });
  if (!res.ok) throw new Error(`OAuth authorize failed: ${res.status}`);
  return res.json();
}

async function submitOAuthCallback(sandboxUrl: string, providerId: string, methodIndex: number, code: string): Promise<void> {
  const res = await sandboxFetch(sandboxUrl, `/provider/${encodeURIComponent(providerId)}/oauth/callback`, {
    method: 'POST',
    body: JSON.stringify({ method: methodIndex, code }),
  });
  if (!res.ok) throw new Error(`OAuth callback failed: ${res.status}`);
  const data = await res.json();
  if (data?.type === 'failed') throw new Error('OAuth authorization failed');
}

function ProviderStep({ onContinue, isDark, themeColors }: StepProps & { onContinue: () => void }) {
  const { sandboxUrl } = useSandboxContext();
  const { data: providersData, isLoading, refetch } = useOpenCodeProviders(sandboxUrl);
  const sheetRef = useRef<BottomSheetModal>(null);

  // Sheet navigation: list → methods → apikey | oauth
  type SheetView = 'list' | 'methods' | 'apikey' | 'oauth';
  const [sheetView, setSheetView] = useState<SheetView>('list');
  const [selectedProvider, setSelectedProvider] = useState<string | null>(null);
  const [authMethods, setAuthMethods] = useState<AuthMethod[]>([]);
  const [selectedMethodIndex, setSelectedMethodIndex] = useState<number | undefined>(undefined);

  // API key state
  const [apiKey, setApiKey] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);

  // OAuth state
  const [oauthUrl, setOauthUrl] = useState('');
  const [oauthCode, setOauthCode] = useState('');
  const [oauthInstructions, setOauthInstructions] = useState('');
  const [oauthLoading, setOauthLoading] = useState(false);

  const colors = useStepColors(isDark);

  const connectedSet = useMemo(() => new Set(providersData?.connected ?? []), [providersData]);
  const hasLLMProvider = useMemo(() => [...connectedSet].some((id) => LLM_PROVIDER_IDS.has(id)), [connectedSet]);
  const connectedCount = connectedSet.size;

  const renderBackdrop = useCallback((props: BottomSheetBackdropProps) => (
    <BottomSheetBackdrop {...props} disappearsOnIndex={-1} appearsOnIndex={0} opacity={0.4} pressBehavior="close" />
  ), []);

  const resetSheet = useCallback(() => {
    setSheetView('list');
    setSelectedProvider(null);
    setAuthMethods([]);
    setSelectedMethodIndex(undefined);
    setApiKey('');
    setConnectError(null);
    setOauthUrl('');
    setOauthCode('');
    setOauthInstructions('');
    setOauthLoading(false);
  }, []);

  const handleOpenSheet = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    resetSheet();
    sheetRef.current?.present();
  }, [resetSheet]);

  const handleSelectProvider = useCallback(async (id: string) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setSelectedProvider(id);
    setConnectError(null);

    if (!sandboxUrl) {
      setAuthMethods([{ type: 'api', label: 'API Key' }]);
      setSheetView('apikey');
      return;
    }

    // Fetch available auth methods for this provider
    const methods = await fetchAuthMethods(sandboxUrl, id);
    setAuthMethods(methods);

    if (methods.length === 1) {
      // Single method — go directly to it
      if (methods[0].type === 'api') {
        setSelectedMethodIndex(0);
        setSheetView('apikey');
      } else {
        await handleSelectMethod(id, methods, 0);
      }
    } else {
      // Multiple methods — show selection
      setSheetView('methods');
    }
  }, [sandboxUrl]);

  const handleSelectMethod = useCallback(async (providerId: string, methods: AuthMethod[], index: number) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setSelectedMethodIndex(index);
    setConnectError(null);
    const method = methods[index];

    if (method.type === 'api') {
      setSheetView('apikey');
      return;
    }

    // OAuth flow
    if (!sandboxUrl) return;
    setOauthLoading(true);
    try {
      const result = await startOAuth(sandboxUrl, providerId, index);
      setOauthUrl(result.url);
      setOauthInstructions(result.instructions || '');
      setSheetView('oauth');
    } catch (e: any) {
      setConnectError(e.message || 'Failed to start OAuth');
    } finally {
      setOauthLoading(false);
    }
  }, [sandboxUrl]);

  const handleApiKeyConnect = useCallback(async () => {
    if (!sandboxUrl || !selectedProvider || !apiKey.trim()) return;
    setConnecting(true);
    setConnectError(null);
    try {
      await connectProvider(sandboxUrl, selectedProvider, apiKey.trim());
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      resetSheet();
      sheetRef.current?.dismiss();
      refetch();
    } catch (e: any) {
      setConnectError(e.message || 'Failed to connect');
    } finally {
      setConnecting(false);
    }
  }, [sandboxUrl, selectedProvider, apiKey, refetch, resetSheet]);

  const handleOAuthSubmit = useCallback(async () => {
    if (!sandboxUrl || !selectedProvider || !oauthCode.trim() || selectedMethodIndex === undefined) return;
    setConnecting(true);
    setConnectError(null);
    try {
      await submitOAuthCallback(sandboxUrl, selectedProvider, selectedMethodIndex, oauthCode.trim());
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      resetSheet();
      sheetRef.current?.dismiss();
      refetch();
    } catch (e: any) {
      setConnectError(e.message || 'OAuth failed');
    } finally {
      setConnecting(false);
    }
  }, [sandboxUrl, selectedProvider, oauthCode, selectedMethodIndex, refetch, resetSheet]);

  const handleContinue = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    refetch();
    onContinue();
  }, [onContinue, refetch]);

  const sheetBg = isDark ? '#1a1a1d' : '#FFFFFF';

  if (isLoading) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 }}>
        <ActivityIndicator size="small" color={isDark ? '#71717a' : '#a1a1aa'} />
        <Text style={{ fontSize: 12, fontFamily: 'Roobert', color: isDark ? 'rgba(248,248,248,0.4)' : 'rgba(18,18,21,0.4)' }}>
          Checking providers…
        </Text>
      </View>
    );
  }

  return (
    <View style={{ width: '100%', flex: 1, justifyContent: 'center' }}>
      <View style={{ gap: 24 }}>
        <View style={{ alignItems: 'center', gap: 8 }}>
          <View style={{ width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center', backgroundColor: hasLLMProvider ? 'rgba(52,211,153,0.1)' : (isDark ? 'rgba(248,248,248,0.06)' : 'rgba(18,18,21,0.04)'), marginBottom: 8 }}>
            {hasLLMProvider ? <Check size={22} color="#34d399" /> : <Sparkles size={22} color={isDark ? 'rgba(248,248,248,0.5)' : 'rgba(18,18,21,0.4)'} />}
          </View>
          <Text style={{ fontSize: 18, fontFamily: 'Roobert-SemiBold', color: isDark ? '#F8F8F8' : '#121215', textAlign: 'center' }}>
            {hasLLMProvider ? 'Provider connected' : 'LLM Providers'}
          </Text>
          <Text style={{ fontSize: 13, fontFamily: 'Roobert', color: isDark ? 'rgba(248,248,248,0.5)' : 'rgba(18,18,21,0.5)', textAlign: 'center', lineHeight: 18, paddingHorizontal: 8, maxWidth: 300 }}>
            {hasLLMProvider
              ? `${connectedCount} provider${connectedCount > 1 ? 's' : ''} ready. You can add more anytime from settings.`
              : 'Configure which AI models to use with your Kortix agent. Connect OpenAI, Anthropic, Google, or any supported provider.'}
          </Text>
        </View>

        <View style={{ gap: 8 }}>
          <Pressable onPress={handleOpenSheet} style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, height: 48, borderRadius: 14, backgroundColor: hasLLMProvider ? 'transparent' : themeColors.primary, borderWidth: hasLLMProvider ? 1 : 0, borderColor: isDark ? 'rgba(248,248,248,0.1)' : 'rgba(18,18,21,0.1)' }}>
            <Settings2 size={16} color={hasLLMProvider ? (isDark ? '#F8F8F8' : '#121215') : themeColors.primaryForeground} />
            <Text style={{ fontSize: 14, fontFamily: 'Roobert-SemiBold', color: hasLLMProvider ? (isDark ? '#F8F8F8' : '#121215') : themeColors.primaryForeground }}>
              {hasLLMProvider ? 'Manage Providers' : 'Connect Provider'}
            </Text>
          </Pressable>

          <Pressable onPress={handleContinue} style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, height: 48, borderRadius: 14, backgroundColor: hasLLMProvider ? themeColors.primary : 'transparent' }}>
            <Text style={{ fontSize: 14, fontFamily: 'Roobert-Medium', color: hasLLMProvider ? themeColors.primaryForeground : (isDark ? 'rgba(248,248,248,0.5)' : 'rgba(18,18,21,0.5)') }}>
              {hasLLMProvider ? 'Continue' : 'Skip for now'}
            </Text>
            {hasLLMProvider && <ChevronRight size={16} color={themeColors.primaryForeground} />}
          </Pressable>
        </View>
      </View>

      {/* ── Provider connection bottom sheet ── */}
      <BottomSheetModal
        ref={sheetRef}
        snapPoints={sheetView === 'list' ? ['75%'] : ['55%']}
        enablePanDownToClose
        enableDynamicSizing={false}
        backdropComponent={renderBackdrop}
        backgroundStyle={{ backgroundColor: sheetBg, borderTopLeftRadius: 24, borderTopRightRadius: 24 }}
        handleIndicatorStyle={{ backgroundColor: isDark ? '#3F3F46' : '#D4D4D8', width: 36, height: 5, borderRadius: 3, marginTop: 8 }}
      >
        {sheetView === 'list' && (
          /* ── Provider list ── */
          <BottomSheetScrollView contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 32 }}>
            <Text style={{ fontSize: 17, fontFamily: 'Roobert-SemiBold', color: colors.fg, textAlign: 'center', marginTop: 4, marginBottom: 2 }}>
              Choose a provider
            </Text>
            <Text style={{ fontSize: 12, fontFamily: 'Roobert', color: colors.muted, textAlign: 'center', marginBottom: 20 }}>
              Select one to connect
            </Text>

            {/* Popular section */}
            <Text style={{ fontSize: 11, fontFamily: 'Roobert-Medium', color: colors.muted, letterSpacing: 1, textTransform: 'uppercase', marginBottom: 8, paddingLeft: 4 }}>
              Popular
            </Text>
            <View style={{ marginBottom: 16 }}>
              {POPULAR_PROVIDER_ORDER.slice(0, 4).map((id, idx) => (
                <ProviderRow key={id} id={id} idx={idx} total={4} isConnected={connectedSet.has(id)} isDark={isDark} colors={colors} onPress={handleSelectProvider} />
              ))}
            </View>

            {/* More section */}
            <Text style={{ fontSize: 11, fontFamily: 'Roobert-Medium', color: colors.muted, letterSpacing: 1, textTransform: 'uppercase', marginBottom: 8, paddingLeft: 4 }}>
              More
            </Text>
            <View>
              {POPULAR_PROVIDER_ORDER.slice(4).map((id, idx) => (
                <ProviderRow key={id} id={id} idx={idx} total={POPULAR_PROVIDER_ORDER.length - 4} isConnected={connectedSet.has(id)} isDark={isDark} colors={colors} onPress={handleSelectProvider} />
              ))}
            </View>
          </BottomSheetScrollView>
        )}

        {sheetView === 'methods' && selectedProvider && (
          /* ── Auth method selection ── */
          <BottomSheetView style={{ flex: 1, paddingHorizontal: 24 }}>
            <Pressable onPress={() => { setSheetView('list'); setSelectedProvider(null); }} style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginBottom: 16 }}>
              <ChevronLeft size={16} color={colors.muted} />
              <Text style={{ fontSize: 13, fontFamily: 'Roobert-Medium', color: colors.muted }}>Back</Text>
            </Pressable>

            <View style={{ alignItems: 'center', gap: 6, marginBottom: 20 }}>
              <ProviderIcon providerId={selectedProvider} size={28} isDark={isDark} />
              <Text style={{ fontSize: 16, fontFamily: 'Roobert-SemiBold', color: colors.fg }}>
                Connect {PROVIDER_LABELS[selectedProvider] || selectedProvider}
              </Text>
              <Text style={{ fontSize: 12, fontFamily: 'Roobert', color: colors.muted }}>
                Select login method
              </Text>
            </View>

            {oauthLoading && (
              <View style={{ alignItems: 'center', paddingVertical: 24 }}>
                <SpinningLoader size={20} color={colors.muted} />
              </View>
            )}

            {!oauthLoading && authMethods.map((method, idx) => {
              const MethodIcon = getMethodIcon(method);
              const desc = getMethodDescription(method);
              return (
                <Pressable
                  key={idx}
                  onPress={() => handleSelectMethod(selectedProvider, authMethods, idx)}
                  style={{
                    flexDirection: 'row', alignItems: 'center', gap: 12,
                    paddingVertical: 12, paddingHorizontal: 4,
                    borderBottomWidth: idx < authMethods.length - 1 ? StyleSheet.hairlineWidth : 0,
                    borderBottomColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)',
                  }}
                >
                  <View style={{ width: 24, alignItems: 'center' }}>
                    <MethodIcon size={18} color={isDark ? 'rgba(255,255,255,0.5)' : 'rgba(0,0,0,0.4)'} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 14, fontFamily: 'Roobert-Medium', color: colors.fg }}>
                      {getMethodLabel(method)}
                    </Text>
                    {desc && (
                      <Text style={{ fontSize: 11, fontFamily: 'Roobert', color: colors.muted, marginTop: 1 }}>
                        {desc}
                      </Text>
                    )}
                  </View>
                  <ChevronRight size={16} color={isDark ? 'rgba(255,255,255,0.25)' : 'rgba(0,0,0,0.2)'} />
                </Pressable>
              );
            })}

            {connectError && (
              <Text style={{ fontSize: 12, fontFamily: 'Roobert', color: isDark ? '#f87171' : '#dc2626', marginTop: 8, textAlign: 'center' }}>
                {connectError}
              </Text>
            )}
          </BottomSheetView>
        )}

        {sheetView === 'apikey' && selectedProvider && (
          /* ── API key input ── */
          <BottomSheetView style={{ flex: 1, paddingHorizontal: 24 }}>
            <View style={{ flex: 1, justifyContent: 'center', paddingBottom: 24 }}>
              <Pressable onPress={() => authMethods.length > 1 ? setSheetView('methods') : (setSheetView('list'), setSelectedProvider(null))} style={{ flexDirection: 'row', alignItems: 'center', gap: 4, position: 'absolute', top: 0, left: 0, zIndex: 1 }}>
                <ChevronLeft size={16} color={colors.muted} />
                <Text style={{ fontSize: 13, fontFamily: 'Roobert-Medium', color: colors.muted }}>Back</Text>
              </Pressable>

              <View style={{ alignItems: 'center', gap: 6, marginBottom: 20 }}>
                <View style={{ width: 40, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)', borderWidth: 1, borderColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)' }}>
                  <ProviderIcon providerId={selectedProvider} size={20} isDark={isDark} />
                </View>
                <Text style={{ fontSize: 16, fontFamily: 'Roobert-SemiBold', color: colors.fg }}>
                  {PROVIDER_LABELS[selectedProvider] || selectedProvider}
                </Text>
                <Text style={{ fontSize: 12, fontFamily: 'Roobert', color: colors.muted }}>
                  Paste your API key below
                </Text>
              </View>

              <BottomSheetTextInput
                placeholder="sk-..."
                placeholderTextColor={isDark ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.2)'}
                value={apiKey}
                onChangeText={(t: string) => { setApiKey(t); setConnectError(null); }}
                autoCapitalize="none"
                autoCorrect={false}
                autoFocus
                secureTextEntry
                style={{
                  height: 44, borderRadius: 12, paddingHorizontal: 14,
                  fontSize: 14, fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace' }),
                  color: colors.fg, backgroundColor: isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.03)',
                  borderWidth: 1, borderColor: connectError ? (isDark ? 'rgba(239,68,68,0.4)' : 'rgba(220,38,38,0.3)') : (isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)'),
                }}
              />

              {connectError && (
                <Text style={{ fontSize: 12, fontFamily: 'Roobert', color: isDark ? '#f87171' : '#dc2626', marginTop: 8, textAlign: 'center' }}>
                  {connectError}
                </Text>
              )}

              <Pressable
                onPress={handleApiKeyConnect}
                disabled={connecting || !apiKey.trim()}
                style={{
                  height: 48, borderRadius: 14, alignItems: 'center', justifyContent: 'center',
                  flexDirection: 'row', gap: 6, marginTop: 14,
                  backgroundColor: themeColors.primary, opacity: apiKey.trim() ? 1 : 0.5,
                }}
              >
                {connecting ? (
                  <><SpinningLoader size={14} color={themeColors.primaryForeground} /><Text style={{ fontSize: 14, fontFamily: 'Roobert-SemiBold', color: themeColors.primaryForeground }}>Connecting…</Text></>
                ) : (
                  <Text style={{ fontSize: 14, fontFamily: 'Roobert-SemiBold', color: themeColors.primaryForeground }}>Connect</Text>
                )}
              </Pressable>
            </View>
          </BottomSheetView>
        )}

        {sheetView === 'oauth' && selectedProvider && (
          /* ── OAuth flow — open browser + paste redirect URL ── */
          <BottomSheetView style={{ flex: 1, paddingHorizontal: 24 }}>
            <View style={{ flex: 1, justifyContent: 'center', paddingBottom: 24 }}>
              <Pressable onPress={() => setSheetView('methods')} style={{ flexDirection: 'row', alignItems: 'center', gap: 4, position: 'absolute', top: 0, left: 0, zIndex: 1 }}>
                <ChevronLeft size={16} color={colors.muted} />
                <Text style={{ fontSize: 13, fontFamily: 'Roobert-Medium', color: colors.muted }}>Back</Text>
              </Pressable>

              <View style={{ alignItems: 'center', gap: 6, marginBottom: 20 }}>
                <View style={{ width: 40, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)' }}>
                  <Sparkles size={18} color={isDark ? 'rgba(255,255,255,0.5)' : 'rgba(0,0,0,0.4)'} />
                </View>
                <Text style={{ fontSize: 16, fontFamily: 'Roobert-SemiBold', color: colors.fg }}>
                  {PROVIDER_LABELS[selectedProvider] || selectedProvider}
                </Text>
                {oauthInstructions ? (
                  <Text style={{ fontSize: 12, fontFamily: 'Roobert', color: colors.muted, textAlign: 'center', lineHeight: 17, paddingHorizontal: 8 }}>
                    {oauthInstructions}
                  </Text>
                ) : (
                  <Text style={{ fontSize: 12, fontFamily: 'Roobert', color: colors.muted, textAlign: 'center' }}>
                    Sign in via browser, then paste the redirect URL below
                  </Text>
                )}
              </View>

              {/* Open browser button */}
              <Pressable
                onPress={() => { if (oauthUrl) Linking.openURL(oauthUrl); }}
                style={{
                  height: 48, borderRadius: 14, alignItems: 'center', justifyContent: 'center',
                  flexDirection: 'row', gap: 8, marginBottom: 14,
                  backgroundColor: themeColors.primary,
                }}
              >
                <ExternalLink size={16} color={themeColors.primaryForeground} />
                <Text style={{ fontSize: 14, fontFamily: 'Roobert-SemiBold', color: themeColors.primaryForeground }}>
                  Open in Browser
                </Text>
              </Pressable>

              {/* Paste redirect URL */}
              <BottomSheetTextInput
                placeholder="Paste the redirect URL here..."
                placeholderTextColor={isDark ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.2)'}
                value={oauthCode}
                onChangeText={(t: string) => { setOauthCode(t); setConnectError(null); }}
                autoCapitalize="none"
                autoCorrect={false}
                style={{
                  height: 44, borderRadius: 12, paddingHorizontal: 14,
                  fontSize: 13, fontFamily: 'Roobert',
                  color: colors.fg, backgroundColor: isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.03)',
                  borderWidth: 1, borderColor: connectError ? (isDark ? 'rgba(239,68,68,0.4)' : 'rgba(220,38,38,0.3)') : (isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)'),
                }}
              />

              {connectError && (
                <Text style={{ fontSize: 12, fontFamily: 'Roobert', color: isDark ? '#f87171' : '#dc2626', marginTop: 8, textAlign: 'center' }}>
                  {connectError}
                </Text>
              )}

              <Pressable
                onPress={handleOAuthSubmit}
                disabled={connecting || !oauthCode.trim()}
                style={{
                  height: 48, borderRadius: 14, alignItems: 'center', justifyContent: 'center',
                  flexDirection: 'row', gap: 6, marginTop: 14,
                  backgroundColor: isDark ? '#F8F8F8' : '#121215', opacity: oauthCode.trim() ? 1 : 0.5,
                }}
              >
                {connecting ? (
                  <><SpinningLoader size={14} color={isDark ? '#121215' : '#F8F8F8'} /><Text style={{ fontSize: 14, fontFamily: 'Roobert-SemiBold', color: isDark ? '#121215' : '#F8F8F8' }}>Connecting…</Text></>
                ) : (
                  <Text style={{ fontSize: 14, fontFamily: 'Roobert-SemiBold', color: isDark ? '#121215' : '#F8F8F8' }}>Connect</Text>
                )}
              </Pressable>
            </View>
          </BottomSheetView>
        )}
      </BottomSheetModal>
    </View>
  );
}

// ─── Step 2: Default Model Selection ─────────────────────────────────────────

function DefaultModelStep({ onContinue, onBack, isDark, themeColors }: StepProps & { onContinue: () => void; onBack: () => void }) {
  const { sandboxUrl } = useSandboxContext();
  const { data: providersData, isLoading } = useOpenCodeProviders(sandboxUrl);
  const allModels = useMemo(() => (providersData ? flattenModels(providersData) : []), [providersData]);
  const store = useLocalConfigStore();
  const colors = useStepColors(isDark);

  const [selected, setSelected] = useState<{ providerID: string; modelID: string } | null>(
    store.globalDefault ?? null,
  );

  // Group visible models by provider
  const grouped = useMemo(() => {
    const groups = new Map<string, FlatModel[]>();
    for (const m of allModels) {
      const list = groups.get(m.providerID) || [];
      list.push(m);
      groups.set(m.providerID, list);
    }
    return Array.from(groups.entries()).sort((a, b) => {
      const la = PROVIDER_LABELS[a[0]] || a[0];
      const lb = PROVIDER_LABELS[b[0]] || b[0];
      return la.localeCompare(lb);
    });
  }, [allModels]);

  const handleSelect = useCallback((model: FlatModel) => {
    const key = { providerID: model.providerID, modelID: model.modelID };
    setSelected(key);
    store.setGlobalDefault(key);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  }, [store]);

  if (isLoading) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 48 }}>
        <ActivityIndicator size="small" color={themeColors.primary} />
        <Text style={{ marginTop: 12, fontSize: 12, fontFamily: 'Roobert', color: colors.muted }}>Loading models…</Text>
      </View>
    );
  }

  const hasModels = grouped.length > 0;

  return (
    <View style={{ flex: 1 }}>
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 100 }}>
        {/* Header */}
        <View style={{ alignItems: 'center', marginBottom: 24 }}>
          <View style={{ width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center', backgroundColor: isDark ? 'rgba(248,248,248,0.06)' : 'rgba(18,18,21,0.04)', marginBottom: 16 }}>
            <Bot size={22} color={colors.muted} strokeWidth={1.8} />
          </View>
          <Text style={{ fontSize: 18, fontFamily: 'Roobert-SemiBold', color: colors.fg, marginBottom: 6 }}>Default Model</Text>
          <Text style={{ fontSize: 13, fontFamily: 'Roobert', color: colors.muted, textAlign: 'center', lineHeight: 18, maxWidth: 280 }}>
            {hasModels
              ? 'Choose which model your agent uses by default. You can switch models anytime in chat.'
              : 'Connect a provider first to see available models.'}
          </Text>
        </View>

        {/* Model list grouped by provider */}
        {hasModels && grouped.map(([providerID, models]) => (
          <View key={providerID} style={{ marginBottom: 16 }}>
            <Text style={{ fontSize: 11, fontFamily: 'Roobert-Medium', color: colors.muted, letterSpacing: 1, textTransform: 'uppercase', paddingLeft: 4, marginBottom: 8 }}>
              {PROVIDER_LABELS[providerID] || providerID}
            </Text>
            {models.map((model) => {
              const isSelected = selected?.providerID === model.providerID && selected?.modelID === model.modelID;
              return (
                <Pressable
                  key={`${model.providerID}:${model.modelID}`}
                  onPress={() => handleSelect(model)}
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    paddingHorizontal: 14,
                    paddingVertical: 12,
                    borderRadius: 14,
                    borderWidth: 1,
                    borderColor: isSelected
                      ? (isDark ? 'rgba(248,248,248,0.2)' : 'rgba(18,18,21,0.2)')
                      : colors.cardBorder,
                    backgroundColor: isSelected
                      ? (isDark ? 'rgba(248,248,248,0.04)' : 'rgba(18,18,21,0.02)')
                      : colors.cardBg,
                    marginBottom: 6,
                  }}
                >
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 14, fontFamily: 'Roobert-Medium', color: isDark ? 'rgba(248,248,248,0.8)' : 'rgba(18,18,21,0.8)' }} numberOfLines={1}>
                      {model.modelName}
                    </Text>
                    <Text style={{ fontSize: 11, fontFamily: 'Roobert', color: isDark ? 'rgba(248,248,248,0.3)' : 'rgba(18,18,21,0.3)', marginTop: 1 }} numberOfLines={1}>
                      {model.modelID}
                    </Text>
                  </View>
                  {isSelected && <Check size={16} color="#34D399" strokeWidth={2.5} />}
                </Pressable>
              );
            })}
          </View>
        ))}
      </ScrollView>

      {/* Sticky bottom buttons */}
      <View style={{ position: 'absolute', bottom: 0, left: 0, right: 0, gap: 10 }}>
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
            {selected ? 'Continue' : 'Skip for now'}
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

export function SetupWizard({ onComplete }: SetupWizardProps) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const insets = useSafeAreaInsets();
  const themeColors = useThemeColors();
  const { sandboxUrl } = useSandboxContext();

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
          {step === 1 && <ProviderStep onContinue={() => setStep(2)} isDark={isDark} themeColors={themeColors} />}
          {step === 2 && <DefaultModelStep onContinue={() => setStep(3)} onBack={() => setStep(1)} isDark={isDark} themeColors={themeColors} />}
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
