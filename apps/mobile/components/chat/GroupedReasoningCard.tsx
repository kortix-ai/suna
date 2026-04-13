/**
 * GroupedReasoningCard — groups consecutive reasoning parts into a single
 * minimal collapsible card. Ported from web commit 38e2d41.
 *
 * Shows:
 * - Brain icon (animated when streaming)
 * - Preview headline (first bold or first sentence from any reasoning block)
 * - Aggregate duration (live timer while streaming, or total ms when done)
 * - Part count badge (e.g. "3x") when grouping multiple parts
 * - Loader spinner while streaming
 * - Chevron
 *
 * Expanded view uses a left-border thread style with subtle separators
 * between blocks.
 */

import React, { useState, useEffect, useMemo } from 'react';
import { View, Pressable, LayoutAnimation, Platform, UIManager, Text as RNText } from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withRepeat,
  withTiming,
  withSequence,
  Easing,
  FadeIn,
  FadeOut,
} from 'react-native-reanimated';
import { Brain, ChevronRight, Loader2 } from 'lucide-react-native';
import { Icon } from '@/components/ui/icon';
import { useColorScheme } from 'nativewind';
import { SelectableMarkdownText } from '@/components/ui/selectable-markdown';
import type { ReasoningPart } from '@/lib/opencode/types';

if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

interface GroupedReasoningCardProps {
  parts: ReasoningPart[];
  isStreaming?: boolean;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const remaining = Math.round(seconds % 60);
  return `${minutes}m ${remaining}s`;
}

export function GroupedReasoningCard({ parts, isStreaming = false }: GroupedReasoningCardProps) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const [open, setOpen] = useState(false);
  const [streamSeconds, setStreamSeconds] = useState(0);

  // Determine if the last part is still streaming
  const lastPart = parts[parts.length - 1];
  const lastEnd = (lastPart as any)?.time?.end;
  const reasoningStreaming = isStreaming && !(typeof lastEnd === 'number' && lastEnd > 0);

  // Find the earliest start for the live timer
  const earliestStart = useMemo(() => {
    let earliest: number | undefined;
    for (const p of parts) {
      const s = (p as any).time?.start;
      if (typeof s === 'number' && (earliest === undefined || s < earliest)) earliest = s;
    }
    return earliest;
  }, [parts]);

  // Live timer while streaming
  useEffect(() => {
    if (!reasoningStreaming || typeof earliestStart !== 'number') {
      setStreamSeconds(0);
      return;
    }
    const update = () =>
      setStreamSeconds(Math.max(0, Math.round((Date.now() - earliestStart) / 1000)));
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [reasoningStreaming, earliestStart]);

  // Aggregate total duration across all completed parts
  const totalDuration = useMemo(() => {
    let total = 0;
    let any = false;
    for (const p of parts) {
      const s = (p as any).time?.start;
      const e = (p as any).time?.end;
      if (typeof s === 'number' && typeof e === 'number' && e > s) {
        total += e - s;
        any = true;
      }
    }
    return any ? total : undefined;
  }, [parts]);

  // Build one-line preview from first non-empty reasoning block
  const preview = useMemo(() => {
    for (const p of parts) {
      const t = p.text?.trim();
      if (t) {
        const boldMatch = t.match(/\*\*(.+?)\*\*/);
        if (boldMatch) return boldMatch[1];
        const firstLine = t.split('\n')[0].replace(/^#+\s*/, '');
        return firstLine.length > 80 ? firstLine.slice(0, 77) + '…' : firstLine;
      }
    }
    return '';
  }, [parts]);

  const nonEmptyParts = useMemo(() => parts.filter((p) => p.text?.trim()), [parts]);

  // Heartbeat pulse for the Brain icon while streaming
  const pulse = useSharedValue(1);
  useEffect(() => {
    if (reasoningStreaming) {
      pulse.value = withRepeat(
        withSequence(
          withTiming(0.4, { duration: 700, easing: Easing.inOut(Easing.ease) }),
          withTiming(1, { duration: 700, easing: Easing.inOut(Easing.ease) }),
        ),
        -1,
        false,
      );
    } else {
      pulse.value = withTiming(1, { duration: 200 });
    }
  }, [reasoningStreaming, pulse]);
  const pulseStyle = useAnimatedStyle(() => ({ opacity: pulse.value }));

  // Spinner rotation while streaming
  const spin = useSharedValue(0);
  useEffect(() => {
    if (reasoningStreaming) {
      spin.value = withRepeat(
        withTiming(360, { duration: 1000, easing: Easing.linear }),
        -1,
        false,
      );
    } else {
      spin.value = 0;
    }
  }, [reasoningStreaming, spin]);
  const spinStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${spin.value}deg` }],
  }));

  // Chevron rotation
  const chevronRotation = useSharedValue(0);
  useEffect(() => {
    chevronRotation.value = withTiming(open ? 90 : 0, {
      duration: 200,
      easing: Easing.inOut(Easing.ease),
    });
  }, [open]);
  const chevronStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${chevronRotation.value}deg` }],
  }));

  if (nonEmptyParts.length === 0) return null;

  const mutedColor = isDark ? 'rgba(248,248,248,0.5)' : 'rgba(18,18,21,0.5)';
  const mutedStrongColor = isDark ? 'rgba(248,248,248,0.7)' : 'rgba(18,18,21,0.7)';
  const borderColor = isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)';

  const handleToggle = () => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setOpen(!open);
  };

  return (
    <Animated.View entering={FadeIn.duration(150)} className="w-full">
      {/* Minimal trigger row — matches web's design */}
      <Pressable
        onPress={handleToggle}
        hitSlop={{ top: 6, bottom: 6, left: 4, right: 4 }}
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 8,
          paddingHorizontal: 8,
          paddingVertical: 4,
          borderRadius: 6,
        }}
      >
        <Animated.View style={pulseStyle}>
          <Icon as={Brain} size={13} color={mutedColor} strokeWidth={2} />
        </Animated.View>

        {/* Preview text or "Reasoning" fallback */}
        <RNText
          numberOfLines={1}
          style={{
            flex: 1,
            fontSize: 12,
            fontFamily: 'Roobert-Regular',
            color: mutedColor,
          }}
        >
          {preview || 'Reasoning'}
        </RNText>

        {/* Duration badge — live timer or total */}
        {reasoningStreaming ? (
          <RNText
            style={{
              fontSize: 10,
              fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
              color: mutedColor,
            }}
          >
            {streamSeconds}s
          </RNText>
        ) : totalDuration ? (
          <RNText
            style={{
              fontSize: 10,
              fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
              color: mutedColor,
            }}
          >
            {formatDuration(totalDuration)}
          </RNText>
        ) : null}

        {/* Count badge when grouping multiple */}
        {nonEmptyParts.length > 1 && (
          <RNText
            style={{
              fontSize: 10,
              fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
              color: mutedColor,
              opacity: 0.7,
            }}
          >
            {nonEmptyParts.length}x
          </RNText>
        )}

        {/* Loading spinner while streaming */}
        {reasoningStreaming && (
          <Animated.View style={spinStyle}>
            <Icon as={Loader2} size={11} color={mutedColor} strokeWidth={2} />
          </Animated.View>
        )}

        {/* Chevron */}
        <Animated.View style={chevronStyle}>
          <Icon as={ChevronRight} size={11} color={mutedColor} strokeWidth={2} />
        </Animated.View>
      </Pressable>

      {/* Expanded content — left-border thread style */}
      {open && (
        <Animated.View
          entering={FadeIn.duration(200)}
          style={{
            marginLeft: 18,
            marginTop: 2,
            marginBottom: 6,
            paddingLeft: 12,
            borderLeftWidth: 1,
            borderLeftColor: borderColor,
          }}
        >
          {nonEmptyParts.map((p, i) => (
            <View key={p.id ?? i} style={{ marginBottom: i < nonEmptyParts.length - 1 ? 10 : 0 }}>
              <SelectableMarkdownText isDark={isDark}>
                {p.text!}
              </SelectableMarkdownText>
            </View>
          ))}
        </Animated.View>
      )}
    </Animated.View>
  );
}
