/**
 * The iOS selection fallback, moved out of `selectable-markdown.tsx`
 * (KRTX-1292): on an iOS binary without `RNUITextView` (`IOS_TEXT_VIEW`
 * false), a double tap on the message opens this selection sheet — a read-only
 * live-markdown view of the raw text. This module imports only leaf modules;
 * the main markdown module passes the rendered blocks in as `children`, so
 * nothing here imports back into it.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text as RNText, View, useWindowDimensions } from 'react-native';
import type { BottomSheetModal } from '@gorhom/bottom-sheet';
import { BottomSheetView, TouchableOpacity as BottomSheetTouchable } from '@gorhom/bottom-sheet';
import * as Haptics from 'expo-haptics';
import * as Clipboard from 'expo-clipboard';
import type { MarkdownTextInput as MarkdownTextInputComponent } from '@expensify/react-native-live-markdown';

import { CopyIcon as Copy } from '@/lib/icons';
import {
  markdownParser,
  lightMarkdownStyle,
  darkMarkdownStyle,
} from '@/lib/utils/live-markdown-config';
import { THEME } from '@/lib/utils/theme';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { log } from '@/lib/logger';
import { KortixBottomSheetModal } from '@/components/kortix/sheet';

// The component's own module, not the package root: the root also exports
// `parseExpensiMark`, which loads all of `expensify-common` (1.5 MB) at boot.
// The app passes its own parser (`markdownParser`) and never calls it. A
// `require`, so tsc reads the root's declarations and not the package source.
const MarkdownTextInput: typeof MarkdownTextInputComponent =
  require('@expensify/react-native-live-markdown/src/MarkdownTextInput').default;

interface TextSelectionModalProps {
  sheetRef: React.RefObject<BottomSheetModal | null>;
  text: string;
  isDark: boolean;
  onDismiss: () => void;
}

function TextSelectionModal({ sheetRef, text, isDark, onDismiss }: TextSelectionModalProps) {
  const insets = useSafeAreaInsets();
  const snapPoints = useMemo(() => ['70%', '95%'], []);
  const [copied, setCopied] = useState(false);
  const [currentSnapIndex, setCurrentSnapIndex] = useState(0);
  const { height: screenHeight } = useWindowDimensions();
  
  // Calculate available height based on current snap point
  const snapPercent = currentSnapIndex === 1 ? 0.95 : 0.70;
  const textInputHeight = screenHeight * snapPercent - 100 - insets.bottom;

  const handleSheetChange = useCallback((index: number) => {
    if (index >= 0) {
      setCurrentSnapIndex(index);
    }
  }, []);

  const colors = {
    bg: isDark ? THEME.dark.background : THEME.light.background,
    text: isDark ? THEME.dark.foreground : THEME.light.foreground,
    muted: isDark ? THEME.dark.mutedForeground : THEME.light.mutedForeground,
    card: isDark ? THEME.dark.card : THEME.light.card,
  };


  const handleCopyAll = useCallback(async () => {
    try {
      await Clipboard.setStringAsync(text);
      setCopied(true);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      log.error('Failed to copy:', err);
    }
  }, [text]);

  return (
    <KortixBottomSheetModal
      ref={sheetRef}
      snapPoints={snapPoints}
      index={0}
      enablePanDownToClose
      enableDynamicSizing={false}
      onChange={handleSheetChange}
      onDismiss={onDismiss}
      style={{
        zIndex: 999,
        elevation: Platform.OS === 'android' ? 50 : undefined,
      }}
    >
      <BottomSheetView style={{ flex: 1 }}>
        {/* Header - fixed at top */}
        <View style={[drawerStyles.header, { paddingHorizontal: 24 }]}>
          <RNText style={[drawerStyles.title, { color: colors.text }]}>
            Select Text
          </RNText>
          <BottomSheetTouchable 
            onPress={handleCopyAll} 
            style={[drawerStyles.copyButton, { 
              backgroundColor: 'transparent',
              borderColor: isDark ? THEME.dark.border : THEME.light.border,
            }]}
          >
            <Copy size={16} color={colors.text} />
            <RNText style={[drawerStyles.copyButtonText, { color: colors.text }]}>
              {copied ? 'Copied!' : 'Copy All'}
            </RNText>
          </BottomSheetTouchable>
        </View>

        {/* Hint */}
        <RNText style={[drawerStyles.hint, { color: colors.muted, paddingHorizontal: 24 }]}>
          Tap and hold text to select
        </RNText>

        {/* Scrollable + selectable using Expensify MarkdownTextInput */}
        <View style={{ paddingHorizontal: 24 }}>
          <MarkdownTextInput
            value={text}
            onChangeText={() => {}}
            parser={markdownParser}
            markdownStyle={isDark ? darkMarkdownStyle : lightMarkdownStyle}
            editable={false}
            multiline={true}
            scrollEnabled={true}
            style={[
              drawerStyles.textContent, 
              { 
                height: textInputHeight,
                color: colors.text,
                textAlignVertical: 'top',
              }
            ]}
          />
        </View>
      </BottomSheetView>
    </KortixBottomSheetModal>
  );
}

const drawerStyles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingTop: 8,
    paddingBottom: 16,
  },
  title: {
    fontSize: 20,
    fontFamily: 'Roobert-SemiBold',
  },
  hint: {
    fontSize: 13,
    fontFamily: 'Roobert-Regular',
    marginBottom: 16,
  },
  copyButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 20,
    borderWidth: 1,
  },
  copyButtonText: {
    fontSize: 14,
    fontFamily: 'Roobert-Medium',
  },
  textContent: {
    fontSize: 16,
    lineHeight: 26,
    fontFamily: 'Roobert-Regular',
  },
});

const DOUBLE_TAP_DELAY_MS = 300;

function noop() {}

/**
 * iOS binary without `RNUITextView` only: a double tap opens the selection sheet. The sheet mounts on the first
 * double tap, not with every text part, and stays mounted after dismiss.
 * `Pressable` is deliberate, NOT `Button`: this is a gesture target over body
 * text, so it must have no press animation at all.
 */
export function IOSSelectableMarkdown({
  text,
  isDark,
  isStreaming,
  children,
}: {
  text: string;
  isDark: boolean;
  isStreaming?: boolean;
  /** The rendered markdown blocks: the Pressable's content, passed in so this
   * module never imports the main renderer. */
  children: React.ReactNode;
}) {
  const bottomSheetRef = useRef<BottomSheetModal>(null);
  const lastTapRef = useRef(0);
  const presentOnMountRef = useRef(false);
  const [sheetMounted, setSheetMounted] = useState(false);

  useEffect(() => {
    if (sheetMounted && presentOnMountRef.current) {
      presentOnMountRef.current = false;
      bottomSheetRef.current?.present();
    }
  }, [sheetMounted]);

  const handlePress = useCallback(() => {
    const now = Date.now();
    if (now - lastTapRef.current >= DOUBLE_TAP_DELAY_MS) {
      lastTapRef.current = now;
      return;
    }
    lastTapRef.current = 0;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    if (sheetMounted) {
      bottomSheetRef.current?.present();
    } else {
      presentOnMountRef.current = true;
      setSheetMounted(true);
    }
  }, [sheetMounted]);

  return (
    <>
      <Pressable onPress={handlePress}>{children}</Pressable>
      {sheetMounted ? (
        <TextSelectionModal sheetRef={bottomSheetRef} text={text} isDark={isDark} onDismiss={noop} />
      ) : null}
    </>
  );
}
