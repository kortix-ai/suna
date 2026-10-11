/**
 * The markdown text node and the external-link opener, shared by every
 * markdown renderer module (KRTX-1292: moved out of `selectable-markdown.tsx`
 * so the table and selection-fallback renderers import them without a cycle
 * through the main module).
 */
import React from 'react';
import { Platform, Text as RNText, UIManager, type TextProps } from 'react-native';
import { UITextView } from 'react-native-uitextview';
import { isSafeExternalLink } from '@/lib/markdown/safe-link';
import { openLink } from '@/lib/utils/open-link';

/**
 * The running iOS binary has `react-native-uitextview`'s native view. An OTA
 * update can reach a binary built before it: that binary renders plain `Text`
 * and keeps the double-tap selection sheet.
 */
export const IOS_TEXT_VIEW = Platform.OS === 'ios' && UIManager.hasViewManagerConfig('RNUITextView');

/**
 * Every text node of the markdown. On iOS it is a `UITextView`: the outermost
 * one is the selectable view, nested ones are its styled spans, so every text
 * rule must use this and never `RNText`. Elsewhere it is React Native's `Text`,
 * which reads `selectable` from the outermost node only.
 */
export function MarkdownText(props: TextProps) {
  return IOS_TEXT_VIEW ? <UITextView uiTextView {...props} /> : <RNText {...props} />;
}

/**
 * Opens a link from message markdown when its scheme is http(s) or mailto.
 * Any other scheme is ignored, and a failed open never becomes an unhandled
 * rejection.
 */
export function openExternalLink(href: unknown) {
  if (!isSafeExternalLink(href)) return;
  openLink(href).catch(() => {});
}
