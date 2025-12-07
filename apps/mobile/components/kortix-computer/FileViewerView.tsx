import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { View, ScrollView, TextInput, Pressable, Alert, Share, Modal, FlatList } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { KortixLoader } from '@/components/ui';
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
  Loader2,
} from 'lucide-react-native';
import { useColorScheme } from 'nativewind';
import * as Haptics from 'expo-haptics';
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

  const fileName = filePath.split('/').pop() || '';
  const fileExtension = fileName.split('.').pop()?.toLowerCase() || '';
  const previewType = getFilePreviewType(fileName);
  const isImage = previewType === FilePreviewType.IMAGE;
  const isMarkdown = previewType === FilePreviewType.MARKDOWN;
  const isText = previewType === FilePreviewType.TEXT || previewType === FilePreviewType.CODE;
  const canEdit = (isMarkdown || isText) && !selectedVersion;

  const shouldFetchText = !isImage && !selectedVersion;
  const shouldFetchBlob = isImage && !selectedVersion;

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
          console.error('Failed to convert version blob to text:', error);
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
      console.error('Save error:', error);
      setSaveStatus('error');
      Alert.alert('Error', 'Failed to save file');
    } finally {
      setIsSaving(false);
    }
  }, [filePath, sandboxId, localContent, canEdit, clearUnsavedContent, setUnsavedState, refetchFile]);

  const handleDownload = useCallback(async () => {
    try {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

      const currentBlobUrl = selectedVersion ? versionBlobUrl : blobUrl;
      const currentContent = selectedVersion ? localContent : (localContent || textContent);

      if (isImage && currentBlobUrl) {
        await Share.share({
          url: currentBlobUrl,
          title: fileName,
        });
      } else if (currentContent) {
        await Share.share({
          message: currentContent,
          title: fileName,
        });
      }
    } catch (error) {
      console.error('Download failed:', error);
      Alert.alert('Error', 'Failed to download file');
    }
  }, [isImage, blobUrl, versionBlobUrl, textContent, localContent, fileName, selectedVersion]);

  const handleDiscard = useCallback(() => {
    if (textContent !== undefined) {
      setLocalContent(textContent);
      clearUnsavedContent(filePath);
      setUnsavedState(filePath, false);
      setIsEditing(false);
    }
  }, [textContent, filePath, clearUnsavedContent, setUnsavedState]);

  const handleContentChange = useCallback((content: string) => {
    setLocalContent(content);
    if (canEdit && filePath) {
      setUnsavedContent(filePath, content);
      setUnsavedState(filePath, true);
      setIsEditing(true);
    }
  }, [canEdit, filePath, setUnsavedContent, setUnsavedState]);

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
        className="px-4 py-3 active:opacity-70"
        style={{
          backgroundColor: isSelected 
            ? (isDark ? 'rgba(248, 248, 248, 0.1)' : 'rgba(18, 18, 21, 0.05)')
            : 'transparent',
        }}
      >
        <View className="flex-row items-start justify-between">
          <View className="flex-1 min-w-0 mr-2">
            <Text className="text-sm font-roobert-medium text-foreground" numberOfLines={1}>
              {parts[0]}
            </Text>
            {parts.length > 1 && (
              <Text className="text-xs text-muted-foreground mt-0.5" numberOfLines={1}>
                {parts.slice(1).join(':').trim()}
              </Text>
            )}
            <Text className="text-xs text-muted-foreground mt-1">
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
            className="px-2 py-1 rounded-full active:opacity-70"
            style={{
              backgroundColor: isDark ? 'rgba(248, 248, 248, 0.1)' : 'rgba(18, 18, 21, 0.05)',
              borderWidth: 1,
              borderColor: isDark ? 'rgba(248, 248, 248, 0.15)' : 'rgba(18, 18, 21, 0.15)',
              opacity: isCurrent ? 0.5 : 1,
            }}
          >
            <Text className="text-[11px] font-roobert-medium text-foreground">
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
                  className="p-1 rounded active:opacity-70"
                  style={{ opacity: canNavigatePrev ? 1 : 0.3 }}
                >
                  <Icon
                    as={ChevronLeft}
                    size={14}
                    color={isDark ? '#f8f8f8' : '#121215'}
                    strokeWidth={2}
                  />
                </Pressable>
                <Text className="text-[10px] text-muted-foreground tabular-nums min-w-[32px] text-center">
                  {currentFileIndex + 1}/{filePathList?.length || 0}
                </Text>
                <Pressable
                  onPress={navigateNext}
                  disabled={!canNavigateNext}
                  className="p-1 rounded active:opacity-70"
                  style={{ opacity: canNavigateNext ? 1 : 0.3 }}
                >
                  <Icon
                    as={ChevronRight}
                    size={14}
                    color={isDark ? '#f8f8f8' : '#121215'}
                    strokeWidth={2}
                  />
                </Pressable>
              </View>
            )}

            {/* Save/Discard for editable files */}
            {canEdit && (
              <>
                {hasUnsavedChanges && (
                  <Pressable
                    onPress={handleDiscard}
                    className="px-2 py-1 rounded active:opacity-70"
                  >
                    <Text className="text-xs text-muted-foreground">Discard</Text>
                  </Pressable>
                )}
                {saveStatus === 'saving' ? (
                  <Pressable className="px-2 py-1 rounded" disabled>
                    <Icon as={Loader2} size={14} className="text-muted-foreground" />
                  </Pressable>
                ) : saveStatus === 'saved' ? (
                  <Pressable className="px-2 py-1 rounded" disabled>
                    <Icon as={Check} size={14} color="#22c55e" strokeWidth={2} />
                  </Pressable>
                ) : saveStatus === 'error' ? (
                  <Pressable onPress={handleSave} className="px-2 py-1 rounded active:opacity-70">
                    <Icon as={AlertCircle} size={14} color="#ef4444" strokeWidth={2} />
                  </Pressable>
                ) : (
                  <Pressable
                    onPress={handleSave}
                    disabled={!hasUnsavedChanges}
                    className="px-2 py-1 rounded active:opacity-70"
                    style={{ opacity: hasUnsavedChanges ? 1 : 0.3 }}
                  >
                    <Icon
                      as={Save}
                      size={14}
                      color={hasUnsavedChanges ? (isDark ? '#f8f8f8' : '#121215') : (isDark ? 'rgba(248, 248, 248, 0.3)' : 'rgba(18, 18, 21, 0.3)')}
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
              className="flex-row items-center gap-1.5 px-2 py-1.5 rounded-lg active:opacity-70"
              style={{
                backgroundColor: isDark ? 'rgba(248, 248, 248, 0.1)' : 'rgba(18, 18, 21, 0.05)',
                borderWidth: 1,
                borderColor: isDark ? 'rgba(248, 248, 248, 0.1)' : 'rgba(18, 18, 21, 0.1)',
              }}
            >
              <Icon
                as={Clock}
                size={14}
                color={isDark ? '#f8f8f8' : '#121215'}
                strokeWidth={2}
              />
              <Text className="text-xs font-roobert-medium text-foreground">
                {selectedVersion && selectedVersionDate ? (
                  new Date(selectedVersionDate).toLocaleDateString('en-US', {
                    month: 'short',
                    day: 'numeric'
                  })
                ) : (
                  'History'
                )}
              </Text>
              <Icon
                as={ChevronDown}
                size={12}
                color={isDark ? '#f8f8f8' : '#121215'}
                strokeWidth={2}
              />
            </Pressable>

            {/* Download button for non-editable files */}
            {!canEdit && (
              <Pressable
                onPress={handleDownload}
                className="px-2 py-1 rounded active:opacity-70"
              >
                <Icon
                  as={Download}
                  size={14}
                  color={isDark ? '#f8f8f8' : '#121215'}
                  strokeWidth={2}
                />
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
            <Text className="text-sm text-muted-foreground mt-4">
              {isLoadingVersionContent ? 'Loading version...' : `Loading ${fileName}...`}
            </Text>
          </View>
        ) : hasError ? (
          <View className="flex-1 items-center justify-center p-8">
            <Icon
              as={AlertTriangle}
              size={48}
              color="#ef4444"
              strokeWidth={1.5}
            />
            <Text className="text-sm text-destructive text-center mb-2 mt-4">
              Error Loading File
            </Text>
            <Text className="text-xs text-muted-foreground text-center">
              {String(textError || imageError)}
            </Text>
          </View>
        ) : canEdit && isEditing ? (
          <ScrollView className="flex-1" keyboardShouldPersistTaps="handled">
            <TextInput
              value={localContent}
              onChangeText={handleContentChange}
              multiline
              className="flex-1 px-4 py-4 font-mono text-sm"
              style={{
                color: isDark ? '#f8f8f8' : '#121215',
                backgroundColor: 'transparent',
                minHeight: 400,
              }}
              textAlignVertical="top"
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
        className="px-4 py-2 border-t flex-row items-center justify-between"
        style={{
          backgroundColor: isDark ? 'rgba(248, 248, 248, 0.02)' : 'rgba(18, 18, 21, 0.02)',
          borderTopColor: isDark ? 'rgba(248, 248, 248, 0.1)' : 'rgba(18, 18, 21, 0.1)',
        }}
      >
        <View className="flex-row items-center gap-2">
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              borderRadius: 6,
              paddingHorizontal: 8,
              paddingVertical: 4,
              borderWidth: 1,
              borderColor: isDark ? 'rgba(248, 248, 248, 0.2)' : 'rgba(18, 18, 21, 0.2)',
            }}
          >
            <Icon as={FileText} size={12} className="mr-1" />
            <Text className="text-xs">
              {fileExtension.toUpperCase() || 'FILE'}
            </Text>
          </View>
        </View>
        <Text className="text-xs text-muted-foreground truncate max-w-[200px]" numberOfLines={1}>
          {filePath}
        </Text>
      </View>

      {/* Version History Modal */}
      <Modal
        visible={showVersionModal}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setShowVersionModal(false)}
      >
        <View className="flex-1" style={{ backgroundColor: isDark ? '#121215' : '#ffffff' }}>
          <View
            className="px-4 py-3 border-b flex-row items-center justify-between"
            style={{
              borderBottomColor: isDark ? 'rgba(248, 248, 248, 0.1)' : 'rgba(18, 18, 21, 0.1)',
            }}
          >
            <Text className="text-lg font-roobert-semibold">File History</Text>
            <Pressable
              onPress={() => setShowVersionModal(false)}
              className="p-2 rounded-lg active:opacity-70"
              style={{
                backgroundColor: isDark ? 'rgba(248, 248, 248, 0.1)' : 'rgba(18, 18, 21, 0.05)',
              }}
            >
              <Icon as={X} size={20} color={isDark ? '#f8f8f8' : '#121215'} strokeWidth={2} />
            </Pressable>
          </View>

          {isLoadingVersions ? (
            <View className="flex-1 items-center justify-center">
              <KortixLoader size="large" />
              <Text className="text-sm text-muted-foreground mt-4">Loading history...</Text>
            </View>
          ) : versions.length === 0 ? (
            <View className="flex-1 items-center justify-center p-8">
              <Icon as={Clock} size={48} color={isDark ? 'rgba(248, 248, 248, 0.3)' : 'rgba(18, 18, 21, 0.3)'} />
              <Text className="text-sm text-muted-foreground mt-4">No history available</Text>
            </View>
          ) : (
            <FlatList
              data={versions}
              renderItem={renderVersionItem}
              keyExtractor={(item) => item.commit}
              ItemSeparatorComponent={() => (
                <View
                  style={{
                    height: 1,
                    backgroundColor: isDark ? 'rgba(248, 248, 248, 0.05)' : 'rgba(18, 18, 21, 0.05)',
                  }}
                />
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
        <View className="flex-1 items-center justify-center px-4" style={{ backgroundColor: 'rgba(0,0,0,0.5)' }}>
          <View
            className="w-full max-w-md rounded-2xl p-4"
            style={{ backgroundColor: isDark ? '#1a1a1d' : '#ffffff' }}
          >
            <Text className="text-lg font-roobert-semibold mb-2">Restore Previous Version</Text>
            <Text className="text-sm text-muted-foreground mb-4">
              Choose to restore just this file or all files from this version snapshot.
            </Text>

            <View
              className="flex-row items-start gap-2 p-3 rounded-xl mb-4"
              style={{
                backgroundColor: isDark ? 'rgba(239, 68, 68, 0.1)' : 'rgba(239, 68, 68, 0.05)',
                borderWidth: 1,
                borderColor: isDark ? 'rgba(239, 68, 68, 0.2)' : 'rgba(239, 68, 68, 0.15)',
              }}
            >
              <Icon as={AlertTriangle} size={16} color="#ef4444" strokeWidth={2} />
              <Text className="text-xs flex-1" style={{ color: isDark ? '#fca5a5' : '#dc2626' }}>
                This will replace current files with the selected version snapshot. Your current changes will be overwritten.
              </Text>
            </View>

            {isLoadingRevertInfo ? (
              <View className="py-8 items-center">
                <KortixLoader size="small" />
              </View>
            ) : revertCommitInfo ? (
              <View className="mb-4">
                <Text className="text-sm font-roobert-medium mb-1">{revertCommitInfo.message}</Text>
                <Text className="text-xs text-muted-foreground mb-3">
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
                    className="flex-1 py-2 rounded-xl items-center active:opacity-70"
                    style={{
                      backgroundColor: revertMode === 'single' 
                        ? '#3b82f6' 
                        : (isDark ? 'rgba(248, 248, 248, 0.1)' : 'rgba(18, 18, 21, 0.05)'),
                    }}
                  >
                    <Text 
                      className="text-xs font-roobert-medium"
                      style={{ color: revertMode === 'single' ? '#ffffff' : (isDark ? '#f8f8f8' : '#121215') }}
                    >
                      Just this file
                    </Text>
                  </Pressable>
                  <Pressable
                    onPress={() => setRevertMode('commit')}
                    className="flex-1 py-2 rounded-xl items-center active:opacity-70"
                    style={{
                      backgroundColor: revertMode === 'commit' 
                        ? '#3b82f6' 
                        : (isDark ? 'rgba(248, 248, 248, 0.1)' : 'rgba(18, 18, 21, 0.05)'),
                    }}
                  >
                    <Text 
                      className="text-xs font-roobert-medium"
                      style={{ color: revertMode === 'commit' ? '#ffffff' : (isDark ? '#f8f8f8' : '#121215') }}
                    >
                      Entire snapshot
                    </Text>
                  </Pressable>
                </View>

                {/* Files list */}
                {revertMode === 'single' ? (
                  <View
                    className="rounded-xl p-2"
                    style={{
                      backgroundColor: isDark ? 'rgba(248, 248, 248, 0.05)' : 'rgba(18, 18, 21, 0.02)',
                      borderWidth: 1,
                      borderColor: isDark ? 'rgba(248, 248, 248, 0.1)' : 'rgba(18, 18, 21, 0.1)',
                    }}
                  >
                    <Text className="text-xs text-foreground" numberOfLines={1}>{fileName}</Text>
                  </View>
                ) : revertCommitInfo.revert_files && revertCommitInfo.revert_files.length > 0 ? (
                  <View
                    className="rounded-xl p-2 max-h-32"
                    style={{
                      backgroundColor: isDark ? 'rgba(248, 248, 248, 0.05)' : 'rgba(18, 18, 21, 0.02)',
                      borderWidth: 1,
                      borderColor: isDark ? 'rgba(248, 248, 248, 0.1)' : 'rgba(18, 18, 21, 0.1)',
                    }}
                  >
                    <ScrollView>
                      {revertCommitInfo.revert_files.slice(0, 10).map((f, i) => (
                        <View key={i} className="flex-row items-center justify-between py-1">
                          <Text className="text-xs text-foreground flex-1" numberOfLines={1}>{f.path}</Text>
                          <Text className="text-xs text-muted-foreground ml-2">{f.status}</Text>
                        </View>
                      ))}
                      {revertCommitInfo.revert_files.length > 10 && (
                        <Text className="text-xs text-muted-foreground py-1">
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
                className="flex-1 py-3 rounded-xl items-center active:opacity-70"
                style={{
                  backgroundColor: isDark ? 'rgba(248, 248, 248, 0.1)' : 'rgba(18, 18, 21, 0.05)',
                }}
              >
                <Text className="text-sm font-roobert-medium text-foreground">Cancel</Text>
              </Pressable>
              <Pressable
                onPress={handleRevert}
                disabled={isReverting}
                className="flex-1 py-3 rounded-xl items-center active:opacity-70"
                style={{
                  backgroundColor: '#3b82f6',
                }}
              >
                {isReverting ? (
                  <View className="flex-row items-center gap-2">
                    <Icon as={Loader2} size={14} color="#ffffff" />
                    <Text className="text-sm font-roobert-medium" style={{ color: '#ffffff' }}>Restoring...</Text>
                  </View>
                ) : (
                  <Text className="text-sm font-roobert-medium" style={{ color: '#ffffff' }}>Restore</Text>
                )}
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}
