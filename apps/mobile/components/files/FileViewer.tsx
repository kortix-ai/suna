/**
 * File Viewer Modal
 * Full-screen file viewer with preview and actions
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Modal,
  Pressable,
  Platform,
  TextInput,
  Keyboard,
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
import { FilePreview } from './FilePreviewRenderers';
import { useFilePreviewData } from './use-file-preview-data';
import { useWriteSandboxFile, downloadSandboxFileToCache } from '@/lib/files/hooks';
import { saveFileToDevice } from '@/lib/files/save-to-device';
import { useToast } from '@/components/kortix/toast-provider';
import type { SandboxFile } from '@/api/types';

import { log } from '@/lib/logger';
import { MONO_FONT_FAMILY } from '@/lib/utils/mono-font';
import { THEME, withAlpha } from '@/lib/utils/theme';
import { sheetHandleIndicatorStyle } from '@/components/kortix/sheet';
import { useConfirmDialog } from '@/components/kortix/confirm-dialog';
import { blobToDataURL } from '@/lib/files/hooks';
import { PortalHost } from '@rn-primitives/portal';

/** Portal host inside the viewer's native `Modal`: the root host draws under it. */
const FILE_VIEWER_PORTAL_HOST = 'file-viewer';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

/**
 * The inline text editor's state machine, lifted out of the `FileViewer`
 * shell: whether the editor is open, its draft, and the save / cancel /
 * discard-confirm flows around it. `close` is the viewer's own close; the
 * guarded variant confirms unsaved edits first.
 */
function useInlineTextEditor({
  file,
  sandboxUrl,
  textContent,
  visible,
  initialEditing,
  canEdit,
  close,
}: {
  file: SandboxFile | null;
  sandboxUrl?: string;
  textContent?: string | null;
  visible: boolean;
  initialEditing?: boolean;
  canEdit: boolean;
  close: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const writeMutation = useWriteSandboxFile();
  const { confirm, dialog: confirmDialog } = useConfirmDialog({ portalHost: FILE_VIEWER_PORTAL_HOST });

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

  const confirmDiscard = useCallback(
    (onDiscard: () => void) => {
      if (!dirty) return onDiscard();
      confirm({
        title: 'Discard changes?',
        description: 'Your edits will be lost.',
        cancelLabel: 'Keep editing',
        confirmLabel: 'Discard',
        destructive: true,
        onConfirm: onDiscard,
      });
    },
    [dirty, confirm],
  );

  const handleCancelEdit = useCallback(() => {
    confirmDiscard(() => setEditing(false));
  }, [confirmDiscard]);

  const handleSave = useCallback(async () => {
    if (!file || !sandboxUrl) return;
    try {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      await writeMutation.mutateAsync({ sandboxUrl, path: file.path, content: draft });
      setEditing(false); // content query is invalidated → refetches the saved text
    } catch (e) {
      // One-button acknowledgement, not a toast: the root toaster draws under
      // this native Modal on Android.
      const message = e instanceof Error ? e.message : 'Could not save the file. Your edits are kept — try again.';
      Alert.alert('Save failed', message);
    }
  }, [file, sandboxUrl, draft, writeMutation]);

  const handleCloseGuarded = useCallback(() => {
    confirmDiscard(() => {
      setEditing(false);
      close();
    });
  }, [confirmDiscard, close]);

  return {
    editing,
    draft,
    setDraft,
    dirty,
    canEdit,
    isPending: writeMutation.isPending,
    handleStartEdit,
    handleCancelEdit,
    handleSave,
    handleCloseGuarded,
    confirmDialog,
  };
}

/** The header's right side: Cancel and Save while editing, and the view
 * actions (file navigation, edit pencil, download, close) otherwise. */
function EditorHeaderActions({
  isDark,
  editing,
  isPending,
  dirty,
  onCancel,
  onSave,
  onPrevious,
  onNext,
  showNavigation,
  canPrevious,
  canNext,
  canEdit,
  onStartEdit,
  onDownload,
  isDownloading,
  onClose,
  closeScale,
  closeAnimatedStyle,
}: {
  isDark: boolean;
  editing: boolean;
  isPending: boolean;
  dirty: boolean;
  onCancel: () => void;
  onSave: () => void;
  onPrevious: () => void;
  onNext: () => void;
  showNavigation: boolean;
  canPrevious: boolean;
  canNext: boolean;
  canEdit: boolean;
  onStartEdit: () => void;
  onDownload: () => void;
  isDownloading: boolean;
  onClose: () => void;
  closeScale: ReturnType<typeof useSharedValue<number>>;
  closeAnimatedStyle: object;
}) {
  const fg = isDark ? THEME.dark.foreground : THEME.light.foreground;
  if (editing) {
    return (
      <View className="flex-row items-center gap-2">
        <Pressable onPress={onCancel} className="px-2 py-2" hitSlop={8}>
          <Text
            style={{ color: withAlpha(isDark ? THEME.dark.foreground : THEME.light.foreground, isDark ? 0.6 : 0.5) }}
            className="font-roobert-medium text-sm">
            Cancel
          </Text>
        </Pressable>
        <Pressable
          onPress={onSave}
          disabled={isPending || !dirty}
          hitSlop={6}
          className="flex-row items-center rounded-full px-3.5 py-2"
          style={{
            backgroundColor: isDark ? THEME.dark.foreground : THEME.light.foreground,
            opacity: isPending || !dirty ? 0.5 : 1,
            gap: 6,
          }}>
          {isPending ? (
            <KortixLoader size="small" forceTheme={isDark ? 'light' : 'dark'} />
          ) : (
            <Icon as={Check} size={16} color={isDark ? THEME.dark.background : THEME.light.background} />
          )}
          <Text
            style={{ color: isDark ? THEME.dark.background : THEME.light.background }}
            className="font-roobert-medium text-sm">
            {isPending ? 'Saving…' : 'Save'}
          </Text>
        </Pressable>
      </View>
    );
  }
  return (
    <View className="flex-row items-center gap-3">
      {showNavigation && (
        <>
          <AnimatedPressable
            onPress={onPrevious}
            disabled={!canPrevious}
            className="p-2"
            style={{ opacity: canPrevious ? 1 : 0.3 }}
            accessibilityRole="button"
            accessibilityLabel="Previous file">
            <Icon as={ChevronLeft} size={24} color={fg} />
          </AnimatedPressable>
          <AnimatedPressable
            onPress={onNext}
            disabled={!canNext}
            className="p-2"
            style={{ opacity: canNext ? 1 : 0.3 }}
            accessibilityRole="button"
            accessibilityLabel="Next file">
            <Icon as={ChevronRight} size={24} color={fg} />
          </AnimatedPressable>
        </>
      )}
      {canEdit && (
        <AnimatedPressable onPress={onStartEdit} className="p-2" hitSlop={6} accessibilityRole="button" accessibilityLabel="Edit file">
          <Icon as={Pencil} size={20} color={fg} />
        </AnimatedPressable>
      )}
      <AnimatedPressable
        onPress={onDownload}
        disabled={isDownloading}
        className="p-2"
        style={{ opacity: isDownloading ? 0.6 : 1 }}
        accessibilityRole="button"
        accessibilityLabel="Download">
        {isDownloading ? (
          <KortixLoader size="small" />
        ) : (
          <Icon as={Download} size={22} color={fg} />
        )}
      </AnimatedPressable>
      <AnimatedPressable
        onPressIn={() => {
          closeScale.value = withSpring(0.9, { damping: 15, stiffness: 400 });
        }}
        onPressOut={() => {
          closeScale.value = withSpring(1, { damping: 15, stiffness: 400 });
        }}
        onPress={onClose}
        style={closeAnimatedStyle}
        className="p-2"
        accessibilityRole="button"
        accessibilityLabel="Close">
        <Icon as={X} size={24} color={fg} />
      </AnimatedPressable>
    </View>
  );
}

/** The editing body: the mono draft field over the keyboard. */
function EditorPane({
  draft,
  setDraft,
  isPending,
  isDark,
}: {
  draft: string;
  setDraft: (next: string) => void;
  isPending: boolean;
  isDark: boolean;
}) {
  const insets = useSafeAreaInsets();
  return (
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
        editable={!isPending}
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
  );
}


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
  const [isDownloading, setIsDownloading] = useState(false);
  const toast = useToast();

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
    imageSource,
    imageRatio,
    dropImageSource,
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
      // The file as it is, in the cache first, then saved on the device
      // (`saveFileToDevice`). No PDF export and no share sheet on mobile.
      const fileUri = `${FileSystem.cacheDirectory}${file.name}`;
      let source: string | null = null;
      if (imageBlob && isBinaryFile && !blobTooLarge) {
        // The hook already made the `data:...;base64,` URL for the preview; the
        // bytes after the comma are the base64 payload.
        const base64Data = (await blobToDataURL(imageBlob, file.path)).split(',')[1];
        await FileSystem.writeAsStringAsync(fileUri, base64Data, { encoding: FileSystem.EncodingType.Base64 });
        source = fileUri;
      } else if (textContent) {
        await FileSystem.writeAsStringAsync(fileUri, textContent);
        source = fileUri;
      } else if (sandboxUrl) {
        // Nothing loaded (over the preview limit, not previewable, or still
        // loading): stream the file to disk natively.
        source = await downloadSandboxFileToCache(sandboxUrl, file.path, file.name);
      }
      if (!source) return;
      const result = await saveFileToDevice(source, file.name);
      if (result.status === 'saved') toast.success(`Saved to ${result.folder}`);
    } catch (error) {
      log.error('Download failed:', error);
      toast.error('Unable to save the file. Try again.');
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
  const {
    editing,
    draft,
    setDraft,
    dirty,
    isPending,
    handleStartEdit,
    handleCancelEdit,
    handleSave,
    handleCloseGuarded,
    confirmDialog,
  } = useInlineTextEditor({ file, sandboxUrl, textContent, visible, initialEditing, canEdit, close: handleClose });

  // A native modal does not take the focus from the field behind it, so the
  // keyboard would stay up over the viewer. Same rule as the sheets.
  useEffect(() => {
    if (visible) Keyboard.dismiss();
  }, [visible]);

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
            <EditorHeaderActions
              isDark={isDark}
              editing={editing}
              isPending={isPending}
              dirty={dirty}
              onCancel={handleCancelEdit}
              onSave={handleSave}
              onPrevious={handlePrevious}
              onNext={handleNext}
              showNavigation={!!canNavigate}
              canPrevious={currentIndex > 0}
              canNext={!!fileList && currentIndex < fileList.length - 1}
              canEdit={canEdit}
              onStartEdit={handleStartEdit}
              onDownload={() => void handleDownload()}
              isDownloading={isDownloading}
              onClose={handleCloseGuarded}
              closeScale={closeScale}
              closeAnimatedStyle={closeAnimatedStyle}
            />
          </Animated.View>
        </View>

        {/* Content */}
        <View className="flex-1">
          {editing ? (
            <EditorPane draft={draft} setDraft={setDraft} isPending={isPending} isDark={isDark} />
          ) : isLoading ? (
            <View className="flex-1 items-center justify-center">
              <KortixLoader size="small" />
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
              imageSource={imageSource}
              imageRatio={imageRatio}
              onImageSourceError={dropImageSource}
            />
          )}
        </View>
        {confirmDialog}
        <PortalHost name={FILE_VIEWER_PORTAL_HOST} />
      </View>
    </Modal>
  );
}
