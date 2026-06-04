/**
 * ExportTranscriptSheet — bottom sheet for exporting session transcript as Markdown.
 * Ported from web's ExportTranscriptDialog.
 */
import React, { forwardRef, useMemo, useState, useCallback } from 'react';
import { View, TouchableOpacity, Switch, Platform, ActivityIndicator } from 'react-native';
import { Text } from '@/components/ui/text';
import {
  BottomSheetModal,
  BottomSheetBackdrop,
  BottomSheetView,
} from '@gorhom/bottom-sheet';
import type { BottomSheetBackdropProps } from '@gorhom/bottom-sheet';
import { useColorScheme } from 'nativewind';
import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import * as Haptics from 'expo-haptics';
import { getSheetBg } from '@/lib/theme-colors';

import { useSyncStore } from '@/lib/opencode/sync-store';
import { useSession } from '@/lib/platform/hooks';
import { useSandboxContext } from '@/contexts/SandboxContext';
import {
  formatTranscript,
  getTranscriptFilename,
  DEFAULT_TRANSCRIPT_OPTIONS,
  type TranscriptOptions,
} from '@/lib/transcript';

interface ExportTranscriptSheetProps {
  sessionId: string | null;
}

export const ExportTranscriptSheet = forwardRef<BottomSheetModal, ExportTranscriptSheetProps>(
  function ExportTranscriptSheet({ sessionId }, ref) {
    const { colorScheme } = useColorScheme();
    const isDark = colorScheme === 'dark';
    const { sandboxUrl } = useSandboxContext();

    const [options, setOptions] = useState<TranscriptOptions>(DEFAULT_TRANSCRIPT_OPTIONS);
    const [copied, setCopied] = useState(false);
    const [sharing, setSharing] = useState(false);

    // Session info
    const { data: session } = useSession(sandboxUrl, sessionId || '');

    // Messages from sync store
    const messages = useSyncStore((s: any) => sessionId ? s.messages[sessionId] : undefined);

    // Build transcript
    const transcript = useMemo(() => {
      if (!session || !messages || !Array.isArray(messages) || messages.length === 0) return '';
      return formatTranscript(
        {
          id: session.id,
          title: session.title || 'Untitled',
          time: session.time,
        },
        messages,
        options,
      );
    }, [session, messages, options]);

    const filename = useMemo(() => {
      if (!session) return 'session.md';
      return getTranscriptFilename(session.id, session.title);
    }, [session]);

    const wordCount = useMemo(() => {
      if (!transcript) return 0;
      return transcript.split(/\s+/).filter(Boolean).length;
    }, [transcript]);

    const messageCount = Array.isArray(messages) ? messages.length : 0;

    // Copy to clipboard
    const handleCopy = useCallback(async () => {
      if (!transcript) return;
      await Clipboard.setStringAsync(transcript);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }, [transcript]);

    // Share as .md file
    const handleShare = useCallback(async () => {
      if (!transcript) return;
      setSharing(true);
      try {
        const fileUri = `${FileSystem.cacheDirectory}${filename}`;
        await FileSystem.writeAsStringAsync(fileUri, transcript, { encoding: FileSystem.EncodingType.UTF8 });
        await Sharing.shareAsync(fileUri, {
          mimeType: 'text/markdown',
          dialogTitle: 'Export transcript',
          UTI: 'net.daringfireball.markdown',
        });
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        (ref as React.RefObject<BottomSheetModal>)?.current?.dismiss();
      } catch {
        // User cancelled share or error
      } finally {
        setSharing(false);
      }
    }, [transcript, filename, ref]);

    const toggleOption = useCallback((key: keyof TranscriptOptions) => {
      setOptions((prev) => ({ ...prev, [key]: !prev[key] }));
    }, []);

    const renderBackdrop = useMemo(
      () => (props: BottomSheetBackdropProps) => (
        <BottomSheetBackdrop {...props} appearsOnIndex={0} disappearsOnIndex={-1} opacity={0.35} />
      ),
      [],
    );

    const bg = isDark ? '#161618' : '#FFFFFF';
    const fg = isDark ? '#e4e4e7' : '#18181b';
    const muted = isDark ? '#71717a' : '#a1a1aa';
    const cardBg = isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.03)';
    const border = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)';
    const trackColor = { false: isDark ? '#3f3f46' : '#d4d4d8', true: isDark ? '#4ade80' : '#16a34a' };

    return (
      <BottomSheetModal
        ref={ref}
        enableDynamicSizing
        enablePanDownToClose
        handleIndicatorStyle={{
          backgroundColor: isDark ? '#3F3F46' : '#D4D4D8',
          width: 36,
          height: 5,
          borderRadius: 3,
        }}
        backgroundStyle={{
          backgroundColor: getSheetBg(isDark),
          borderTopLeftRadius: 24,
          borderTopRightRadius: 24,
        }}
        backdropComponent={renderBackdrop}
      >
        <BottomSheetView style={{ paddingHorizontal: 24, paddingBottom: Platform.OS === 'ios' ? 40 : 24 }}>
          {/* Title */}
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 16 }}>
            <Ionicons name="download-outline" size={18} color={fg} />
            <Text style={{ fontSize: 18, fontFamily: 'Roobert-SemiBold', color: fg }}>
              Export Transcript
            </Text>
          </View>

          {/* Description */}
          <Text style={{ fontSize: 13, fontFamily: 'Roobert', color: muted, lineHeight: 18, marginBottom: 16 }}>
            Export this session as a Markdown file. Configure what to include below.
          </Text>

          {/* Options */}
          <View style={{ gap: 8, marginBottom: 16 }}>
            <OptionRow
              icon="person-outline"
              label="Assistant metadata"
              value={options.assistantMetadata}
              onToggle={() => toggleOption('assistantMetadata')}
              isDark={isDark}
              fg={fg}
              muted={muted}
              cardBg={cardBg}
              border={border}
              trackColor={trackColor}
            />
            <OptionRow
              icon="build-outline"
              label="Tool call details"
              value={options.toolDetails}
              onToggle={() => toggleOption('toolDetails')}
              isDark={isDark}
              fg={fg}
              muted={muted}
              cardBg={cardBg}
              border={border}
              trackColor={trackColor}
            />
            <OptionRow
              icon="bulb-outline"
              label="Thinking / reasoning"
              value={options.thinking}
              onToggle={() => toggleOption('thinking')}
              isDark={isDark}
              fg={fg}
              muted={muted}
              cardBg={cardBg}
              border={border}
              trackColor={trackColor}
            />
          </View>

          {/* Stats */}
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
              backgroundColor: cardBg,
              borderRadius: 10,
              borderWidth: 1,
              borderColor: border,
              paddingHorizontal: 12,
              paddingVertical: 10,
              marginBottom: 20,
            }}
          >
            <Text style={{ fontSize: 12, fontFamily: 'Roobert', color: muted }}>
              {messageCount} message{messageCount !== 1 ? 's' : ''} · ~{wordCount.toLocaleString()} words
            </Text>
            <Text style={{ fontSize: 11, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', color: muted }}>
              {filename}
            </Text>
          </View>

          {/* Action buttons */}
          <View style={{ flexDirection: 'row', gap: 10 }}>
            {/* Copy */}
            <TouchableOpacity
              onPress={handleCopy}
              disabled={!transcript}
              activeOpacity={0.7}
              style={{
                flex: 1,
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 6,
                paddingVertical: 12,
                borderRadius: 9999,
                borderWidth: 1,
                borderColor: border,
                backgroundColor: cardBg,
                opacity: transcript ? 1 : 0.4,
              }}
            >
              <Ionicons
                name={copied ? 'checkmark' : 'copy-outline'}
                size={16}
                color={copied ? (isDark ? '#4ade80' : '#16a34a') : fg}
              />
              <Text style={{ fontSize: 14, fontFamily: 'Roobert-Medium', color: copied ? (isDark ? '#4ade80' : '#16a34a') : fg }}>
                {copied ? 'Copied' : 'Copy'}
              </Text>
            </TouchableOpacity>

            {/* Share / Download */}
            <TouchableOpacity
              onPress={handleShare}
              disabled={!transcript || sharing}
              activeOpacity={0.7}
              style={{
                flex: 1,
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 6,
                paddingVertical: 12,
                borderRadius: 9999,
                backgroundColor: fg,
                opacity: transcript && !sharing ? 1 : 0.4,
              }}
            >
              {sharing ? (
                <ActivityIndicator size="small" color={bg} />
              ) : (
                <>
                  <Ionicons name="share-outline" size={16} color={bg} />
                  <Text style={{ fontSize: 14, fontFamily: 'Roobert-Medium', color: bg }}>
                    Share .md
                  </Text>
                </>
              )}
            </TouchableOpacity>
          </View>
        </BottomSheetView>
      </BottomSheetModal>
    );
  },
);

// ─── Option row ─────────────────────────────────────────────────────────────

function OptionRow({
  icon,
  label,
  value,
  onToggle,
  isDark,
  fg,
  muted,
  cardBg,
  border,
  trackColor,
}: {
  icon: string;
  label: string;
  value: boolean;
  onToggle: () => void;
  isDark: boolean;
  fg: string;
  muted: string;
  cardBg: string;
  border: string;
  trackColor: { false: string; true: string };
}) {
  return (
    <TouchableOpacity
      onPress={onToggle}
      activeOpacity={0.7}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: cardBg,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: border,
        paddingHorizontal: 12,
        paddingVertical: 10,
      }}
    >
      <Ionicons name={icon as any} size={15} color={muted} style={{ marginRight: 10 }} />
      <Text style={{ flex: 1, fontSize: 14, fontFamily: 'Roobert', color: fg }}>{label}</Text>
      <Switch
        value={value}
        onValueChange={onToggle}
        trackColor={trackColor}
        thumbColor="#FFFFFF"
        style={{ transform: [{ scale: 0.8 }] }}
      />
    </TouchableOpacity>
  );
}
