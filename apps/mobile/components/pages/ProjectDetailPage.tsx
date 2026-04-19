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
  Keyboard,
  Platform,
  Text as RNText,
} from 'react-native';

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
import { useThemeColors } from '@/lib/theme-colors';
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
} from 'lucide-react-native';

import { FileItem } from '@/components/files/FileItem';
import { FileViewer } from '@/components/files/FileViewer';
import { SelectableMarkdownText } from '@/components/ui/selectable-markdown';
import { useOpenCodeFiles } from '@/lib/files/hooks';
import type { SandboxFile } from '@/api/types';

import { useSandboxContext } from '@/contexts/SandboxContext';
import { useSheetBottomPadding } from '@/hooks/useSheetKeyboard';
import {
  useKortixProject,
  useKortixProjectSessions,
  useKortixTasks,
  useUpdateProject,
  useDeleteProject,
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
  const sheetPadding = useSheetBottomPadding();
  const tabScrollRef = useRef<ScrollView>(null);
  const tabLayoutsRef = useRef<Record<number, { x: number; width: number }>>({});
  const [editField, setEditField] = useState<'name' | 'description'>('name');
  const [editValue, setEditValue] = useState('');
  const [selectedTask, setSelectedTask] = useState<KortixTask | null>(null);

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
  const taskList = tasks ?? [];

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
                borderBottomColor: active ? (isDark ? '#e4e4e7' : '#18181b') : 'transparent',
              }}>
              <Icon size={14} color={active ? fg : mutedStrong} />
              <RNText
                style={{
                  fontSize: 13,
                  fontFamily: active ? 'Roobert-Medium' : 'Roobert',
                  color: active ? fg : mutedStrong,
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
          ))}

        {/* ── Tasks Tab ── */}
        {tab === 'tasks' &&
          (taskList.length === 0 ? (
            <EmptyState
              icon={ListTodo}
              text="No tasks yet"
              sub="Tasks appear here as Kortix works on this project"
              isDark={isDark}
            />
          ) : (
            <>
              {/* Progress bar */}
              {taskStats.total > 0 && (
                <View style={{ marginBottom: 14 }}>
                  <View
                    style={{
                      flexDirection: 'row',
                      justifyContent: 'space-between',
                      marginBottom: 6,
                    }}>
                    <RNText style={{ fontSize: 12, fontFamily: 'Roobert', color: mutedStrong }}>
                      {Math.round((taskStats.done / taskStats.total) * 100)}% complete
                    </RNText>
                    <RNText style={{ fontSize: 12, fontFamily: 'Roobert', color: mutedStrong }}>
                      {taskStats.done}/{taskStats.total}
                    </RNText>
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

              <View
                style={{
                  borderRadius: 12,
                  borderWidth: 1,
                  borderColor: border,
                  backgroundColor: cardBg,
                  overflow: 'hidden',
                }}>
                {taskList.map((t: KortixTask, i: number) => {
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
                        borderBottomWidth: i < taskList.length - 1 ? 1 : 0,
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
            </>
          ))}

        {/* ── About Tab ── */}
        {tab === 'about' && (
          <View style={{ gap: 16 }}>
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
          backgroundColor: isDark ? '#161618' : '#FFFFFF',
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
          backgroundColor: isDark ? '#161618' : '#FFFFFF',
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
                  borderRadius: 14,
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
      </PageContent>
    </View>
  );
}

// ── Empty state ──────────────────────────────────────────────────────────────

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
