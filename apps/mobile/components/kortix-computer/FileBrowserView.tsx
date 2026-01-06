import React, { useState, useCallback, useMemo } from 'react';
import { View, ScrollView, Pressable, Alert, Modal, FlatList } from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { KortixLoader } from '@/components/ui';
import {
  File,
  Folder,
  Upload,
  Home,
  FileText,
  Presentation,
  Clock,
  ChevronDown,
  RotateCcw,
  AlertTriangle,
  X,
} from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useKortixComputerStore } from '@/stores/kortix-computer-store';
import {
  useSandboxFiles,
  useUploadFileToSandbox,
  useFileHistory,
  useFilesAtCommit,
  useRevertToCommit,
  fetchCommitInfo,
  type FileVersion,
  type CommitInfo,
} from '@/lib/files/hooks';
import type { SandboxFile } from '@/api/types';
import { KortixComputerHeader, type BreadcrumbSegment } from './KortixComputerHeader';
import { VersionBanner } from './VersionBanner';

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

function getBreadcrumbSegments(path: string): BreadcrumbSegment[] {
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
  const insets = useSafeAreaInsets();
  const {
    currentPath,
    navigateToPath,
    openFile,
    selectedVersion,
    selectedVersionDate,
    setSelectedVersion,
    clearSelectedVersion,
  } = useKortixComputerStore();

  const [isUploading, setIsUploading] = useState(false);
  const [showVersionModal, setShowVersionModal] = useState(false);
  const [showRevertModal, setShowRevertModal] = useState(false);
  const [revertCommit, setRevertCommit] = useState<string | null>(null);
  const [revertCommitInfo, setRevertCommitInfo] = useState<CommitInfo | null>(null);
  const [isLoadingRevertInfo, setIsLoadingRevertInfo] = useState(false);
  const [isReverting, setIsReverting] = useState(false);

  // Current files query
  const {
    data: files = [],
    isLoading: isLoadingFiles,
    error: filesError,
    refetch: refetchFiles,
  } = useSandboxFiles(sandboxId, currentPath, {
    refetchOnMount: 'always',
    staleTime: 0,
    gcTime: 0,
    enabled: !selectedVersion, // Disable when viewing a version
  });

  // Version history query
  const {
    data: versions = [],
    isLoading: isLoadingVersions,
    refetch: refetchVersions,
  } = useFileHistory(sandboxId, '/workspace', {
    enabled: showVersionModal || !!selectedVersion,
  });

  // Files at version query
  const {
    data: versionFiles = [],
    isLoading: isLoadingVersionFiles,
  } = useFilesAtCommit(sandboxId, currentPath, selectedVersion || undefined, {
    enabled: !!selectedVersion,
  });

  // Revert mutation
  const revertMutation = useRevertToCommit();

  const uploadMutation = useUploadFileToSandbox();

  const breadcrumbs = useMemo(() => getBreadcrumbSegments(currentPath), [currentPath]);

  // Use version files if viewing a version, otherwise use current files
  const displayFiles = selectedVersion ? versionFiles : files;

  const { folders, regularFiles } = useMemo(() => {
    if (!displayFiles || !Array.isArray(displayFiles)) {
      return { folders: [], regularFiles: [] };
    }
    const folders = displayFiles.filter(f => f.type === 'directory');
    const regularFiles = displayFiles.filter(f => f.type === 'file');
    return { folders, regularFiles };
  }, [displayFiles]);

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
          if (selectedVersion) {
            Alert.alert('Info', 'Cannot view presentations from historical versions');
            return;
          }
          openFile(file.path);
        } else {
          navigateToPath(file.path);
        }
      } else {
        openFile(file.path);
      }
    },
    [navigateToPath, openFile, isPresentationFolder, selectedVersion],
  );

  const handleUploadImage = async () => {
    if (selectedVersion) {
      Alert.alert('Info', 'Cannot upload while viewing a historical version');
      return;
    }

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

  const handleSelectVersion = async (version: FileVersion | null) => {
    setShowVersionModal(false);

    if (!version) {
      clearSelectedVersion();
      refetchFiles();
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

    try {
      const info = await fetchCommitInfo(sandboxId, commit);
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
      await revertMutation.mutateAsync({
        sandboxId,
        commit: revertCommit,
      });

      setShowRevertModal(false);
      clearSelectedVersion();
      await refetchFiles();
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      Alert.alert('Success', 'Version restored successfully');
    } catch (error) {
      Alert.alert('Error', 'Failed to restore version');
    } finally {
      setIsReverting(false);
    }
  };

  const getFileIcon = useCallback((file: SandboxFile) => {
    if (file.type === 'directory') {
      if (isPresentationFolder(file)) {
        return <Presentation size={36} className="text-primary" />;
      }
      return <Folder size={36} className="text-primary" />;
    }

    const extension = file.name.split('.').pop()?.toLowerCase();

    if (['md', 'txt', 'doc'].includes(extension || '')) {
      return <FileText size={32} className="text-primary opacity-50" />;
    }

    return <File size={32} className="text-primary opacity-50" />;
  }, [isPresentationFolder]);

  const hasSandbox = !!(project?.sandbox?.id || sandboxId);
  const isComputerStarted = project?.sandbox?.sandbox_url ? true : false;
  const isLoading = isLoadingFiles || isLoadingVersionFiles;

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

          {!isCurrent && (
            <Pressable
              onPress={(e) => {
                e.stopPropagation?.();
                handleOpenRevertModal(item.commit);
              }}
              className="px-2 py-1 rounded-full bg-card border border-border active:opacity-70"
            >
              <Text className="text-[11px] font-roobert-medium text-primary">
                Restore
              </Text>
            </Pressable>
          )}
        </View>
      </Pressable>
    );
  };

  return (
    <View className="flex-1">
      {/* Header */}
      <KortixComputerHeader
        icon={Home}
        onIconClick={navigateHome}
        iconTitle="Home"
        title={currentPath === '/workspace' ? 'Files' : undefined}
        breadcrumbs={currentPath !== '/workspace' ? breadcrumbs : undefined}
        onBreadcrumbClick={navigateToBreadcrumb}
        actions={
          <View className="flex-row items-center gap-1.5">
            {/* Upload Button */}
            <Pressable
              onPress={handleUploadImage}
              disabled={isUploading || !!selectedVersion}
              className={`h-9 w-9 items-center justify-center rounded-xl bg-card border border-border active:opacity-70 ${selectedVersion ? 'opacity-50' : ''}`}
            >
              {isUploading ? (
                <KortixLoader size="small" customSize={17} />
              ) : (
                <Icon
                  as={Upload}
                  size={17}
                  className="text-primary"
                  strokeWidth={2}
                />
              )}
            </Pressable>

            {/* History Button */}
            <Pressable
              onPress={() => {
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                setShowVersionModal(true);
                refetchVersions();
              }}
              className="flex-row items-center gap-1.5 h-9 px-3 rounded-xl bg-card border border-border active:opacity-70"
            >
              <Icon
                as={Clock}
                size={17}
                className="text-primary"
                strokeWidth={2}
              />
              <Text className="text-xs font-roobert-medium text-primary">
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
                className="text-primary"
                strokeWidth={2}
              />
            </Pressable>
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

      {/* File Explorer */}
      <View className="flex-1">
        {isLoading ? (
          <View className="flex-1 items-center justify-center gap-2">
            <KortixLoader size="large" />
            <Text className="text-sm text-muted-foreground">
              {isLoadingVersionFiles ? 'Loading version...' : 'Loading files...'}
            </Text>
          </View>
        ) : displayFiles.length === 0 ? (
          <View className="flex-1 items-center justify-center gap-2 p-8">
            <Icon
              as={Folder}
              size={48}
              className="text-primary opacity-50"
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
                  className="flex-col items-center justify-between p-3 rounded-2xl border border-border bg-card active:opacity-70"
                  style={{ width: 100, height: 100 }}
                >
                  {isPresentationFolder(file) && (
                    <View className="absolute top-1 right-1 bg-card border border-border rounded px-1.5 py-0.5">
                      <Text className="text-[10px] font-roobert-medium text-primary">
                        Presentation
                      </Text>
                    </View>
                  )}
                  <View className="w-10 h-10 items-center justify-center">
                    {getFileIcon(file)}
                  </View>
                  <Text className="text-xs text-center font-roobert-medium text-primary w-full" numberOfLines={2}>
                    {file.name}
                  </Text>
                </Pressable>
              ))}

              {regularFiles.map((file) => (
                <Pressable
                  key={file.path}
                  onPress={() => handleItemClick(file)}
                  className="flex-col items-center justify-between p-3 rounded-2xl border border-border bg-card active:opacity-70"
                  style={{ width: 100, height: 100 }}
                >
                  <View className="w-10 h-10 items-center justify-center">
                    {getFileIcon(file)}
                  </View>
                  <Text className="text-xs text-center font-roobert-medium text-primary w-full" numberOfLines={2}>
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
        className="px-4 pt-4 border-t border-border bg-card"
        style={{ paddingBottom: Math.max(24, insets.bottom + 8) }}
      >
        <View className="flex-row items-center justify-between h-9">
          <View className="flex-row items-center gap-2">
            <View className="flex-row items-center gap-1.5 px-2 py-1 rounded-full border border-border">
              <Icon as={Folder} size={12} className="text-primary" />
              <Text className="text-xs font-roobert-medium text-primary">
                {displayFiles.length} {displayFiles.length === 1 ? 'item' : 'items'}
              </Text>
            </View>
          </View>
          <Text className="text-xs text-primary opacity-50 truncate max-w-[200px]" numberOfLines={1}>
            {currentPath}
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
            <Text className="text-lg font-roobert-semibold text-primary">Version History</Text>
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
              <Text className="text-sm text-muted-foreground mt-4">Loading history...</Text>
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
              This will restore all files from this version snapshot.
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
                <Text className="text-sm font-roobert-medium mb-1">{revertCommitInfo.message}</Text>
                <Text className="text-xs text-muted-foreground mb-3">
                  {revertCommitInfo.date && new Date(revertCommitInfo.date).toLocaleDateString('en-US', {
                    month: 'short',
                    day: 'numeric',
                    year: 'numeric'
                  })}
                </Text>

                {revertCommitInfo.revert_files && revertCommitInfo.revert_files.length > 0 && (
                  <>
                    <Text className="text-xs text-muted-foreground mb-2">Files that will be affected:</Text>
                    <View className="rounded-xl p-2 max-h-40 bg-card border border-border">
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
                  </>
                )}
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
                className="flex-1 py-3 rounded-xl items-center active:opacity-70"
                style={{
                  backgroundColor: '#3b82f6',
                }}
              >
                {isReverting ? (
                  <View className="flex-row items-center gap-2">
                    <KortixLoader size="small" customSize={14} forceTheme="dark" />
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
