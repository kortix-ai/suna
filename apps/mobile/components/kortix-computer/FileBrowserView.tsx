import React, { useState, useCallback, useMemo, useRef } from 'react';
import { View, ScrollView, Pressable, Alert } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { KortixLoader } from '@/components/ui';
import {
  File,
  Folder,
  Upload,
  Home,
  FileText,
  Archive,
  Presentation,
  Loader2,
} from 'lucide-react-native';
import { useColorScheme } from 'nativewind';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import { FileBreadcrumb } from '@/components/files/FileBreadcrumb';
import { useKortixComputerStore } from '@/stores/kortix-computer-store';
import {
  useSandboxFiles,
  useUploadFileToSandbox,
  useCreateSandboxDirectory,
} from '@/lib/files/hooks';
import type { SandboxFile } from '@/api/types';
import { API_URL, getAuthToken } from '@/api/config';

interface FileBrowserViewProps {
  sandboxId: string;
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

function normalizePath(path: string | null | undefined): string {
  if (!path || typeof path !== 'string') return '/workspace';
  const trimmed = path.trim();
  if (trimmed === '' || trimmed === '/') return '/workspace';
  return trimmed.startsWith('/workspace')
    ? trimmed
    : `/workspace/${trimmed.replace(/^\//, '')}`;
}

function getBreadcrumbSegments(path: string) {
  const normalized = normalizePath(path);
  const cleanPath = normalized.replace(/^\/workspace\/?/, '');

  if (!cleanPath) return [];

  const parts = cleanPath.split('/').filter(Boolean);
  let currentPath = '/workspace';

  return parts.map((part, index) => {
    currentPath = `${currentPath}/${part}`;
    return {
      name: part,
      path: currentPath,
      isLast: index === parts.length - 1,
    };
  });
}

export function FileBrowserView({
  sandboxId,
  project,
}: FileBrowserViewProps) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const insets = useSafeAreaInsets();

  const { currentPath, navigateToPath, openFile } = useKortixComputerStore();

  const [isUploading, setIsUploading] = useState(false);
  const [isDownloadingAll, setIsDownloadingAll] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState<{
    current: number;
    total: number;
    currentFile: string;
  } | null>(null);

  const {
    data: files = [],
    isLoading: isLoadingFiles,
    error: filesError,
    refetch: refetchFiles,
  } = useSandboxFiles(sandboxId, currentPath, {
    refetchOnMount: 'always',
    staleTime: 0,
    gcTime: 0,
  });

  const uploadMutation = useUploadFileToSandbox();
  const createFolderMutation = useCreateSandboxDirectory();

  const breadcrumbs = useMemo(() => getBreadcrumbSegments(currentPath), [currentPath]);

  const { folders, regularFiles } = useMemo(() => {
    if (!files || !Array.isArray(files)) {
      return { folders: [], regularFiles: [] };
    }
    const folders = files.filter(f => f.type === 'directory');
    const regularFiles = files.filter(f => f.type === 'file');
    return { folders, regularFiles };
  }, [files]);

  const navigateHome = useCallback(() => {
    navigateToPath('/workspace');
  }, [navigateToPath]);

  const navigateToBreadcrumb = useCallback(
    (path: string) => {
      navigateToPath(path);
    },
    [navigateToPath],
  );

  const isPresentationFolder = useCallback((file: SandboxFile): boolean => {
    if (file.type !== 'directory') return false;
    
    const pathParts = file.path.split('/').filter(Boolean);
    
    if (pathParts.length >= 3) {
      const parentIndex = pathParts.length - 2;
      if (pathParts[parentIndex] === 'presentations') {
        return true;
      }
    }
    
    return false;
  }, []);

  const handleItemClick = useCallback(
    (file: SandboxFile) => {
      if (file.type === 'directory') {
        if (isPresentationFolder(file)) {
          openFile(file.path);
        } else {
          navigateToPath(file.path);
        }
      } else {
        openFile(file.path);
      }
    },
    [navigateToPath, openFile, isPresentationFolder],
  );

  const handleUploadDocument = async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: '*/*',
        copyToCacheDirectory: true,
      });

      if (result.canceled) return;

      const file = result.assets[0];
      setIsUploading(true);

      await uploadMutation.mutateAsync({
        sandboxId,
        file: {
          uri: file.uri,
          name: file.name,
          type: file.mimeType || 'application/octet-stream',
        },
        destinationPath: `${currentPath}/${file.name}`,
      });

      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      await refetchFiles();
    } catch (error) {
      Alert.alert('Error', 'Failed to upload file');
    } finally {
      setIsUploading(false);
    }
  };

  const handleUploadImage = async () => {
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        allowsMultipleSelection: false,
        quality: 1,
      });

      if (result.canceled) return;

      const asset = result.assets[0];
      setIsUploading(true);

      await uploadMutation.mutateAsync({
        sandboxId,
        file: {
          uri: asset.uri,
          name: asset.fileName || 'image.jpg',
          type: asset.type === 'image' ? 'image/jpeg' : 'application/octet-stream',
        },
        destinationPath: `${currentPath}/${asset.fileName || 'image.jpg'}`,
      });

      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      await refetchFiles();
    } catch (error) {
      Alert.alert('Error', 'Failed to upload image');
    } finally {
      setIsUploading(false);
    }
  };

  const getFileIcon = useCallback((file: SandboxFile) => {
    if (file.type === 'directory') {
      if (isPresentationFolder(file)) {
        return <Presentation size={36} color={isDark ? '#f97316' : '#ea580c'} />;
      }
      return <Folder size={36} color={isDark ? '#60a5fa' : '#2563eb'} />;
    }
    
    const extension = file.name.split('.').pop()?.toLowerCase();
    
    if (['md', 'txt', 'doc'].includes(extension || '')) {
      return <FileText size={32} color={isDark ? 'rgba(248, 248, 248, 0.5)' : 'rgba(18, 18, 21, 0.5)'} />;
    }
    
    return <File size={32} color={isDark ? 'rgba(248, 248, 248, 0.5)' : 'rgba(18, 18, 21, 0.5)'} />;
  }, [isDark, isPresentationFolder]);

  const hasSandbox = !!(project?.sandbox?.id || sandboxId);
  const isComputerStarted = project?.sandbox?.sandbox_url ? true : false;

  return (
    <View className="flex-1">
      {/* Header with Breadcrumb Navigation */}
      <View
        className="px-4 py-2 border-b flex-row items-center justify-between"
        style={{
          backgroundColor: isDark ? 'rgba(248, 248, 248, 0.02)' : 'rgba(18, 18, 21, 0.02)',
          borderBottomColor: isDark ? 'rgba(248, 248, 248, 0.1)' : 'rgba(18, 18, 21, 0.1)',
        }}
      >
        {/* Breadcrumb */}
        <View className="flex-1 min-w-0 mr-2">
          <View className="flex-row items-center gap-3">
            <Pressable
              onPress={navigateHome}
              className="p-2 rounded-lg border flex-shrink-0"
              style={{
                backgroundColor: isDark ? 'rgba(248, 248, 248, 0.05)' : 'rgba(18, 18, 21, 0.05)',
                borderColor: isDark ? 'rgba(248, 248, 248, 0.15)' : 'rgba(18, 18, 21, 0.15)',
              }}
            >
              <Icon
                as={Home}
                size={20}
                color={isDark ? 'rgba(248, 248, 248, 0.6)' : 'rgba(18, 18, 21, 0.6)'}
                strokeWidth={2}
              />
            </Pressable>

            {currentPath === '/workspace' ? (
              <Text className="text-base font-roobert-medium">
                Files
              </Text>
            ) : (
              <FileBreadcrumb segments={breadcrumbs} onNavigate={navigateToBreadcrumb} />
            )}
          </View>
        </View>

        {/* Actions */}
        <View className="flex-row items-center gap-1.5 flex-shrink-0">
          {downloadProgress && (
            <View className="flex-row items-center gap-1.5 px-2">
              <Icon as={Loader2} size={12} className="text-muted-foreground animate-spin" />
              <Text className="text-xs text-muted-foreground">
                {downloadProgress.total > 0
                  ? `${downloadProgress.current}/${downloadProgress.total}`
                  : 'Preparing...'}
              </Text>
            </View>
          )}

          <Pressable
            onPress={handleUploadImage}
            disabled={isUploading}
            className="p-2 rounded-lg active:opacity-70"
            style={{
              backgroundColor: isDark ? 'rgba(248, 248, 248, 0.1)' : 'rgba(18, 18, 21, 0.05)',
            }}
          >
            {isUploading ? (
              <Icon as={Loader2} size={14} className="text-foreground animate-spin" />
            ) : (
              <Icon
                as={Upload}
                size={14}
                color={isDark ? '#f8f8f8' : '#121215'}
                strokeWidth={2}
              />
            )}
          </Pressable>
        </View>
      </View>

      {/* File Explorer */}
      <View className="flex-1">
        {isLoadingFiles ? (
          <View className="flex-1 items-center justify-center gap-2">
            <KortixLoader size="large" />
            <Text className="text-sm text-muted-foreground">
              Loading files...
            </Text>
          </View>
        ) : files.length === 0 ? (
          <View className="flex-1 items-center justify-center gap-2 p-8">
            <Icon
              as={Folder}
              size={48}
              color={isDark ? 'rgba(248, 248, 248, 0.3)' : 'rgba(18, 18, 21, 0.3)'}
              strokeWidth={1.5}
            />
            {!hasSandbox ? (
              <>
                <Text className="text-sm font-roobert-medium text-center">
                  Computer is not available yet
                </Text>
                <Text className="text-xs text-muted-foreground text-center">
                  A computer will be created when you start working on this task
                </Text>
              </>
            ) : !isComputerStarted ? (
              <>
                <Text className="text-sm font-roobert-medium text-center">
                  Computer is not started yet
                </Text>
                <Text className="text-xs text-muted-foreground text-center">
                  Files will appear once the computer is ready
                </Text>
              </>
            ) : (
              <Text className="text-sm text-muted-foreground text-center">
                Directory is empty
              </Text>
            )}
          </View>
        ) : (
          <ScrollView
            className="flex-1"
            showsVerticalScrollIndicator={false}
            contentContainerStyle={{ padding: 16 }}
          >
            <View className="flex-row flex-wrap gap-3">
              {folders.map((file) => (
                <Pressable
                  key={file.path}
                  onPress={() => handleItemClick(file)}
                  className="flex-col items-center p-3 rounded-2xl border min-w-[100px] max-w-[120px]"
                  style={{
                    backgroundColor: isDark ? 'rgba(248, 248, 248, 0.02)' : 'rgba(18, 18, 21, 0.02)',
                    borderColor: isDark ? 'rgba(248, 248, 248, 0.1)' : 'rgba(18, 18, 21, 0.1)',
                  }}
                >
                  {isPresentationFolder(file) && (
                    <View
                      className="absolute top-1 right-1"
                      style={{
                        backgroundColor: isDark ? 'rgba(251, 146, 60, 0.3)' : 'rgba(251, 146, 60, 0.1)',
                        borderRadius: 6,
                        paddingHorizontal: 6,
                        paddingVertical: 2,
                      }}
                    >
                      <Text
                        className="text-[10px] font-roobert-medium"
                        style={{
                          color: isDark ? '#fb923c' : '#c2410c',
                        }}
                      >
                        Presentation
                      </Text>
                    </View>
                  )}
                  <View className="w-12 h-12 items-center justify-center mb-1">
                    {getFileIcon(file)}
                  </View>
                  <Text className="text-xs text-center font-roobert-medium truncate max-w-full" numberOfLines={2}>
                    {file.name}
                  </Text>
                </Pressable>
              ))}

              {regularFiles.map((file) => (
                <Pressable
                  key={file.path}
                  onPress={() => handleItemClick(file)}
                  className="flex-col items-center p-3 rounded-2xl border min-w-[100px] max-w-[120px]"
                  style={{
                    backgroundColor: isDark ? 'rgba(248, 248, 248, 0.02)' : 'rgba(18, 18, 21, 0.02)',
                    borderColor: isDark ? 'rgba(248, 248, 248, 0.1)' : 'rgba(18, 18, 21, 0.1)',
                  }}
                >
                  <View className="w-12 h-12 items-center justify-center mb-1">
                    {getFileIcon(file)}
                  </View>
                  <Text className="text-xs text-center font-roobert-medium truncate max-w-full" numberOfLines={2}>
                    {file.name}
                  </Text>
                </Pressable>
              ))}
            </View>
          </ScrollView>
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
            <Icon as={Folder} size={12} className="mr-1" />
            <Text className="text-xs">
              {files.length} {files.length === 1 ? 'item' : 'items'}
            </Text>
          </View>
        </View>
        <Text className="text-xs text-muted-foreground truncate max-w-[200px]" numberOfLines={1}>
          {currentPath}
        </Text>
      </View>
    </View>
  );
}

