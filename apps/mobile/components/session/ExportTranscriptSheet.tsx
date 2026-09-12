/**
 * ExportTranscriptSheet — bottom sheet for exporting session transcript as Markdown.
 * Ported from web's ExportTranscriptDialog.
 */
import React, { forwardRef, useMemo, useState, useCallback } from 'react';
import { View, Platform, ActivityIndicator } from 'react-native';
import { Text } from '@/components/ui/text';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { BottomSheetModal, BottomSheetView } from '@gorhom/bottom-sheet';
import { useColorScheme } from 'nativewind';
import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import * as Haptics from 'expo-haptics';

import { getAuthToken } from '@/api/config';

import { useSyncStore } from '@/lib/opencode/sync-store';
import { useSession } from '@/lib/platform/hooks';
import { useSandboxContext } from '@/contexts/SandboxContext';
import {
  formatTranscript,
  getTranscriptFilename,
  DEFAULT_TRANSCRIPT_OPTIONS,
  loadHttpSessionHistory,
  type TranscriptOptions,
} from '@kortix/sdk';
import { SheetBackdrop, sheetHandleIndicatorStyle, useSheetBackground } from '@/components/kortix/sheet';
import { useThemeColors } from '@/lib/theme-colors';
import { THEME, withAlpha } from '@/lib/utils/theme';

interface ExportTranscriptSheetProps {
  sessionId: string | null;
}

export const ExportTranscriptSheet = forwardRef<BottomSheetModal, ExportTranscriptSheetProps>(
  function ExportTranscriptSheet({ sessionId }, ref) {
    const sheetBg = useSheetBackground();
    const { colorScheme } = useColorScheme();
    const isDark = colorScheme === 'dark';
    const theme = useThemeColors();
    const { sandboxUrl } = useSandboxContext();

    const [options, setOptions] = useState<TranscriptOptions>(DEFAULT_TRANSCRIPT_OPTIONS);
    const [copied, setCopied] = useState(false);
    const [sharing, setSharing] = useState(false);

    // Session info
    const { data: session } = useSession(sandboxUrl, sessionId || '');

    const loadTranscript = useCallback(async () => {
      if (!session || !sessionId || !sandboxUrl) return '';
      const history = await loadHttpSessionHistory({
        baseUrl: sandboxUrl,
        sessionId,
        getToken: getAuthToken,
      });
      return formatTranscript(
        {
          id: session.id,
          title: session.title || 'Untitled',
          time: session.time,
        },
        history,
        options
      );
    }, [options, sandboxUrl, session, sessionId]);

    // Messages from sync store
    const messages = useSyncStore((state) => (sessionId ? state.messages[sessionId] : undefined));

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
        options
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
    const canExport = !!session && !!sessionId && !!sandboxUrl;

    // Copy to clipboard
    const handleCopy = useCallback(async () => {
      setSharing(true);
      try {
        const completeTranscript = await loadTranscript();
        if (!completeTranscript) return;
        await Clipboard.setStringAsync(completeTranscript);
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      } finally {
        setSharing(false);
      }
    }, [loadTranscript]);

    // Share as .md file
    const handleShare = useCallback(async () => {
      setSharing(true);
      try {
        const completeTranscript = await loadTranscript();
        if (!completeTranscript) return;
        const fileUri = `${FileSystem.cacheDirectory}${filename}`;
        await FileSystem.writeAsStringAsync(fileUri, completeTranscript, {
          encoding: FileSystem.EncodingType.UTF8,
        });
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
    }, [filename, loadTranscript, ref]);

    const toggleOption = useCallback((key: keyof TranscriptOptions) => {
      setOptions((prev) => ({ ...prev, [key]: !prev[key] }));
    }, []);


    const fg = isDark ? THEME.dark.foreground : THEME.light.foreground;
    const muted = isDark ? THEME.dark.mutedForeground : THEME.light.mutedForeground;
    const cardBg = isDark ? withAlpha(THEME.dark.foreground, 0.04) : withAlpha(THEME.light.foreground, 0.03);
    const border = isDark ? withAlpha(THEME.dark.foreground, 0.06) : withAlpha(THEME.light.foreground, 0.06);

    return (
      <BottomSheetModal
        ref={ref}
        enableDynamicSizing
        enablePanDownToClose
        handleIndicatorStyle={sheetHandleIndicatorStyle(isDark)}
        backgroundStyle={{
          backgroundColor: sheetBg,
          borderTopLeftRadius: 24,
          borderTopRightRadius: 24,
        }}
        backdropComponent={(p) => <SheetBackdrop {...p} opacity={0.35} />}>
        <BottomSheetView
          style={{ paddingHorizontal: 24, paddingBottom: Platform.OS === 'ios' ? 40 : 24 }}>
          {/* Title */}
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 16 }}>
            <Ionicons name="download-outline" size={18} color={fg} />
            <Text style={{ fontSize: 18, fontFamily: 'Roobert-SemiBold', color: fg }}>
              Export Transcript
            </Text>
          </View>

          {/* Description */}
          <Text
            style={{
              fontSize: 13,
              fontFamily: 'Roobert',
              color: muted,
              lineHeight: 18,
              marginBottom: 16,
            }}>
            Export this session as a Markdown file. Configure what to include below.
          </Text>

          {/* Options */}
          <View style={{ gap: 8, marginBottom: 16 }}>
            <OptionRow
              icon="person-outline"
              label="Assistant metadata"
              value={options.assistantMetadata}
              onToggle={() => toggleOption('assistantMetadata')}
              fg={fg}
              muted={muted}
              cardBg={cardBg}
              border={border}
            />
            <OptionRow
              icon="build-outline"
              label="Tool call details"
              value={options.toolDetails}
              onToggle={() => toggleOption('toolDetails')}
              fg={fg}
              muted={muted}
              cardBg={cardBg}
              border={border}
            />
            <OptionRow
              icon="bulb-outline"
              label="Thinking / reasoning"
              value={options.thinking}
              onToggle={() => toggleOption('thinking')}
              fg={fg}
              muted={muted}
              cardBg={cardBg}
              border={border}
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
            }}>
            <Text style={{ fontSize: 12, fontFamily: 'Roobert', color: muted }}>
              {messageCount} message{messageCount !== 1 ? 's' : ''} · ~{wordCount.toLocaleString()}{' '}
              words
            </Text>
            <Text
              style={{
                fontSize: 11,
                fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
                color: muted,
              }}>
              {filename}
            </Text>
          </View>

          {/* Action buttons */}
          <View style={{ flexDirection: 'row', gap: 10 }}>
            {/* Copy */}
            <Button
              variant="ghost"
              onPress={handleCopy}
              disabled={!canExport || sharing}
              className="h-auto flex-1 flex-row items-center justify-center gap-1.5 rounded-full active:bg-transparent active:opacity-70"
              style={{
                paddingVertical: 12,
                borderWidth: 1,
                borderColor: border,
                backgroundColor: cardBg,
              }}>
              <Ionicons
                name={copied ? 'checkmark' : 'copy-outline'}
                size={16}
                color={copied ? THEME.accent.green : fg}
              />
              <Text
                style={{
                  fontSize: 14,
                  fontFamily: 'Roobert-Medium',
                  color: copied ? THEME.accent.green : fg,
                }}>
                {copied ? 'Copied' : 'Copy'}
              </Text>
            </Button>

            {/* Share / Download */}
            <Button
              variant="ghost"
              onPress={handleShare}
              disabled={!canExport || sharing}
              className="h-auto flex-1 flex-row items-center justify-center gap-1.5 rounded-full active:bg-transparent active:opacity-70"
              style={{
                paddingVertical: 12,
                backgroundColor: theme.primary,
              }}>
              {sharing ? (
                <ActivityIndicator size="small" color={theme.primaryForeground} />
              ) : (
                <>
                  <Ionicons name="share-outline" size={16} color={theme.primaryForeground} />
                  <Text style={{ fontSize: 14, fontFamily: 'Roobert-Medium', color: theme.primaryForeground }}>
                    Share .md
                  </Text>
                </>
              )}
            </Button>
          </View>
        </BottomSheetView>
      </BottomSheetModal>
    );
  }
);

// ─── Option row ─────────────────────────────────────────────────────────────

function OptionRow({
  icon,
  label,
  value,
  onToggle,
  fg,
  muted,
  cardBg,
  border,
}: {
  icon: string;
  label: string;
  value: boolean;
  onToggle: () => void;
  fg: string;
  muted: string;
  cardBg: string;
  border: string;
}) {
  return (
    <Button
      variant="ghost"
      onPress={onToggle}
      className="h-auto flex-row items-center justify-start rounded-[10px] active:bg-transparent active:opacity-70"
      style={{
        backgroundColor: cardBg,
        borderWidth: 1,
        borderColor: border,
        paddingHorizontal: 12,
        paddingVertical: 10,
      }}>
      <Ionicons name={icon as any} size={15} color={muted} style={{ marginRight: 10 }} />
      <Text style={{ flex: 1, fontSize: 14, fontFamily: 'Roobert', color: fg }}>{label}</Text>
      <Switch checked={value} onCheckedChange={onToggle} />
    </Button>
  );
}
