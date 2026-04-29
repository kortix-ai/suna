/**
 * ProjectDetailPage — Single project view with tabs (Sessions, Tasks, Agents).
 * Ported from web's /projects/[id]/page.tsx.
 */

import React, { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import {
  View,
  TouchableOpacity,
  ScrollView,
  RefreshControl,
  Alert,
  ActivityIndicator,
  ActionSheetIOS,
  Keyboard,
  Platform,
  Switch,
  TextInput,
  Image,
  Text as RNText,
} from 'react-native';
import * as Haptics from 'expo-haptics';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import { useQueryClient } from '@tanstack/react-query';

const monoFont = Platform.OS === 'ios' ? 'Menlo' : 'monospace';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { useColorScheme } from 'nativewind';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import {
  BottomSheetModal,
  BottomSheetBackdrop,
  BottomSheetView,
  BottomSheetScrollView,
  BottomSheetTextInput,
  TouchableOpacity as BottomSheetTouchable,
} from '@gorhom/bottom-sheet';
import type { BottomSheetBackdropProps } from '@gorhom/bottom-sheet';
import { useThemeColors, getSheetBg } from '@/lib/theme-colors';
import {
  FolderGit2,
  MessageSquare,
  ListTodo,
  Clock,
  Trash2,
  Pencil,
  CheckCircle2,
  Circle,
  Loader2,
  AlertTriangle,
  Ban,
  FolderOpen,
  Code2,
  FileText,
  Plus,
  Play,
  Paperclip,
  X as XIcon,
  File as FileIcon,
  Search,
} from 'lucide-react-native';

import { FileItem } from '@/components/files/FileItem';
import { FileViewer } from '@/components/files/FileViewer';
import { SelectableMarkdownText } from '@/components/ui/selectable-markdown';
import { useOpenCodeFiles, useOpenCodeFileContent, useOpenCodeUploadFile, fileKeys } from '@/lib/files/hooks';
import type { SandboxFile } from '@/api/types';

import { useSandboxContext } from '@/contexts/SandboxContext';
import { useSheetBottomPadding } from '@/hooks/useSheetKeyboard';
import {
  useKortixProject,
  useKortixProjectSessions,
  useKortixTasks,
  useUpdateProject,
  useDeleteProject,
  useCreateKortixTask,
  useUpdateKortixTask,
  useDeleteKortixTask,
  useStartKortixTask,
  useApproveKortixTask,
  type KortixTask,
  type KortixTaskStatus,
} from '@/lib/kortix';
import { useTabStore } from '@/stores/tab-store';
import { PageHeader } from '@/components/ui/page-header';
import { PageContent } from '@/components/ui/page-content';
import { formatCost, formatTokens } from '@/lib/opencode/turns';
import {
  useProjectSessionStats,
  totalTokens as sumTokens,
} from '@/lib/opencode/hooks/use-project-session-stats';

// ── Helpers ──────────────────────────────────────────────────────────────────

function ago(t?: string | number) {
  if (!t) return '';
  const ms = Date.now() - (typeof t === 'string' ? +new Date(t) : t);
  const m = (ms / 60000) | 0;
  if (m < 1) return 'just now';
  if (m < 60) return m + 'm ago';
  const h = (m / 60) | 0;
  if (h < 24) return h + 'h ago';
  const d = (h / 24) | 0;
  return d < 30
    ? d + 'd ago'
    : new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

type Tab = 'files' | 'sessions' | 'tasks' | 'about';

// Task status config — aligned with web's unified agent_task system.
// Pipeline: todo → [START] → in_progress → input_needed/awaiting_review → [APPROVE] → completed
const STATUS_CONFIG: Record<string, { icon: typeof Circle; color: string; label: string }> = {
  todo: { icon: Circle, color: '#71717a', label: 'Planned' },
  in_progress: { icon: Loader2, color: '#60a5fa', label: 'Running' },
  input_needed: { icon: AlertTriangle, color: '#a78bfa', label: 'Input Needed' },
  awaiting_review: { icon: AlertTriangle, color: '#f59e0b', label: 'Awaiting Review' },
  completed: { icon: CheckCircle2, color: '#22c55e', label: 'Completed' },
  cancelled: { icon: Ban, color: '#71717a', label: 'Cancelled' },
  // Agent statuses (separate enum, but reused for visual parity)
  running: { icon: Loader2, color: '#60a5fa', label: 'Running' },
  failed: { icon: AlertTriangle, color: '#ef4444', label: 'Failed' },
  stopped: { icon: Ban, color: '#71717a', label: 'Stopped' },
};

// ── Types ────────────────────────────────────────────────────────────────────

interface ProjectDetailPageProps {
  projectId: string;
  onBack: () => void;
  onOpenDrawer?: () => void;
  onOpenRightDrawer?: () => void;
  isDrawerOpen?: boolean;
  isRightDrawerOpen?: boolean;
}

// ── Component ────────────────────────────────────────────────────────────────

export function ProjectDetailPage({
  projectId,
  onBack,
  onOpenDrawer,
  onOpenRightDrawer,
  isDrawerOpen,
  isRightDrawerOpen,
}: ProjectDetailPageProps) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const insets = useSafeAreaInsets();
  const { sandboxUrl } = useSandboxContext();
  const themeColors = useThemeColors();

  const { data: project, isLoading, refetch } = useKortixProject(sandboxUrl, projectId);
  const { data: sessions } = useKortixProjectSessions(sandboxUrl, projectId);
  const { data: tasks } = useKortixTasks(sandboxUrl, project?.id);
  const updateProject = useUpdateProject(sandboxUrl);
  const deleteProject = useDeleteProject(sandboxUrl);
  const createTask = useCreateKortixTask(sandboxUrl);
  const updateTask = useUpdateKortixTask(sandboxUrl);
  const deleteTask = useDeleteKortixTask(sandboxUrl);
  const startTask = useStartKortixTask(sandboxUrl);
  const approveTask = useApproveKortixTask(sandboxUrl);

  // Store project name in tab state for TabsOverview title
  useEffect(() => {
    if (project?.name) {
      useTabStore
        .getState()
        .setTabState(`page:project:${projectId}`, { projectName: project.name });
    }
  }, [project?.name, projectId]);

  const [tab, setTab] = useState<Tab>('files');
  const editSheetRef = useRef<BottomSheetModal>(null);
  const taskSheetRef = useRef<BottomSheetModal>(null);
  const newTaskSheetRef = useRef<BottomSheetModal>(null);
  const sheetPadding = useSheetBottomPadding();
  const tabScrollRef = useRef<ScrollView>(null);
  const tabLayoutsRef = useRef<Record<number, { x: number; width: number }>>({});
  const [editField, setEditField] = useState<'name' | 'description'>('name');
  const [editValue, setEditValue] = useState('');
  const [selectedTask, setSelectedTask] = useState<KortixTask | null>(null);

  // ── New task state (ported from web new-task-dialog) ────────────────────
  type TaskAttachment = { uri: string; name: string; mimeType: string; isImage: boolean };
  const [newTaskTitle, setNewTaskTitle] = useState('');
  const [newTaskDescription, setNewTaskDescription] = useState('');
  const [newTaskVerification, setNewTaskVerification] = useState('');
  const [showVerification, setShowVerification] = useState(false);
  const [autoRun, setAutoRun] = useState(true);
  const [createMore, setCreateMore] = useState(false);
  const [newTaskFiles, setNewTaskFiles] = useState<TaskAttachment[]>([]);
  const [uploadingAttachments, setUploadingAttachments] = useState(false);
  const [taskSearch, setTaskSearch] = useState('');
  const uploadMutForTasks = useOpenCodeUploadFile();

  const resetNewTaskForm = useCallback(() => {
    setNewTaskTitle('');
    setNewTaskDescription('');
    setNewTaskVerification('');
    setShowVerification(false);
    setNewTaskFiles([]);
  }, []);

  const openNewTaskSheet = useCallback(() => {
    resetNewTaskForm();
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    newTaskSheetRef.current?.present();
  }, [resetNewTaskForm]);

  const addTaskFiles = useCallback((files: TaskAttachment[]) => {
    if (files.length === 0) return;
    setNewTaskFiles((prev) => [...prev, ...files]);
  }, []);

  const removeTaskFile = useCallback((index: number) => {
    setNewTaskFiles((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const pickFromPhotos = useCallback(async () => {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsMultipleSelection: true,
      quality: 0.9,
    });
    if (!result.canceled) {
      addTaskFiles(
        result.assets.map((a) => ({
          uri: a.uri,
          name: a.fileName || a.uri.split('/').pop() || `image_${Date.now()}.jpg`,
          mimeType: a.mimeType || 'image/jpeg',
          isImage: true,
        })),
      );
    }
  }, [addTaskFiles]);

  const takePhoto = useCallback(async () => {
    const { status } = await ImagePicker.requestCameraPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert('Permission required', 'Camera access is needed to take photos.');
      return;
    }
    const result = await ImagePicker.launchCameraAsync({ quality: 0.9 });
    if (!result.canceled) {
      const a = result.assets[0];
      addTaskFiles([
        {
          uri: a.uri,
          name: a.fileName || `photo_${Date.now()}.jpg`,
          mimeType: a.mimeType || 'image/jpeg',
          isImage: true,
        },
      ]);
    }
  }, [addTaskFiles]);

  const pickDocuments = useCallback(async () => {
    const result = await DocumentPicker.getDocumentAsync({
      multiple: true,
      copyToCacheDirectory: true,
    });
    if (!result.canceled) {
      addTaskFiles(
        result.assets.map((a) => ({
          uri: a.uri,
          name: a.name,
          mimeType: a.mimeType || 'application/octet-stream',
          isImage: (a.mimeType || '').startsWith('image/'),
        })),
      );
    }
  }, [addTaskFiles]);

  const openAttachmentPicker = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions(
        {
          options: ['Cancel', 'Photo Library', 'Take Photo', 'Browse Files'],
          cancelButtonIndex: 0,
        },
        async (buttonIndex) => {
          if (buttonIndex === 1) await pickFromPhotos();
          else if (buttonIndex === 2) await takePhoto();
          else if (buttonIndex === 3) await pickDocuments();
        },
      );
    } else {
      Alert.alert('Attach file', 'Choose source', [
        { text: 'Photo Library', onPress: pickFromPhotos },
        { text: 'Take Photo', onPress: takePhoto },
        { text: 'Browse Files', onPress: pickDocuments },
        { text: 'Cancel', style: 'cancel' },
      ]);
    }
  }, [pickFromPhotos, takePhoto, pickDocuments]);

  const submitNewTask = useCallback(async () => {
    if (!project) return;
    const title = newTaskTitle.trim();
    if (!title) return;
    Keyboard.dismiss();

    // Upload attachments first (matches web flow — upload to /workspace/uploads, then append refs).
    let attachmentPaths: string[] = [];
    if (newTaskFiles.length > 0 && sandboxUrl) {
      setUploadingAttachments(true);
      try {
        const uploadDir = '/workspace/uploads';
        const results = await Promise.all(
          newTaskFiles.map((f) =>
            uploadMutForTasks.mutateAsync({
              sandboxUrl,
              file: { uri: f.uri, name: f.name, type: f.mimeType },
              targetPath: uploadDir,
            }),
          ),
        );
        attachmentPaths = results
          .flat()
          .map((r: any) => r?.path || r?.file?.path)
          .filter(Boolean);
      } catch (err: any) {
        setUploadingAttachments(false);
        Alert.alert('Upload failed', err?.message || 'Could not upload attachments.');
        return;
      }
      setUploadingAttachments(false);
    }

    let fullDescription = newTaskDescription.trim();
    if (attachmentPaths.length > 0) {
      const refs = attachmentPaths.map((p) => `- ${p}`).join('\n');
      fullDescription = fullDescription
        ? `${fullDescription}\n\nAttachments:\n${refs}`
        : `Attachments:\n${refs}`;
    }

    createTask.mutate(
      {
        project_id: project.id,
        title,
        description: fullDescription,
        verification_condition: newTaskVerification.trim(),
        status: 'todo',
      },
      {
        onSuccess: (task) => {
          if (autoRun && task?.id) {
            startTask.mutate({ id: task.id });
          }
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          if (createMore) {
            resetNewTaskForm();
          } else {
            newTaskSheetRef.current?.dismiss();
          }
        },
        onError: (err: any) => {
          Alert.alert('Failed to create task', err?.message || 'Something went wrong.');
        },
      },
    );
  }, [
    project,
    sandboxUrl,
    newTaskTitle,
    newTaskDescription,
    newTaskVerification,
    newTaskFiles,
    autoRun,
    createMore,
    createTask,
    startTask,
    uploadMutForTasks,
    resetNewTaskForm,
  ]);

  const fg = isDark ? '#F8F8F8' : '#121215';
  const muted = isDark ? 'rgba(248,248,248,0.5)' : 'rgba(18,18,21,0.5)';
  const mutedStrong = isDark ? '#a1a1aa' : '#71717a';
  const cardBg = isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.02)';
  const border = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)';
  const bg = isDark ? '#121215' : '#F8F8F8';

  const sessionList = useMemo(() => {
    const rows = sessions ?? [];
    return [...rows].sort((a: any, b: any) => (
      (b.time?.updated ? +new Date(b.time.updated) : 0) -
      (a.time?.updated ? +new Date(a.time.updated) : 0)
    ));
  }, [sessions]);
  const sessionIds = useMemo(() => sessionList.map((s: any) => s.id), [sessionList]);
  const { totals: sessionTotals, loading: statsLoading } = useProjectSessionStats(
    sandboxUrl,
    sessionIds,
    tab === 'sessions',
  );
  const taskList = tasks ?? [];
  const filteredTaskList = useMemo(() => {
    if (!taskSearch.trim()) return taskList;
    const q = taskSearch.toLowerCase();
    return taskList.filter(
      (t) =>
        t.title.toLowerCase().includes(q) ||
        (t.description || '').toLowerCase().includes(q),
    );
  }, [taskList, taskSearch]);

  const taskStats = useMemo(() => {
    const done = taskList.filter((t) => t.status === 'completed').length;
    const inProgress = taskList.filter((t) => t.status === 'in_progress').length;
    const inputNeeded = taskList.filter((t) => t.status === 'input_needed').length;
    const awaitingReview = taskList.filter((t) => t.status === 'awaiting_review').length;
    const todo = taskList.filter((t) => t.status === 'todo').length;
    return { done, inProgress, inputNeeded, awaitingReview, todo, total: taskList.length };
  }, [taskList]);

  // Files tab state
  const hasFiles = !!project?.path && project.path !== '/';
  const [filePath, setFilePath] = useState(project?.path || '/workspace');
  const {
    data: files,
    isLoading: filesLoading,
    refetch: refetchFiles,
  } = useOpenCodeFiles(hasFiles && tab === 'files' ? sandboxUrl : undefined, filePath);
  const [viewerFile, setViewerFile] = useState<SandboxFile | null>(null);
  const [viewerVisible, setViewerVisible] = useState(false);

  // Reset file path when project changes
  useEffect(() => {
    if (project?.path) setFilePath(project.path);
  }, [project?.path]);

  // ── CONTEXT.md hero (ported from web project-about.tsx) ──────────────────
  const contextPath = useMemo(() => {
    if (!project?.path || project.path === '/') return undefined;
    return `${project.path.replace(/\/+$/, '')}/.kortix/CONTEXT.md`;
  }, [project?.path]);

  const {
    data: contextContent,
    isLoading: contextLoading,
    error: contextError,
  } = useOpenCodeFileContent(
    tab === 'about' ? sandboxUrl : undefined,
    tab === 'about' ? contextPath : undefined,
    { staleTime: 30_000, retry: 1 },
  );

  const qc = useQueryClient();
  const uploadMutation = useOpenCodeUploadFile();
  const [contextEditing, setContextEditing] = useState(false);
  const [contextDraft, setContextDraft] = useState('');
  const [contextSaving, setContextSaving] = useState(false);

  const saveContext = useCallback(async () => {
    if (!sandboxUrl || !contextPath) return;
    const current = (contextContent || '') as string;
    if (contextDraft === current) {
      setContextEditing(false);
      return;
    }
    setContextSaving(true);
    try {
      const parts = contextPath.split('/');
      const fileName = parts.pop() || 'CONTEXT.md';
      const dirPath = parts.join('/');

      // Write draft to cache, then upload the file to the project .kortix dir.
      const cacheUri = `${FileSystem.cacheDirectory}${fileName}`;
      await FileSystem.writeAsStringAsync(cacheUri, contextDraft, {
        encoding: FileSystem.EncodingType.UTF8,
      });
      await uploadMutation.mutateAsync({
        sandboxUrl,
        file: { uri: cacheUri, name: fileName, type: 'text/markdown' },
        targetPath: dirPath,
      });
      // Invalidate the specific file-content query so the preview updates.
      qc.invalidateQueries({ queryKey: fileKeys.opencodeFile(sandboxUrl, contextPath) });
    } catch (err: any) {
      Alert.alert('Save Failed', err?.message || 'Could not save CONTEXT.md');
    } finally {
      setContextSaving(false);
      setContextEditing(false);
    }
  }, [sandboxUrl, contextPath, contextContent, contextDraft, uploadMutation, qc]);

  const startContextEdit = useCallback(() => {
    setContextDraft(((contextContent as string) || ''));
    setContextEditing(true);
  }, [contextContent]);

  const cancelContextEdit = useCallback(() => {
    setContextEditing(false);
    setContextDraft('');
    Keyboard.dismiss();
  }, []);

  const { folders, regularFiles } = useMemo(() => {
    if (!files || !Array.isArray(files)) return { folders: [], regularFiles: [] };
    const sort = (a: SandboxFile, b: SandboxFile) => a.name.localeCompare(b.name);
    return {
      folders: files
        .filter((f: SandboxFile) => f.type === 'directory' && !f.name.startsWith('.'))
        .sort(sort),
      regularFiles: files
        .filter((f: SandboxFile) => f.type === 'file' && !f.name.startsWith('.'))
        .sort(sort),
    };
  }, [files]);

  const handleFilePress = useCallback((file: SandboxFile) => {
    if (file.type === 'directory') {
      setFilePath(file.path);
    } else {
      setViewerFile(file);
      setViewerVisible(true);
    }
  }, []);

  // Navigate up in file tree
  const canGoUp = hasFiles && filePath !== project?.path;
  const handleFileGoUp = useCallback(() => {
    const parent = filePath.substring(0, filePath.lastIndexOf('/')) || '/';
    setFilePath(parent);
  }, [filePath]);

  const tabs: Array<{ id: Tab; label: string; count: number; icon: typeof MessageSquare }> = [
    ...(hasFiles ? [{ id: 'files' as Tab, label: 'Files', count: 0, icon: Code2 }] : []),
    { id: 'sessions', label: 'Sessions', count: sessionList.length, icon: MessageSquare },
    { id: 'tasks', label: 'Tasks', count: taskList.length, icon: ListTodo },
    { id: 'about', label: 'About', count: 0, icon: FolderOpen },
  ];

  const handleSessionPress = useCallback((sessionId: string) => {
    useTabStore.getState().navigateToSession(sessionId);
  }, []);

  const handleEdit = useCallback(
    (field: 'name' | 'description') => {
      if (!project) return;
      setEditField(field);
      setEditValue(field === 'name' ? project.name : project.description || '');
      editSheetRef.current?.present();
    },
    [project]
  );

  const handleSaveEdit = useCallback(() => {
    if (!project) return;
    const trimmed = editValue.trim();
    if (editField === 'name' && !trimmed) return;
    Keyboard.dismiss();
    updateProject.mutate(
      { id: project.id, [editField]: trimmed },
      {
        onSuccess: () => {
          editSheetRef.current?.dismiss();
          setEditValue('');
        },
      }
    );
  }, [project, editField, editValue, updateProject]);

  const handleDelete = useCallback(() => {
    if (!project) return;
    Alert.alert(
      'Delete Project',
      `Remove "${project.name}" from registry? Files on disk will NOT be deleted.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            deleteProject.mutate(project.id, { onSuccess: onBack });
          },
        },
      ]
    );
  }, [project, deleteProject, onBack]);

  const renderBackdrop = useMemo(
    () => (props: BottomSheetBackdropProps) => (
      <BottomSheetBackdrop {...props} appearsOnIndex={0} disappearsOnIndex={-1} opacity={0.35} />
    ),
    []
  );

  // Loading
  if (isLoading) {
    return (
      <View
        style={{ flex: 1, backgroundColor: bg, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator size="large" color={muted} />
      </View>
    );
  }

  // Not found
  if (!project) {
    return (
      <View
        style={{
          flex: 1,
          backgroundColor: bg,
          alignItems: 'center',
          justifyContent: 'center',
          padding: 40,
        }}>
        <FolderGit2
          size={48}
          color={isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.05)'}
          style={{ marginBottom: 12 }}
        />
        <RNText style={{ fontSize: 15, fontFamily: 'Roobert-Medium', color: muted }}>
          Project not found
        </RNText>
        <TouchableOpacity onPress={onBack} style={{ marginTop: 12 }}>
          <RNText
            style={{
              fontSize: 13,
              fontFamily: 'Roobert-Medium',
              color: isDark ? '#60a5fa' : '#2563eb',
            }}>
            Go back
          </RNText>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: bg }}>
      <PageHeader
        title={
          <TouchableOpacity
            onPress={() => handleEdit('name')}
            activeOpacity={0.7}
            style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <FolderGit2 size={16} color={mutedStrong} />
            <Text
              className="text-base font-medium text-muted-foreground"
              style={{ flexShrink: 1 }}
              numberOfLines={1}>
              {project.name}
            </Text>
            <Pencil size={12} color={isDark ? '#3f3f46' : '#d4d4d8'} />
          </TouchableOpacity>
        }
        onOpenDrawer={onOpenDrawer}
        onOpenRightDrawer={onOpenRightDrawer}
        isDrawerOpen={isDrawerOpen}
        isRightDrawerOpen={isRightDrawerOpen}
        rightActions={
          <TouchableOpacity
            onPress={handleDelete}
            style={{ padding: 6, marginRight: 4 }}
            hitSlop={8}>
            <Trash2 size={18} color={isDark ? '#52525b' : '#a1a1aa'} />
          </TouchableOpacity>
        }
      />

      <PageContent>
      {/* Tab bar */}
      <ScrollView
        ref={tabScrollRef}
        horizontal
        showsHorizontalScrollIndicator={false}
        style={{ borderBottomWidth: 1, borderBottomColor: border, flexGrow: 0 }}
        contentContainerStyle={{ paddingHorizontal: 16 }}>
        {tabs.map((t, index) => {
          const active = tab === t.id;
          const Icon = t.icon;
          return (
            <TouchableOpacity
              key={t.id}
              onLayout={(e) => {
                tabLayoutsRef.current[index] = {
                  x: e.nativeEvent.layout.x,
                  width: e.nativeEvent.layout.width,
                };
              }}
              onPress={() => {
                setTab(t.id);
                const layout = tabLayoutsRef.current[index];
                if (layout && tabScrollRef.current) {
                  tabScrollRef.current.scrollTo({ x: Math.max(0, layout.x - 16), animated: true });
                }
              }}
              activeOpacity={0.7}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 5,
                paddingHorizontal: 12,
                paddingVertical: 10,
                borderBottomWidth: 2,
                borderBottomColor: active ? themeColors.primary : 'transparent',
              }}>
              <Icon size={14} color={active ? themeColors.primary : mutedStrong} />
              <RNText
                style={{
                  fontSize: 13,
                  fontFamily: active ? 'Roobert-Medium' : 'Roobert',
                  color: active ? themeColors.primary : mutedStrong,
                }}>
                {t.label}
              </RNText>
              {t.count > 0 && (
                <View
                  style={{
                    backgroundColor: active
                      ? isDark
                        ? 'rgba(255,255,255,0.1)'
                        : 'rgba(0,0,0,0.06)'
                      : isDark
                        ? 'rgba(255,255,255,0.05)'
                        : 'rgba(0,0,0,0.03)',
                    borderRadius: 10,
                    paddingHorizontal: 6,
                    paddingVertical: 1,
                  }}>
                  <RNText
                    style={{
                      fontSize: 11,
                      fontFamily: 'Roobert',
                      color: active ? fg : mutedStrong,
                    }}>
                    {t.count}
                  </RNText>
                </View>
              )}
            </TouchableOpacity>
          );
        })}
      </ScrollView>

      {/* Content */}
      <ScrollView
        style={{ flex: 1 }}
        refreshControl={<RefreshControl refreshing={false} onRefresh={refetch} tintColor={muted} />}
        contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>
        {/* ── Files Tab ── */}
        {tab === 'files' &&
          (hasFiles ? (
            <View>
              {/* Breadcrumb / back navigation */}
              {canGoUp && (
                <TouchableOpacity
                  onPress={handleFileGoUp}
                  activeOpacity={0.7}
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 6,
                    paddingVertical: 8,
                    paddingHorizontal: 4,
                    marginBottom: 4,
                  }}>
                  <Ionicons name="arrow-back" size={16} color={mutedStrong} />
                  <RNText
                    style={{ fontSize: 12, fontFamily: 'Menlo', color: mutedStrong }}
                    numberOfLines={1}>
                    {filePath.split('/').pop() || filePath}
                  </RNText>
                </TouchableOpacity>
              )}

              {filesLoading && folders.length === 0 && regularFiles.length === 0 && (
                <View style={{ padding: 30, alignItems: 'center' }}>
                  <ActivityIndicator size="small" color={muted} />
                </View>
              )}

              {/* Folders */}
              {folders.length > 0 && (
                <View style={{ marginBottom: 8 }}>
                  {folders.map((file: SandboxFile) => (
                    <FileItem key={file.path} file={file} onPress={handleFilePress} />
                  ))}
                </View>
              )}

              {/* Files */}
              {regularFiles.length > 0 && (
                <View>
                  {regularFiles.map((file: SandboxFile) => (
                    <FileItem key={file.path} file={file} onPress={handleFilePress} />
                  ))}
                </View>
              )}

              {!filesLoading && folders.length === 0 && regularFiles.length === 0 && (
                <EmptyState icon={FolderOpen} text="Empty directory" isDark={isDark} />
              )}
            </View>
          ) : (
            <EmptyState
              icon={FolderOpen}
              text="No project path configured"
              sub="This project doesn't have a file path"
              isDark={isDark}
            />
          ))}

        {/* ── Sessions Tab ── */}
        {tab === 'sessions' &&
          (sessionList.length === 0 ? (
            <EmptyState
              icon={MessageSquare}
              text="No sessions linked"
              sub="Sessions appear when you use project_select"
              isDark={isDark}
            />
          ) : (
            <View style={{ gap: 14 }}>
              <ProjectTotalsCard
                totalSessions={sessionList.length}
                messageCount={sessionTotals.messageCount}
                tokens={sumTokens(sessionTotals.tokens)}
                cost={sessionTotals.cost}
                loading={statsLoading}
                isDark={isDark}
                fg={fg}
                muted={muted}
                cardBg={cardBg}
                border={border}
              />
              <View
                style={{
                  borderRadius: 12,
                  borderWidth: 1,
                  borderColor: border,
                  backgroundColor: cardBg,
                  overflow: 'hidden',
                }}>
              {sessionList.map((s: any, i: number) => (
                <TouchableOpacity
                  key={s.id}
                  onPress={() => handleSessionPress(s.id)}
                  activeOpacity={0.7}
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    paddingHorizontal: 14,
                    paddingVertical: 12,
                    gap: 10,
                    borderBottomWidth: i < sessionList.length - 1 ? 1 : 0,
                    borderBottomColor: border,
                  }}>
                  <MessageSquare size={14} color={isDark ? '#3f3f46' : '#d4d4d8'} />
                  <RNText
                    numberOfLines={1}
                    style={{ flex: 1, fontSize: 14, fontFamily: 'Roobert', color: fg }}>
                    {s.title || 'Untitled'}
                  </RNText>
                  <RNText
                    style={{
                      fontSize: 11,
                      fontFamily: 'Roobert',
                      color: isDark ? '#3f3f46' : '#a1a1aa',
                    }}>
                    {ago(s.time?.updated)}
                  </RNText>
                </TouchableOpacity>
              ))}
              </View>
            </View>
          ))}

        {/* ── Tasks Tab ── */}
        {tab === 'tasks' &&
          (taskList.length === 0 ? (
            <View style={{ paddingVertical: 40, alignItems: 'center' }}>
              <ListTodo
                size={32}
                color={isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.05)'}
                style={{ marginBottom: 10 }}
              />
              <RNText
                style={{
                  fontSize: 14,
                  fontFamily: 'Roobert-Medium',
                  color: isDark ? 'rgba(248,248,248,0.5)' : 'rgba(18,18,21,0.5)',
                  marginBottom: 4,
                }}>
                No tasks yet
              </RNText>
              <RNText
                style={{
                  fontSize: 12,
                  fontFamily: 'Roobert',
                  color: isDark ? 'rgba(255,255,255,0.25)' : 'rgba(0,0,0,0.25)',
                  textAlign: 'center',
                  marginBottom: 18,
                  paddingHorizontal: 20,
                  lineHeight: 17,
                }}>
                Create tasks so Kortix knows what to work on next.
              </RNText>
              <TouchableOpacity
                onPress={openNewTaskSheet}
                activeOpacity={0.85}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 8,
                  paddingHorizontal: 18,
                  paddingVertical: 11,
                  borderRadius: 9999,
                  backgroundColor: themeColors.primary,
                }}>
                <Plus size={15} color={themeColors.primaryForeground} />
                <RNText
                  style={{
                    fontSize: 14,
                    fontFamily: 'Roobert-Medium',
                    color: themeColors.primaryForeground,
                  }}>
                  New task
                </RNText>
              </TouchableOpacity>
            </View>
          ) : (
            <>
              {/* Progress bar + new task button */}
              {taskStats.total > 0 && (
                <View style={{ marginBottom: 14 }}>
                  <View
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      marginBottom: 8,
                      gap: 10,
                    }}>
                    <RNText style={{ fontSize: 12, fontFamily: 'Roobert', color: mutedStrong }}>
                      {Math.round((taskStats.done / taskStats.total) * 100)}% complete
                      {'  '}
                      <RNText style={{ color: isDark ? 'rgba(255,255,255,0.3)' : 'rgba(0,0,0,0.3)' }}>
                        {taskStats.done}/{taskStats.total}
                      </RNText>
                    </RNText>
                    <TouchableOpacity
                      onPress={openNewTaskSheet}
                      activeOpacity={0.85}
                      hitSlop={6}
                      style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        gap: 6,
                        paddingHorizontal: 12,
                        paddingVertical: 7,
                        borderRadius: 9999,
                        backgroundColor: themeColors.primary,
                      }}>
                      <Plus size={13} color={themeColors.primaryForeground} />
                      <RNText
                        style={{
                          fontSize: 12,
                          fontFamily: 'Roobert-Medium',
                          color: themeColors.primaryForeground,
                        }}>
                        New task
                      </RNText>
                    </TouchableOpacity>
                  </View>
                  <View
                    style={{
                      height: 6,
                      backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)',
                      borderRadius: 3,
                      overflow: 'hidden',
                    }}>
                    <View
                      style={{
                        height: '100%',
                        width: `${(taskStats.done / taskStats.total) * 100}%`,
                        backgroundColor: '#22c55e',
                        borderRadius: 3,
                      }}
                    />
                  </View>
                </View>
              )}

              {/* Task search */}
              <View
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)',
                  borderRadius: 9999,
                  paddingHorizontal: 14,
                  height: 38,
                  marginBottom: 10,
                }}>
                <Search size={14} color={isDark ? '#71717a' : '#a1a1aa'} />
                <TextInput
                  value={taskSearch}
                  onChangeText={setTaskSearch}
                  placeholder="Search tasks..."
                  placeholderTextColor={isDark ? '#71717a' : '#a1a1aa'}
                  style={{
                    flex: 1,
                    marginLeft: 6,
                    fontSize: 14,
                    fontFamily: 'Roobert',
                    color: fg,
                    paddingVertical: 0,
                  }}
                  autoCorrect={false}
                  autoCapitalize="none"
                  returnKeyType="search"
                />
                {taskSearch.length > 0 && (
                  <TouchableOpacity onPress={() => setTaskSearch('')} hitSlop={8}>
                    <XIcon size={14} color={isDark ? '#71717a' : '#a1a1aa'} />
                  </TouchableOpacity>
                )}
              </View>

              {filteredTaskList.length === 0 ? (
                <View style={{ paddingVertical: 28, alignItems: 'center' }}>
                  <RNText
                    style={{
                      fontSize: 13,
                      fontFamily: 'Roobert',
                      color: mutedStrong,
                    }}>
                    No tasks match &ldquo;{taskSearch}&rdquo;
                  </RNText>
                </View>
              ) : (
              <View
                style={{
                  borderRadius: 12,
                  borderWidth: 1,
                  borderColor: border,
                  backgroundColor: cardBg,
                  overflow: 'hidden',
                }}>
                {filteredTaskList.map((t: KortixTask, i: number) => {
                  const sc = STATUS_CONFIG[t.status] || STATUS_CONFIG.todo;
                  const StatusIcon = sc.icon;
                  const isTerminal = t.status === 'completed' || t.status === 'cancelled';
                  return (
                    <TouchableOpacity
                      key={t.id}
                      onPress={() => {
                        setSelectedTask(t);
                        taskSheetRef.current?.present();
                      }}
                      activeOpacity={0.7}
                      style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        paddingHorizontal: 14,
                        paddingVertical: 11,
                        gap: 10,
                        borderBottomWidth: i < filteredTaskList.length - 1 ? 1 : 0,
                        borderBottomColor: border,
                        opacity: isTerminal ? 0.55 : 1,
                      }}>
                      <StatusIcon size={14} color={sc.color} />
                      <RNText
                        numberOfLines={1}
                        style={{
                          flex: 1,
                          fontSize: 14,
                          fontFamily: 'Roobert',
                          color: fg,
                          textDecorationLine: isTerminal ? 'line-through' : 'none',
                        }}>
                        {t.title}
                      </RNText>
                      <RNText
                        style={{
                          fontSize: 11,
                          fontFamily: 'Roobert',
                          color: isDark ? '#3f3f46' : '#a1a1aa',
                        }}>
                        {ago(t.updated_at)}
                      </RNText>
                    </TouchableOpacity>
                  );
                })}
              </View>
              )}
            </>
          ))}

        {/* ── About Tab ── */}
        {tab === 'about' && (
          <View style={{ gap: 16 }}>
            {/* CONTEXT.md — hero section (ported from web project-about.tsx) */}
            {contextPath && (
              <View
                style={{
                  borderRadius: 14,
                  borderWidth: 1,
                  borderColor: border,
                  backgroundColor: cardBg,
                  padding: 14,
                }}>
                <View
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    marginBottom: 10,
                  }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1 }}>
                    <FileText size={15} color={fg} />
                    <RNText style={{ fontSize: 14, fontFamily: 'Roobert-Medium', color: fg }}>
                      CONTEXT.md
                    </RNText>
                    <RNText
                      style={{
                        fontSize: 11,
                        fontFamily: 'Menlo',
                        color: mutedStrong,
                        marginLeft: 2,
                      }}
                      numberOfLines={1}
                    >
                      .kortix/CONTEXT.md
                    </RNText>
                  </View>
                  {!contextEditing ? (
                    <TouchableOpacity
                      onPress={startContextEdit}
                      hitSlop={8}
                      disabled={contextLoading}
                    >
                      <Pencil size={14} color={mutedStrong} />
                    </TouchableOpacity>
                  ) : (
                    <View style={{ flexDirection: 'row', gap: 6 }}>
                      <TouchableOpacity
                        onPress={cancelContextEdit}
                        disabled={contextSaving}
                        hitSlop={6}
                        style={{
                          paddingHorizontal: 10,
                          paddingVertical: 5,
                          borderRadius: 8,
                          backgroundColor: isDark
                            ? 'rgba(255,255,255,0.06)'
                            : 'rgba(0,0,0,0.04)',
                        }}
                      >
                        <RNText
                          style={{ fontSize: 12, fontFamily: 'Roobert-Medium', color: fg }}
                        >
                          Cancel
                        </RNText>
                      </TouchableOpacity>
                      <TouchableOpacity
                        onPress={saveContext}
                        disabled={contextSaving}
                        hitSlop={6}
                        style={{
                          flexDirection: 'row',
                          alignItems: 'center',
                          gap: 4,
                          paddingHorizontal: 10,
                          paddingVertical: 5,
                          borderRadius: 8,
                          backgroundColor: themeColors.primary,
                          opacity: contextSaving ? 0.7 : 1,
                        }}
                      >
                        {contextSaving ? (
                          <ActivityIndicator size="small" color={themeColors.primaryForeground} />
                        ) : (
                          <RNText
                            style={{
                              fontSize: 12,
                              fontFamily: 'Roobert-Medium',
                              color: themeColors.primaryForeground,
                            }}
                          >
                            Save
                          </RNText>
                        )}
                      </TouchableOpacity>
                    </View>
                  )}
                </View>

                {/* Body */}
                {contextEditing ? (
                  <TextInput
                    value={contextDraft}
                    onChangeText={setContextDraft}
                    multiline
                    placeholder={'# Project context\n\nWhat the agent should know about this project...'}
                    placeholderTextColor={muted}
                    style={{
                      fontSize: 13,
                      fontFamily: monoFont,
                      color: fg,
                      lineHeight: 20,
                      minHeight: 180,
                      textAlignVertical: 'top',
                      padding: 10,
                      borderRadius: 10,
                      backgroundColor: isDark
                        ? 'rgba(255,255,255,0.03)'
                        : 'rgba(0,0,0,0.02)',
                      borderWidth: 1,
                      borderColor: themeColors.primary,
                    }}
                    autoFocus
                  />
                ) : contextLoading ? (
                  <View style={{ paddingVertical: 18, alignItems: 'center' }}>
                    <ActivityIndicator color={muted} />
                  </View>
                ) : contextError || !contextContent ? (
                  <TouchableOpacity onPress={startContextEdit} activeOpacity={0.7}>
                    <RNText
                      style={{
                        fontSize: 13,
                        fontFamily: 'Roobert',
                        color: mutedStrong,
                        fontStyle: 'italic',
                      }}
                    >
                      No CONTEXT.md yet — tap to create. Agents read this file first when working on
                      the project.
                    </RNText>
                  </TouchableOpacity>
                ) : (
                  <SelectableMarkdownText
                    style={{
                      fontSize: 14,
                      fontFamily: 'Roobert',
                      color: fg,
                      lineHeight: 21,
                    }}
                  >
                    {contextContent as string}
                  </SelectableMarkdownText>
                )}
              </View>
            )}

            {/* Description */}
            <View
              style={{
                borderRadius: 12,
                borderWidth: 1,
                borderColor: border,
                backgroundColor: cardBg,
                padding: 14,
              }}>
              <View
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  marginBottom: 10,
                }}>
                <RNText style={{ fontSize: 14, fontFamily: 'Roobert-Medium', color: fg }}>
                  Description
                </RNText>
                <TouchableOpacity onPress={() => handleEdit('description')} hitSlop={8}>
                  <Pencil size={14} color={mutedStrong} />
                </TouchableOpacity>
              </View>
              <TouchableOpacity onPress={() => handleEdit('description')} activeOpacity={0.7}>
                {project.description ? (
                  <RNText
                    style={{
                      fontSize: 14,
                      fontFamily: 'Roobert',
                      color: isDark ? '#a1a1aa' : '#52525b',
                      lineHeight: 20,
                    }}>
                    {project.description}
                  </RNText>
                ) : (
                  <RNText
                    style={{
                      fontSize: 13,
                      fontFamily: 'Roobert',
                      color: isDark ? '#3f3f46' : '#a1a1aa',
                      fontStyle: 'italic',
                    }}>
                    No description — tap to add
                  </RNText>
                )}
              </TouchableOpacity>
            </View>

            {/* Details */}
            <View
              style={{
                borderRadius: 12,
                borderWidth: 1,
                borderColor: border,
                backgroundColor: cardBg,
                padding: 14,
                gap: 10,
              }}>
              <RNText
                style={{ fontSize: 14, fontFamily: 'Roobert-Medium', color: fg, marginBottom: 2 }}>
                Details
              </RNText>
              {project.path && project.path !== '/' && (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                  <FolderOpen size={14} color={mutedStrong} />
                  <RNText
                    style={{
                      fontSize: 13,
                      fontFamily: 'Menlo',
                      color: isDark ? '#71717a' : '#a1a1aa',
                    }}>
                    {project.path}
                  </RNText>
                </View>
              )}
              {project.created_at && (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                  <Clock size={14} color={mutedStrong} />
                  <RNText
                    style={{
                      fontSize: 13,
                      fontFamily: 'Roobert',
                      color: isDark ? '#71717a' : '#a1a1aa',
                    }}>
                    Created {ago(project.created_at)}
                  </RNText>
                </View>
              )}
              {sessionList.length > 0 && (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                  <MessageSquare size={14} color={mutedStrong} />
                  <RNText
                    style={{
                      fontSize: 13,
                      fontFamily: 'Roobert',
                      color: isDark ? '#71717a' : '#a1a1aa',
                    }}>
                    {sessionList.length} session{sessionList.length !== 1 ? 's' : ''}
                  </RNText>
                </View>
              )}
              {taskStats.total > 0 && (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                  <ListTodo size={14} color={mutedStrong} />
                  <RNText
                    style={{
                      fontSize: 13,
                      fontFamily: 'Roobert',
                      color: isDark ? '#71717a' : '#a1a1aa',
                    }}>
                    {taskStats.done}/{taskStats.total} tasks complete
                  </RNText>
                </View>
              )}
              {project.opencode_id && (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                  <FolderGit2 size={14} color={mutedStrong} />
                  <RNText
                    style={{
                      fontSize: 12,
                      fontFamily: 'Menlo',
                      color: isDark ? '#52525b' : '#a1a1aa',
                    }}>
                    {project.opencode_id}
                  </RNText>
                </View>
              )}
            </View>
          </View>
        )}
      </ScrollView>

      {/* File Viewer */}
      {viewerFile && (
        <FileViewer
          visible={viewerVisible}
          onClose={() => {
            setViewerVisible(false);
            setViewerFile(null);
          }}
          file={viewerFile}
          sandboxId={''}
          sandboxUrl={sandboxUrl}
        />
      )}

      {/* Task detail sheet — scrollable for long content (ported from web 54fd0e3) */}
      <BottomSheetModal
        ref={taskSheetRef}
        snapPoints={['85%']}
        enableDynamicSizing={false}
        enablePanDownToClose
        backdropComponent={renderBackdrop}
        onDismiss={() => setSelectedTask(null)}
        backgroundStyle={{
          backgroundColor: getSheetBg(isDark),
          borderTopLeftRadius: 24,
          borderTopRightRadius: 24,
        }}
        handleIndicatorStyle={{
          backgroundColor: isDark ? '#3F3F46' : '#D4D4D8',
          width: 36,
          height: 5,
          borderRadius: 3,
        }}>
        <BottomSheetScrollView
          contentContainerStyle={{
            paddingHorizontal: 20,
            paddingTop: 8,
            paddingBottom: sheetPadding,
          }}>
          {selectedTask &&
            (() => {
              const currentStatus = STATUS_CONFIG[selectedTask.status] || STATUS_CONFIG.todo;
              const CurrentIcon = currentStatus.icon;
              const isTerminal =
                selectedTask.status === 'completed' || selectedTask.status === 'cancelled';
              const canStart = selectedTask.status === 'todo';
              const canApprove =
                selectedTask.status === 'input_needed' || selectedTask.status === 'awaiting_review';
              const isBusy = updateTask.isPending || startTask.isPending || approveTask.isPending;

              return (
                <>
                  {/* Header: title + delete */}
                  <View
                    style={{
                      flexDirection: 'row',
                      alignItems: 'flex-start',
                      justifyContent: 'space-between',
                      marginBottom: 12,
                      gap: 12,
                    }}>
                    <RNText
                      style={{
                        flex: 1,
                        fontSize: 17,
                        fontFamily: 'Roobert-Medium',
                        color: fg,
                        lineHeight: 22,
                        textDecorationLine: isTerminal ? 'line-through' : 'none',
                      }}>
                      {selectedTask.title}
                    </RNText>
                    <TouchableOpacity
                      onPress={() => {
                        Alert.alert(
                          'Delete task',
                          `Delete "${selectedTask.title}"? This cannot be undone.`,
                          [
                            { text: 'Cancel', style: 'cancel' },
                            {
                              text: 'Delete',
                              style: 'destructive',
                              onPress: () => {
                                deleteTask.mutate(selectedTask.id, {
                                  onSuccess: () => {
                                    taskSheetRef.current?.dismiss();
                                  },
                                });
                              },
                            },
                          ]
                        );
                      }}
                      hitSlop={10}
                      style={{ padding: 4 }}>
                      <Trash2 size={18} color={isDark ? '#52525b' : '#a1a1aa'} />
                    </TouchableOpacity>
                  </View>

                  {/* Status pill + owner agent */}
                  <View
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: 8,
                      marginBottom: 14,
                      flexWrap: 'wrap',
                    }}>
                    <View
                      style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        gap: 6,
                        paddingHorizontal: 10,
                        paddingVertical: 5,
                        borderRadius: 999,
                        borderWidth: 1,
                        borderColor: currentStatus.color,
                        backgroundColor: `${currentStatus.color}15`,
                      }}>
                      <CurrentIcon size={12} color={currentStatus.color} />
                      <RNText
                        style={{
                          fontSize: 11,
                          fontFamily: 'Roobert-Medium',
                          color: currentStatus.color,
                        }}>
                        {currentStatus.label}
                      </RNText>
                    </View>
                    {!!selectedTask.owner_agent && (
                      <RNText style={{ fontSize: 11, fontFamily: 'Roobert', color: mutedStrong }}>
                        · {selectedTask.owner_agent}
                      </RNText>
                    )}
                  </View>

                  {/* Action buttons: Start / Approve */}
                  {(canStart || canApprove) && (
                    <View style={{ flexDirection: 'row', gap: 8, marginBottom: 16 }}>
                      {canStart && (
                        <TouchableOpacity
                          onPress={() => {
                            if (isBusy) return;
                            startTask.mutate(
                              { id: selectedTask.id },
                              { onSuccess: (updated: KortixTask) => setSelectedTask(updated) }
                            );
                          }}
                          activeOpacity={0.7}
                          disabled={isBusy}
                          style={{
                            flex: 1,
                            flexDirection: 'row',
                            alignItems: 'center',
                            justifyContent: 'center',
                            gap: 6,
                            paddingVertical: 11,
                            borderRadius: 10,
                            backgroundColor: fg,
                            opacity: isBusy ? 0.5 : 1,
                          }}>
                          <Ionicons name="play" size={13} color={bg} />
                          <RNText style={{ fontSize: 13, fontFamily: 'Roobert-Medium', color: bg }}>
                            {startTask.isPending ? 'Starting…' : 'Start task'}
                          </RNText>
                        </TouchableOpacity>
                      )}
                      {canApprove && (
                        <TouchableOpacity
                          onPress={() => {
                            if (isBusy) return;
                            approveTask.mutate(selectedTask.id, {
                              onSuccess: (updated: KortixTask) => setSelectedTask(updated),
                            });
                          }}
                          activeOpacity={0.7}
                          disabled={isBusy}
                          style={{
                            flex: 1,
                            flexDirection: 'row',
                            alignItems: 'center',
                            justifyContent: 'center',
                            gap: 6,
                            paddingVertical: 11,
                            borderRadius: 10,
                            backgroundColor: '#22c55e',
                            opacity: isBusy ? 0.5 : 1,
                          }}>
                          <CheckCircle2 size={14} color="#FFFFFF" />
                          <RNText
                            style={{
                              fontSize: 13,
                              fontFamily: 'Roobert-Medium',
                              color: '#FFFFFF',
                            }}>
                            {approveTask.isPending ? 'Approving…' : 'Approve'}
                          </RNText>
                        </TouchableOpacity>
                      )}
                    </View>
                  )}

                  {/* Worker session link */}
                  {!!selectedTask.owner_session_id && (
                    <TouchableOpacity
                      onPress={() => {
                        taskSheetRef.current?.dismiss();
                        handleSessionPress(selectedTask.owner_session_id!);
                      }}
                      activeOpacity={0.7}
                      style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        gap: 10,
                        paddingHorizontal: 12,
                        paddingVertical: 11,
                        borderRadius: 10,
                        borderWidth: 1,
                        borderColor: border,
                        backgroundColor: cardBg,
                        marginBottom: 16,
                      }}>
                      <Ionicons name="open-outline" size={14} color={mutedStrong} />
                      <RNText style={{ flex: 1, fontSize: 13, fontFamily: 'Roobert', color: fg }}>
                        Open worker session
                      </RNText>
                      <RNText
                        style={{
                          fontSize: 10,
                          fontFamily: monoFont,
                          color: isDark ? '#3f3f46' : '#a1a1aa',
                        }}>
                        {selectedTask.owner_session_id.slice(-8)}
                      </RNText>
                    </TouchableOpacity>
                  )}

                  {/* Description — rendered as markdown (ported from web ca81efc) */}
                  {!!selectedTask.description && (
                    <View style={{ marginBottom: 16 }}>
                      <RNText
                        style={{
                          fontSize: 11,
                          fontFamily: 'Roobert-Medium',
                          color: mutedStrong,
                          marginBottom: 6,
                          textTransform: 'uppercase',
                          letterSpacing: 0.5,
                        }}>
                        Description
                      </RNText>
                      <SelectableMarkdownText isDark={isDark}>
                        {selectedTask.description}
                      </SelectableMarkdownText>
                    </View>
                  )}

                  {/* Verification condition — read-only, shown if set */}
                  {!!selectedTask.verification_condition && (
                    <View style={{ marginBottom: 16 }}>
                      <RNText
                        style={{
                          fontSize: 11,
                          fontFamily: 'Roobert-Medium',
                          color: mutedStrong,
                          marginBottom: 6,
                          textTransform: 'uppercase',
                          letterSpacing: 0.5,
                        }}>
                        Verification condition
                      </RNText>
                      <SelectableMarkdownText isDark={isDark}>
                        {selectedTask.verification_condition}
                      </SelectableMarkdownText>
                    </View>
                  )}

                  {/* Blocking question — amber card when task needs input */}
                  {!!selectedTask.blocking_question && (
                    <View
                      style={{
                        marginBottom: 16,
                        borderRadius: 12,
                        borderWidth: 1,
                        borderColor: isDark ? 'rgba(245,158,11,0.3)' : 'rgba(245,158,11,0.25)',
                        backgroundColor: isDark ? 'rgba(245,158,11,0.06)' : 'rgba(245,158,11,0.04)',
                        padding: 14,
                      }}>
                      <View
                        style={{
                          flexDirection: 'row',
                          alignItems: 'center',
                          gap: 6,
                          marginBottom: 8,
                        }}>
                        <AlertTriangle size={12} color={isDark ? '#fbbf24' : '#d97706'} />
                        <RNText
                          style={{
                            fontSize: 11,
                            fontFamily: 'Roobert-Medium',
                            color: isDark ? '#fbbf24' : '#d97706',
                            textTransform: 'uppercase',
                            letterSpacing: 0.5,
                          }}>
                          Input needed
                        </RNText>
                      </View>
                      <SelectableMarkdownText isDark={isDark}>
                        {selectedTask.blocking_question}
                      </SelectableMarkdownText>
                    </View>
                  )}

                  {/* Result — rendered as markdown, shown prominently in an emerald card */}
                  {!!selectedTask.result && (
                    <View
                      style={{
                        marginBottom: 16,
                        borderRadius: 12,
                        borderWidth: 1,
                        borderColor: isDark ? 'rgba(16,185,129,0.25)' : 'rgba(16,185,129,0.2)',
                        backgroundColor: isDark ? 'rgba(16,185,129,0.04)' : 'rgba(16,185,129,0.03)',
                        padding: 14,
                      }}>
                      <RNText
                        style={{
                          fontSize: 11,
                          fontFamily: 'Roobert-Medium',
                          color: isDark ? '#34d399' : '#059669',
                          textTransform: 'uppercase',
                          letterSpacing: 0.5,
                          marginBottom: 8,
                        }}>
                        Result
                      </RNText>
                      <SelectableMarkdownText isDark={isDark}>
                        {selectedTask.result}
                      </SelectableMarkdownText>
                      {!!selectedTask.verification_summary && (
                        <View
                          style={{
                            marginTop: 10,
                            paddingTop: 10,
                            borderTopWidth: 1,
                            borderTopColor: isDark
                              ? 'rgba(16,185,129,0.15)'
                              : 'rgba(16,185,129,0.15)',
                          }}>
                          <RNText
                            style={{
                              fontSize: 10,
                              fontFamily: 'Roobert-Medium',
                              color: isDark ? 'rgba(52,211,153,0.7)' : 'rgba(5,150,105,0.7)',
                              textTransform: 'uppercase',
                              letterSpacing: 0.5,
                              marginBottom: 4,
                            }}>
                            Verification
                          </RNText>
                          <SelectableMarkdownText isDark={isDark}>
                            {selectedTask.verification_summary}
                          </SelectableMarkdownText>
                        </View>
                      )}
                    </View>
                  )}

                  {/* Status selector — unified agent_task statuses */}
                  <RNText
                    style={{
                      fontSize: 11,
                      fontFamily: 'Roobert-Medium',
                      color: mutedStrong,
                      marginBottom: 8,
                      textTransform: 'uppercase',
                      letterSpacing: 0.5,
                    }}>
                    Change status
                  </RNText>
                  <View style={{ gap: 6, marginBottom: 16 }}>
                    {(
                      [
                        'todo',
                        'in_progress',
                        'input_needed',
                        'awaiting_review',
                        'completed',
                        'cancelled',
                      ] as KortixTaskStatus[]
                    ).map((s) => {
                      const sc = STATUS_CONFIG[s];
                      const SIcon = sc.icon;
                      const isCurrent = selectedTask.status === s;
                      return (
                        <TouchableOpacity
                          key={s}
                          onPress={() => {
                            if (isCurrent || isBusy) return;
                            updateTask.mutate(
                              { id: selectedTask.id, status: s },
                              {
                                onSuccess: (updated: KortixTask) => {
                                  setSelectedTask(updated);
                                },
                              }
                            );
                          }}
                          activeOpacity={0.7}
                          disabled={isBusy}
                          style={{
                            flexDirection: 'row',
                            alignItems: 'center',
                            gap: 10,
                            paddingHorizontal: 12,
                            paddingVertical: 11,
                            borderRadius: 10,
                            borderWidth: 1,
                            borderColor: isCurrent ? sc.color : border,
                            backgroundColor: isCurrent ? `${sc.color}15` : cardBg,
                          }}>
                          <SIcon size={15} color={sc.color} />
                          <RNText
                            style={{
                              flex: 1,
                              fontSize: 14,
                              fontFamily: isCurrent ? 'Roobert-Medium' : 'Roobert',
                              color: fg,
                            }}>
                            {sc.label}
                          </RNText>
                          {isCurrent && <CheckCircle2 size={14} color={sc.color} />}
                        </TouchableOpacity>
                      );
                    })}
                  </View>

                  {/* Meta */}
                  <View
                    style={{
                      flexDirection: 'row',
                      gap: 16,
                      paddingTop: 10,
                      borderTopWidth: 1,
                      borderTopColor: border,
                      flexWrap: 'wrap',
                    }}>
                    <RNText style={{ fontSize: 11, fontFamily: 'Roobert', color: muted }}>
                      Created {ago(selectedTask.created_at)}
                    </RNText>
                    {!!selectedTask.started_at && (
                      <RNText style={{ fontSize: 11, fontFamily: 'Roobert', color: muted }}>
                        Started {ago(selectedTask.started_at)}
                      </RNText>
                    )}
                    {!!selectedTask.completed_at && (
                      <RNText style={{ fontSize: 11, fontFamily: 'Roobert', color: muted }}>
                        Completed {ago(selectedTask.completed_at)}
                      </RNText>
                    )}
                  </View>
                </>
              );
            })()}
        </BottomSheetScrollView>
      </BottomSheetModal>

      {/* Edit sheet — matches FilesPage rename sheet pattern */}
      <BottomSheetModal
        ref={editSheetRef}
        enableDynamicSizing
        enablePanDownToClose
        backdropComponent={renderBackdrop}
        keyboardBehavior="interactive"
        keyboardBlurBehavior="restore"
        android_keyboardInputMode="adjustResize"
        onDismiss={() => {
          setEditValue('');
        }}
        backgroundStyle={{
          backgroundColor: getSheetBg(isDark),
          borderTopLeftRadius: 24,
          borderTopRightRadius: 24,
        }}
        handleIndicatorStyle={{
          backgroundColor: isDark ? '#3F3F46' : '#D4D4D8',
          width: 36,
          height: 5,
          borderRadius: 3,
        }}>
        <BottomSheetView
          style={{
            paddingHorizontal: 24,
            paddingTop: 8,
            paddingBottom: sheetPadding,
          }}>
          {/* Header */}
          <View className="mb-5 flex-row items-center">
            <View
              className="mr-3 h-10 w-10 items-center justify-center rounded-xl"
              style={{
                backgroundColor: isDark ? 'rgba(248, 248, 248, 0.08)' : 'rgba(18, 18, 21, 0.05)',
              }}>
              <Icon
                as={editField === 'name' ? FolderGit2 : Pencil}
                size={20}
                color={fg}
                strokeWidth={1.8}
              />
            </View>
            <View className="flex-1">
              <Text className="font-roobert-semibold text-lg" style={{ color: fg }}>
                {editField === 'name' ? 'Rename' : 'Edit description'}
              </Text>
              <Text
                className="mt-0.5 font-roobert text-xs"
                style={{
                  color: isDark ? 'rgba(248, 248, 248, 0.4)' : 'rgba(18, 18, 21, 0.4)',
                }}
                numberOfLines={1}>
                {project?.name}
              </Text>
            </View>
          </View>

          {/* Input */}
          <BottomSheetTextInput
            value={editValue}
            onChangeText={setEditValue}
            placeholder={editField === 'name' ? 'Enter project name' : 'Enter description'}
            placeholderTextColor={isDark ? 'rgba(248, 248, 248, 0.25)' : 'rgba(18, 18, 21, 0.3)'}
            autoFocus
            autoCapitalize="none"
            autoCorrect={false}
            multiline={editField === 'description'}
            returnKeyType={editField === 'name' ? 'done' : 'default'}
            onSubmitEditing={editField === 'name' ? handleSaveEdit : undefined}
            style={{
              backgroundColor: isDark ? 'rgba(248, 248, 248, 0.06)' : 'rgba(18, 18, 21, 0.04)',
              borderWidth: 1,
              borderColor: isDark ? 'rgba(248, 248, 248, 0.1)' : 'rgba(18, 18, 21, 0.08)',
              borderRadius: 14,
              paddingHorizontal: 16,
              paddingVertical: 14,
              fontSize: 16,
              fontFamily: 'Roobert',
              color: fg,
              marginBottom: 20,
              minHeight: editField === 'description' ? 80 : undefined,
              textAlignVertical: editField === 'description' ? 'top' : 'center',
            }}
          />

          {/* Save button */}
          {(() => {
            const canSave =
              !!editValue.trim() && (editField !== 'name' || editValue.trim() !== project?.name);
            return (
              <BottomSheetTouchable
                onPress={handleSaveEdit}
                disabled={!canSave || updateProject.isPending}
                style={{
                  backgroundColor: canSave
                    ? themeColors.primary
                    : isDark
                      ? 'rgba(248, 248, 248, 0.08)'
                      : 'rgba(18, 18, 21, 0.06)',
                  borderRadius: 9999,
                  paddingVertical: 15,
                  alignItems: 'center',
                  opacity: canSave ? 1 : 0.5,
                }}>
                <Text
                  className="font-roobert-semibold text-[15px]"
                  style={{
                    color: canSave
                      ? themeColors.primaryForeground
                      : isDark
                        ? 'rgba(248, 248, 248, 0.3)'
                        : 'rgba(18, 18, 21, 0.3)',
                  }}>
                  {updateProject.isPending ? 'Saving...' : 'Save'}
                </Text>
              </BottomSheetTouchable>
            );
          })()}
        </BottomSheetView>
      </BottomSheetModal>

      {/* New task sheet — ported from web new-task-dialog */}
      <BottomSheetModal
        ref={newTaskSheetRef}
        snapPoints={['75%', '95%']}
        enablePanDownToClose
        backdropComponent={renderBackdrop}
        keyboardBehavior="interactive"
        keyboardBlurBehavior="restore"
        android_keyboardInputMode="adjustResize"
        backgroundStyle={{
          backgroundColor: getSheetBg(isDark),
          borderTopLeftRadius: 24,
          borderTopRightRadius: 24,
        }}
        handleIndicatorStyle={{
          backgroundColor: isDark ? '#3F3F46' : '#D4D4D8',
          width: 36,
          height: 5,
          borderRadius: 3,
        }}>
        <BottomSheetScrollView
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{
            paddingHorizontal: 24,
            paddingTop: 4,
            paddingBottom: sheetPadding,
          }}>
          {/* Breadcrumb header */}
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              marginBottom: 14,
              gap: 6,
            }}>
            <RNText
              style={{
                fontSize: 13,
                fontFamily: 'Roobert-Medium',
                color: fg,
                letterSpacing: -0.1,
              }}
              numberOfLines={1}>
              {project?.name || 'Project'}
            </RNText>
            <RNText
              style={{
                fontSize: 13,
                fontFamily: 'Roobert',
                color: isDark ? 'rgba(255,255,255,0.3)' : 'rgba(0,0,0,0.25)',
              }}>
              ›
            </RNText>
            <RNText
              style={{
                fontSize: 13,
                fontFamily: 'Roobert',
                color: mutedStrong,
              }}>
              New task
            </RNText>
          </View>

          {/* Title — big, bold */}
          <BottomSheetTextInput
            value={newTaskTitle}
            onChangeText={setNewTaskTitle}
            autoFocus
            placeholder="Task title"
            placeholderTextColor={isDark ? 'rgba(255,255,255,0.25)' : 'rgba(0,0,0,0.25)'}
            style={{
              fontSize: 22,
              fontFamily: 'Roobert-Semibold',
              color: fg,
              paddingVertical: 0,
              paddingHorizontal: 0,
              marginBottom: 10,
              letterSpacing: -0.3,
            }}
          />

          {/* Description */}
          <BottomSheetTextInput
            value={newTaskDescription}
            onChangeText={setNewTaskDescription}
            multiline
            placeholder="Add description..."
            placeholderTextColor={isDark ? 'rgba(255,255,255,0.25)' : 'rgba(0,0,0,0.25)'}
            style={{
              fontSize: 14,
              fontFamily: 'Roobert',
              color: fg,
              paddingVertical: 0,
              paddingHorizontal: 0,
              minHeight: 96,
              textAlignVertical: 'top',
              lineHeight: 20,
              marginBottom: 12,
            }}
          />

          {/* Verification condition — collapsible */}
          {showVerification ? (
            <View style={{ marginBottom: 12 }}>
              <View
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  marginBottom: 6,
                }}>
                <RNText
                  style={{
                    fontSize: 10,
                    fontFamily: 'Roobert-Semibold',
                    color: mutedStrong,
                    letterSpacing: 1,
                    textTransform: 'uppercase',
                  }}>
                  Verification condition
                </RNText>
                <TouchableOpacity
                  onPress={() => {
                    setShowVerification(false);
                    setNewTaskVerification('');
                  }}
                  hitSlop={6}>
                  <RNText
                    style={{
                      fontSize: 11,
                      fontFamily: 'Roobert-Medium',
                      color: mutedStrong,
                    }}>
                    Remove
                  </RNText>
                </TouchableOpacity>
              </View>
              <BottomSheetTextInput
                value={newTaskVerification}
                onChangeText={setNewTaskVerification}
                multiline
                placeholder="How will we know this task is actually done?"
                placeholderTextColor={isDark ? 'rgba(255,255,255,0.25)' : 'rgba(0,0,0,0.25)'}
                style={{
                  fontSize: 13,
                  fontFamily: 'Roobert',
                  color: fg,
                  paddingVertical: 10,
                  paddingHorizontal: 12,
                  backgroundColor: isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.02)',
                  borderRadius: 10,
                  minHeight: 56,
                  textAlignVertical: 'top',
                  lineHeight: 19,
                }}
              />
            </View>
          ) : (
            <TouchableOpacity
              onPress={() => setShowVerification(true)}
              hitSlop={6}
              style={{ alignSelf: 'flex-start', marginBottom: 14 }}>
              <RNText
                style={{
                  fontSize: 12,
                  fontFamily: 'Roobert-Medium',
                  color: mutedStrong,
                }}>
                + Add verification condition
              </RNText>
            </TouchableOpacity>
          )}

          {/* Attachment strip */}
          {newTaskFiles.length > 0 && (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              style={{ marginBottom: 10, marginHorizontal: -24 }}
              contentContainerStyle={{ paddingHorizontal: 24, gap: 8 }}
            >
              {newTaskFiles.map((f, i) => (
                <View
                  key={`${f.uri}-${i}`}
                  style={{
                    width: 112,
                    borderRadius: 10,
                    borderWidth: 1,
                    borderColor: border,
                    backgroundColor: isDark ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.02)',
                    overflow: 'hidden',
                    position: 'relative',
                  }}
                >
                  {f.isImage ? (
                    <Image
                      source={{ uri: f.uri }}
                      style={{ width: '100%', height: 64 }}
                      resizeMode="cover"
                    />
                  ) : (
                    <View
                      style={{
                        height: 64,
                        alignItems: 'center',
                        justifyContent: 'center',
                        backgroundColor: isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.03)',
                      }}
                    >
                      <FileIcon size={22} color={mutedStrong} />
                    </View>
                  )}
                  <View
                    style={{
                      paddingHorizontal: 8,
                      paddingVertical: 6,
                      borderTopWidth: 1,
                      borderTopColor: border,
                    }}
                  >
                    <RNText
                      numberOfLines={1}
                      style={{
                        fontSize: 11,
                        fontFamily: 'Roobert-Medium',
                        color: fg,
                      }}
                    >
                      {f.name}
                    </RNText>
                  </View>
                  <TouchableOpacity
                    onPress={() => removeTaskFile(i)}
                    hitSlop={8}
                    style={{
                      position: 'absolute',
                      top: 4,
                      right: 4,
                      width: 18,
                      height: 18,
                      borderRadius: 9,
                      backgroundColor: isDark ? 'rgba(0,0,0,0.7)' : 'rgba(0,0,0,0.6)',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    <XIcon size={10} color="#FFFFFF" />
                  </TouchableOpacity>
                </View>
              ))}
            </ScrollView>
          )}

          {/* Divider */}
          <View
            style={{
              height: 1,
              backgroundColor: border,
              marginTop: 4,
              marginBottom: 14,
            }}
          />

          {/* Attach button + toggles */}
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              marginBottom: 14,
            }}
          >
            <TouchableOpacity
              onPress={openAttachmentPicker}
              hitSlop={6}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 6,
                paddingHorizontal: 12,
                paddingVertical: 7,
                borderRadius: 9999,
                borderWidth: 1,
                borderColor: border,
                backgroundColor: isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.02)',
              }}
            >
              <Paperclip size={13} color={mutedStrong} />
              <RNText
                style={{
                  fontSize: 12,
                  fontFamily: 'Roobert-Medium',
                  color: mutedStrong,
                }}
              >
                Attach{newTaskFiles.length > 0 ? ` (${newTaskFiles.length})` : ''}
              </RNText>
            </TouchableOpacity>
          </View>

          {/* Toggles */}
          <View style={{ gap: 10, marginBottom: 18 }}>
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between',
              }}>
              <View style={{ flex: 1 }}>
                <RNText
                  style={{
                    fontSize: 14,
                    fontFamily: 'Roobert-Medium',
                    color: fg,
                  }}>
                  Auto-run
                </RNText>
                <RNText
                  style={{
                    fontSize: 12,
                    fontFamily: 'Roobert',
                    color: mutedStrong,
                    marginTop: 2,
                  }}>
                  Start the task immediately after creating.
                </RNText>
              </View>
              <Switch
                value={autoRun}
                onValueChange={setAutoRun}
                trackColor={{
                  false: isDark ? '#333' : '#ddd',
                  true: themeColors.primary,
                }}
                thumbColor="#fff"
              />
            </View>
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between',
              }}>
              <View style={{ flex: 1 }}>
                <RNText
                  style={{
                    fontSize: 14,
                    fontFamily: 'Roobert-Medium',
                    color: fg,
                  }}>
                  Create more
                </RNText>
                <RNText
                  style={{
                    fontSize: 12,
                    fontFamily: 'Roobert',
                    color: mutedStrong,
                    marginTop: 2,
                  }}>
                  Keep this open to add more tasks back-to-back.
                </RNText>
              </View>
              <Switch
                value={createMore}
                onValueChange={setCreateMore}
                trackColor={{
                  false: isDark ? '#333' : '#ddd',
                  true: themeColors.primary,
                }}
                thumbColor="#fff"
              />
            </View>
          </View>

          {/* Submit button */}
          {(() => {
            const isBusy = createTask.isPending || startTask.isPending || uploadingAttachments;
            const canSubmit = !!newTaskTitle.trim() && !isBusy;
            return (
              <BottomSheetTouchable
                onPress={submitNewTask}
                disabled={!canSubmit}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 8,
                  backgroundColor: canSubmit
                    ? themeColors.primary
                    : isDark
                      ? 'rgba(248, 248, 248, 0.08)'
                      : 'rgba(18, 18, 21, 0.06)',
                  borderRadius: 9999,
                  paddingVertical: 15,
                  opacity: canSubmit ? 1 : 0.55,
                }}>
                {isBusy ? (
                  <ActivityIndicator size="small" color={themeColors.primaryForeground} />
                ) : autoRun ? (
                  <Play
                    size={14}
                    color={canSubmit ? themeColors.primaryForeground : mutedStrong}
                    fill={canSubmit ? themeColors.primaryForeground : 'transparent'}
                  />
                ) : null}
                <RNText
                  style={{
                    fontSize: 15,
                    fontFamily: 'Roobert-Semibold',
                    color: canSubmit
                      ? themeColors.primaryForeground
                      : isDark
                        ? 'rgba(248, 248, 248, 0.4)'
                        : 'rgba(18, 18, 21, 0.4)',
                  }}>
                  {uploadingAttachments
                    ? 'Uploading…'
                    : createTask.isPending || startTask.isPending
                      ? 'Creating...'
                      : autoRun
                        ? 'Create & run'
                        : 'Create task'}
                </RNText>
              </BottomSheetTouchable>
            );
          })()}
        </BottomSheetScrollView>
      </BottomSheetModal>
      </PageContent>
    </View>
  );
}

// ── Empty state ──────────────────────────────────────────────────────────────

function ProjectTotalsCard({
  totalSessions,
  messageCount,
  tokens,
  cost,
  loading,
  isDark,
  fg,
  muted,
  cardBg,
  border,
}: {
  totalSessions: number;
  messageCount: number;
  tokens: number;
  cost: number;
  loading: boolean;
  isDark: boolean;
  fg: string;
  muted: string;
  cardBg: string;
  border: string;
}) {
  const labelColor = isDark ? 'rgba(248,248,248,0.4)' : 'rgba(18,18,21,0.4)';
  const dimValue = isDark ? 'rgba(248,248,248,0.5)' : 'rgba(18,18,21,0.5)';
  const items = [
    { label: 'Sessions', value: String(totalSessions), dim: false },
    { label: 'Messages', value: String(messageCount), dim: loading },
    { label: 'Tokens', value: formatTokens(tokens), dim: loading },
    { label: 'Cost', value: formatCost(cost), dim: loading },
  ];
  return (
    <View
      style={{
        borderRadius: 12,
        borderWidth: 1,
        borderColor: border,
        backgroundColor: cardBg,
        paddingHorizontal: 14,
        paddingVertical: 12,
      }}>
      <RNText
        style={{
          fontSize: 10,
          fontFamily: 'Roobert-Medium',
          letterSpacing: 0.8,
          color: labelColor,
          marginBottom: 10,
        }}>
        PROJECT TOTALS
      </RNText>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
        {items.map((it) => (
          <View key={it.label} style={{ flex: 1, minWidth: 0 }}>
            <RNText
              style={{
                fontSize: 10,
                fontFamily: 'Roobert-Medium',
                letterSpacing: 0.8,
                color: labelColor,
              }}>
              {it.label.toUpperCase()}
            </RNText>
            <RNText
              numberOfLines={1}
              style={{
                fontSize: 16,
                fontFamily: 'Roobert-Medium',
                fontVariant: ['tabular-nums'],
                color: it.dim ? dimValue : fg,
                marginTop: 2,
              }}>
              {it.value}
            </RNText>
          </View>
        ))}
      </View>
    </View>
  );
}

function EmptyState({
  icon: Icon,
  text,
  sub,
  isDark,
}: {
  icon: typeof ListTodo;
  text: string;
  sub?: string;
  isDark: boolean;
}) {
  const muted = isDark ? 'rgba(248,248,248,0.3)' : 'rgba(18,18,21,0.25)';
  return (
    <View style={{ padding: 40, alignItems: 'center' }}>
      <Icon
        size={32}
        color={isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.05)'}
        style={{ marginBottom: 10 }}
      />
      <RNText style={{ fontSize: 14, fontFamily: 'Roobert-Medium', color: muted, marginBottom: 4 }}>
        {text}
      </RNText>
      {sub && (
        <RNText
          style={{
            fontSize: 12,
            fontFamily: 'Roobert',
            color: isDark ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.15)',
            textAlign: 'center',
          }}>
          {sub}
        </RNText>
      )}
    </View>
  );
}
