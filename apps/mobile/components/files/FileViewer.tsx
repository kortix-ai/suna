/**
 * File Viewer Modal
 * Full-screen file viewer with preview and actions
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Modal,
  Pressable,
  Share,
  Platform,
  TextInput,
  KeyboardAvoidingView,
  Alert,
} from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { KortixLoader } from '@/components/kortix/kortix-loader';
import { XIcon as X, DownloadIcon as Download, CaretLeftIcon as ChevronLeft, CaretRightIcon as ChevronRight, PencilIcon as Pencil, CheckIcon as Check } from '@/lib/icons';
import { useColorScheme } from 'nativewind';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  FadeIn,
  FadeOut,
} from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { FilePreview } from './FilePreviewRenderers';
import { useFilePreviewData } from './use-file-preview-data';
import { useOpenCodeWriteFile, downloadOpenCodeFileToCache } from '@/lib/files/hooks';
import type { SandboxFile } from '@/api/types';

import { log } from '@/lib/logger';
import { MONO_FONT_FAMILY } from '@/lib/utils/mono-font';
import { THEME, withAlpha } from '@/lib/utils/theme';
import { sheetHandleIndicatorStyle } from '@/components/kortix/sheet';
import { useConfirmDialog } from '@/components/kortix/confirm-dialog';
import { PortalHost } from '@rn-primitives/portal';

/** Portal host inside the viewer's native `Modal`: the root host draws under it. */
const FILE_VIEWER_PORTAL_HOST = 'file-viewer';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

interface FileViewerProps {
  visible: boolean;
  onClose: () => void;
  file: SandboxFile | null;
  sandboxId: string;
  sandboxUrl?: string;
  fileList?: SandboxFile[];
  currentIndex?: number;
  onNavigate?: (index: number) => void;
  /** Open straight into the editor (e.g. for a just-created file). */
  initialEditing?: boolean;
}

/**
 * File Viewer Component
 */
export function FileViewer({
  visible,
  onClose,
  file,
  sandboxId,
  sandboxUrl,
  fileList,
  currentIndex = -1,
  onNavigate,
  initialEditing,
}: FileViewerProps) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const closeScale = useSharedValue(1);
  const [viewMode, setViewMode] = useState<'preview' | 'raw'>('preview');
  const [isDownloading, setIsDownloading] = useState(false);
  // In-place text editing
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const writeMutation = useOpenCodeWriteFile();
  const { confirm, dialog: confirmDialog } = useConfirmDialog({ portalHost: FILE_VIEWER_PORTAL_HOST });

  const {
    previewType,
    isBinaryFile,
    shouldFetchText,
    textContent,
    textError,
    blob: imageBlob,
    blobError: imageError,
    blobTooLarge,
    blobUrl,
    isLoading,
    error: hasError,
    size: previewSize,
  } = useFilePreviewData(file, sandboxUrl);

  const closeAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: closeScale.value }],
  }));

  const handleClose = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onClose();
  };

  const handleDownload = async () => {
    if (!file) return;
    setIsDownloading(true);
    try {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

      // For binary files (images, PDFs, etc.) write to file and share
      if (imageBlob && isBinaryFile && !blobTooLarge) {
        // Convert blob to base64
        const reader = new FileReader();
        const base64Data = await new Promise<string>((resolve, reject) => {
          reader.onloadend = () => {
            const result = reader.result as string;
            const base64 = result.split(',')[1];
            resolve(base64);
          };
          reader.onerror = reject;
          reader.readAsDataURL(imageBlob);
        });

        // Write to temporary file
        const fileUri = `${FileSystem.cacheDirectory}${file.name}`;
        await FileSystem.writeAsStringAsync(fileUri, base64Data, {
          encoding: FileSystem.EncodingType.Base64,
        });

        // Share the file
        const canShare = await Sharing.isAvailableAsync();
        if (canShare) {
          await Sharing.shareAsync(fileUri, {
            dialogTitle: `Download ${file.name}`,
          });
        }
        return;
      }
      
      // For text files, write to file and share
      if (textContent) {
        const fileUri = `${FileSystem.cacheDirectory}${file.name}`;
        await FileSystem.writeAsStringAsync(fileUri, textContent);
        
        const canShare = await Sharing.isAvailableAsync();
        if (canShare) {
          await Sharing.shareAsync(fileUri, {
            dialogTitle: `Download ${file.name}`,
          });
        } else {
          await Share.share({
            message: textContent,
            title: file.name,
          });
        }
        return;
      }

      // Nothing loaded (over the preview limit, not previewable, or still
      // loading): stream the file to disk natively and share it.
      if (sandboxUrl) {
        const fileUri = await downloadOpenCodeFileToCache(sandboxUrl, file.path, file.name);
        const canShare = await Sharing.isAvailableAsync();
        if (canShare) {
          await Sharing.shareAsync(fileUri, {
            dialogTitle: `Download ${file.name}`,
          });
        }
      }
    } catch (error) {
      log.error('Download failed:', error);
    } finally {
      setIsDownloading(false);
    }
  };

  const handlePrevious = () => {
    if (currentIndex > 0 && onNavigate) {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      onNavigate(currentIndex - 1);
    }
  };

  const handleNext = () => {
    if (fileList && currentIndex < fileList.length - 1 && onNavigate) {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      onNavigate(currentIndex + 1);
    }
  };

  const canNavigate = fileList && fileList.length > 1 && currentIndex >= 0;

  // ── In-place editing ──────────────────────────────────────────────────────
  // Text files can be edited once their content has loaded.
  const canEdit = !!file && !!sandboxUrl && !!shouldFetchText && !isLoading && !textError;
  const dirty = editing && draft !== (textContent ?? '');

  // Reset edit mode whenever the file changes or the viewer closes. A freshly
  // created file (initialEditing) opens straight into the editor.
  useEffect(() => {
    setEditing(visible && !!initialEditing);
    setDraft('');
  }, [file?.path, visible, initialEditing]);

  const handleStartEdit = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setDraft(textContent ?? '');
    setEditing(true);
  }, [textContent]);

  const handleCancelEdit = useCallback(() => {
    if (dirty) {
      confirm({
        title: 'Discard changes?',
        description: 'Your edits will be lost.',
        cancelLabel: 'Keep editing',
        confirmLabel: 'Discard',
        destructive: true,
        onConfirm: () => setEditing(false),
      });
      return;
    }
    setEditing(false);
  }, [dirty, confirm]);

  const handleSave = useCallback(async () => {
    if (!file || !sandboxUrl) return;
    try {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      await writeMutation.mutateAsync({ sandboxUrl, path: file.path, content: draft });
      setEditing(false); // content query is invalidated → refetches the saved text
    } catch (e: any) {
      // One-button acknowledgement, not a toast: the root toaster draws under
      // this native Modal on Android.
      Alert.alert('Save failed', e?.message || 'Could not save the file. Your edits are kept — try again.');
    }
  }, [file, sandboxUrl, draft, writeMutation]);

  const handleCloseGuarded = useCallback(() => {
    if (editing && dirty) {
      confirm({
        title: 'Discard changes?',
        description: 'Your edits will be lost.',
        cancelLabel: 'Keep editing',
        confirmLabel: 'Discard',
        destructive: true,
        onConfirm: () => {
          setEditing(false);
          handleClose();
        },
      });
      return;
    }
    handleClose();
  }, [editing, dirty, handleClose, confirm]);

  const insets = useSafeAreaInsets();

  if (!visible || !file) {
    return null;
  }

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={handleCloseGuarded}>
      <View className="flex-1" style={{ backgroundColor: isDark ? THEME.dark.background : THEME.light.background }}>
        {/* Drag handle indicator (visible on iOS pageSheet) */}
        <View
          style={{
            alignItems: 'center',
            paddingTop: 8,
            paddingBottom: 4,
            backgroundColor: isDark ? THEME.dark.background : THEME.light.background,
          }}
        >
          <View style={sheetHandleIndicatorStyle(isDark)} />
        </View>
        {/* Header */}
        <View
          style={{
            backgroundColor: isDark ? THEME.dark.background : THEME.light.background,
            borderBottomWidth: 1,
            borderBottomColor: withAlpha(isDark ? THEME.dark.foreground : THEME.light.foreground, 0.1),
          }}>
          <Animated.View
            entering={FadeIn.duration(200)}
            exiting={FadeOut.duration(200)}
            className="flex-row items-center justify-between px-4 py-4">
            <View className="mr-4 min-w-0 flex-1">
              <Text
                style={{ color: isDark ? THEME.dark.foreground : THEME.light.foreground }}
                className="font-roobert-medium text-base"
                numberOfLines={1}>
                {file.name}
              </Text>
              {canNavigate && (
                <Text
                  style={{ color: withAlpha(isDark ? THEME.dark.foreground : THEME.light.foreground, 0.5) }}
                  className="mt-0.5 font-roobert text-xs">
                  {currentIndex + 1} of {fileList?.length}
                </Text>
              )}
            </View>

            {/* Action Buttons */}
            {editing ? (
              <View className="flex-row items-center gap-2">
                <Pressable onPress={handleCancelEdit} className="px-2 py-2" hitSlop={8}>
                  <Text
                    style={{ color: withAlpha(isDark ? THEME.dark.foreground : THEME.light.foreground, isDark ? 0.6 : 0.5) }}
                    className="font-roobert-medium text-sm">
                    Cancel
                  </Text>
                </Pressable>
                <Pressable
                  onPress={handleSave}
                  disabled={writeMutation.isPending || !dirty}
                  hitSlop={6}
                  className="flex-row items-center rounded-full px-3.5 py-2"
                  style={{
                    backgroundColor: isDark ? THEME.dark.foreground : THEME.light.foreground,
                    opacity: writeMutation.isPending || !dirty ? 0.5 : 1,
                    gap: 6,
                  }}>
                  {writeMutation.isPending ? (
                    <KortixLoader size="small" forceTheme={isDark ? 'light' : 'dark'} />
                  ) : (
                    <Icon as={Check} size={16} color={isDark ? THEME.dark.background : THEME.light.background} />
                  )}
                  <Text
                    style={{ color: isDark ? THEME.dark.background : THEME.light.background }}
                    className="font-roobert-medium text-sm">
                    {writeMutation.isPending ? 'Saving…' : 'Save'}
                  </Text>
                </Pressable>
              </View>
            ) : (
              <View className="flex-row items-center gap-3">
                {canNavigate && (
                  <>
                    <AnimatedPressable
                      onPress={handlePrevious}
                      disabled={currentIndex <= 0}
                      className="p-2"
                      style={{ opacity: currentIndex <= 0 ? 0.3 : 1 }}
                      accessibilityRole="button"
                      accessibilityLabel="Previous file">
                      <Icon
                        as={ChevronLeft}
                        size={24}
                        color={isDark ? THEME.dark.foreground : THEME.light.foreground}
                      />
                    </AnimatedPressable>
                    <AnimatedPressable
                      onPress={handleNext}
                      disabled={currentIndex >= (fileList?.length || 0) - 1}
                      className="p-2"
                      style={{ opacity: currentIndex >= (fileList?.length || 0) - 1 ? 0.3 : 1 }}
                      accessibilityRole="button"
                      accessibilityLabel="Next file">
                      <Icon
                        as={ChevronRight}
                        size={24}
                        color={isDark ? THEME.dark.foreground : THEME.light.foreground}
                      />
                    </AnimatedPressable>
                  </>
                )}
                {canEdit && (
                  <AnimatedPressable onPress={handleStartEdit} className="p-2" hitSlop={6} accessibilityRole="button" accessibilityLabel="Edit file">
                    <Icon as={Pencil} size={20} color={isDark ? THEME.dark.foreground : THEME.light.foreground} />
                  </AnimatedPressable>
                )}
                <AnimatedPressable
                  onPress={handleDownload}
                  disabled={isDownloading}
                  className="p-2"
                  style={{ opacity: isDownloading ? 0.6 : 1 }}
                  accessibilityRole="button"
                  accessibilityLabel="Download">
                  {isDownloading ? (
                    <KortixLoader size="small" />
                  ) : (
                    <Icon
                      as={Download}
                      size={22}
                      color={isDark ? THEME.dark.foreground : THEME.light.foreground}
                    />
                  )}
                </AnimatedPressable>
                <AnimatedPressable
                  onPressIn={() => {
                    closeScale.value = withSpring(0.9, { damping: 15, stiffness: 400 });
                  }}
                  onPressOut={() => {
                    closeScale.value = withSpring(1, { damping: 15, stiffness: 400 });
                  }}
                  onPress={handleCloseGuarded}
                  style={closeAnimatedStyle}
                  className="p-2"
                  accessibilityRole="button"
                  accessibilityLabel="Close">
                  <Icon as={X} size={24} color={isDark ? THEME.dark.foreground : THEME.light.foreground} />
                </AnimatedPressable>
              </View>
            )}
          </Animated.View>
        </View>

        {/* Content */}
        <View className="flex-1">
          {editing ? (
            <KeyboardAvoidingView
              style={{ flex: 1 }}
              behavior={Platform.OS === 'ios' ? 'padding' : undefined}
              keyboardVerticalOffset={insets.top + 8}>
              <TextInput
                value={draft}
                onChangeText={setDraft}
                multiline
                autoCapitalize="none"
                autoCorrect={false}
                autoComplete="off"
                spellCheck={false}
                editable={!writeMutation.isPending}
                textAlignVertical="top"
                style={{
                  flex: 1,
                  paddingHorizontal: 16,
                  paddingTop: 12,
                  paddingBottom: insets.bottom + 12,
                  fontFamily: MONO_FONT_FAMILY,
                  fontSize: 13,
                  lineHeight: 19,
                  color: isDark ? THEME.dark.foreground : THEME.light.foreground,
                }}
              />
            </KeyboardAvoidingView>
          ) : isLoading ? (
            <View className="flex-1 items-center justify-center">
              <KortixLoader size="large" />
              <Text className="mt-4 text-sm text-muted-foreground">Loading file...</Text>
            </View>
          ) : hasError ? (
            <View className="flex-1 items-center justify-center p-8">
              <Text className="mb-2 text-center text-sm text-destructive">Failed to load file</Text>
              <Text className="text-center text-xs text-muted-foreground">
                {String(textError || imageError)}
              </Text>
            </View>
          ) : (
            <FilePreview
              content={textContent || null}
              fileName={file.name}
              previewType={previewType}
              blobUrl={blobUrl}
              filePath={file.path}
              sandboxUrl={sandboxUrl}
              size={previewSize}
            />
          )}
        </View>
        {confirmDialog}
        <PortalHost name={FILE_VIEWER_PORTAL_HOST} />
      </View>
    </Modal>
  );
}
