/**
 * File Viewer Modal
 * Full-screen file viewer with preview and actions
 */

import React, { useState, useEffect, useCallback } from 'react';
import { View, Modal, Pressable, Share, Platform, Alert } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { KortixLoader } from '@/components/ui';
import { X, Download, Share2, ChevronLeft, ChevronRight, Lock } from 'lucide-react-native';
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
import { FilePreview, FilePreviewType, getFilePreviewType } from './FilePreviewRenderers';
import { useSandboxFileContent, useSandboxImageBlob, blobToDataURL } from '@/lib/files/hooks';
import type { SandboxFile } from '@/api/types';
import { useBillingContext } from '@/contexts/BillingContext';
import { useRouter } from 'expo-router';
import { log } from '@/lib/logger';

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
}: FileViewerProps) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const router = useRouter();
  const closeScale = useSharedValue(1);
  const [blobUrl, setBlobUrl] = useState<string | undefined>();
  const [viewMode, setViewMode] = useState<'preview' | 'raw'>('preview');
  const [isDownloading, setIsDownloading] = useState(false);
  const { hasFreeTier } = useBillingContext();

  // Handle upgrade prompt for free tier users
  const handleUpgradePrompt = useCallback(() => {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    Alert.alert(
      'Upgrade Required',
      'Downloads and sharing are available on paid plans. Upgrade to unlock this feature.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Upgrade',
          onPress: () => {
            onClose();
            router.push('/plans');
          },
        },
      ]
    );
  }, [onClose, router]);

  const previewType = file ? getFilePreviewType(file.name) : FilePreviewType.OTHER;
  const isImage = previewType === FilePreviewType.IMAGE;
  // Binary file types that should be fetched as blob, not text
  const isBinaryFile = previewType === FilePreviewType.IMAGE || 
                       previewType === FilePreviewType.PDF ||
                       previewType === FilePreviewType.XLSX ||
                       previewType === FilePreviewType.BINARY;
  const shouldFetchText = file && !isBinaryFile;
  const shouldFetchBlob = file && isBinaryFile;
  
  // Can show raw view for non-binary files
  const canShowRaw =
    file && previewType !== FilePreviewType.BINARY && previewType !== FilePreviewType.OTHER;

  // Fetch file content for text-based files
  const {
    data: textContent,
    isLoading: isLoadingText,
    error: textError,
  } = useSandboxFileContent(
    shouldFetchText ? sandboxId : undefined,
    shouldFetchText ? file?.path : undefined
  );

  // Fetch blob for images
  const {
    data: imageBlob,
    isLoading: isLoadingImage,
    error: imageError,
  } = useSandboxImageBlob(
    shouldFetchBlob ? sandboxId : undefined,
    shouldFetchBlob ? file?.path : undefined
  );

  // Convert blob to data URL for binary files (images, PDFs, etc.)
  useEffect(() => {
    if (imageBlob && file?.path) {
      blobToDataURL(imageBlob, file.path).then(setBlobUrl);
    }
    return () => setBlobUrl(undefined);
  }, [imageBlob, file?.path]);

  const closeAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: closeScale.value }],
  }));

  const handleClose = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onClose();
  };

  const handleDownload = async () => {
    if (!file) return;

    // Block downloads for free tier users
    if (hasFreeTier) {
      handleUpgradePrompt();
      return;
    }

    setIsDownloading(true);
    try {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

      // For binary files (images, PDFs, etc.) write to file and share
      if (imageBlob && isBinaryFile) {
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
    } catch (error) {
      log.error('Download failed:', error);
    } finally {
      setIsDownloading(false);
    }
  };

  const handleShare = async () => {
    if (!file) return;

    // Block sharing for free tier users
    if (hasFreeTier) {
      handleUpgradePrompt();
      return;
    }

    try {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);

      // For binary files (images, PDFs, etc.) use blob URL
      if (blobUrl) {
        await Share.share({
          url: blobUrl,
          title: file.name,
        });
        return;
      }
      
      // For text files, share the content
      if (textContent) {
        await Share.share({
          message: textContent,
          title: file.name,
        });
      }
    } catch (error) {
      log.error('Share failed:', error);
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

  const isLoading = isLoadingText || isLoadingImage;
  const hasError = textError || imageError;
  const canNavigate = fileList && fileList.length > 1 && currentIndex >= 0;

  const insets = useSafeAreaInsets();

  if (!visible || !file) {
    return null;
  }

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="fullScreen"
      onRequestClose={handleClose}>
      <View className="flex-1" style={{ backgroundColor: isDark ? '#121215' : '#ffffff' }}>
        {/* Header */}
        <View
          style={{
            paddingTop: insets.top,
            backgroundColor: isDark ? '#121215' : '#ffffff',
            borderBottomWidth: 1,
            borderBottomColor: isDark ? 'rgba(248, 248, 248, 0.1)' : 'rgba(18, 18, 21, 0.1)',
          }}>
          <Animated.View
            entering={FadeIn.duration(200)}
            exiting={FadeOut.duration(200)}
            className="flex-row items-center justify-between px-4 py-4">
            <View className="mr-4 min-w-0 flex-1">
              <Text
                style={{ color: isDark ? '#f8f8f8' : '#121215' }}
                className="font-roobert-medium text-base"
                numberOfLines={1}>
                {file.name}
              </Text>
              {canNavigate && (
                <Text
                  style={{ color: isDark ? 'rgba(248, 248, 248, 0.5)' : 'rgba(18, 18, 21, 0.5)' }}
                  className="mt-0.5 font-roobert text-xs">
                  {currentIndex + 1} of {fileList?.length}
                </Text>
              )}
            </View>

            {/* Action Buttons */}
            <View className="flex-row items-center gap-3">
              {canNavigate && (
                <>
                  <AnimatedPressable
                    onPress={handlePrevious}
                    disabled={currentIndex <= 0}
                    className="p-2"
                    style={{ opacity: currentIndex <= 0 ? 0.3 : 1 }}>
                    <Icon
                      as={ChevronLeft}
                      size={24}
                      color={isDark ? '#f8f8f8' : '#121215'}
                      strokeWidth={2}
                    />
                  </AnimatedPressable>
                  <AnimatedPressable
                    onPress={handleNext}
                    disabled={currentIndex >= (fileList?.length || 0) - 1}
                    className="p-2"
                    style={{ opacity: currentIndex >= (fileList?.length || 0) - 1 ? 0.3 : 1 }}>
                    <Icon
                      as={ChevronRight}
                      size={24}
                      color={isDark ? '#f8f8f8' : '#121215'}
                      strokeWidth={2}
                    />
                  </AnimatedPressable>
                </>
              )}
              <AnimatedPressable 
                onPress={handleDownload} 
                disabled={isDownloading}
                className="relative p-2"
                style={{ opacity: isDownloading ? 0.6 : 1 }}>
                {isDownloading ? (
                  <KortixLoader size={22} />
                ) : (
                  <Icon
                    as={hasFreeTier ? Lock : Download}
                    size={22}
                    color={
                      hasFreeTier ? (isDark ? '#a78bfa' : '#7c3aed') : isDark ? '#f8f8f8' : '#121215'
                    }
                    strokeWidth={2}
                  />
                )}
              </AnimatedPressable>
              <AnimatedPressable onPress={handleShare} className="relative p-2">
                <Icon
                  as={hasFreeTier ? Lock : Share2}
                  size={22}
                  color={
                    hasFreeTier ? (isDark ? '#a78bfa' : '#7c3aed') : isDark ? '#f8f8f8' : '#121215'
                  }
                  strokeWidth={2}
                />
              </AnimatedPressable>
              <AnimatedPressable
                onPressIn={() => {
                  closeScale.value = withSpring(0.9, { damping: 15, stiffness: 400 });
                }}
                onPressOut={() => {
                  closeScale.value = withSpring(1, { damping: 15, stiffness: 400 });
                }}
                onPress={handleClose}
                style={closeAnimatedStyle}
                className="p-2">
                <Icon as={X} size={24} color={isDark ? '#f8f8f8' : '#121215'} strokeWidth={2} />
              </AnimatedPressable>
            </View>
          </Animated.View>
        </View>

        {/* Content */}
        <View className="flex-1">
          {isLoading ? (
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
            />
          )}
        </View>
      </View>
    </Modal>
  );
}
