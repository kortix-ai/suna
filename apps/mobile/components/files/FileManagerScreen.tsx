/**
 * File Manager Screen
 * Main file manager interface with navigation and operations
 */

import React, { useState, useMemo } from 'react';
import { View, ScrollView, Pressable, Alert, TextInput, RefreshControl } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { KortixLoader } from '@/components/ui';
import { 
  Upload, 
  FolderPlus, 
  Trash2, 
  Coffee,
  X,
  Check,
  AlertCircle,
  RefreshCw,
} from 'lucide-react-native';
import { useColorScheme } from 'nativewind';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  FadeIn,
} from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';
import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import BottomSheet, { BottomSheetScrollView } from '@gorhom/bottom-sheet';

import { FileItem } from './FileItem';
import { FileBreadcrumb } from './FileBreadcrumb';
import { FileViewer } from './FileViewer';

import { 
  useSandboxFiles,
  useUploadFileToSandbox,
  useDeleteSandboxFile,
  useCreateSandboxDirectory,
} from '@/lib/files/hooks';
import type { SandboxFile } from '@/api/types';

// Helper functions
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

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

interface FileManagerScreenProps {
  sandboxId: string;
  sandboxUrl?: string;
  onClose: () => void;
  initialFilePath?: string;
  isStreaming?: boolean;
}

/**
 * File Manager Screen Component
 */
export function FileManagerScreen({ sandboxId, sandboxUrl, onClose, initialFilePath, isStreaming = false }: FileManagerScreenProps) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';

  // Navigation state
  const [currentPath, setCurrentPath] = useState(() => {
    if (initialFilePath) {
      const dir = initialFilePath.substring(0, initialFilePath.lastIndexOf('/'));
      return dir || '/workspace';
    }
    return '/workspace';
  });
  
  // Viewer state
  const [viewerVisible, setViewerVisible] = useState(!!initialFilePath);
  const [selectedFile, setSelectedFile] = useState<SandboxFile | null>(() => {
    if (initialFilePath) {
      const fileName = initialFilePath.split('/').pop() || '';
      return {
        path: initialFilePath,
        name: fileName,
        type: 'file',
        size: 0,
      } as SandboxFile;
    }
    return null;
  });

  // Create folder state
  const [showCreateFolder, setShowCreateFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');

  // Fetch files for current path
  const { data: files, isLoading, error, refetch, isRefetching } = useSandboxFiles(sandboxId, currentPath, {
    refetchOnMount: 'always',
    refetchOnWindowFocus: true,
    staleTime: 0,
    gcTime: 0,
  });

  React.useEffect(() => {
    if (sandboxId) {
      refetch();
    }
  }, [sandboxId, refetch]);

  // Refetch when currentPath changes
  React.useEffect(() => {
    refetch();
  }, [currentPath, refetch]);

  // Track previous streaming state
  const wasStreamingRef = React.useRef(isStreaming);
  
  // Refetch when streaming ends
  React.useEffect(() => { 
    if (wasStreamingRef.current && !isStreaming) {
      console.log('[FileManagerScreen] Streaming ended, refetching files...');
      // Delay refetch to ensure backend has processed files
      const timer = setTimeout(() => {
        refetch();
      }, 1000);
      return () => clearTimeout(timer);
    }
    wasStreamingRef.current = isStreaming;
  }, [isStreaming, refetch]);

  // Mutations
  const uploadMutation = useUploadFileToSandbox();
  const deleteMutation = useDeleteSandboxFile();
  const createFolderMutation = useCreateSandboxDirectory();

  // Breadcrumb segments
  const breadcrumbs = useMemo(() => getBreadcrumbSegments(currentPath), [currentPath]);

  // Filter files (separate folders and files) - safely handle undefined
  const { folders, regularFiles } = useMemo(() => {
    if (!files || !Array.isArray(files)) {
      return { folders: [], regularFiles: [] };
    }
    const folders = files.filter(f => f.type === 'directory');
    const regularFiles = files.filter(f => f.type === 'file');
    return { folders, regularFiles };
  }, [files]);

  // Handle file press
  const handleFilePress = (file: SandboxFile) => {
    if (file.type === 'directory') {
      setCurrentPath(normalizePath(file.path));
    } else {
      setSelectedFile(file);
      setViewerVisible(true);
    }
  };

  // Handle file long press (delete)
  const handleFileLongPress = (file: SandboxFile) => {
    Alert.alert(
      'Delete File',
      `Are you sure you want to delete ${file.name}?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            try {
              await deleteMutation.mutateAsync({
                sandboxId,
                filePath: file.path,
              });
              Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
            } catch (error) {
              Alert.alert('Error', 'Failed to delete file');
            }
          },
        },
      ]
    );
  };

  // Handle upload
  const handleUploadDocument = async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: '*/*',
        copyToCacheDirectory: true,
      });

      if (result.canceled) return;

      const file = result.assets[0];
      
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
    } catch (error) {
      Alert.alert('Error', 'Failed to upload file');
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
    } catch (error) {
      Alert.alert('Error', 'Failed to upload image');
    }
  };

  // Handle create folder
  const handleCreateFolder = async () => {
    if (!newFolderName.trim()) return;

    try {
      const folderPath = `${currentPath}/${newFolderName.trim()}`;
      await createFolderMutation.mutateAsync({
        sandboxId,
        dirPath: folderPath,
      });

      setShowCreateFolder(false);
      setNewFolderName('');
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (error) {
      Alert.alert('Error', 'Failed to create folder');
    }
  };

  // Handle navigation
  const handleNavigate = (path: string) => {
    setCurrentPath(normalizePath(path));
  };

  const insets = useSafeAreaInsets();

  return (
    <View 
      className="flex-1"
      style={{ backgroundColor: isDark ? '#121215' : '#f8f8f8' }}
    >
      {/* Header with proper safe area */}
      <View 
        style={{ 
          paddingTop: insets.top,
          backgroundColor: isDark ? '#121215' : '#ffffff',
          borderBottomWidth: 1,
          borderBottomColor: isDark ? 'rgba(248, 248, 248, 0.1)' : 'rgba(18, 18, 21, 0.1)',
        }}
      >
        <View className="px-4 py-4 flex-row items-center justify-between">
          <Text
            style={{ color: isDark ? '#f8f8f8' : '#121215' }}
            className="text-2xl font-roobert-semibold"
          >
            Files
          </Text>

          <View className="flex-row items-center gap-1">
            <AnimatedPressable 
              onPress={handleUploadImage}
              className="p-2.5 rounded-xl active:opacity-70"
              style={{ 
                backgroundColor: isDark ? 'rgba(248, 248, 248, 0.1)' : 'rgba(18, 18, 21, 0.05)' 
              }}
            >
              <Icon
                as={Upload}
                size={20}
                color={isDark ? '#f8f8f8' : '#121215'}
                strokeWidth={2}
              />
            </AnimatedPressable>
            <AnimatedPressable 
              onPress={() => setShowCreateFolder(true)}
              className="p-2.5 rounded-xl active:opacity-70"
              style={{ 
                backgroundColor: isDark ? 'rgba(248, 248, 248, 0.1)' : 'rgba(18, 18, 21, 0.05)' 
              }}
            >
              <Icon
                as={FolderPlus}
                size={20}
                color={isDark ? '#f8f8f8' : '#121215'}
                strokeWidth={2}
              />
            </AnimatedPressable>
            <AnimatedPressable 
              onPress={onClose}
              className="p-2.5 rounded-xl active:opacity-70 ml-1"
              style={{ 
                backgroundColor: isDark ? 'rgba(248, 248, 248, 0.1)' : 'rgba(18, 18, 21, 0.05)' 
              }}
            >
              <Icon
                as={X}
                size={20}
                color={isDark ? '#f8f8f8' : '#121215'}
                strokeWidth={2}
              />
            </AnimatedPressable>
          </View>
        </View>
      </View>

      {/* Breadcrumb */}
      {breadcrumbs.length > 0 && (
        <View 
          className="py-2.5"
          style={{
            backgroundColor: isDark ? '#121215' : '#ffffff',
          }}
        >
          <FileBreadcrumb segments={breadcrumbs} onNavigate={handleNavigate} />
        </View>
      )}

      {/* Content */}
      <View className="flex-1">
        {isLoading ? (
          <View className="flex-1 items-center justify-center">
            <KortixLoader size="large" />
            <Text 
              className="text-sm mt-4 font-roobert"
              style={{ color: isDark ? 'rgba(248, 248, 248, 0.5)' : 'rgba(18, 18, 21, 0.5)' }}
            >
              Loading files...
            </Text>
          </View>
        ) : error ? (
          <View className="flex-1 items-center justify-center p-8">
            <View 
              className="w-16 h-16 rounded-2xl items-center justify-center mb-4"
              style={{ 
                backgroundColor: isDark ? 'rgba(239, 68, 68, 0.1)' : 'rgba(239, 68, 68, 0.05)' 
              }}
            >
              <Icon
                as={AlertCircle}
                size={32}
                color="#ef4444"
                strokeWidth={2}
              />
            </View>
            <Text 
              className="text-lg font-roobert-semibold text-center mb-2"
              style={{ color: isDark ? '#f8f8f8' : '#121215' }}
            >
              Failed to load files
            </Text>
            <Text 
              className="text-sm text-center mb-6 font-roobert"
              style={{ color: isDark ? 'rgba(248, 248, 248, 0.5)' : 'rgba(18, 18, 21, 0.5)' }}
            >
              {error?.message || 'An error occurred while loading files'}
            </Text>
            <Pressable 
              onPress={() => refetch()}
              className="px-8 py-3.5 rounded-xl active:opacity-80"
              style={{ backgroundColor: isDark ? '#f8f8f8' : '#121215' }}
            >
              <Text 
                className="text-sm font-roobert-medium"
                style={{ color: isDark ? '#121215' : '#f8f8f8' }}
              >
                Retry
              </Text>
            </Pressable>
          </View>
        ) : !files || files.length === 0 ? (
          <View className="flex-1 items-center justify-center p-8">
            <View 
              className="w-20 h-20 rounded-2xl items-center justify-center mb-4"
              style={{ 
                backgroundColor: isDark ? 'rgba(248, 248, 248, 0.05)' : 'rgba(18, 18, 21, 0.03)' 
              }}
            >
              <Icon
                as={Coffee}
                size={36}
                color={isDark ? 'rgba(248, 248, 248, 0.3)' : 'rgba(18, 18, 21, 0.3)'}
                strokeWidth={1.5}
              />
            </View>
            <Text 
              className="text-base font-roobert-semibold text-center mb-2"
              style={{ color: isDark ? '#f8f8f8' : '#121215' }}
            >
              This folder is empty
            </Text>
            <Text 
              className="text-sm text-center font-roobert"
              style={{ color: isDark ? 'rgba(248, 248, 248, 0.5)' : 'rgba(18, 18, 21, 0.5)' }}
            >
              Upload files or create folders to get started
            </Text>
          </View>
        ) : (
          <ScrollView 
            className="flex-1 px-4 py-3" 
            showsVerticalScrollIndicator={false}
            contentContainerStyle={{ paddingBottom: 20 }}
          >
            {/* Folders First */}
            {folders.map((file) => (
              <FileItem
                key={file.path}
                file={file}
                onPress={handleFilePress}
                onLongPress={handleFileLongPress}
              />
            ))}

            {/* Then Files */}
            {regularFiles.map((file) => (
              <FileItem
                key={file.path}
                file={file}
                onPress={handleFilePress}
                onLongPress={handleFileLongPress}
              />
            ))}
            
            {/* Bottom spacing for safe area */}
            <View style={{ height: 20 }} />
          </ScrollView>
        )}
      </View>

      {/* Create Folder Dialog */}
      {showCreateFolder && (
        <View 
          className="absolute inset-0 items-center justify-center" 
          style={{ backgroundColor: 'rgba(0, 0, 0, 0.6)' }}
        >
          <Animated.View
            entering={FadeIn.duration(200)}
            className="rounded-3xl p-6 mx-8 w-full max-w-sm"
            style={{
              backgroundColor: isDark ? '#1f1f21' : '#ffffff',
              shadowColor: '#000',
              shadowOffset: { width: 0, height: 8 },
              shadowOpacity: 0.25,
              shadowRadius: 16,
              elevation: 12,
            }}
          >
            <Text
              style={{ color: isDark ? '#f8f8f8' : '#121215' }}
              className="text-xl font-roobert-semibold mb-4"
            >
              Create Folder
            </Text>

            <TextInput
              value={newFolderName}
              onChangeText={setNewFolderName}
              placeholder="Folder name"
              placeholderTextColor={isDark ? 'rgba(248, 248, 248, 0.3)' : 'rgba(18, 18, 21, 0.4)'}
              autoFocus
              className="px-4 py-3.5 rounded-xl border mb-6 font-roobert"
              style={{
                backgroundColor: isDark ? 'rgba(248, 248, 248, 0.05)' : '#f4f4f5',
                borderColor: isDark ? 'rgba(248, 248, 248, 0.15)' : 'rgba(18, 18, 21, 0.1)',
                color: isDark ? '#f8f8f8' : '#121215',
              }}
            />

            <View className="flex-row gap-3">
              <Pressable
                onPress={() => {
                  setShowCreateFolder(false);
                  setNewFolderName('');
                }}
                className="flex-1 px-4 py-3.5 rounded-xl active:opacity-70"
                style={{
                  backgroundColor: isDark ? 'rgba(248, 248, 248, 0.1)' : 'rgba(18, 18, 21, 0.05)',
                }}
              >
                <Text
                  style={{ color: isDark ? '#f8f8f8' : '#121215' }}
                  className="text-center font-roobert-medium"
                >
                  Cancel
                </Text>
              </Pressable>

              <Pressable
                onPress={handleCreateFolder}
                disabled={!newFolderName.trim()}
                className="flex-1 px-4 py-3.5 rounded-xl active:opacity-90"
                style={{
                  backgroundColor: newFolderName.trim() 
                    ? (isDark ? '#f8f8f8' : '#121215')
                    : (isDark ? 'rgba(248, 248, 248, 0.2)' : 'rgba(18, 18, 21, 0.2)'),
                  opacity: newFolderName.trim() ? 1 : 0.5,
                }}
              >
                <Text 
                  className="text-center font-roobert-medium"
                  style={{ 
                    color: newFolderName.trim() 
                      ? (isDark ? '#121215' : '#f8f8f8')
                      : (isDark ? 'rgba(248, 248, 248, 0.5)' : 'rgba(18, 18, 21, 0.5)'),
                  }}
                >
                  Create
                </Text>
              </Pressable>
            </View>
          </Animated.View>
        </View>
      )}

      {/* File Viewer */}
      <FileViewer
        visible={viewerVisible}
        onClose={() => {
          setViewerVisible(false);
          setSelectedFile(null);
        }}
        file={selectedFile}
        sandboxId={sandboxId}
        sandboxUrl={sandboxUrl}
      />
    </View>
  );
}

