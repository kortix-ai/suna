/**
 * FilesPage — Full file manager page for the "Files" page tab.
 *
 * Uses the OpenCode file API (GET {sandboxUrl}/file?path=...) — the same
 * approach as the web frontend — to list, upload, delete, and create files.
 */

import React, { useState, useMemo, useCallback, useRef, useEffect, useImperativeHandle, forwardRef } from 'react';
import {
  View,
  TouchableOpacity,
  Text as RNText,
  Pressable,
  ScrollView,
  Alert,
  RefreshControl,
  Keyboard,
  ActivityIndicator,
  TextInput,
} from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { KortixLoader } from '@/components/ui';
import {
  Upload,
  FolderPlus,
  Trash2,
  AlertCircle,
  LayoutGrid,
  List,
  ChevronRight,
  Folder,
  Home,
  Search,
  X as XIcon,
} from 'lucide-react-native';
import { useColorScheme } from 'nativewind';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useSheetBottomPadding } from '@/hooks/useSheetKeyboard';
import { Ionicons } from '@expo/vector-icons';
import Animated, {
  FadeIn,
} from 'react-native-reanimated';
import {
  BottomSheetModal,
  BottomSheetBackdrop,
  BottomSheetView,
  BottomSheetTextInput,
  TouchableOpacity as BottomSheetTouchable,
} from '@gorhom/bottom-sheet';
import type { BottomSheetBackdropProps } from '@gorhom/bottom-sheet';
import * as Haptics from 'expo-haptics';
import * as Clipboard from 'expo-clipboard';
import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';

import { useSandboxContext } from '@/contexts/SandboxContext';
import {
  FileItem,
  getFileIconAndColor,
  getFileIconComponent,
  getMutedIconColor,
} from '@/components/files/FileItem';
import { FileBreadcrumb } from '@/components/files/FileBreadcrumb';
import { FileViewer } from '@/components/files/FileViewer';
import {
  useOpenCodeFiles,
  useOpenCodeUploadFile,
  useOpenCodeDeleteFile,
  useOpenCodeMkdir,
  useOpenCodeRenameFile,
} from '@/lib/files/hooks';
import type { SandboxFile } from '@/api/types';
import { useTabStore, type PageTab } from '@/stores/tab-store';
import { PageHeader } from '@/components/ui/page-header';
import { PageContent } from '@/components/ui/page-content';
import { useThemeColors } from '@/lib/theme-colors';

interface FilesTabState {
  viewMode?: 'list' | 'grid';
  showHidden?: boolean;
  currentPath?: string;
  selectedFile?: SandboxFile | null;
  viewerVisible?: boolean;
  viewerFile?: SandboxFile | null;
  scrollOffsets?: Record<string, number>;
}

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

export interface FilesPageRef {
  showHidden: boolean;
  viewMode: 'list' | 'grid';
  selectedFile: SandboxFile | null;
  toggleHidden: () => void;
  toggleViewMode: () => void;
  refetch: () => void;
  uploadDocument: () => void;
  uploadImage: () => void;
  createFolder: () => void;
  openFile: () => void;
  copyPath: () => void;
  renameFile: () => void;
  deleteFile: () => void;
  deselectFile: () => void;
  openPath: (path: string) => void;
}

interface FilesPageProps {
  page: PageTab;
  onBack: () => void;
  onOpenDrawer?: () => void;
  onOpenRightDrawer?: () => void;
  isDrawerOpen?: boolean;
  isRightDrawerOpen?: boolean;
  onFileSelectionChange?: (file: SandboxFile | null) => void;
  /** Called when the file actions menu should open (e.g. after long-press) */
  onRequestMenu?: () => void;
}

export const FilesPage = forwardRef<FilesPageRef, FilesPageProps>(function FilesPage(
  { page, onBack, onOpenDrawer, onOpenRightDrawer, isDrawerOpen, isRightDrawerOpen, onFileSelectionChange, onRequestMenu },
  ref,
) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const insets = useSafeAreaInsets();
  const sheetPadding = useSheetBottomPadding();
  const { sandboxId, sandboxUrl } = useSandboxContext();
  const setTabState = useTabStore((s) => s.setTabState);
  const savedTabState = useTabStore((s) => s.tabStateById[page.id] as FilesTabState | undefined);

  const fgColor = isDark ? '#F8F8F8' : '#121215';
  const mutedColor = isDark ? '#888' : '#777';
  const themeColors = useThemeColors();

  // View mode state
  const [viewMode, setViewMode] = useState<'list' | 'grid'>(savedTabState?.viewMode ?? 'list');

  // Show/hide dotfiles (hidden by default, same as frontend)
  const [showHidden, setShowHidden] = useState(savedTabState?.showHidden ?? false);

  // Search state — filters files in the current directory by name.
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const searchInputRef = useRef<TextInput>(null);
  const openSearch = useCallback(() => {
    setIsSearchOpen(true);
    // Give the input a moment to mount before focusing.
    setTimeout(() => searchInputRef.current?.focus(), 50);
  }, []);
  const closeSearch = useCallback(() => {
    setIsSearchOpen(false);
    setSearchQuery('');
    Keyboard.dismiss();
  }, []);

  // Navigation state
  const [currentPath, setCurrentPath] = useState(savedTabState?.currentPath ?? '/workspace');

  // Viewer state
  const [viewerVisible, setViewerVisible] = useState(savedTabState?.viewerVisible ?? false);
  const [viewerFile, setViewerFile] = useState<SandboxFile | null>(savedTabState?.viewerFile ?? null);

  // Context-selected file (long-press selects for three-dot menu actions)
  const [selectedFile, setSelectedFile] = useState<SandboxFile | null>(savedTabState?.selectedFile ?? null);

  const [scrollOffsets, setScrollOffsets] = useState<Record<string, number>>(savedTabState?.scrollOffsets ?? {});
  const listScrollRef = useRef<ScrollView>(null);
  const gridScrollRef = useRef<ScrollView>(null);
  const restoredScrollKeysRef = useRef<Record<string, true>>({});

  // Create folder / rename bottom sheets
  const createFolderSheetRef = useRef<BottomSheetModal>(null);
  const [newFolderName, setNewFolderName] = useState('');
  const renameSheetRef = useRef<BottomSheetModal>(null);
  const [renameName, setRenameName] = useState('');
  const [renameFile, setRenameFile] = useState<SandboxFile | null>(null);

  // Notify parent when selection changes, auto-open menu on select
  useEffect(() => {
    onFileSelectionChange?.(selectedFile);
    if (selectedFile) {
      // Small delay to let React re-render with updated menu items
      const timer = setTimeout(() => onRequestMenu?.(), 50);
      return () => clearTimeout(timer);
    }
  }, [selectedFile, onFileSelectionChange, onRequestMenu]);

  // Fetch files via OpenCode API (same as frontend)
  const {
    data: files,
    isLoading,
    error,
    refetch,
    isRefetching,
  } = useOpenCodeFiles(sandboxUrl, currentPath);

  // Mutations via OpenCode API
  const uploadMutation = useOpenCodeUploadFile();
  const deleteMutation = useOpenCodeDeleteFile();
  const createFolderMutation = useOpenCodeMkdir();
  const renameMutation = useOpenCodeRenameFile();

  // Bottom sheet backdrop
  const renderBackdrop = useCallback(
    (props: BottomSheetBackdropProps) => (
      <BottomSheetBackdrop
        {...props}
        disappearsOnIndex={-1}
        appearsOnIndex={0}
        opacity={0.5}
        pressBehavior="close"
      />
    ),
    [],
  );

  const openCreateFolder = useCallback(() => {
    setNewFolderName('');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    createFolderSheetRef.current?.present();
  }, []);

  // Breadcrumbs
  const breadcrumbs = useMemo(() => getBreadcrumbSegments(currentPath), [currentPath]);
  const scrollKey = `${viewMode}:${currentPath}`;

  useEffect(() => {
    setTabState(page.id, {
      viewMode,
      showHidden,
      currentPath,
      selectedFile,
      viewerVisible,
      viewerFile,
      scrollOffsets,
    });
  }, [
    page.id,
    setTabState,
    viewMode,
    showHidden,
    currentPath,
    selectedFile,
    viewerVisible,
    viewerFile,
    scrollOffsets,
  ]);

  useEffect(() => {
    const savedOffset = scrollOffsets[scrollKey] ?? 0;
    if (savedOffset <= 0) return;
    if (restoredScrollKeysRef.current[scrollKey]) return;
    const timer = setTimeout(() => {
      if (viewMode === 'grid') {
        gridScrollRef.current?.scrollTo({ x: 0, y: savedOffset, animated: false });
      } else {
        listScrollRef.current?.scrollTo({ x: 0, y: savedOffset, animated: false });
      }
      restoredScrollKeysRef.current[scrollKey] = true;
    }, 40);
    return () => clearTimeout(timer);
  }, [scrollOffsets, scrollKey, viewMode]);

  // Separate folders and files, sorted, with dotfile filtering
  const { folders, regularFiles } = useMemo(() => {
    if (!files || !Array.isArray(files)) {
      return { folders: [], regularFiles: [] };
    }
    const visible = showHidden ? files : files.filter((f) => !f.name.startsWith('.'));
    const q = searchQuery.trim().toLowerCase();
    const searched = q ? visible.filter((f) => f.name.toLowerCase().includes(q)) : visible;
    const sortFn = (a: SandboxFile, b: SandboxFile) => a.name.localeCompare(b.name);
    const folders = searched.filter((f) => f.type === 'directory').sort(sortFn);
    const regularFiles = searched.filter((f) => f.type === 'file').sort(sortFn);
    return { folders, regularFiles };
  }, [files, showHidden, searchQuery]);

  // All sibling names in current directory (for duplicate detection)
  const siblingNames = useMemo(() => {
    if (!files || !Array.isArray(files)) return [];
    return files.map((f) => f.name.toLowerCase());
  }, [files]);

  // Check if new folder name already exists (case-insensitive)
  const folderNameExists = useMemo(() => {
    if (!newFolderName.trim()) return false;
    return siblingNames.includes(newFolderName.trim().toLowerCase());
  }, [newFolderName, siblingNames]);

  // Check if rename target already exists (case-insensitive, excluding current name)
  const renameNameExists = useMemo(() => {
    if (!renameName.trim() || !renameFile) return false;
    const trimmed = renameName.trim().toLowerCase();
    if (trimmed === renameFile.name.toLowerCase()) return false;
    return siblingNames.includes(trimmed);
  }, [renameName, renameFile, siblingNames]);

  // Handlers
  const handleFilePress = useCallback((file: SandboxFile) => {
    setSelectedFile(null);
    if (file.type === 'directory') {
      setCurrentPath(normalizePath(file.path));
    } else {
      setViewerFile(file);
      setViewerVisible(true);
    }
  }, []);

  const handleFileLongPress = useCallback(
    (file: SandboxFile) => {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      setSelectedFile(file);
    },
    [],
  );

  // File context actions (exposed via ref for BottomBar menu)
  const handleOpenSelectedFile = useCallback(() => {
    if (!selectedFile) return;
    if (selectedFile.type === 'directory') {
      setCurrentPath(normalizePath(selectedFile.path));
    } else {
      setViewerFile(selectedFile);
      setViewerVisible(true);
    }
    setSelectedFile(null);
  }, [selectedFile]);

  const handleCopyPath = useCallback(async () => {
    if (!selectedFile) return;
    await Clipboard.setStringAsync(selectedFile.path);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    setSelectedFile(null);
  }, [selectedFile]);

  const handleRenameFile = useCallback(() => {
    if (!selectedFile) return;
    setRenameFile(selectedFile);
    setRenameName(selectedFile.name);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    renameSheetRef.current?.present();
  }, [selectedFile]);

  const handleConfirmRename = useCallback(async () => {
    if (!renameName.trim() || !renameFile || !sandboxUrl || renameNameExists) return;
    Keyboard.dismiss();
    try {
      const parentDir = renameFile.path.substring(0, renameFile.path.lastIndexOf('/'));
      const newPath = `${parentDir}/${renameName.trim()}`;
      await renameMutation.mutateAsync({
        sandboxUrl,
        from: renameFile.path,
        to: newPath,
      });
      renameSheetRef.current?.dismiss();
      setRenameFile(null);
      setRenameName('');
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch {
      Alert.alert('Error', 'Failed to rename');
    }
  }, [renameFile, renameName, sandboxUrl, renameMutation, renameNameExists]);

  const handleDeleteFile = useCallback(() => {
    if (!selectedFile || !sandboxUrl) return;
    const name = selectedFile.name;
    const isDir = selectedFile.type === 'directory';
    Alert.alert(
      `Delete ${isDir ? 'folder' : 'file'}`,
      `Delete "${name}"? This cannot be undone.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            try {
              await deleteMutation.mutateAsync({
                sandboxUrl,
                filePath: selectedFile.path,
              });
              Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
            } catch {
              Alert.alert('Error', 'Failed to delete');
            }
            setSelectedFile(null);
          },
        },
      ],
    );
  }, [selectedFile, sandboxUrl, deleteMutation]);

  const handleNavigate = useCallback((path: string) => {
    setCurrentPath(normalizePath(path));
    setSelectedFile(null);
  }, []);

  const handleFilesScroll = useCallback(
    (offsetY: number) => {
      const y = Math.max(0, Math.floor(offsetY || 0));
      setScrollOffsets((prev) => {
        if (Math.abs((prev[scrollKey] ?? 0) - y) < 24) return prev;
        return { ...prev, [scrollKey]: y };
      });
    },
    [scrollKey],
  );

  const handleOpenPath = useCallback((path: string) => {
    const normalized = normalizePath(path);
    const isDir = normalized.endsWith('/');

    if (isDir) {
      setCurrentPath(normalized.replace(/\/$/, ''));
      setSelectedFile(null);
      return;
    }

    // Navigate to the file's parent directory for context, then open viewer.
    const lastSlash = normalized.lastIndexOf('/');
    const parentDir = lastSlash > 0 ? normalized.slice(0, lastSlash) : '/workspace';
    const name = normalized.split('/').pop() || normalized;

    setCurrentPath(parentDir || '/workspace');
    setSelectedFile(null);
    setViewerFile({
      name,
      path: normalized,
      type: 'file',
    });
    setViewerVisible(true);
  }, []);

  const handleUploadDocument = useCallback(async () => {
    if (!sandboxUrl) return;
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: '*/*',
        copyToCacheDirectory: true,
      });
      if (result.canceled) return;

      const file = result.assets[0];
      await uploadMutation.mutateAsync({
        sandboxUrl,
        file: {
          uri: file.uri,
          name: file.name,
          type: file.mimeType || 'application/octet-stream',
        },
        targetPath: currentPath,
      });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch {
      Alert.alert('Error', 'Failed to upload file');
    }
  }, [sandboxUrl, uploadMutation, currentPath]);

  const handleUploadImage = useCallback(async () => {
    if (!sandboxUrl) return;
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        allowsMultipleSelection: false,
        quality: 1,
      });
      if (result.canceled) return;

      const asset = result.assets[0];
      await uploadMutation.mutateAsync({
        sandboxUrl,
        file: {
          uri: asset.uri,
          name: asset.fileName || 'image.jpg',
          type: asset.type === 'image' ? 'image/jpeg' : 'application/octet-stream',
        },
        targetPath: currentPath,
      });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch {
      Alert.alert('Error', 'Failed to upload image');
    }
  }, [sandboxUrl, uploadMutation, currentPath]);

  const handleCreateFolder = useCallback(async () => {
    if (!newFolderName.trim() || !sandboxUrl || folderNameExists) return;
    Keyboard.dismiss();
    try {
      const folderPath = `${currentPath}/${newFolderName.trim()}`;
      await createFolderMutation.mutateAsync({
        sandboxUrl,
        dirPath: folderPath,
      });
      createFolderSheetRef.current?.dismiss();
      setNewFolderName('');
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch {
      Alert.alert('Error', 'Failed to create folder');
    }
  }, [sandboxUrl, createFolderMutation, currentPath, newFolderName, folderNameExists]);

  // Expose actions to parent via ref (for BottomBar menu)
  useImperativeHandle(ref, () => ({
    showHidden,
    viewMode,
    selectedFile,
    toggleHidden: () => setShowHidden((v) => !v),
    toggleViewMode: () => setViewMode((v) => (v === 'list' ? 'grid' : 'list')),
    refetch: () => refetch(),
    uploadDocument: () => handleUploadDocument(),
    uploadImage: () => handleUploadImage(),
    createFolder: () => openCreateFolder(),
    openFile: () => handleOpenSelectedFile(),
    copyPath: () => handleCopyPath(),
    renameFile: () => handleRenameFile(),
    deleteFile: () => handleDeleteFile(),
    deselectFile: () => setSelectedFile(null),
    openPath: (path: string) => handleOpenPath(path),
  }), [showHidden, viewMode, selectedFile, refetch, handleUploadDocument, handleUploadImage, openCreateFolder, handleOpenSelectedFile, handleCopyPath, handleRenameFile, handleDeleteFile, handleOpenPath]);

  const isAtRoot = currentPath === '/workspace';

  // No sandbox available
  if (!sandboxUrl) {
    return (
      <View style={{ flex: 1, backgroundColor: isDark ? '#121215' : '#f5f5f5' }}>
        <PageHeader
          title={page.label}
          onOpenDrawer={onOpenDrawer}
          onOpenRightDrawer={onOpenRightDrawer}
          isDrawerOpen={isDrawerOpen}
          isRightDrawerOpen={isRightDrawerOpen}
        />
        <PageContent>
          <View className="flex-1 items-center justify-center px-8">
            <ActivityIndicator size="large" color={mutedColor} />
            <Text className="text-sm mt-3 text-muted-foreground">
              Connecting to sandbox...
            </Text>
          </View>
        </PageContent>
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: isDark ? '#121215' : '#f5f5f5' }}>
      <PageHeader
        title={
          isSearchOpen ? (
            <View className="flex-1 flex-row items-center" style={{ gap: 8 }}>
              <Icon as={Search} size={16} color={mutedColor} strokeWidth={2} />
              <TextInput
                ref={searchInputRef}
                value={searchQuery}
                onChangeText={setSearchQuery}
                placeholder="Search files in this folder"
                placeholderTextColor={mutedColor}
                returnKeyType="search"
                autoCapitalize="none"
                autoCorrect={false}
                style={{
                  flex: 1,
                  color: fgColor,
                  fontSize: 16,
                  fontFamily: 'Roobert-Regular',
                  padding: 0,
                }}
              />
            </View>
          ) : (
            'Files'
          )
        }
        onOpenDrawer={onOpenDrawer}
        onOpenRightDrawer={onOpenRightDrawer}
        isDrawerOpen={isDrawerOpen}
        isRightDrawerOpen={isRightDrawerOpen}
        hideRightDrawerToggle={isSearchOpen}
        rightActions={
          <View className="flex-row items-center" style={{ gap: 4 }}>
            {/* Search — always visible; icon flips between Search and X. */}
            <AnimatedPressable
              onPress={isSearchOpen ? closeSearch : openSearch}
              className="p-2 rounded-xl active:opacity-70"
            >
              <Icon
                as={isSearchOpen ? XIcon : Search}
                size={18}
                color={fgColor}
                strokeWidth={2}
              />
            </AnimatedPressable>

            {/* Other actions hide while search is active to free up header space. */}
            {!isSearchOpen && (
              <>
                <AnimatedPressable
                  onPress={() => setViewMode((v) => (v === 'list' ? 'grid' : 'list'))}
                  className="p-2 rounded-xl active:opacity-70"
                >
                  <Icon
                    as={viewMode === 'list' ? LayoutGrid : List}
                    size={18}
                    color={fgColor}
                    strokeWidth={2}
                  />
                </AnimatedPressable>
                <AnimatedPressable
                  onPress={handleUploadDocument}
                  className="p-2 rounded-xl active:opacity-70"
                >
                  <Icon as={Upload} size={18} color={fgColor} strokeWidth={2} />
                </AnimatedPressable>
                <AnimatedPressable
                  onPress={openCreateFolder}
                  className="p-2 rounded-xl active:opacity-70"
                >
                  <Icon as={FolderPlus} size={18} color={fgColor} strokeWidth={2} />
                </AnimatedPressable>
              </>
            )}
          </View>
        }
      />

      <PageContent>
      {/* Breadcrumbs container */}
      <View
        style={{
          borderBottomWidth: 1,
          borderBottomColor: isDark
            ? 'rgba(248, 248, 248, 0.1)'
            : 'rgba(18, 18, 21, 0.1)',
        }}
      >
        {/* Breadcrumbs */}
        <View className="pb-2">
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{
              flexDirection: 'row',
              alignItems: 'center',
              paddingHorizontal: 12,
            }}
          >
            {/* Root */}
            <Pressable
              onPress={() => handleNavigate('/workspace')}
              className="flex-row items-center px-2 py-1 rounded-lg active:opacity-70"
            >
              <Icon
                as={Home}
                size={14}
                color={
                  isAtRoot
                    ? fgColor
                    : isDark
                      ? 'rgba(248, 248, 248, 0.4)'
                      : 'rgba(18, 18, 21, 0.4)'
                }
                strokeWidth={2}
              />
              <Text
                style={{
                  color: isAtRoot
                    ? fgColor
                    : isDark
                      ? 'rgba(248, 248, 248, 0.5)'
                      : 'rgba(18, 18, 21, 0.5)',
                  marginLeft: 6,
                }}
                className={`text-sm ${isAtRoot ? 'font-roobert-medium' : 'font-roobert'}`}
              >
                My Kortix
              </Text>
            </Pressable>

            {/* Path segments */}
            {breadcrumbs.map((segment) => (
              <React.Fragment key={segment.path}>
                <Icon
                  as={ChevronRight}
                  size={12}
                  color={
                    isDark
                      ? 'rgba(248, 248, 248, 0.25)'
                      : 'rgba(18, 18, 21, 0.25)'
                  }
                  strokeWidth={2}
                  style={{ marginHorizontal: 2 }}
                />
                <Pressable
                  onPress={() =>
                    !segment.isLast && handleNavigate(segment.path)
                  }
                  disabled={segment.isLast}
                  className="px-2 py-1 rounded-lg active:opacity-70"
                >
                  <Text
                    style={{
                      color: segment.isLast
                        ? fgColor
                        : isDark
                          ? 'rgba(248, 248, 248, 0.5)'
                          : 'rgba(18, 18, 21, 0.5)',
                    }}
                    className={`text-sm ${segment.isLast ? 'font-roobert-medium' : 'font-roobert'}`}
                    numberOfLines={1}
                  >
                    {segment.name}
                  </Text>
                </Pressable>
              </React.Fragment>
            ))}
          </ScrollView>
        </View>
      </View>

      {/* Content */}
      <View className="flex-1">
        {isLoading ? (
          <View className="flex-1 items-center justify-center">
            <KortixLoader size="large" />
            <Text
              className="text-sm mt-4 font-roobert"
              style={{
                color: isDark
                  ? 'rgba(248, 248, 248, 0.5)'
                  : 'rgba(18, 18, 21, 0.5)',
              }}
            >
              Loading files...
            </Text>
          </View>
        ) : error ? (
          <View className="flex-1 items-center justify-center p-8">
            <View
              className="w-16 h-16 rounded-2xl items-center justify-center mb-4"
              style={{
                backgroundColor: isDark
                  ? 'rgba(239, 68, 68, 0.1)'
                  : 'rgba(239, 68, 68, 0.05)',
              }}
            >
              <Icon as={AlertCircle} size={32} color="#ef4444" strokeWidth={2} />
            </View>
            <Text
              className="text-lg font-roobert-semibold text-center mb-2"
              style={{ color: fgColor }}
            >
              Failed to load files
            </Text>
            <Text
              className="text-sm text-center mb-6 font-roobert"
              style={{
                color: isDark
                  ? 'rgba(248, 248, 248, 0.5)'
                  : 'rgba(18, 18, 21, 0.5)',
              }}
            >
              {error?.message || 'An error occurred'}
            </Text>
            <Pressable
              onPress={() => refetch()}
              className="px-8 py-3.5 rounded-2xl active:opacity-80"
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
          <ScrollView
            ref={listScrollRef}
            className="flex-1"
            contentContainerStyle={{
              flexGrow: 1,
              justifyContent: 'center',
              alignItems: 'center',
              paddingHorizontal: 40,
              paddingBottom: 60,
            }}
            scrollEventThrottle={100}
            onScroll={(e) => handleFilesScroll(e.nativeEvent.contentOffset.y)}
            refreshControl={
              <RefreshControl refreshing={isRefetching} onRefresh={() => refetch()} />
            }
          >
            <View
              className="w-20 h-20 rounded-3xl items-center justify-center mb-6"
              style={{
                backgroundColor: isDark
                  ? 'rgba(248, 248, 248, 0.04)'
                  : 'rgba(18, 18, 21, 0.03)',
              }}
            >
              <Icon
                as={Folder}
                size={36}
                strokeWidth={1.2}
                color={
                  isDark
                    ? 'rgba(248, 248, 248, 0.15)'
                    : 'rgba(18, 18, 21, 0.15)'
                }
              />
            </View>
            <Text
              className="text-base font-roobert-semibold text-center mb-2"
              style={{ color: fgColor }}
            >
              This folder is empty
            </Text>
            <Text
              className="text-sm font-roobert text-center mb-8"
              style={{
                color: isDark
                  ? 'rgba(248, 248, 248, 0.35)'
                  : 'rgba(18, 18, 21, 0.35)',
                lineHeight: 20,
              }}
            >
              Upload files or create a folder{'\n'}to get started
            </Text>
            <View className="flex-row gap-3">
              <Pressable
                onPress={handleUploadDocument}
                className="flex-row items-center px-5 py-3 rounded-2xl active:opacity-70"
                style={{
                  backgroundColor: themeColors.primary,
                }}
              >
                <Icon
                  as={Upload}
                  size={16}
                  color={themeColors.primaryForeground}
                  strokeWidth={2}
                  style={{ marginRight: 8 }}
                />
                <Text
                  className="text-sm font-roobert-medium"
                  style={{ color: themeColors.primaryForeground }}
                >
                  Upload
                </Text>
              </Pressable>
              <Pressable
                onPress={openCreateFolder}
                className="flex-row items-center px-5 py-3 rounded-2xl active:opacity-70"
                style={{
                  backgroundColor: isDark
                    ? 'rgba(248, 248, 248, 0.1)'
                    : 'rgba(18, 18, 21, 0.06)',
                }}
              >
                <Icon
                  as={FolderPlus}
                  size={16}
                  color={fgColor}
                  strokeWidth={2}
                  style={{ marginRight: 8 }}
                />
                <Text
                  className="text-sm font-roobert-medium"
                  style={{ color: fgColor }}
                >
                  New folder
                </Text>
              </Pressable>
            </View>
          </ScrollView>
        ) : viewMode === 'grid' ? (
          /* ── Grid View ── */
          <ScrollView
            ref={gridScrollRef}
            className="flex-1"
            showsVerticalScrollIndicator={false}
            contentContainerStyle={{ paddingBottom: 20 }}
            scrollEventThrottle={100}
            onScroll={(e) => handleFilesScroll(e.nativeEvent.contentOffset.y)}
            refreshControl={
              <RefreshControl refreshing={isRefetching} onRefresh={() => refetch()} />
            }
          >
            {/* Folders */}
            {folders.length > 0 && (
              <View className="px-4 pt-4">
                <Text
                  className="text-xs font-roobert-medium mb-3 uppercase tracking-wider"
                  style={{
                    color: isDark
                      ? 'rgba(248, 248, 248, 0.4)'
                      : 'rgba(18, 18, 21, 0.4)',
                  }}
                >
                  Folders
                </Text>
                <View className="flex-row flex-wrap" style={{ marginHorizontal: -4 }}>
                  {folders.map((file) => (
                    <View
                      key={file.path}
                      style={{ width: '50%', paddingHorizontal: 4, marginBottom: 8 }}
                    >
                      <FileRowCard
                        file={file}
                        isDark={isDark}
                        fgColor={fgColor}
                        onPress={() => handleFilePress(file)}
                        onLongPress={() => handleFileLongPress(file)}
                      />
                    </View>
                  ))}
                </View>
              </View>
            )}

            {/* Files */}
            {regularFiles.length > 0 && (
              <View className="px-4 pt-2">
                <Text
                  className="text-xs font-roobert-medium mb-3 uppercase tracking-wider"
                  style={{
                    color: isDark
                      ? 'rgba(248, 248, 248, 0.4)'
                      : 'rgba(18, 18, 21, 0.4)',
                  }}
                >
                  Files
                </Text>
                <View className="flex-row flex-wrap" style={{ marginHorizontal: -4 }}>
                  {regularFiles.map((file) => (
                    <View
                      key={file.path}
                      style={{ width: '50%', paddingHorizontal: 4, marginBottom: 8 }}
                    >
                      <FileRowCard
                        file={file}
                        isDark={isDark}
                        fgColor={fgColor}
                        onPress={() => handleFilePress(file)}
                        onLongPress={() => handleFileLongPress(file)}
                      />
                    </View>
                  ))}
                </View>
              </View>
            )}
          </ScrollView>
        ) : (
          /* ── List View ── */
          <ScrollView
            ref={listScrollRef}
            className="flex-1 px-4 pt-3"
            showsVerticalScrollIndicator={false}
            contentContainerStyle={{ paddingBottom: 20 }}
            scrollEventThrottle={100}
            onScroll={(e) => handleFilesScroll(e.nativeEvent.contentOffset.y)}
            refreshControl={
              <RefreshControl refreshing={isRefetching} onRefresh={() => refetch()} />
            }
          >
            {/* Folders section */}
            {folders.length > 0 && (
              <View className="mb-2">
                <Text
                  className="text-xs font-roobert-medium mb-2 uppercase tracking-wider px-1"
                  style={{
                    color: isDark
                      ? 'rgba(248, 248, 248, 0.4)'
                      : 'rgba(18, 18, 21, 0.4)',
                  }}
                >
                  Folders
                </Text>
                {folders.map((file) => (
                  <FileItem
                    key={file.path}
                    file={file}
                    onPress={handleFilePress}
                    onLongPress={handleFileLongPress}
                  />
                ))}
              </View>
            )}

            {/* Files section */}
            {regularFiles.length > 0 && (
              <View>
                <Text
                  className="text-xs font-roobert-medium mb-2 uppercase tracking-wider px-1"
                  style={{
                    color: isDark
                      ? 'rgba(248, 248, 248, 0.4)'
                      : 'rgba(18, 18, 21, 0.4)',
                  }}
                >
                  Files
                </Text>
                {regularFiles.map((file) => (
                  <FileItem
                    key={file.path}
                    file={file}
                    onPress={handleFilePress}
                    onLongPress={handleFileLongPress}
                  />
                ))}
              </View>
            )}
          </ScrollView>
        )}
      </View>

      {/* Create Folder Bottom Sheet */}
      <BottomSheetModal
        ref={createFolderSheetRef}
        enableDynamicSizing
        enablePanDownToClose
        backdropComponent={renderBackdrop}
        keyboardBehavior="interactive"
        keyboardBlurBehavior="restore"
        android_keyboardInputMode="adjustResize"
        onDismiss={() => setNewFolderName('')}
        backgroundStyle={{
          backgroundColor: isDark ? '#161618' : '#FFFFFF',
          borderTopLeftRadius: 24,
          borderTopRightRadius: 24,
        }}
        handleIndicatorStyle={{
          backgroundColor: isDark ? '#3F3F46' : '#D4D4D8',
          width: 36,
          height: 5,
          borderRadius: 3,
        }}
      >
        <BottomSheetView
          style={{
            paddingHorizontal: 24,
            paddingTop: 8,
            paddingBottom: sheetPadding,
          }}
        >
          {/* Header */}
          <View className="flex-row items-center mb-5">
            <View
              className="w-10 h-10 rounded-xl items-center justify-center mr-3"
              style={{
                backgroundColor: isDark
                  ? 'rgba(248, 248, 248, 0.08)'
                  : 'rgba(18, 18, 21, 0.05)',
              }}
            >
              <Icon as={FolderPlus} size={20} color={fgColor} strokeWidth={1.8} />
            </View>
            <View className="flex-1">
              <Text
                className="text-lg font-roobert-semibold"
                style={{ color: fgColor }}
              >
                New Folder
              </Text>
              <Text
                className="text-xs font-roobert mt-0.5"
                style={{
                  color: isDark
                    ? 'rgba(248, 248, 248, 0.4)'
                    : 'rgba(18, 18, 21, 0.4)',
                }}
                numberOfLines={1}
              >
                {currentPath === '/workspace' ? 'My Kortix' : currentPath.split('/').pop()}
              </Text>
            </View>
          </View>

          {/* Input */}
          <BottomSheetTextInput
            value={newFolderName}
            onChangeText={setNewFolderName}
            placeholder="Enter folder name"
            placeholderTextColor={
              isDark ? 'rgba(248, 248, 248, 0.25)' : 'rgba(18, 18, 21, 0.3)'
            }
            autoFocus
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="done"
            onSubmitEditing={handleCreateFolder}
            style={{
              backgroundColor: isDark
                ? 'rgba(248, 248, 248, 0.06)'
                : 'rgba(18, 18, 21, 0.04)',
              borderWidth: 1,
              borderColor: folderNameExists
                ? 'rgba(239, 68, 68, 0.6)'
                : isDark
                  ? 'rgba(248, 248, 248, 0.1)'
                  : 'rgba(18, 18, 21, 0.08)',
              borderRadius: 14,
              paddingHorizontal: 16,
              paddingVertical: 14,
              fontSize: 16,
              fontFamily: 'Roobert',
              color: fgColor,
              marginBottom: folderNameExists ? 8 : 20,
            }}
          />
          {folderNameExists && (
            <Text
              className="text-xs font-roobert mb-4"
              style={{ color: '#ef4444', paddingLeft: 4 }}
            >
              A file or folder with that name already exists
            </Text>
          )}

          {/* Create button */}
          <BottomSheetTouchable
            onPress={handleCreateFolder}
            disabled={!newFolderName.trim() || folderNameExists || createFolderMutation.isPending}
            style={{
              backgroundColor:
                newFolderName.trim() && !folderNameExists
                  ? themeColors.primary
                  : isDark
                    ? 'rgba(248, 248, 248, 0.08)'
                    : 'rgba(18, 18, 21, 0.06)',
              borderRadius: 14,
              paddingVertical: 15,
              alignItems: 'center',
              opacity: newFolderName.trim() && !folderNameExists ? 1 : 0.5,
            }}
          >
            <Text
              className="text-[15px] font-roobert-semibold"
              style={{
                color:
                  newFolderName.trim() && !folderNameExists
                    ? themeColors.primaryForeground
                    : isDark
                      ? 'rgba(248, 248, 248, 0.3)'
                      : 'rgba(18, 18, 21, 0.3)',
              }}
            >
              {createFolderMutation.isPending ? 'Creating...' : 'Create Folder'}
            </Text>
          </BottomSheetTouchable>
        </BottomSheetView>
      </BottomSheetModal>

      {/* Rename Bottom Sheet */}
      <BottomSheetModal
        ref={renameSheetRef}
        enableDynamicSizing
        enablePanDownToClose
        backdropComponent={renderBackdrop}
        keyboardBehavior="interactive"
        keyboardBlurBehavior="restore"
        android_keyboardInputMode="adjustResize"
        onDismiss={() => { setRenameName(''); setRenameFile(null); }}
        backgroundStyle={{
          backgroundColor: isDark ? '#161618' : '#FFFFFF',
          borderTopLeftRadius: 24,
          borderTopRightRadius: 24,
        }}
        handleIndicatorStyle={{
          backgroundColor: isDark ? '#3F3F46' : '#D4D4D8',
          width: 36,
          height: 5,
          borderRadius: 3,
        }}
      >
        <BottomSheetView
          style={{
            paddingHorizontal: 24,
            paddingTop: 8,
            paddingBottom: sheetPadding,
          }}
        >
          {/* Header */}
          <View className="flex-row items-center mb-5">
            {(() => {
              const { icon: RenameIcon, color: renameIconColor } = renameFile
                ? getFileIconAndColor(renameFile, isDark)
                : { icon: Folder, color: fgColor };
              return (
                <View
                  className="w-10 h-10 rounded-xl items-center justify-center mr-3"
                  style={{
                    backgroundColor: isDark
                      ? 'rgba(248, 248, 248, 0.08)'
                      : 'rgba(18, 18, 21, 0.05)',
                  }}
                >
                  <Icon
                    as={RenameIcon}
                    size={20}
                    color={renameIconColor}
                    strokeWidth={1.8}
                  />
                </View>
              );
            })()}
            <View className="flex-1">
              <Text
                className="text-lg font-roobert-semibold"
                style={{ color: fgColor }}
              >
                Rename
              </Text>
              <Text
                className="text-xs font-roobert mt-0.5"
                style={{
                  color: isDark
                    ? 'rgba(248, 248, 248, 0.4)'
                    : 'rgba(18, 18, 21, 0.4)',
                }}
                numberOfLines={1}
              >
                {renameFile?.name}
              </Text>
            </View>
          </View>

          {/* Input */}
          <BottomSheetTextInput
            value={renameName}
            onChangeText={setRenameName}
            placeholder="Enter new name"
            placeholderTextColor={
              isDark ? 'rgba(248, 248, 248, 0.25)' : 'rgba(18, 18, 21, 0.3)'
            }
            autoFocus
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="done"
            onSubmitEditing={handleConfirmRename}
            style={{
              backgroundColor: isDark
                ? 'rgba(248, 248, 248, 0.06)'
                : 'rgba(18, 18, 21, 0.04)',
              borderWidth: 1,
              borderColor: renameNameExists
                ? 'rgba(239, 68, 68, 0.6)'
                : isDark
                  ? 'rgba(248, 248, 248, 0.1)'
                  : 'rgba(18, 18, 21, 0.08)',
              borderRadius: 14,
              paddingHorizontal: 16,
              paddingVertical: 14,
              fontSize: 16,
              fontFamily: 'Roobert',
              color: fgColor,
              marginBottom: renameNameExists ? 8 : 20,
            }}
          />
          {renameNameExists && (
            <Text
              className="text-xs font-roobert mb-4"
              style={{ color: '#ef4444', paddingLeft: 4 }}
            >
              A file or folder with that name already exists
            </Text>
          )}

          {/* Rename button */}
          {(() => {
            const canRename =
              !!renameName.trim() &&
              renameName.trim() !== renameFile?.name &&
              !renameNameExists;
            return (
              <BottomSheetTouchable
                onPress={handleConfirmRename}
                disabled={!canRename || renameMutation.isPending}
                style={{
                  backgroundColor: canRename
                    ? themeColors.primary
                    : isDark
                      ? 'rgba(248, 248, 248, 0.08)'
                      : 'rgba(18, 18, 21, 0.06)',
                  borderRadius: 14,
                  paddingVertical: 15,
                  alignItems: 'center',
                  opacity: canRename ? 1 : 0.5,
                }}
              >
                <Text
                  className="text-[15px] font-roobert-semibold"
                  style={{
                    color: canRename
                      ? themeColors.primaryForeground
                      : isDark
                        ? 'rgba(248, 248, 248, 0.3)'
                        : 'rgba(18, 18, 21, 0.3)',
                  }}
                >
                  {renameMutation.isPending ? 'Renaming...' : 'Rename'}
                </Text>
              </BottomSheetTouchable>
            );
          })()}
        </BottomSheetView>
      </BottomSheetModal>

      {/* File Viewer */}
      <FileViewer
        visible={viewerVisible}
        onClose={() => {
          setViewerVisible(false);
          setViewerFile(null);
        }}
        file={viewerFile}
        sandboxId={sandboxId || ''}
        sandboxUrl={sandboxUrl}
      />
      </PageContent>
    </View>
  );
});

// ── Unified row card for folders + files ───────────────────────────────────
// Single compact row variant (matches the FOLDERS row style in the screenshot)
// so folders and files share identical card chrome. Icon uses the same
// monochrome mapping as the web file tree and the FileItem list view.

function FileRowCard({
  file,
  isDark,
  fgColor,
  onPress,
  onLongPress,
}: {
  file: SandboxFile;
  isDark: boolean;
  fgColor: string;
  onPress: () => void;
  onLongPress: () => void;
}) {
  const IconComponent = getFileIconComponent(file);
  const iconColor = getMutedIconColor(isDark);

  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      className="flex-row items-center rounded-xl border active:opacity-70"
      style={{
        borderColor: isDark
          ? 'rgba(248, 248, 248, 0.1)'
          : 'rgba(18, 18, 21, 0.1)',
        backgroundColor: isDark ? '#1a1a1c' : '#ffffff',
        paddingHorizontal: 12,
        paddingVertical: 10,
      }}
    >
      <Icon
        as={IconComponent}
        size={18}
        color={iconColor}
        strokeWidth={2}
        style={{ marginRight: 8 }}
      />
      <Text
        style={{ color: fgColor }}
        className="text-sm font-roobert-medium flex-1"
        numberOfLines={1}
      >
        {file.name}
      </Text>
    </Pressable>
  );
}
