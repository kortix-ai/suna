import React, { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { View, StyleSheet, useWindowDimensions } from 'react-native';
import { Text } from '@/components/ui/text';
import { Button } from '@/components/ui/button';
import { InfinityIcon, InfoIcon, CaretLeftIcon, CheckIcon } from '@/lib/icons';
import Svg, { Line } from 'react-native-svg';
import { BottomSheetModal, BottomSheetScrollView } from '@gorhom/bottom-sheet';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { THEME, withAlpha } from '@/lib/utils/theme';
import { SheetBackdrop, KortixBottomSheetModal } from '@/components/kortix/sheet';
import type { Command } from '@/lib/session/runtime-data';

// ─── AutoContinue configuration (shared with frontend) ────────────────────────

export type AutoContinueMode = 'autowork' | 'autowork1' | 'autowork2' | 'autowork3';

interface AutoContinueAlgorithm {
  id: AutoContinueMode;
  label: string;
  role: string;
  description: string;
  commandName: string;
  bestFor: string;
  strengths: string[];
  weaknesses: string[];
  howItWorks: string;
}

const AUTOCONTINUE_ALGORITHMS: AutoContinueAlgorithm[] = [
  {
    id: 'autowork',
    label: 'Kraemer',
    role: 'Connector',
    description: 'Fast TDD loop — reliable for clear specs',
    commandName: 'autowork',
    bestFor: 'Clear specs, coding tasks, "just build it" work',
    strengths: [
      'Reliable and balanced speed/cost',
      'Solid TDD discipline — writes tests first, implements, verifies',
      'No overhead from extra validation passes',
    ],
    weaknesses: [
      'Can miss subtle edge cases that need deeper second-pass reasoning',
      'No adversarial self-review — trusts its own DONE claim',
    ],
    howItWorks:
      'The original autowork algorithm. Runs an autonomous loop where the agent works until it emits DONE, then enters a verification phase where it self-reviews and emits VERIFIED. Simple binary loop — no staged validators, no critic, no phase system.',
  },
  {
    id: 'autowork1',
    label: 'Kubet',
    role: 'Validator',
    description: 'Adversarial review — catches hidden issues',
    commandName: 'autowork1',
    bestFor: 'Correctness-critical tasks — ops planning, complex logic, risk analysis',
    strengths: [
      'Catches hidden issues through forced adversarial self-review',
      'Most reliable outcomes across all task types',
      '3-level validator pipeline ensures nothing slips through',
      'Async process critic monitors efficiency during work',
    ],
    weaknesses: [
      'Slower and more expensive due to validation passes',
      'May over-engineer simple tasks that do not need 3 levels of review',
    ],
    howItWorks:
      'After the agent claims DONE, the system drives it through a 3-level validator pipeline. Level 1 (Format) — Are all files valid? Does the build pass? Any syntax errors? Level 2 (Quality) — Do tests pass? Are requirements traced? Any anti-patterns? Level 3 (Top-notch) — Adversarial edge cases, performance review, regression sweep. The agent must pass each level before advancing. An async critic also nudges the agent if it stalls.',
  },
  {
    id: 'autowork2',
    label: 'Ino',
    role: 'Decomposer',
    description: 'Kanban cards — structured per-module work',
    commandName: 'autowork2',
    bestFor: 'Multi-domain tasks — investigations, audits, research, modular systems',
    strengths: [
      'Strong structured breakdown into discrete work units',
      'Each card goes through its own review/test cycle',
      'Thorough coverage of individual domains',
    ],
    weaknesses: [
      'Can underscope if it misses cards for certain requirements',
      'Integration mistakes between independently built parts',
      'Most expensive due to per-card overhead',
    ],
    howItWorks:
      'Work is organized as a kanban board with explicit prefixes: [BACKLOG], [IN PROGRESS], [REVIEW], [TESTING], [DONE]. Cards advance sequentially and the system enforces progress markers. After all cards hit [DONE], a final integration check runs.',
  },
  {
    id: 'autowork3',
    label: 'Saumya',
    role: 'Architect',
    description: 'Entropy search — diverge then compress',
    commandName: 'autowork3',
    bestFor: 'Design, strategy, architecture — problems with ambiguity',
    strengths: [
      'Fastest and cheapest across all tasks',
      'Produces clean, well-architected solutions',
      'Genuine strategic exploration — not fake variations',
    ],
    weaknesses: [
      'Implementation detail correctness can slip',
      'Upfront exploration adds no value on spec-driven tasks',
      'Tests may validate components without catching integration bugs',
    ],
    howItWorks:
      'Uses five entropy-phased stages: EXPAND (diverge problem framings), BRANCH (crystallize distinct candidates), ATTACK (candidates cross-attack), RANK (score + pick one path), COMPRESS (execute winner with TDD). Phase markers ensure it does not converge early.',
  },
];

const DEFAULT_AUTOCONTINUE_MODE: AutoContinueMode = 'autowork';

export function useAutoContinue(commands: Command[], onCommand?: (command: Command, args?: string) => void) {
  const [mode, setMode] = useState<AutoContinueMode | null>(null);
  const algorithms = useMemo(() => AUTOCONTINUE_ALGORITHMS.filter((alg) =>
    Array.isArray(commands) && commands.some((c) => c.name === alg.commandName)), [commands]);
  const current = useMemo(() => algorithms.find((alg) => alg.id === mode) || null, [algorithms, mode]);
  useEffect(() => { if (mode && !current) setMode(null); }, [mode, current]);
  const dispatch = (text: string) => {
    if (!mode || !onCommand) return false;
    const alg = AUTOCONTINUE_ALGORITHMS.find((a) => a.id === mode);
    const command = alg && commands.find((c) => c.name === alg.commandName);
    if (!command) return false;
    onCommand(command, text || undefined);
    return true;
  };
  return { mode, setMode, algorithms, current, dispatch };
}

function InfinityOffIcon({ color, size }: { color: string; size: number }) {
  return (
    <View style={{ width: size, height: size }}>
      <InfinityIcon color={color} size={size} />
      <Svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        style={{ position: 'absolute', left: 0, top: 0 }}
      >
        <Line x1={22} y1={2} x2={2} y2={22} stroke={color} strokeWidth={2} strokeLinecap="round" />
      </Svg>
    </View>
  );
}

export interface AutoContinueSheetProps {
  visible: boolean;
  onClose: () => void;
  selected: AutoContinueMode | null;
  onSelect: (mode: AutoContinueMode | null) => void;
  algorithms: AutoContinueAlgorithm[];
  isDark: boolean;
}

/** Memoized: the composer around it re-renders on every keystroke and passes stable props. */
export const AutoContinueSheet = React.memo(function AutoContinueSheet({
  visible,
  onClose,
  selected,
  onSelect,
  algorithms,
  isDark,
}: AutoContinueSheetProps) {
  const insets = useSafeAreaInsets();
  const [detailAlg, setDetailAlg] = useState<AutoContinueAlgorithm | null>(null);
  const isActive = selected !== null;
  const currentAlg = algorithms.find((alg) => alg.id === selected) || null;
  const defaultMode = useMemo(() => {
    const preferred = algorithms.find((alg) => alg.id === DEFAULT_AUTOCONTINUE_MODE);
    return preferred?.id ?? algorithms[0]?.id ?? null;
  }, [algorithms]);

  const { height: screenHeight } = useWindowDimensions();
  const muted = isDark ? THEME.dark.mutedForeground : THEME.light.mutedForeground;
  const border = isDark ? withAlpha(THEME.dark.foreground, 0.1) : withAlpha(THEME.light.foreground, 0.08);

  // Bridge `visible` prop to the imperative BottomSheetModal API.
  const sheetRef = useRef<BottomSheetModal>(null);
  const dismissingRef = useRef(false);

  useEffect(() => {
    if (visible) {
      dismissingRef.current = false;
      sheetRef.current?.present();
    } else {
      dismissingRef.current = true;
      sheetRef.current?.dismiss();
    }
  }, [visible]);

  const handleSheetDismiss = useCallback(() => {
    if (!dismissingRef.current) onClose();
    dismissingRef.current = false;
  }, [onClose]);


  useEffect(() => {
    if (!visible) {
      setDetailAlg(null);
    }
  }, [visible]);

  if (algorithms.length === 0) return null;

  return (
    <KortixBottomSheetModal
      ref={sheetRef}
      enableDynamicSizing
      maxDynamicContentSize={Math.floor(screenHeight * 0.86)}
      enablePanDownToClose={!detailAlg}
      enableOverDrag={false}
      onDismiss={handleSheetDismiss}
      backdropComponent={(p) => <SheetBackdrop {...p} opacity={0.4} />}
    >
      {detailAlg ? (
        /* Detail view — algorithm deep-dive with its own scroller. */
        <BottomSheetScrollView
          contentContainerStyle={{ paddingBottom: insets.bottom + 16 }}
          showsVerticalScrollIndicator={false}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', paddingTop: 6, paddingHorizontal: 20, paddingBottom: 12 }}>
            <Button
              variant="ghost"
              className="h-auto w-auto gap-0 rounded-full p-0 active:bg-transparent active:opacity-20"
              onPress={() => setDetailAlg(null)}
              hitSlop={12}
              accessibilityLabel="Back"
              style={{ marginRight: 12 }}
            >
              <CaretLeftIcon size={22} color={muted} />
            </Button>
            <Text style={{ fontSize: 18, fontFamily: 'Roobert-SemiBold', color: isDark ? THEME.dark.foreground : THEME.light.foreground }}>
              {detailAlg.label}
            </Text>
            <Button
              variant="ghost"
              className="h-auto w-auto gap-0 rounded-md p-0 active:bg-transparent active:opacity-20"
              onPress={() => {
                onSelect(detailAlg.id);
                setDetailAlg(null);
                onClose();
              }}
              style={{ marginLeft: 'auto', flexDirection: 'row', alignItems: 'center', gap: 4 }}
              hitSlop={10}
            >
              <Text style={{ color: THEME.accent.purple, fontFamily: 'Roobert-Medium', fontSize: 13 }}>
                Use
              </Text>
              <CheckIcon size={18} color={THEME.accent.purple} />
            </Button>
          </View>

          <View style={{ paddingHorizontal: 20 }}>
            <Text style={{ color: muted, fontSize: 13, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8 }}>
              Role
            </Text>
            <Text style={{ fontSize: 14, marginBottom: 16, color: isDark ? THEME.dark.foreground : THEME.light.foreground }}>
              {detailAlg.role}
            </Text>

            <Text style={{ color: muted, fontSize: 13, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8 }}>
              Description
            </Text>
            <Text style={{ fontSize: 14, color: isDark ? THEME.dark.mutedForeground : THEME.light.mutedForeground, marginBottom: 16 }}>
              {detailAlg.description}
            </Text>

            <Text style={{ color: muted, fontSize: 13, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8 }}>
              Best for
            </Text>
            <Text style={{ fontSize: 14, color: isDark ? THEME.dark.mutedForeground : THEME.light.mutedForeground, marginBottom: 16 }}>
              {detailAlg.bestFor}
            </Text>

            <View style={{ flexDirection: 'row', marginTop: 4 }}>
              <View style={{ flex: 1, marginRight: 12 }}>
                <Text style={{ color: muted, fontSize: 13, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8 }}>
                  Strengths
                </Text>
                {detailAlg.strengths.map((s, idx) => (
                  <Text key={idx} style={{ fontSize: 13, color: THEME.accent.green, marginBottom: 6 }}>
                    • {s}
                  </Text>
                ))}
              </View>
              <View style={{ flex: 1, marginLeft: 12 }}>
                <Text style={{ color: muted, fontSize: 13, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8 }}>
                  Weaknesses
                </Text>
                {detailAlg.weaknesses.map((s, idx) => (
                  <Text key={idx} style={{ fontSize: 13, color: THEME.accent.orange, marginBottom: 6 }}>
                    • {s}
                  </Text>
                ))}
              </View>
            </View>

            <Text style={{ color: muted, fontSize: 13, textTransform: 'uppercase', letterSpacing: 1, marginTop: 20, marginBottom: 8 }}>
              How it works
            </Text>
            <Text style={{ fontSize: 13, lineHeight: 20, color: isDark ? THEME.dark.mutedForeground : THEME.light.mutedForeground }}>
              {detailAlg.howItWorks}
            </Text>
          </View>
        </BottomSheetScrollView>
      ) : (
        /* List view — Off / On toggle + algorithm list. Top-level scroller so
           scroll gestures actually work inside the sheet. */
        <BottomSheetScrollView
          contentContainerStyle={{ paddingBottom: insets.bottom + 12 }}
          showsVerticalScrollIndicator={false}
        >
        {/* Header — drag handle + backdrop tap dismiss, no explicit close. */}
        <View style={{ paddingHorizontal: 20, paddingTop: 6, paddingBottom: 12 }}>
          <Text style={{ fontSize: 18, fontFamily: 'Roobert-SemiBold', color: isDark ? THEME.dark.foreground : THEME.light.foreground }}>
            AutoContinue
          </Text>
        </View>

        <View>
          <View>
            <Button
              variant="ghost"
              className="h-auto w-full gap-0 rounded-none justify-start p-0 active:bg-transparent active:opacity-70"
              onPress={() => { onSelect(null); onClose(); }}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                paddingVertical: 14,
                paddingHorizontal: 20,
                backgroundColor: !isActive ? (isDark ? withAlpha(THEME.dark.foreground, 0.04) : withAlpha(THEME.light.foreground, 0.03)) : 'transparent',
              }}
            >
              <InfinityOffIcon color={muted} size={18} />
              <View style={{ marginLeft: 12, flex: 1 }}>
                <Text style={{ fontSize: 15, fontFamily: 'Roobert-Medium', color: isDark ? THEME.dark.foreground : THEME.light.foreground }}>
                  Off
                </Text>
                <Text style={{ fontSize: 13, color: muted, marginTop: 2 }}>
                  Manual — you send each message
                </Text>
              </View>
              {!isActive && <CheckIcon size={18} color={THEME.accent.purple} />}
            </Button>

            <Button
              variant="ghost"
              className="h-auto w-full gap-0 rounded-none justify-start p-0 active:bg-transparent active:opacity-70"
              onPress={() => {
                if (!isActive && defaultMode) {
                  onSelect(defaultMode);
                }
              }}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                paddingVertical: 14,
                paddingHorizontal: 20,
                backgroundColor: isActive ? withAlpha(THEME.accent.purple, 0.08) : 'transparent',
              }}
            >
              <InfinityIcon color={isActive ? (THEME.accent.purple) : muted} size={18} />
              <View style={{ marginLeft: 12, flex: 1 }}>
                <Text style={{ fontSize: 15, fontFamily: 'Roobert-Medium', color: isDark ? THEME.dark.foreground : THEME.light.foreground }}>
                  On
                </Text>
                <Text style={{ fontSize: 13, color: muted, marginTop: 2 }}>
                  {isActive && currentAlg
                    ? `Running ${currentAlg.label}`
                    : 'Pick an algorithm and the agent will continue on its own'}
                </Text>
              </View>
              {isActive && <CheckIcon size={18} color={THEME.accent.purple} />}
            </Button>
          </View>

          <View style={{ marginTop: 20, paddingHorizontal: 20 }}>
            <Text style={{ fontSize: 13, color: muted, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8 }}>
              Algorithms
            </Text>
          </View>

          {algorithms.map((alg, idx) => {
            const isSelected = selected === alg.id;
            return (
              <Button
                key={alg.id}
                variant="ghost"
                className="h-auto w-full gap-0 rounded-none justify-start p-0 active:bg-transparent active:opacity-70"
                onPress={() => {
                  onSelect(alg.id);
                  onClose();
                }}
                style={{
                  paddingVertical: 14,
                  paddingHorizontal: 20,
                  borderBottomWidth: idx < algorithms.length - 1 ? StyleSheet.hairlineWidth : 0,
                  borderBottomColor: border,
                  backgroundColor: isSelected ? (isDark ? withAlpha(THEME.dark.foreground, 0.04) : withAlpha(THEME.accent.purple, 0.07)) : 'transparent',
                }}
              >
                <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 15, fontFamily: 'Roobert-Medium', color: isDark ? THEME.dark.foreground : THEME.light.foreground }}>
                      {alg.label}
                    </Text>
                    <Text style={{ fontSize: 13, color: muted, marginTop: 1 }}>
                      {alg.role}
                    </Text>
                    <Text style={{ fontSize: 13, color: isDark ? THEME.dark.mutedForeground : THEME.light.mutedForeground, marginTop: 6 }} numberOfLines={1}>
                      {alg.description}
                    </Text>
                  </View>
                  <Button
                    variant="ghost"
                    className="h-auto w-auto gap-0 rounded-md p-0 active:bg-transparent active:opacity-20"
                    hitSlop={10}
                    accessibilityLabel={`About ${alg.label}`}
                    onPress={() => setDetailAlg(alg)}
                    style={{ padding: 6, marginHorizontal: 4 }}
                  >
                    <InfoIcon size={18} color={muted} />
                  </Button>
                  {isSelected && (
                    <CheckIcon size={18} color={THEME.accent.purple} />
                  )}
                </View>
              </Button>
            );
          })}
        </View>
        </BottomSheetScrollView>
      )}
    </KortixBottomSheetModal>
  );
});

