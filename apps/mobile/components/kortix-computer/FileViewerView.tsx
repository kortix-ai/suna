import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { View, ScrollView, TextInput, Pressable, Alert, Share, Modal, FlatList, Platform } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { KortixLoader } from '@/components/ui';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  Home,
  Save,
  Download,
  ChevronLeft,
  ChevronRight,
  FileText,
  AlertTriangle,
  Check,
  AlertCircle,
  Clock,
  ChevronDown,
  X,
  Pencil,
} from 'lucide-react-native';
import { MarkdownTextInput } from '@expensify/react-native-live-markdown';
import { MarkdownToolbar, insertMarkdownFormat, type MarkdownFormat } from '@/components/chat/MarkdownToolbar';
import {
  markdownParser,
  lightMarkdownStyle,
  darkMarkdownStyle,
} from '@/lib/utils/live-markdown-config';
import { HybridMarkdownEditor } from './HybridMarkdownEditor';
import { useColorScheme } from 'nativewind';
import * as Haptics from 'expo-haptics';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { FilePreview, FilePreviewType, getFilePreviewType } from '@/components/files/FilePreviewRenderers';
import {
  useSandboxFileContent,
  useSandboxImageBlob,
  useFileHistory,
  useFileContentAtCommit,
  useRevertToCommit,
  fetchCommitInfo,
  blobToDataURL,
  type FileVersion,
  type CommitInfo,
} from '@/lib/files/hooks';
import { useKortixComputerStore } from '@/stores/kortix-computer-store';
import { API_URL, getAuthToken } from '@/api/config';
import { KortixComputerHeader } from './KortixComputerHeader';
import { VersionBanner } from './VersionBanner';
import { log } from '@/lib/logger';

interface FileViewerViewProps {
  sandboxId: string;
  filePath: string;
  project?: {
    id: string;
    name: string;
    sandbox?: {
      id?: string;
      sandbox_url?: string;
      vnc_preview?: string;
      pass?: string;
    };
  };
}

export function FileViewerView({
  sandboxId,
  filePath,
  project,
}: FileViewerViewProps) {
  const insets = useSafeAreaInsets();
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const {
    filePathList,
    currentFileIndex,
    setCurrentFileIndex,
    goBackToBrowser,
    setUnsavedContent,
    getUnsavedContent,
    clearUnsavedContent,
    setUnsavedState,
    getUnsavedState,
    selectedVersion,
    selectedVersionDate,
    setSelectedVersion,
    clearSelectedVersion,
  } = useKortixComputerStore();

  const [blobUrl, setBlobUrl] = useState<string | undefined>();
  const [versionBlobUrl, setVersionBlobUrl] = useState<string | undefined>();
  const [isSaving, setIsSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [localContent, setLocalContent] = useState<string>('');
  const [isEditing, setIsEditing] = useState(false);
  const [showVersionModal, setShowVersionModal] = useState(false);
  const [showRevertModal, setShowRevertModal] = useState(false);
  const [revertCommit, setRevertCommit] = useState<string | null>(null);
  const [revertCommitInfo, setRevertCommitInfo] = useState<CommitInfo | null>(null);
  const [isLoadingRevertInfo, setIsLoadingRevertInfo] = useState(false);
  const [isReverting, setIsReverting] = useState(false);
  const [revertMode, setRevertMode] = useState<'single' | 'commit'>('single');
  const [selection, setSelection] = useState({ start: 0, end: 0 });
  const markdownInputRef = useRef<any>(null);

  const fileName = filePath.split('/').pop() || '';
  const fileExtension = fileName.split('.').pop()?.toLowerCase() || '';
  const previewType = getFilePreviewType(fileName);
  const isImage = previewType === FilePreviewType.IMAGE;
  const isMarkdown = previewType === FilePreviewType.MARKDOWN;
  const isText = previewType === FilePreviewType.TEXT || previewType === FilePreviewType.CODE;
  const canEdit = (isMarkdown || isText) && !selectedVersion;

  // Binary file types that should be fetched as blob, not text
  const isBinaryFile = previewType === FilePreviewType.IMAGE || 
                       previewType === FilePreviewType.PDF ||
                       previewType === FilePreviewType.XLSX ||
                       previewType === FilePreviewType.BINARY;
  const shouldFetchText = !isBinaryFile && !selectedVersion;
  const shouldFetchBlob = isBinaryFile && !selectedVersion;

  // Current file content
  const {
    data: textContent,
    isLoading: isLoadingText,
    error: textError,
    refetch: refetchFile,
  } = useSandboxFileContent(
    shouldFetchText ? sandboxId : undefined,
    shouldFetchText ? filePath : undefined
  );

  const {
    data: imageBlob,
    isLoading: isLoadingImage,
    error: imageError,
  } = useSandboxImageBlob(
    shouldFetchBlob ? sandboxId : undefined,
    shouldFetchBlob ? filePath : undefined
  );

  // File version history
  const {
    data: versions = [],
    isLoading: isLoadingVersions,
    refetch: refetchVersions,
  } = useFileHistory(sandboxId, filePath, {
    enabled: showVersionModal || !!selectedVersion,
  });

  // File content at version
  const {
    data: versionBlob,
    isLoading: isLoadingVersionContent,
  } = useFileContentAtCommit(
    sandboxId,
    filePath,
    selectedVersion || undefined,
    {
      enabled: !!selectedVersion,
    }
  );

  // Revert mutation
  const revertMutation = useRevertToCommit();

  // Convert current image blob to data URL
  useEffect(() => {
    if (imageBlob) {
      blobToDataURL(imageBlob).then(setBlobUrl);
    }
    return () => setBlobUrl(undefined);
  }, [imageBlob]);

  // Handle version blob (convert to text or image URL)
  useEffect(() => {
    if (versionBlob && selectedVersion) {
      if (isImage) {
        blobToDataURL(versionBlob).then(setVersionBlobUrl);
      } else {
        versionBlob.text().then((text) => {
          setLocalContent(text);
        }).catch((error) => {
          log.error('Failed to convert version blob to text:', error);
          setLocalContent('');
        });
      }
    } else if (!selectedVersion) {
      // Clear version blob URL when not viewing a version
      setVersionBlobUrl(undefined);
    }
  }, [versionBlob, isImage, selectedVersion]);

  // Initialize local content from text content (only when not viewing a version)
  useEffect(() => {
    if (!selectedVersion && textContent !== undefined) {
      const unsavedContent = getUnsavedContent(filePath);
      if (unsavedContent !== undefined && canEdit) {
        setLocalContent(unsavedContent);
        setIsEditing(true);
      } else {
        setLocalContent(textContent);
        setIsEditing(false);
      }
    } else if (!selectedVersion && textContent === undefined) {
      // Clear local content when switching away from version and textContent is not available yet
      setLocalContent('');
    }
  }, [textContent, filePath, getUnsavedContent, canEdit, selectedVersion]);

  const hasUnsavedChanges = useMemo(() => {
    if (!canEdit || !textContent) return false;
    return localContent !== textContent || getUnsavedState(filePath);
  }, [localContent, textContent, canEdit, filePath, getUnsavedState]);

  const handleSave = useCallback(async () => {
    if (!filePath || !sandboxId || !canEdit) return;

    try {
      setIsSaving(true);
      setSaveStatus('saving');

      const token = await getAuthToken();
      const response = await fetch(
        `${API_URL}/sandboxes/${sandboxId}/files`,
        {
          method: 'PUT',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            path: filePath,
            content: localContent,
          }),
        }
      );

      if (!response.ok) {
        throw new Error('Failed to save file');
      }

      clearUnsavedContent(filePath);
      setUnsavedState(filePath, false);
      setIsEditing(false);
      setSaveStatus('saved');
      await refetchFile();

      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);

      setTimeout(() => {
        setSaveStatus('idle');
      }, 2000);
    } catch (error) {
      log.error('Save error:', error);
      setSaveStatus('error');
      Alert.alert('Error', 'Failed to save file');
    } finally {
      setIsSaving(false);
    }
  }, [filePath, sandboxId, localContent, canEdit, clearUnsavedContent, setUnsavedState, refetchFile]);

  const [isDownloading, setIsDownloading] = useState(false);
  
  const handleDownload = useCallback(async () => {
    setIsDownloading(true);
    try {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

      const currentBlob = selectedVersion ? versionBlob : imageBlob;
      const currentContent = selectedVersion ? localContent : (localContent || textContent);

      // For binary files (images, PDFs, etc.) write to file and share
      if (currentBlob && isBinaryFile) {
        // Convert blob to base64
        const reader = new FileReader();
        const base64Data = await new Promise<string>((resolve, reject) => {
          reader.onloadend = () => {
            const result = reader.result as string;
            // Extract base64 data from data URL
            const base64 = result.split(',')[1];
            resolve(base64);
          };
          reader.onerror = reject;
          reader.readAsDataURL(currentBlob);
        });

        // Write to temporary file
        const fileUri = `${FileSystem.cacheDirectory}${fileName}`;
        await FileSystem.writeAsStringAsync(fileUri, base64Data, {
          encoding: FileSystem.EncodingType.Base64,
        });

        // Share the file
        const canShare = await Sharing.isAvailableAsync();
        if (canShare) {
          await Sharing.shareAsync(fileUri, {
            dialogTitle: `Download ${fileName}`,
          });
        } else {
          Alert.alert('Error', 'Sharing is not available on this device');
        }
      } else if (currentContent) {
        // For text files, write to file and share
        const fileUri = `${FileSystem.cacheDirectory}${fileName}`;
        await FileSystem.writeAsStringAsync(fileUri, currentContent);
        
        const canShare = await Sharing.isAvailableAsync();
        if (canShare) {
          await Sharing.shareAsync(fileUri, {
            dialogTitle: `Download ${fileName}`,
          });
        } else {
          // Fallback to Share API for text
          await Share.share({
            message: currentContent,
            title: fileName,
          });
        }
      } else {
        Alert.alert('Error', 'No content available to download');
      }
    } catch (error) {
      log.error('Download failed:', error);
      Alert.alert('Error', 'Failed to download file');
    } finally {
      setIsDownloading(false);
    }
  }, [imageBlob, versionBlob, textContent, localContent, fileName, selectedVersion, isBinaryFile]);

  const handleDiscard = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

    Alert.alert(
      'Discard Changes',
      'Are you sure you want to discard your unsaved changes? This action cannot be undone.',
      [
        {
          text: 'Cancel',
          style: 'cancel',
          onPress: () => {
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
          },
        },
        {
          text: 'Discard',
          style: 'destructive',
          onPress: () => {
            if (textContent !== undefined) {
              setLocalContent(textContent);
              clearUnsavedContent(filePath);
              setUnsavedState(filePath, false);
              setIsEditing(false);
              Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
            }
          },
        },
      ]
    );
  }, [textContent, filePath, clearUnsavedContent, setUnsavedState]);

  const handleContentChange = useCallback((content: string) => {
    setLocalContent(content);
    if (canEdit && filePath) {
      setUnsavedContent(filePath, content);
      setUnsavedState(filePath, true);
      setIsEditing(true);
    }
  }, [canEdit, filePath, setUnsavedContent, setUnsavedState]);

  const handleMarkdownFormat = useCallback((format: MarkdownFormat, extra?: string) => {
    const { newText, newCursorPosition, newSelectionEnd } = insertMarkdownFormat(
      localContent,
      selection.start,
      selection.end,
      format,
      extra
    );
    setLocalContent(newText);
    setSelection({ start: newCursorPosition, end: newSelectionEnd });
    if (canEdit && filePath) {
      setUnsavedContent(filePath, newText);
      setUnsavedState(filePath, true);
      setIsEditing(true);
    }
    // Set selection to new cursor position
    setTimeout(() => {
      markdownInputRef.current?.setNativeProps({
        selection: { start: newCursorPosition, end: newSelectionEnd },
      });
    }, 10);
  }, [localContent, selection, canEdit, filePath, setUnsavedContent, setUnsavedState]);

  const handleSelectionChange = useCallback((event: { nativeEvent: { selection: { start: number; end: number } } }) => {
    setSelection(event.nativeEvent.selection);
  }, []);

  const handleSelectVersion = async (version: FileVersion | null) => {
    setShowVersionModal(false);

    if (!version) {
      clearSelectedVersion();
      refetchFile();
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      return;
    }

    setSelectedVersion(version.commit, version.date);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  };

  const handleOpenRevertModal = async (commit: string) => {
    setRevertCommit(commit);
    setShowVersionModal(false);
    setShowRevertModal(true);
    setIsLoadingRevertInfo(true);
    setRevertMode('single'); // Default to single file

    try {
      const info = await fetchCommitInfo(sandboxId, commit, filePath);
      setRevertCommitInfo(info);
    } catch (error) {
      Alert.alert('Error', 'Failed to load commit info');
      setShowRevertModal(false);
    } finally {
      setIsLoadingRevertInfo(false);
    }
  };

  const handleRevert = async () => {
    if (!revertCommit) return;

    setIsReverting(true);
    try {
      const relativePath = filePath.startsWith('/workspace')
        ? filePath.replace(/^\/workspace\//, '')
        : filePath.replace(/^\//, '');

      await revertMutation.mutateAsync({
        sandboxId,
        commit: revertCommit,
        paths: revertMode === 'single' ? [relativePath] : undefined,
      });

      setShowRevertModal(false);
      clearSelectedVersion();
      clearUnsavedContent(filePath);
      await refetchFile();
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      Alert.alert('Success', 'Version restored successfully');
    } catch (error) {
      Alert.alert('Error', 'Failed to restore version');
    } finally {
      setIsReverting(false);
    }
  };

  const hasMultipleFiles = filePathList && filePathList.length > 1;
  const canNavigatePrev = hasMultipleFiles && currentFileIndex > 0;
  const canNavigateNext = hasMultipleFiles && currentFileIndex < (filePathList?.length || 0) - 1;

  const navigatePrevious = useCallback(() => {
    if (canNavigatePrev) {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      setCurrentFileIndex(currentFileIndex - 1);
    }
  }, [canNavigatePrev, currentFileIndex, setCurrentFileIndex]);

  const navigateNext = useCallback(() => {
    if (canNavigateNext) {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      setCurrentFileIndex(currentFileIndex + 1);
    }
  }, [canNavigateNext, currentFileIndex, setCurrentFileIndex]);

  const isLoading = isLoadingText || isLoadingImage || isLoadingVersionContent;
  const hasError = textError || imageError;

  const currentBlobUrl = selectedVersion ? versionBlobUrl : blobUrl;

  // Compute display content: use version content if viewing version, otherwise use current content
  const displayContent = useMemo(() => {
    if (isImage) {
      return null; // Images use blobUrl
    }
    if (selectedVersion) {
      // When viewing a version, use localContent (which should be set from versionBlob)
      return localContent || null;
    }
    // When viewing current version, use localContent if editing, otherwise textContent
    return localContent || textContent || null;
  }, [isImage, selectedVersion, localContent, textContent]);

  const renderVersionItem = ({ item, index }: { item: FileVersion; index: number }) => {
    const isCurrent = index === 0;
    const isSelected = isCurrent ? !selectedVersion : selectedVersion === item.commit;
    const parts = (item.message || '').split(':');

    return (
      <Pressable
        onPress={() => handleSelectVersion(isCurrent ? null : item)}
        className={`px-4 py-3 active:opacity-70 ${isSelected ? 'bg-card' : 'bg-transparent'}`}
      >
        <View className="flex-row items-start justify-between">
          <View className="flex-1 min-w-0 mr-2">
            <Text className="text-sm font-roobert-medium text-primary" numberOfLines={1}>
              {parts[0]}
            </Text>
            {parts.length > 1 && (
              <Text className="text-xs text-primary opacity-50 mt-0.5" numberOfLines={1}>
                {parts.slice(1).join(':').trim()}
              </Text>
            )}
            <Text className="text-xs text-primary opacity-50 mt-1">
              {new Date(item.date).toLocaleDateString('en-US', {
                month: 'short',
                day: 'numeric',
                year: new Date(item.date).getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined
              })} at {new Date(item.date).toLocaleTimeString('en-US', {
                hour: 'numeric',
                minute: '2-digit',
                hour12: true
              })}
            </Text>
          </View>

          <Pressable
            onPress={(e) => {
              e.stopPropagation?.();
              if (!isCurrent) handleOpenRevertModal(item.commit);
            }}
            disabled={isCurrent}
            className={`px-2 py-1 rounded-full bg-card border border-border active:opacity-70 ${isCurrent ? 'opacity-50' : ''}`}
          >
            <Text className="text-[11px] font-roobert-medium text-primary">
              {isCurrent ? 'Current' : 'Restore'}
            </Text>
          </Pressable>
        </View>
      </Pressable>
    );
  };

  return (
    <View className="flex-1">
      {/* Header */}
      <KortixComputerHeader
        icon={Home}
        onIconClick={goBackToBrowser}
        iconTitle="Back to files"
        fileName={fileName}
        actions={
          <View className="flex-row items-center gap-1.5">
            {/* File navigation */}
            {hasMultipleFiles && (
              <View className="flex-row items-center gap-1 mr-1">
                <Pressable
                  onPress={navigatePrevious}
                  disabled={!canNavigatePrev}
                  className={`h-9 w-9 items-center justify-center rounded-xl bg-card border border-border active:opacity-70 ${!canNavigatePrev ? 'opacity-50' : ''}`}
                >
                  <Icon
                    as={ChevronLeft}
                    size={17}
                    className="text-primary"
                    strokeWidth={2}
                  />
                </Pressable>
                <View className="w-14">
                  <Text className="text-xs font-roobert-medium tabular-nums text-center text-primary">
                    {currentFileIndex + 1}/{filePathList?.length || 0}
                  </Text>
                </View>
                <Pressable
                  onPress={navigateNext}
                  disabled={!canNavigateNext}
                  className={`h-9 w-9 items-center justify-center rounded-xl bg-card border border-border active:opacity-70 ${!canNavigateNext ? 'opacity-50' : ''}`}
                >
                  <Icon
                    as={ChevronRight}
                    size={17}
                    className="text-primary"
                    strokeWidth={2}
                  />
                </Pressable>
              </View>
            )}

            {/* Edit/Save/Discard for editable files */}
            {canEdit && (
              <>
                {isEditing ? (
                  <>
                    {hasUnsavedChanges && (
                      <Pressable
                        onPress={handleDiscard}
                        className="h-9 w-9 items-center justify-center rounded-xl bg-card border border-border active:opacity-70"
                      >
                        <Icon
                          as={X}
                          size={17}
                          className="text-primary"
                          strokeWidth={2}
                        />
                      </Pressable>
                    )}
                    <Pressable
                      onPress={handleSave}
                      disabled={!hasUnsavedChanges || saveStatus === 'saving'}
                      className={`h-9 w-9 items-center justify-center rounded-xl bg-card border border-border active:opacity-70 ${!hasUnsavedChanges ? 'opacity-50' : ''}`}
                    >
                      {saveStatus === 'saving' ? (
                        <KortixLoader size="small" customSize={17} />
                      ) : (
                        <Icon
                          as={saveStatus === 'saved' ? Check : saveStatus === 'error' ? AlertCircle : Save}
                          size={17}
                          className="text-primary"
                          strokeWidth={2}
                        />
                      )}
                    </Pressable>
                  </>
                ) : (
                  <Pressable
                    onPress={() => {
                      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                      setIsEditing(true);
                    }}
                    className="h-9 w-9 items-center justify-center rounded-xl bg-card border border-border active:opacity-70"
                  >
                    <Icon
                      as={Pencil}
                      size={17}
                      className="text-primary"
                      strokeWidth={2}
                    />
                  </Pressable>
                )}
              </>
            )}

            {/* History Button */}
            <Pressable
              onPress={() => {
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                setShowVersionModal(true);
                refetchVersions();
              }}
              className={`h-9 w-9 items-center justify-center rounded-xl bg-card border active:opacity-70 ${selectedVersion ? 'border-primary' : 'border-border'}`}
            >
              <Icon
                as={Clock}
                size={17}
                className={selectedVersion ? 'text-primary' : 'text-primary'}
                strokeWidth={2}
              />
            </Pressable>

            {/* Download button for non-editable files */}
            {!canEdit && (
              <Pressable
                onPress={handleDownload}
                disabled={isDownloading}
                className={`h-9 w-9 items-center justify-center rounded-xl bg-card border border-border active:opacity-70 ${isDownloading ? 'opacity-60' : ''}`}
              >
                {isDownloading ? (
                  <KortixLoader size="small" customSize={17} />
                ) : (
                  <Icon
                    as={Download}
                    size={17}
                    className="text-primary"
                    strokeWidth={2}
                  />
                )}
              </Pressable>
            )}
          </View>
        }
      />

      {/* Version Banner */}
      {selectedVersion && (
        <VersionBanner
          versionDate={selectedVersionDate || undefined}
          onReturnToCurrent={() => handleSelectVersion(null)}
        />
      )}

      {/* Content */}
      <View className="flex-1">
        {isLoading ? (
          <View className="flex-1 items-center justify-center">
            <KortixLoader size="large" />
            <Text className="text-sm text-primary opacity-50 mt-4">
              {isLoadingVersionContent ? 'Loading version...' : `Loading ${fileName}...`}
            </Text>
          </View>
        ) : hasError ? (
          <View className="flex-1 items-center justify-center p-8">
            <Icon
              as={AlertTriangle}
              size={48}
              className="text-primary opacity-50"
              strokeWidth={1.5}
            />
            <Text className="text-sm text-primary text-center mb-2 mt-4">
              Error Loading File
            </Text>
            <Text className="text-xs text-primary opacity-50 text-center">
              {String(textError || imageError)}
            </Text>
          </View>
        ) : isMarkdown ? (
          <View className="flex-1">
            {/* Markdown Toolbar - only show when editing */}
            <MarkdownToolbar
              onFormat={handleMarkdownFormat}
              isVisible={canEdit && isEditing}
              text={localContent}
              selection={selection}
            />
            <ScrollView
              className="flex-1"
              keyboardShouldPersistTaps="handled"
              keyboardDismissMode="on-drag">
              <HybridMarkdownEditor
                value={localContent}
                onChange={handleContentChange}
                onSelectionChange={handleSelectionChange}
                editable={canEdit && isEditing}
                isDark={isDark}
                markdownInputRef={markdownInputRef}
                isEditing={canEdit && isEditing}
              />
            </ScrollView>
          </View>
        ) : isText && canEdit ? (
          <ScrollView
            className="flex-1"
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="on-drag">
            <TextInput
              value={localContent}
              onChangeText={handleContentChange}
              multiline
              scrollEnabled={false}
              editable={isEditing}
              className="flex-1 px-4 py-4 font-roobert-mono text-sm text-primary"
              style={{
                backgroundColor: 'transparent',
                minHeight: 400,
              }}
              textAlignVertical="top"
              placeholder="Start typing..."
              placeholderTextColor={isDark ? '#71717a' : '#a1a1aa'}
            />
          </ScrollView>
        ) : (
          <FilePreview
            content={displayContent}
            fileName={fileName}
            previewType={previewType}
            blobUrl={currentBlobUrl}
            filePath={filePath}
            sandboxUrl={project?.sandbox?.sandbox_url}
          />
        )}
      </View>

      {/* Footer */}
      <View
        className="px-4 pt-4 border-t border-border bg-card"
        style={{ paddingBottom: Math.max(24, insets.bottom + 8) }}
      >
        <View className="flex-row items-center justify-between h-9">
          <View className="flex-row items-center gap-2">
            <View className="flex-row items-center gap-1.5 px-2 py-1 rounded-full border border-border">
              <Icon as={FileText} size={12} className="text-primary" />
              <Text className="text-xs font-roobert-medium text-primary">
                {fileExtension.toUpperCase() || 'FILE'}
              </Text>
            </View>
          </View>
          <Text className="text-xs text-primary opacity-50 truncate max-w-[200px]" numberOfLines={1}>
            {filePath}
          </Text>
        </View>
      </View>

      {/* Version History Modal */}
      <Modal
        visible={showVersionModal}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setShowVersionModal(false)}
      >
        <View className="flex-1 bg-background">
          <View className="px-4 py-3 border-b border-border bg-background flex-row items-center justify-between">
            <Text className="text-lg font-roobert-semibold text-primary">File History</Text>
            <Pressable
              onPress={() => setShowVersionModal(false)}
              className="h-9 w-9 items-center justify-center rounded-xl bg-card border border-border active:opacity-70"
            >
              <Icon as={X} size={17} className="text-primary" strokeWidth={2} />
            </Pressable>
          </View>

          {isLoadingVersions ? (
            <View className="flex-1 items-center justify-center">
              <KortixLoader size="large" />
              <Text className="text-sm text-primary opacity-50 mt-4">Loading history...</Text>
            </View>
          ) : versions.length === 0 ? (
            <View className="flex-1 items-center justify-center p-8">
              <Icon as={Clock} size={48} className="text-primary opacity-50" />
              <Text className="text-sm text-primary opacity-50 mt-4">No history available</Text>
            </View>
          ) : (
            <FlatList
              data={versions}
              renderItem={renderVersionItem}
              keyExtractor={(item) => item.commit}
              ItemSeparatorComponent={() => (
                <View className="h-px bg-border" />
              )}
            />
          )}
        </View>
      </Modal>

      {/* Revert Confirmation Modal */}
      <Modal
        visible={showRevertModal}
        animationType="fade"
        transparent
        onRequestClose={() => setShowRevertModal(false)}
      >
        <View className="flex-1 items-center justify-center px-4 bg-background/80">
          <View className="w-full max-w-md rounded-2xl p-4 bg-card border border-border">
            <Text className="text-lg font-roobert-semibold mb-2 text-primary">Restore Previous Version</Text>
            <Text className="text-sm text-primary opacity-50 mb-4">
              Choose to restore just this file or all files from this version snapshot.
            </Text>

            <View className="flex-row items-start gap-2 p-3 rounded-xl mb-4 bg-card border border-border">
              <Icon as={AlertTriangle} size={16} className="text-primary" strokeWidth={2} />
              <Text className="text-xs flex-1 text-primary opacity-70">
                This will replace current files with the selected version snapshot. Your current changes will be overwritten.
              </Text>
            </View>

            {isLoadingRevertInfo ? (
              <View className="py-8 items-center">
                <KortixLoader size="small" />
              </View>
            ) : revertCommitInfo ? (
              <View className="mb-4">
                <Text className="text-sm font-roobert-medium mb-1 text-primary">{revertCommitInfo.message}</Text>
                <Text className="text-xs text-primary opacity-50 mb-3">
                  {revertCommitInfo.date && new Date(revertCommitInfo.date).toLocaleDateString('en-US', {
                    month: 'short',
                    day: 'numeric',
                    year: 'numeric'
                  })}
                </Text>

                {/* Mode selection */}
                <View className="flex-row gap-2 mb-3">
                  <Pressable
                    onPress={() => setRevertMode('single')}
                    className={`flex-1 py-2 rounded-xl items-center active:opacity-70 ${revertMode === 'single' ? 'bg-primary' : 'bg-card border border-border'}`}
                  >
                    <Text className={`text-xs font-roobert-medium ${revertMode === 'single' ? 'text-background' : 'text-primary'}`}>
                      Just this file
                    </Text>
                  </Pressable>
                  <Pressable
                    onPress={() => setRevertMode('commit')}
                    className={`flex-1 py-2 rounded-xl items-center active:opacity-70 ${revertMode === 'commit' ? 'bg-primary' : 'bg-card border border-border'}`}
                  >
                    <Text className={`text-xs font-roobert-medium ${revertMode === 'commit' ? 'text-background' : 'text-primary'}`}>
                      Entire snapshot
                    </Text>
                  </Pressable>
                </View>

                {/* Files list */}
                {revertMode === 'single' ? (
                  <View className="rounded-xl p-2 bg-card border border-border">
                    <Text className="text-xs text-primary" numberOfLines={1}>{fileName}</Text>
                  </View>
                ) : revertCommitInfo.revert_files && revertCommitInfo.revert_files.length > 0 ? (
                  <View className="rounded-xl p-2 max-h-32 bg-card border border-border">
                    <ScrollView>
                      {revertCommitInfo.revert_files.slice(0, 10).map((f, i) => (
                        <View key={i} className="flex-row items-center justify-between py-1">
                          <Text className="text-xs text-primary flex-1" numberOfLines={1}>{f.path}</Text>
                          <Text className="text-xs text-primary opacity-50 ml-2">{f.status}</Text>
                        </View>
                      ))}
                      {revertCommitInfo.revert_files.length > 10 && (
                        <Text className="text-xs text-primary opacity-50 py-1">
                          ... and {revertCommitInfo.revert_files.length - 10} more files
                        </Text>
                      )}
                    </ScrollView>
                  </View>
                ) : null}
              </View>
            ) : null}

            <View className="flex-row gap-2">
              <Pressable
                onPress={() => setShowRevertModal(false)}
                disabled={isReverting}
                className="flex-1 py-3 rounded-xl items-center active:opacity-70 bg-card border border-border"
              >
                <Text className="text-sm font-roobert-medium text-primary">Cancel</Text>
              </Pressable>
              <Pressable
                onPress={handleRevert}
                disabled={isReverting}
                className="flex-1 py-3 rounded-xl items-center active:opacity-70 bg-primary"
              >
                {isReverting ? (
                  <View className="flex-row items-center gap-2">
                    <KortixLoader size="small" customSize={14} forceTheme="dark" />
                    <Text className="text-sm font-roobert-medium text-background">Restoring...</Text>
                  </View>
                ) : (
                  <Text className="text-sm font-roobert-medium text-background">Restore</Text>
                )}
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}
