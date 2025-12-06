import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { View, ScrollView, TextInput, Pressable, Alert, Share } from 'react-native';
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
} from 'lucide-react-native';
import { useColorScheme } from 'nativewind';
import * as Haptics from 'expo-haptics';
import { FilePreview, FilePreviewType, getFilePreviewType } from '@/components/files/FilePreviewRenderers';
import {
  useSandboxFileContent,
  useSandboxImageBlob,
  blobToDataURL,
} from '@/lib/files/hooks';
import { useKortixComputerStore } from '@/stores/kortix-computer-store';
import { API_URL, getAuthToken } from '@/api/config';
import Markdown from 'react-native-markdown-display';
import { markdownStyles, markdownStylesDark } from '@/lib/utils/markdown-styles';

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
  } = useKortixComputerStore();

  const [blobUrl, setBlobUrl] = useState<string | undefined>();
  const [isSaving, setIsSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [localContent, setLocalContent] = useState<string>('');
  const [isEditing, setIsEditing] = useState(false);

  const fileName = filePath.split('/').pop() || '';
  const fileExtension = fileName.split('.').pop()?.toLowerCase() || '';
  const previewType = getFilePreviewType(fileName);
  const isImage = previewType === FilePreviewType.IMAGE;
  const isMarkdown = previewType === FilePreviewType.MARKDOWN;
  const isText = previewType === FilePreviewType.TEXT || previewType === FilePreviewType.CODE;
  const canEdit = isMarkdown || isText;

  const shouldFetchText = !isImage && canEdit;
  const shouldFetchBlob = isImage;

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

  useEffect(() => {
    if (imageBlob) {
      blobToDataURL(imageBlob).then(setBlobUrl);
    }
    return () => setBlobUrl(undefined);
  }, [imageBlob]);

  useEffect(() => {
    if (textContent !== undefined) {
      const unsavedContent = getUnsavedContent(filePath);
      if (unsavedContent !== undefined && canEdit) {
        setLocalContent(unsavedContent);
        setIsEditing(true);
      } else {
        setLocalContent(textContent);
        setIsEditing(false);
      }
    }
  }, [textContent, filePath, getUnsavedContent, canEdit]);

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

      if (isImage && blobUrl) {
        await Share.share({
          url: blobUrl,
          title: fileName,
        });
      } else if (textContent) {
        await Share.share({
          message: textContent,
          title: fileName,
        });
      }
    } catch (error) {
      console.error('Download failed:', error);
      Alert.alert('Error', 'Failed to download file');
    }
  }, [isImage, blobUrl, textContent, fileName]);

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

  const isLoading = isLoadingText || isLoadingImage;
  const hasError = textError || imageError;

  return (
    <View className="flex-1">
      {/* Header - No safe area padding needed, parent KortixComputer handles it */}
      <View
        className="px-4 py-3 border-b flex-row items-center justify-between"
        style={{
          backgroundColor: isDark ? 'rgba(248, 248, 248, 0.02)' : 'rgba(18, 18, 21, 0.02)',
          borderBottomColor: isDark ? 'rgba(248, 248, 248, 0.1)' : 'rgba(18, 18, 21, 0.1)',
        }}
      >
        <View className="flex-row items-center flex-1 min-w-0">
          <Pressable
            onPress={goBackToBrowser}
            className="p-2 rounded-lg border flex-shrink-0"
            style={{
              backgroundColor: isDark ? 'rgba(248, 248, 248, 0.05)' : 'rgba(18, 18, 21, 0.05)',
              borderColor: isDark ? 'rgba(248, 248, 248, 0.15)' : 'rgba(18, 18, 21, 0.15)',
              marginRight: 12,
            }}
          >
            <Icon
              as={Home}
              size={20}
              color={isDark ? 'rgba(248, 248, 248, 0.6)' : 'rgba(18, 18, 21, 0.6)'}
              strokeWidth={2}
            />
          </Pressable>

          <Text 
            className="text-base font-roobert-medium flex-1 min-w-0" 
            numberOfLines={1}
            style={{ 
              paddingRight: 8,
            }}
          >
            {fileName}
          </Text>
        </View>

        <View className="flex-row items-center gap-1.5 flex-shrink-0 ml-2">
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
                  <Icon as={Save} size={14} className="text-muted-foreground" />
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
      </View>

      {/* Content */}
      <View className="flex-1">
        {isLoading ? (
          <View className="flex-1 items-center justify-center">
            <KortixLoader size="large" />
            <Text className="text-sm text-muted-foreground mt-4">
              Loading {fileName}...
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
            {isMarkdown ? (
              <View className="flex-1">
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
              </View>
            ) : (
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
            )}
          </ScrollView>
        ) : (
          <FilePreview
            content={isImage ? null : localContent || textContent || null}
            fileName={fileName}
            previewType={previewType}
            blobUrl={blobUrl}
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
    </View>
  );
}

