/**
 * InstanceOnboarding — Post-wizard agent-driven onboarding flow.
 *
 * Matches the web frontend's onboarding page:
 *   Phase 1 (bios):    Terminal boot sequence
 *   Phase 2 (logo):    Kortix logo + progress bar
 *   Phase 3 (session): Full-screen chat with /onboarding command
 *
 * Env vars persisted to sandbox:
 *   ONBOARDING_SESSION_ID     — session to resume on app restart
 *   ONBOARDING_COMMAND_FIRED  — prevents duplicate /onboarding fires
 *   ONBOARDING_COMPLETE       — polled; agent sets to 'true' when done
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { View, Platform, TouchableOpacity } from 'react-native';
import { Text } from '@/components/ui/text';
import { useColorScheme } from 'nativewind';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  Easing,
  FadeIn,
} from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';

import { KortixLogo } from '@/components/ui/KortixLogo';
import { useSandboxContext } from '@/contexts/SandboxContext';
import { useCreateSession } from '@/lib/platform/hooks';
import { getAuthToken } from '@/api/config';
import { SessionPage } from '@/components/session/SessionPage';
import { log } from '@/lib/logger';

// ─── BIOS lines (matches web frontend) ──────────────────────────────────────

const BIOS_LINES = [
  { text: 'KORTIX BIOS v2.0.1', bold: true },
  { text: '' },
  { text: 'CPU: Kortix Inference Engine X1 @ 3.80 GHz' },
  { text: 'Memory test................. OK' },
  { text: 'Neural cores............... 8/8 online' },
  { text: 'Agent runtime.............. initialized' },
  { text: 'Tool registry.............. 47 tools loaded' },
  { text: 'Secure enclave............. active' },
  { text: 'Mounting workspace......... done' },
  { text: 'Connecting to services..... done' },
  { text: '' },
  { text: 'All systems nominal. Starting KORTIX OS...' },
];

const LINE_DELAY_MS = 160;
const BIOS_AUTO_ADVANCE_MS = 600;
const LOGO_DURATION_MS = 2500;
const LOGO_PHASE_TOTAL_MS = 3400;
const POLL_INTERVAL_MS = 3000;

// ─── Helpers ─────────────────────────────────────────────────────────────────

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

async function readEnv(sandboxUrl: string, key: string): Promise<string | null> {
  try {
    const res = await sandboxFetch(sandboxUrl, `/env/${encodeURIComponent(key)}`);
    if (!res.ok) return null;
    const data = await res.json();
    return data?.[key] ?? null;
  } catch {
    return null;
  }
}

async function writeEnv(sandboxUrl: string, key: string, value: string): Promise<void> {
  try {
    await sandboxFetch(sandboxUrl, `/env/${encodeURIComponent(key)}`, {
      method: 'PUT',
      body: JSON.stringify({ value }),
    });
  } catch {
    // Best effort
  }
}

// ─── Types ───────────────────────────────────────────────────────────────────

type Phase = 'bios' | 'logo' | 'session';

interface InstanceOnboardingProps {
  onComplete: () => void;
}

// ─── BIOS Phase ──────────────────────────────────────────────────────────────

function BiosPhase({ onDone, onSkip }: { onDone: () => void; onSkip: () => void }) {
  const insets = useSafeAreaInsets();
  const [visibleCount, setVisibleCount] = useState(0);

  useEffect(() => {
    const timers: ReturnType<typeof setTimeout>[] = [];
    BIOS_LINES.forEach((_, i) => {
      timers.push(setTimeout(() => setVisibleCount(i + 1), 100 + i * LINE_DELAY_MS));
    });
    // Auto-advance after all lines + pause
    const total = 100 + BIOS_LINES.length * LINE_DELAY_MS + BIOS_AUTO_ADVANCE_MS;
    timers.push(setTimeout(onDone, total));
    return () => timers.forEach(clearTimeout);
  }, [onDone]);

  return (
    <View style={{ flex: 1, backgroundColor: '#09090b', paddingTop: insets.top + 40, paddingHorizontal: 24 }}>
      {BIOS_LINES.slice(0, visibleCount).map((line, i) => (
        <Animated.View key={i} entering={FadeIn.duration(40)}>
          <Text
            style={{
              fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
              fontSize: 12,
              lineHeight: 20,
              color: line.bold ? '#FFFFFF' : 'rgba(248,248,248,0.6)',
              fontWeight: line.bold ? '700' : '400',
            }}
          >
            {line.text || ' '}
          </Text>
        </Animated.View>
      ))}
      <TouchableOpacity
        onPress={onSkip}
        style={{ position: 'absolute', bottom: insets.bottom + 24, alignSelf: 'center', left: 0, right: 0, alignItems: 'center' }}
        hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
      >
        <Text style={{ fontSize: 14, fontFamily: 'Roobert-Medium', color: 'rgba(248,248,248,0.4)' }}>
          Skip onboarding
        </Text>
      </TouchableOpacity>
    </View>
  );
}

// ─── Logo Phase ──────────────────────────────────────────────────────────────

function LogoPhase({ onDone, onSkip }: { onDone: () => void; onSkip: () => void }) {
  const insets = useSafeAreaInsets();
  const progressWidth = useSharedValue(0);

  useEffect(() => {
    const t1 = setTimeout(() => {
      progressWidth.value = withTiming(1, { duration: LOGO_DURATION_MS, easing: Easing.bezierFn(0.16, 1, 0.3, 1) });
    }, 200);
    const t2 = setTimeout(onDone, LOGO_PHASE_TOTAL_MS);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, [onDone]);

  const barStyle = useAnimatedStyle(() => ({
    width: `${progressWidth.value * 100}%`,
  }));

  return (
    <Animated.View entering={FadeIn.duration(800)} style={{ flex: 1, backgroundColor: '#09090b', alignItems: 'center', justifyContent: 'center' }}>
      <KortixLogo size={64} variant="symbol" color="light" />
      {/* Progress bar */}
      <View style={{ width: 120, height: 3, borderRadius: 1.5, backgroundColor: 'rgba(255,255,255,0.1)', marginTop: 28, overflow: 'hidden' }}>
        <Animated.View style={[{ height: 3, borderRadius: 1.5, backgroundColor: '#FFFFFF' }, barStyle]} />
      </View>
      <TouchableOpacity
        onPress={onSkip}
        style={{ position: 'absolute', bottom: insets.bottom + 24 }}
        hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
      >
        <Text style={{ fontSize: 14, fontFamily: 'Roobert-Medium', color: 'rgba(248,248,248,0.4)' }}>
          Skip onboarding
        </Text>
      </TouchableOpacity>
    </Animated.View>
  );
}

// ─── Main Component ──────────────────────────────────────────────────────────

export function InstanceOnboarding({ onComplete }: InstanceOnboardingProps) {
  const { sandboxUrl } = useSandboxContext();
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';

  const [phase, setPhase] = useState<Phase>('bios');
  const [onboardingSessionId, setOnboardingSessionId] = useState<string | null>(null);
  const commandFiredRef = useRef(false);

  const createSession = useCreateSession(sandboxUrl);

  // ── Resume logic: check existing onboarding session on mount ──
  useEffect(() => {
    if (!sandboxUrl) return;
    let cancelled = false;

    (async () => {
      // Check if onboarding already complete
      const complete = await readEnv(sandboxUrl, 'ONBOARDING_COMPLETE');
      if (complete === 'true') {
        if (!cancelled) onComplete();
        return;
      }

      // Check for existing session to resume
      const existingId = await readEnv(sandboxUrl, 'ONBOARDING_SESSION_ID');
      const alreadyFired = await readEnv(sandboxUrl, 'ONBOARDING_COMMAND_FIRED');

      if (existingId && alreadyFired === 'true') {
        // Resume: skip boot sequence, go straight to session
        if (!cancelled) {
          commandFiredRef.current = true;
          setOnboardingSessionId(existingId);
          setPhase('session');
        }
      }
    })();

    return () => { cancelled = true; };
  }, [sandboxUrl, onComplete]);

  // ── Create session & fire /onboarding when entering session phase ──
  const initSession = useCallback(async () => {
    if (!sandboxUrl || onboardingSessionId) return;

    try {
      const session = await createSession.mutateAsync({
        title: 'Kortix Onboarding',
        initialPrompt: '/onboarding',
      });
      setOnboardingSessionId(session.id);
      await writeEnv(sandboxUrl, 'ONBOARDING_SESSION_ID', session.id);

      // Fire /onboarding command
      if (!commandFiredRef.current) {
        commandFiredRef.current = true;
        await writeEnv(sandboxUrl, 'ONBOARDING_COMMAND_FIRED', 'true');

        log.log('[Onboarding] Queued /onboarding as the session ACP initial prompt:', session.id);
      }
    } catch (err: any) {
      log.error('[Onboarding] Session creation failed:', err?.message);
    }
  }, [sandboxUrl, onboardingSessionId, createSession]);

  // When phase transitions to 'session', create session if needed
  useEffect(() => {
    if (phase === 'session' && !onboardingSessionId) {
      initSession();
    }
  }, [phase, onboardingSessionId, initSession]);

  // Note: pending questions are restored by SessionPage's self-heal effect
  // (detects running question tool parts and polls GET /question).

  // ── Poll ONBOARDING_COMPLETE ──
  useEffect(() => {
    if (phase !== 'session' || !sandboxUrl) return;

    const interval = setInterval(async () => {
      const val = await readEnv(sandboxUrl, 'ONBOARDING_COMPLETE');
      if (val === 'true') {
        clearInterval(interval);
        onComplete();
      }
    }, POLL_INTERVAL_MS);

    return () => clearInterval(interval);
  }, [phase, sandboxUrl, onComplete]);

  // ── Skip handler ──
  const handleSkip = useCallback(async () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    if (sandboxUrl) {
      await writeEnv(sandboxUrl, 'ONBOARDING_COMPLETE', 'true');
    }
    onComplete();
  }, [sandboxUrl, onComplete]);

  // ── Phase callbacks ──
  const handleBiosDone = useCallback(() => setPhase('logo'), []);
  const handleLogoDone = useCallback(() => setPhase('session'), []);

  // ── Render ──

  if (phase === 'bios') {
    return <BiosPhase onDone={handleBiosDone} onSkip={handleSkip} />;
  }

  if (phase === 'logo') {
    return <LogoPhase onDone={handleLogoDone} onSkip={handleSkip} />;
  }

  // Session phase
  if (!onboardingSessionId) {
    // Still creating session — show loading
    return (
      <Animated.View entering={FadeIn.duration(400)} style={{ flex: 1, backgroundColor: isDark ? '#09090b' : '#FFFFFF', alignItems: 'center', justifyContent: 'center' }}>
        <KortixLogo size={40} variant="symbol" color={isDark ? 'light' : 'dark'} />
        <Text style={{ marginTop: 16, fontSize: 13, fontFamily: 'Roobert', color: isDark ? 'rgba(248,248,248,0.4)' : 'rgba(18,18,21,0.4)' }}>
          Setting up your workspace…
        </Text>
      </Animated.View>
    );
  }

  return (
    <View style={{ flex: 1 }}>
      <SessionPage
        sessionId={onboardingSessionId}
        onBack={handleSkip}
        onboardingMode
        onSkipOnboarding={handleSkip}
      />
    </View>
  );
}
