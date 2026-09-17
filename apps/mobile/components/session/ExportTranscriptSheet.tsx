/**
 * ExportTranscriptSheet — bottom sheet for exporting session transcript as Markdown.
 * Ported from web's ExportTranscriptDialog.
 */
import React, { forwardRef, useMemo, useState, useCallback, useRef, useImperativeHandle } from 'react';
import { View, Platform, ActivityIndicator } from 'react-native';
import { Text } from '@/components/ui/text';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { BottomSheetModal, BottomSheetView } from '@gorhom/bottom-sheet';
import { useColorScheme } from 'nativewind';
import { DownloadSimpleIcon, ExportIcon, type AppIcon, UserIcon, WrenchIcon, LightbulbIcon, CheckIcon, CopyIcon } from '@/lib/icons';
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

    // Presentation state — this sheet stays mounted while closed (pan-down-to-close
    // needs it pre-mounted), so every subscription and derived computation below
    // must be gated on this, or it re-runs on every streamed message delta.
    const [isOpen, setIsOpen] = useState(false);

    // Real gorhom instance. The `ref` this component forwards is a thin
    // present()-intercepting wrapper around this (see useImperativeHandle
    // below) so `isOpen` flips before the sheet's first visible frame,
    // instead of waiting for the open animation to finish (onChange) or
    // even start (onAnimate) — both fire too late for already-in-memory
    // data like transcript/wordCount to be ready when the sheet appears.
    const sheetRef = useRef<BottomSheetModal>(null);

    // Session info — disabled while closed (useSession has no `enabled` param;
    // an empty id is the form it already treats as disabled).
    const { data: session } = useSession(sandboxUrl, isOpen ? sessionId || '' : '');

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

    // Messages from sync store — only subscribed while open, so a closed sheet
    // never re-renders on stream deltas.
    const messages = useSyncStore((state) => (isOpen && sessionId ? state.messages[sessionId] : undefined));

    // Build transcript (preview + word count while open; handleCopy/handleShare
    // reload a fresh, complete transcript via loadTranscript() regardless).
    const transcript = useMemo(() => {
      if (!isOpen || !session || !messages || !Array.isArray(messages) || messages.length === 0) return '';
      return formatTranscript(
        {
          id: session.id,
          title: session.title || 'Untitled',
          time: session.time,
        },
        messages,
        options
      );
    }, [isOpen, session, messages, options]);

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
        sheetRef.current?.dismiss();
      } catch {
        // User cancelled share or error
      } finally {
        setSharing(false);
      }
    }, [filename, loadTranscript]);

    const toggleOption = useCallback((key: keyof TranscriptOptions) => {
      setOptions((prev) => ({ ...prev, [key]: !prev[key] }));
    }, []);

    const handleSheetChange = useCallback((index: number) => {
      setIsOpen(index >= 0);
    }, []);

    const handleDismiss = useCallback(() => {
      setIsOpen(false);
    }, []);

    // Belt-and-suspenders: onAnimate fires at the start of the open transition
    // (before onChange, which only fires once the animation completes), so it
    // catches any open path that reaches the sheet without going through the
    // present() wrapper below (e.g. a gesture-driven snap).
    const handleAnimate = useCallback((_fromIndex: number, toIndex: number) => {
      if (toIndex >= 0) setIsOpen(true);
    }, []);

    useImperativeHandle(
      ref,
      (): BottomSheetModal => ({
        present: (...args: Parameters<BottomSheetModal['present']>) => {
          // Flip open synchronously, before the sheet even mounts its
          // content — this is what actually gets transcript/wordCount
          // computed and visible on the sheet's first visible frame.
          setIsOpen(true);
          sheetRef.current?.present(...args);
        },
        dismiss: (...args: Parameters<BottomSheetModal['dismiss']>) => sheetRef.current?.dismiss(...args),
        snapToIndex: (...args: Parameters<BottomSheetModal['snapToIndex']>) => sheetRef.current?.snapToIndex(...args),
        snapToPosition: (...args: Parameters<BottomSheetModal['snapToPosition']>) => sheetRef.current?.snapToPosition(...args),
        expand: (...args: Parameters<BottomSheetModal['expand']>) => sheetRef.current?.expand(...args),
        collapse: (...args: Parameters<BottomSheetModal['collapse']>) => sheetRef.current?.collapse(...args),
        close: (...args: Parameters<BottomSheetModal['close']>) => sheetRef.current?.close(...args),
        forceClose: (...args: Parameters<BottomSheetModal['forceClose']>) => sheetRef.current?.forceClose(...args),
      }),
      [],
    );

    const fg = isDark ? THEME.dark.foreground : THEME.light.foreground;
    const muted = isDark ? THEME.dark.mutedForeground : THEME.light.mutedForeground;
    const cardBg = isDark ? withAlpha(THEME.dark.foreground, 0.04) : withAlpha(THEME.light.foreground, 0.03);
    const border = isDark ? withAlpha(THEME.dark.foreground, 0.06) : withAlpha(THEME.light.foreground, 0.06);

    return (
      <BottomSheetModal
        ref={sheetRef}
        enableDynamicSizing
        enablePanDownToClose
        onChange={handleSheetChange}
        onDismiss={handleDismiss}
        onAnimate={handleAnimate}
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
            <DownloadSimpleIcon size={18} color={fg} />
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
              icon={UserIcon}
              label="Assistant metadata"
              value={options.assistantMetadata}
              onToggle={() => toggleOption('assistantMetadata')}
              fg={fg}
              muted={muted}
              cardBg={cardBg}
              border={border}
            />
            <OptionRow
              icon={WrenchIcon}
              label="Tool call details"
              value={options.toolDetails}
              onToggle={() => toggleOption('toolDetails')}
              fg={fg}
              muted={muted}
              cardBg={cardBg}
              border={border}
            />
            <OptionRow
              icon={LightbulbIcon}
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
              variant="outline"
              size="lg"
              onPress={handleCopy}
              disabled={!canExport || sharing}
              className="flex-1 rounded-full">
              {copied ? (
                <CheckIcon size={16} color={THEME.accent.green} />
              ) : (
                <CopyIcon size={16} color={fg} />
              )}
              <Text style={{ color: copied ? THEME.accent.green : fg }}>
                {copied ? 'Copied' : 'Copy'}
              </Text>
            </Button>

            {/* Share / Download */}
            <Button
              size="lg"
              onPress={handleShare}
              disabled={!canExport || sharing}
              className="flex-1 rounded-full">
              {sharing ? (
                <ActivityIndicator size="small" color={theme.primaryForeground} />
              ) : (
                <>
                  <ExportIcon size={16} color={theme.primaryForeground} />
                  <Text>Share .md</Text>
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
  icon: RowIcon,
  label,
  value,
  onToggle,
  fg,
  muted,
  cardBg,
  border,
}: {
  icon: AppIcon;
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
      <RowIcon size={15} color={muted} style={{ marginRight: 10 }} />
      <Text style={{ flex: 1, fontSize: 14, fontFamily: 'Roobert', color: fg }}>{label}</Text>
      <Switch checked={value} onCheckedChange={onToggle} />
    </Button>
  );
}
