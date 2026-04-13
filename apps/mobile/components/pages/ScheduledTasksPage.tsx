/**
 * ScheduledTasksPage — full-screen scheduled tasks / triggers management.
 * Shows list of cron triggers with create, edit, toggle, delete, run now.
 * Matches frontend /scheduled-tasks functionality.
 */

import React, { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import {
  View,
  FlatList,
  TextInput,
  Pressable,
  Alert,
  ActivityIndicator,
  Switch,
  StyleSheet,
  Keyboard,
  TouchableOpacity,
} from 'react-native';
import { Text } from '@/components/ui/text';
import { Text as RNText } from 'react-native';
import {
  Search,
  X,
  Plus,
  Clock,
  Play,
  Pause,
  Trash2,
  ChevronRight,
  Timer,
  Webhook,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  SkipForward,
  Loader2,
  Pencil,
  RotateCw,
  Calendar,
} from 'lucide-react-native';
import { useColorScheme } from 'nativewind';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import BottomSheet, { BottomSheetBackdrop, BottomSheetScrollView, BottomSheetModal, BottomSheetView, BottomSheetTextInput } from '@gorhom/bottom-sheet';

import { useThemeColors } from '@/lib/theme-colors';
import { useSheetBottomPadding } from '@/hooks/useSheetKeyboard';
import { useTabStore, type PageTab } from '@/stores/tab-store';
import {
  useScheduledTasks,
  useCreateScheduledTask,
  useUpdateScheduledTask,
  useDeleteScheduledTask,
  useToggleScheduledTask,
  useRunScheduledTask,
  useTaskExecutions,
  describeCron,
  formatRelativeTime,
  formatDuration,
  type Trigger,
  type Execution,
  type CreateTriggerData,
  type UpdateTriggerData,
  type ExecutionStatus,
} from '@/hooks/useScheduledTasks';

// ─── Tab Page Wrapper ────────────────────────────────────────────────────────

interface ScheduledTasksTabPageProps {
  page: PageTab;
  onBack: () => void;
  onOpenDrawer?: () => void;
  onOpenRightDrawer?: () => void;
}

export function ScheduledTasksTabPage({
  page,
  onBack,
  onOpenDrawer,
  onOpenRightDrawer,
}: ScheduledTasksTabPageProps) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const insets = useSafeAreaInsets();
  const fgColor = isDark ? '#F8F8F8' : '#121215';

  return (
    <View style={{ flex: 1, backgroundColor: isDark ? '#121215' : '#F8F8F8' }}>
      {/* Header */}
      <View style={{ paddingTop: insets.top, paddingHorizontal: 16, paddingBottom: 12, backgroundColor: isDark ? '#121215' : '#F8F8F8' }}>
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          <TouchableOpacity
            onPress={onOpenDrawer}
            style={{ marginRight: 12, padding: 4 }}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          >
            <Ionicons name="menu" size={24} color={fgColor} />
          </TouchableOpacity>
          <View style={{ flex: 1 }}>
            <RNText style={{ fontSize: 18, fontFamily: 'Roobert-SemiBold', color: fgColor }} numberOfLines={1}>
              {page.label}
            </RNText>
          </View>
          <TouchableOpacity
            onPress={onOpenRightDrawer}
            style={{ marginLeft: 12, padding: 4 }}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          >
            <Ionicons name="apps-outline" size={20} color={fgColor} />
          </TouchableOpacity>
        </View>
      </View>

      {/* Content */}
      <ScheduledTasksContent />
    </View>
  );
}

// ─── Main Content ────────────────────────────────────────────────────────────

function ScheduledTasksContent() {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const insets = useSafeAreaInsets();
  const theme = useThemeColors();

  const { data: triggers, isLoading, error } = useScheduledTasks();
  const navigateToSession = useTabStore((s) => s.navigateToSession);
  const createTask = useCreateScheduledTask();
  const deleteTask = useDeleteScheduledTask();
  const toggleTask = useToggleScheduledTask();
  const runTask = useRunScheduledTask();

  const [searchQuery, setSearchQuery] = useState('');
  const [selectedTrigger, setSelectedTrigger] = useState<Trigger | null>(null);
  const [showCreateSheet, setShowCreateSheet] = useState(false);

  const detailSheetRef = useRef<BottomSheet>(null);
  const createSheetRef = useRef<BottomSheetModal>(null);

  // Colors
  const fg = isDark ? '#f8f8f8' : '#121215';
  const muted = isDark ? 'rgba(248,248,248,0.5)' : 'rgba(18,18,21,0.5)';
  const inputBg = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)';

  // Filter + sort triggers
  const filteredTriggers = useMemo(() => {
    if (!triggers) return [];
    let list = [...triggers];

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      list = list.filter(
        (t) =>
          t.name.toLowerCase().includes(q) ||
          describeCron(t.cronExpr).toLowerCase().includes(q) ||
          (t.prompt || '').toLowerCase().includes(q),
      );
    }

    // Sort: active first, then by updatedAt desc
    list.sort((a, b) => {
      if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
      return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    });

    return list;
  }, [triggers, searchQuery]);

  // Handlers
  const handleSelectTrigger = useCallback((trigger: Trigger) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setSelectedTrigger(trigger);
    detailSheetRef.current?.snapToIndex(0);
  }, []);

  const handleToggle = useCallback(
    async (trigger: Trigger) => {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      try {
        await toggleTask.mutateAsync({ id: trigger.id, isActive: !trigger.isActive });
      } catch {
        Alert.alert('Error', 'Failed to toggle task');
      }
    },
    [toggleTask],
  );

  const handleDelete = useCallback(
    (trigger: Trigger) => {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      Alert.alert('Delete Task', `Delete "${trigger.name}"? This cannot be undone.`, [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            try {
              await deleteTask.mutateAsync(trigger.id);
              if (selectedTrigger?.id === trigger.id) {
                setSelectedTrigger(null);
                detailSheetRef.current?.close();
              }
            } catch {
              Alert.alert('Error', 'Failed to delete task');
            }
          },
        },
      ]);
    },
    [deleteTask, selectedTrigger],
  );

  const handleRunNow = useCallback(
    async (trigger: Trigger) => {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      try {
        await runTask.mutateAsync(trigger.id);
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      } catch {
        Alert.alert('Error', 'Failed to run task');
      }
    },
    [runTask],
  );

  const handleOpenCreate = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    createSheetRef.current?.present();
  }, []);

  const renderBackdrop = useCallback(
    (props: any) => (
      <BottomSheetBackdrop {...props} disappearsOnIndex={-1} appearsOnIndex={0} opacity={0.5} />
    ),
    [],
  );

  // ── Search Bar + Add Button ──
  const SearchBar = (
    <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingTop: 8, paddingBottom: 8, gap: 10 }}>
      <View
        style={{
          flex: 1,
          flexDirection: 'row',
          alignItems: 'center',
          backgroundColor: inputBg,
          borderRadius: 12,
          paddingHorizontal: 12,
          height: 42,
        }}
      >
        <Search size={16} color={muted} />
        <TextInput
          value={searchQuery}
          onChangeText={setSearchQuery}
          placeholder="Search tasks..."
          placeholderTextColor={muted}
          style={{
            flex: 1,
            marginLeft: 8,
            fontSize: 15,
            fontFamily: 'Roobert',
            color: fg,
          }}
          returnKeyType="search"
          autoCorrect={false}
          autoCapitalize="none"
        />
        {searchQuery.length > 0 && (
          <Pressable onPress={() => setSearchQuery('')} hitSlop={8}>
            <X size={16} color={muted} />
          </Pressable>
        )}
      </View>
      <Pressable
        onPress={handleOpenCreate}
        style={{
          width: 42, height: 42, borderRadius: 12,
          backgroundColor: theme.primary,
          alignItems: 'center', justifyContent: 'center',
        }}
      >
        <Plus size={20} color={theme.primaryForeground} />
      </Pressable>
    </View>
  );

  return (
    <View style={{ flex: 1 }}>
      {SearchBar}

      <FlatList
        data={filteredTriggers}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <TaskListItem
            trigger={item}
            isDark={isDark}
            theme={theme}
            onPress={() => handleSelectTrigger(item)}
            onToggle={() => handleToggle(item)}
            onDelete={() => handleDelete(item)}
          />
        )}
        contentContainerStyle={{ paddingBottom: insets.bottom + 80 }}
        showsVerticalScrollIndicator={false}
        ListEmptyComponent={
          isLoading ? (
            <View style={{ padding: 60, alignItems: 'center' }}>
              <ActivityIndicator color={muted} />
            </View>
          ) : error ? (
            <View style={{ padding: 40, alignItems: 'center' }}>
              <Text style={{ color: '#ef4444', fontSize: 14, fontFamily: 'Roobert', textAlign: 'center' }}>
                Failed to load tasks
              </Text>
            </View>
          ) : (
            <View style={{ padding: 60, alignItems: 'center' }}>
              <View
                style={{
                  width: 64,
                  height: 64,
                  borderRadius: 20,
                  backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)',
                  alignItems: 'center',
                  justifyContent: 'center',
                  marginBottom: 16,
                }}
              >
                <Timer size={28} color={muted} />
              </View>
              <Text style={{ fontSize: 17, fontFamily: 'Roobert-Medium', color: fg, marginBottom: 6 }}>
                No scheduled tasks
              </Text>
              <Text style={{ fontSize: 14, fontFamily: 'Roobert', color: muted, textAlign: 'center', lineHeight: 20, paddingHorizontal: 20 }}>
                Create tasks that run on a schedule to automate your workflows.
              </Text>
            </View>
          )
        }
      />

      {/* Detail Sheet */}
      <TaskDetailSheet
        sheetRef={detailSheetRef}
        trigger={selectedTrigger}
        isDark={isDark}
        theme={theme}
        onDismiss={() => setSelectedTrigger(null)}
        onToggle={() => selectedTrigger && handleToggle(selectedTrigger)}
        onDelete={() => selectedTrigger && handleDelete(selectedTrigger)}
        onRunNow={async () => { if (selectedTrigger) await handleRunNow(selectedTrigger); }}
        onOpenSession={(sessionId) => {
          detailSheetRef.current?.close();
          setSelectedTrigger(null);
          navigateToSession(sessionId);
        }}
      />

      {/* Create Sheet */}
      <CreateTaskSheet
        sheetRef={createSheetRef}
        isDark={isDark}
        theme={theme}
        renderBackdrop={renderBackdrop}
      />
    </View>
  );
}

// ─── Task List Item ──────────────────────────────────────────────────────────

function TaskListItem({
  trigger,
  isDark,
  theme,
  onPress,
  onToggle,
  onDelete,
}: {
  trigger: Trigger;
  isDark: boolean;
  theme: ReturnType<typeof useThemeColors>;
  onPress: () => void;
  onToggle: () => void;
  onDelete: () => void;
}) {
  const fg = isDark ? '#f8f8f8' : '#121215';
  const muted = isDark ? 'rgba(248,248,248,0.5)' : 'rgba(18,18,21,0.5)';
  const isWebhook = trigger.type === 'webhook';

  return (
    <Pressable
      onPress={onPress}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: 14,
        paddingHorizontal: 20,
        gap: 12,
      }}
    >
      {/* Icon */}
      <View
        style={{
          width: 40,
          height: 40,
          borderRadius: 12,
          backgroundColor: trigger.isActive
            ? (isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)')
            : (isDark ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.02)'),
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {isWebhook ? (
          <Webhook size={18} color={trigger.isActive ? fg : muted} />
        ) : (
          <Timer size={18} color={trigger.isActive ? fg : muted} />
        )}
      </View>

      {/* Name + badges + schedule */}
      <View style={{ flex: 1 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <Text style={{ fontSize: 15, fontFamily: 'Roobert-Medium', color: fg, opacity: trigger.isActive ? 1 : 0.5 }} numberOfLines={1}>
            {trigger.name}
          </Text>
          {/* Active / Paused badge */}
          <View
            style={{
              paddingHorizontal: 7,
              paddingVertical: 2,
              borderRadius: 6,
              backgroundColor: trigger.isActive
                ? (isDark ? 'rgba(52,211,153,0.12)' : 'rgba(52,211,153,0.1)')
                : (isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)'),
            }}
          >
            <Text
              style={{
                fontSize: 10,
                fontFamily: 'Roobert-Medium',
                color: trigger.isActive ? '#34d399' : muted,
              }}
            >
              {trigger.isActive ? 'Active' : 'Paused'}
            </Text>
          </View>
          {/* Source type badge */}
          <View
            style={{
              paddingHorizontal: 7,
              paddingVertical: 2,
              borderRadius: 6,
              backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)',
            }}
          >
            <Text style={{ fontSize: 10, fontFamily: 'Roobert-Medium', color: muted }}>
              {trigger.sourceType === 'agent' ? 'Agent' : 'Manual'}
            </Text>
          </View>
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 3 }}>
          <Text style={{ fontSize: 12, fontFamily: 'Roobert', color: muted, opacity: trigger.isActive ? 1 : 0.5 }} numberOfLines={1}>
            {isWebhook ? `${trigger.webhook?.method} ${trigger.webhook?.path}` : describeCron(trigger.cronExpr)}
          </Text>
          {trigger.timezone && (
            <>
              <Text style={{ fontSize: 12, color: muted }}>·</Text>
              <Text style={{ fontSize: 12, fontFamily: 'Roobert', color: muted }}>{trigger.timezone}</Text>
            </>
          )}
        </View>
      </View>

      {/* Next run */}
      {trigger.nextRunAt && trigger.isActive && (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
          <Clock size={12} color={muted} />
          <Text style={{ fontSize: 11, fontFamily: 'Roobert', color: muted }}>
            {formatRelativeTime(trigger.nextRunAt)}
          </Text>
        </View>
      )}

      <ChevronRight size={16} color={isDark ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.15)'} />
    </Pressable>
  );
}

// ─── Task Detail Sheet ───────────────────────────────────────────────────────

function TaskDetailSheet({
  sheetRef,
  trigger,
  isDark,
  theme,
  onDismiss,
  onToggle,
  onDelete,
  onRunNow,
  onOpenSession,
}: {
  sheetRef: React.RefObject<BottomSheet>;
  trigger: Trigger | null;
  isDark: boolean;
  theme: ReturnType<typeof useThemeColors>;
  onDismiss: () => void;
  onToggle: () => void;
  onDelete: () => void;
  onRunNow: () => void;
  onOpenSession: (sessionId: string) => void;
}) {
  const insets = useSafeAreaInsets();
  const [tab, setTab] = useState<'settings' | 'executions'>('settings');
  const [isRunning, setIsRunning] = useState(false);
  const [localIsActive, setLocalIsActive] = useState<boolean | null>(null);

  // Reset local state when trigger changes
  useEffect(() => {
    setLocalIsActive(null);
  }, [trigger?.id]);

  const effectiveIsActive = localIsActive ?? trigger?.isActive ?? true;

  const handleRunNow = useCallback(async () => {
    setIsRunning(true);
    await onRunNow();
    setTimeout(() => setIsRunning(false), 2000);
  }, [onRunNow]);

  const handleToggle = useCallback(async () => {
    const newState = !effectiveIsActive;
    setLocalIsActive(newState);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onToggle();
  }, [effectiveIsActive, onToggle]);

  const fg = isDark ? '#f8f8f8' : '#121215';
  const muted = isDark ? 'rgba(248,248,248,0.5)' : 'rgba(18,18,21,0.5)';
  const subtleBg = isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.02)';
  const borderColor = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)';

  const snapPoints = useMemo(() => ['65%', '90%'], []);

  const handleSheetChange = useCallback(
    (index: number) => {
      if (index === -1) {
        onDismiss();
        setTab('settings');
      }
    },
    [onDismiss],
  );

  const renderBackdrop = useCallback(
    (props: any) => (
      <BottomSheetBackdrop {...props} disappearsOnIndex={-1} appearsOnIndex={0} opacity={0.5} />
    ),
    [],
  );

  // Reset tab when trigger changes
  useEffect(() => {
    if (trigger) setTab('settings');
  }, [trigger?.id]);

  return (
    <BottomSheet
      ref={sheetRef}
      index={-1}
      snapPoints={snapPoints}
      enablePanDownToClose
      onChange={handleSheetChange}
      backdropComponent={renderBackdrop}
      backgroundStyle={{ backgroundColor: isDark ? '#161618' : '#FFFFFF' }}
      handleIndicatorStyle={{ backgroundColor: isDark ? '#555' : '#ccc' }}
    >
      <BottomSheetScrollView
        contentContainerStyle={{ padding: 20, paddingBottom: insets.bottom + 20 }}
      >
        {trigger && (
          <>
            {/* Header */}
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 20 }}>
              <View
                style={{
                  width: 44,
                  height: 44,
                  borderRadius: 14,
                  backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                {trigger.type === 'webhook' ? (
                  <Webhook size={20} color={fg} />
                ) : (
                  <Timer size={20} color={fg} />
                )}
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 18, fontFamily: 'Roobert-Medium', color: fg }}>{trigger.name}</Text>
                <Text style={{ fontSize: 13, fontFamily: 'Roobert', color: muted, marginTop: 2 }}>
                  {trigger.type === 'webhook' ? 'Webhook' : describeCron(trigger.cronExpr)}
                </Text>
              </View>
              <Switch
                value={effectiveIsActive}
                onValueChange={handleToggle}
                trackColor={{ false: isDark ? '#333' : '#ddd', true: theme.primary }}
                thumbColor="#fff"
              />
            </View>

            {/* Tabs */}
            <View style={{ flexDirection: 'row', marginBottom: 16, gap: 0, borderRadius: 10, overflow: 'hidden', backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)' }}>
              {(['settings', 'executions'] as const).map((t) => (
                <Pressable
                  key={t}
                  onPress={() => setTab(t)}
                  style={{
                    flex: 1,
                    paddingVertical: 8,
                    alignItems: 'center',
                    backgroundColor: tab === t ? (isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.08)') : 'transparent',
                    borderRadius: 10,
                  }}
                >
                  <Text style={{ fontSize: 13, fontFamily: tab === t ? 'Roobert-Medium' : 'Roobert', color: tab === t ? fg : muted, textTransform: 'capitalize' }}>
                    {t}
                  </Text>
                </Pressable>
              ))}
            </View>

            {tab === 'settings' ? (
              <>
                {/* Info grid */}
                <View style={{ gap: 12, marginBottom: 20 }}>
                  <InfoRow label="Next run" value={formatRelativeTime(trigger.nextRunAt)} isDark={isDark} />
                  <InfoRow label="Last run" value={formatRelativeTime(trigger.lastRunAt)} isDark={isDark} />
                  {trigger.agentName && <InfoRow label="Agent" value={trigger.agentName} isDark={isDark} />}
                  <InfoRow label="Session mode" value={trigger.sessionMode === 'reuse' ? 'Reuse session' : 'New session'} isDark={isDark} />
                  <InfoRow label="Max retries" value={String(trigger.maxRetries)} isDark={isDark} />
                  <InfoRow label="Timeout" value={formatDuration(trigger.timeoutMs)} isDark={isDark} />
                  <InfoRow label="Created" value={new Date(trigger.createdAt).toLocaleDateString()} isDark={isDark} />
                </View>

                {/* Prompt */}
                {trigger.prompt && (
                  <View style={{ marginBottom: 20 }}>
                    <Text style={{ fontSize: 12, fontFamily: 'Roobert-Medium', color: muted, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 }}>
                      Prompt
                    </Text>
                    <View style={{ padding: 12, borderRadius: 10, backgroundColor: subtleBg, borderWidth: StyleSheet.hairlineWidth, borderColor }}>
                      <Text style={{ fontSize: 13, fontFamily: 'Roobert', color: fg, lineHeight: 20 }}>
                        {trigger.prompt}
                      </Text>
                    </View>
                  </View>
                )}

                {/* Actions */}
                <View style={{ gap: 10 }}>
                  {trigger.type !== 'webhook' && (
                    <Pressable
                      onPress={handleRunNow}
                      disabled={isRunning}
                      style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: 8,
                        paddingVertical: 13,
                        borderRadius: 12,
                        backgroundColor: theme.primary,
                        opacity: isRunning ? 0.7 : 1,
                      }}
                    >
                      {isRunning ? (
                        <ActivityIndicator size="small" color={theme.primaryForeground} />
                      ) : (
                        <Play size={16} color={theme.primaryForeground} fill={theme.primaryForeground} />
                      )}
                      <Text style={{ fontSize: 15, fontFamily: 'Roobert-Medium', color: theme.primaryForeground }}>
                        {isRunning ? 'Running...' : 'Run Now'}
                      </Text>
                    </Pressable>
                  )}

                  {/* Pause / Resume */}
                  <Pressable
                    onPress={handleToggle}
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: 8,
                      paddingVertical: 13,
                      borderRadius: 12,
                      backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)',
                    }}
                  >
                    {effectiveIsActive ? (
                      <Pause size={16} color={fg} />
                    ) : (
                      <Play size={16} color={fg} />
                    )}
                    <Text style={{ fontSize: 15, fontFamily: 'Roobert-Medium', color: fg }}>
                      {effectiveIsActive ? 'Pause' : 'Resume'}
                    </Text>
                  </Pressable>

                  {trigger.editable && (
                    <Pressable
                      onPress={onDelete}
                      style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: 8,
                        paddingVertical: 13,
                        borderRadius: 12,
                        backgroundColor: isDark ? 'rgba(239,68,68,0.1)' : 'rgba(239,68,68,0.06)',
                      }}
                    >
                      <Trash2 size={16} color="#ef4444" />
                      <Text style={{ fontSize: 15, fontFamily: 'Roobert-Medium', color: '#ef4444' }}>
                        Delete Task
                      </Text>
                    </Pressable>
                  )}
                </View>
              </>
            ) : (
              <ExecutionsTab triggerId={trigger.id} isDark={isDark} onOpenSession={onOpenSession} />
            )}
          </>
        )}
      </BottomSheetScrollView>
    </BottomSheet>
  );
}

// ─── Info Row ────────────────────────────────────────────────────────────────

function InfoRow({ label, value, isDark }: { label: string; value: string; isDark: boolean }) {
  const fg = isDark ? '#f8f8f8' : '#121215';
  const muted = isDark ? 'rgba(248,248,248,0.5)' : 'rgba(18,18,21,0.5)';

  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
      <Text style={{ fontSize: 13, fontFamily: 'Roobert', color: muted }}>{label}</Text>
      <Text style={{ fontSize: 13, fontFamily: 'Roobert-Medium', color: fg }}>{value}</Text>
    </View>
  );
}

// ─── Executions Tab ──────────────────────────────────────────────────────────

function ExecutionsTab({ triggerId, isDark, onOpenSession }: { triggerId: string; isDark: boolean; onOpenSession: (sessionId: string) => void }) {
  const { data: executions, isLoading } = useTaskExecutions(triggerId);
  const fg = isDark ? '#f8f8f8' : '#121215';
  const muted = isDark ? 'rgba(248,248,248,0.5)' : 'rgba(18,18,21,0.5)';

  if (isLoading) {
    return (
      <View style={{ padding: 30, alignItems: 'center' }}>
        <ActivityIndicator color={muted} />
      </View>
    );
  }

  if (!executions || executions.length === 0) {
    return (
      <View style={{ padding: 30, alignItems: 'center' }}>
        <Text style={{ fontSize: 14, fontFamily: 'Roobert', color: muted }}>No executions yet</Text>
      </View>
    );
  }

  return (
    <View style={{ gap: 8 }}>
      {executions.map((exec) => (
        <ExecutionRow key={exec.executionId} execution={exec} isDark={isDark} onOpenSession={onOpenSession} />
      ))}
    </View>
  );
}

function ExecutionRow({ execution, isDark, onOpenSession }: { execution: Execution; isDark: boolean; onOpenSession: (sessionId: string) => void }) {
  const fg = isDark ? '#f8f8f8' : '#121215';
  const muted = isDark ? 'rgba(248,248,248,0.5)' : 'rgba(18,18,21,0.5)';
  const subtleBg = isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.02)';

  const statusConfig: Record<ExecutionStatus, { color: string; icon: typeof CheckCircle2 }> = {
    completed: { color: '#34d399', icon: CheckCircle2 },
    failed: { color: '#ef4444', icon: XCircle },
    timeout: { color: '#f59e0b', icon: AlertTriangle },
    skipped: { color: muted, icon: SkipForward },
    running: { color: '#3b82f6', icon: Loader2 },
    pending: { color: muted, icon: Clock },
  };

  const config = statusConfig[execution.status] || statusConfig.pending;
  const StatusIcon = config.icon;

  const formatTimestamp = (dateStr: string | null) => {
    if (!dateStr) return '';
    const d = new Date(dateStr);
    return d.toLocaleDateString(undefined, { month: 'numeric', day: 'numeric', year: 'numeric' }) +
      ', ' + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  };

  const hasSession = !!execution.sessionId;

  return (
    <Pressable
      onPress={hasSession ? () => onOpenSession(execution.sessionId!) : undefined}
      disabled={!hasSession}
      style={{
        padding: 12,
        borderRadius: 10,
        backgroundColor: subtleBg,
        gap: 8,
      }}
    >
      {/* Top row: status + duration + timestamp */}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <StatusIcon size={16} color={config.color} />
        <Text style={{ fontSize: 13, fontFamily: 'Roobert-Medium', color: config.color, textTransform: 'capitalize' }}>
          {execution.status}
        </Text>
        {hasSession && (
          <View style={{ marginLeft: 'auto', flexDirection: 'row', alignItems: 'center', gap: 2 }}>
            <ChevronRight size={12} color={muted} />
          </View>
        )}
        <View style={{ marginLeft: hasSession ? 0 : 'auto', flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          {execution.durationMs != null && (
            <Text style={{ fontSize: 12, fontFamily: 'Roobert', color: muted }}>
              {formatDuration(execution.durationMs)}
            </Text>
          )}
          <Text style={{ fontSize: 12, fontFamily: 'Roobert', color: muted }}>
            {formatTimestamp(execution.startedAt || execution.createdAt)}
          </Text>
        </View>
      </View>

      {/* Session ID */}
      {hasSession && (
        <Text style={{ fontSize: 11, fontFamily: 'Roobert', color: muted }} numberOfLines={1}>
          Open session {execution.sessionId}
        </Text>
      )}

      {/* Error message */}
      {execution.errorMessage && (
        <Text style={{ fontSize: 11, fontFamily: 'Roobert', color: '#ef4444' }} numberOfLines={3}>
          {execution.errorMessage}
        </Text>
      )}
    </Pressable>
  );
}

// ─── Schedule Builder Constants ─────────────────────────────────────────────

type Frequency = 'minutes' | 'hourly' | 'daily' | 'weekly' | 'monthly';

const FREQUENCY_TABS: { value: Frequency; label: string }[] = [
  { value: 'minutes', label: 'Minutes' },
  { value: 'hourly', label: 'Hourly' },
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'monthly', label: 'Monthly' },
];

const WEEKDAY_BUTTONS = [
  { value: 1, label: 'Mo' },
  { value: 2, label: 'Tu' },
  { value: 3, label: 'We' },
  { value: 4, label: 'Th' },
  { value: 5, label: 'Fr' },
  { value: 6, label: 'Sa' },
  { value: 0, label: 'Su' },
];

const MINUTE_INTERVALS = [1, 5, 10, 15, 30, 45];
const HOUR_INTERVALS = [1, 2, 3, 4, 6, 8, 12];
const HOURS = Array.from({ length: 24 }, (_, i) => i);
const MINUTES = [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55];

const TIMEZONES = [
  'UTC',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'Europe/London',
  'Europe/Paris',
  'Europe/Berlin',
  'Asia/Tokyo',
  'Asia/Shanghai',
  'Asia/Kolkata',
  'Australia/Sydney',
];

function buildCronFromState(frequency: Frequency, interval: number, hour: number, minute: number, weekdays: number[], monthDay: number): string {
  switch (frequency) {
    case 'minutes':
      return `0 */${interval} * * * *`;
    case 'hourly':
      return `0 ${minute} */${interval} * * *`;
    case 'daily':
      return `0 ${minute} ${hour} * * *`;
    case 'weekly': {
      const days = weekdays.length > 0 ? [...weekdays].sort().join(',') : '*';
      return `0 ${minute} ${hour} * * ${days}`;
    }
    case 'monthly':
      return `0 ${minute} ${hour} ${monthDay} * *`;
    default:
      return `0 ${minute} ${hour} * * *`;
  }
}

function describeScheduleState(frequency: Frequency, interval: number, hour: number, minute: number, weekdays: number[], monthDay: number): string {
  const time = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  switch (frequency) {
    case 'minutes':
      return `Runs every ${interval} minute${interval === 1 ? '' : 's'}`;
    case 'hourly':
      return interval === 1
        ? `Runs every hour at :${String(minute).padStart(2, '0')}`
        : `Runs every ${interval} hours at :${String(minute).padStart(2, '0')}`;
    case 'daily':
      return `Runs every day at ${time}`;
    case 'weekly': {
      if (weekdays.length === 0) return 'No days selected';
      if (weekdays.length === 7) return `Runs every day at ${time}`;
      const sorted = [...weekdays].sort();
      if (sorted.join(',') === '1,2,3,4,5') return `Runs weekdays at ${time}`;
      if (sorted.join(',') === '0,6') return `Runs weekends at ${time}`;
      return `Runs ${sorted.map(d => dayNames[d]).join(', ')} at ${time}`;
    }
    case 'monthly': {
      const sfx = monthDay >= 11 && monthDay <= 13 ? 'th' : monthDay % 10 === 1 ? 'st' : monthDay % 10 === 2 ? 'nd' : monthDay % 10 === 3 ? 'rd' : 'th';
      return `Runs on the ${monthDay}${sfx} of each month at ${time}`;
    }
    default:
      return '';
  }
}

// ─── Create Task Sheet ──────────────────────────────────────────────────────

function CreateTaskSheet({
  sheetRef,
  isDark,
  theme,
  renderBackdrop,
}: {
  sheetRef: React.RefObject<BottomSheetModal>;
  isDark: boolean;
  theme: ReturnType<typeof useThemeColors>;
  renderBackdrop: (props: any) => React.ReactElement;
}) {
  const insets = useSafeAreaInsets();
  const sheetPadding = useSheetBottomPadding();
  const createTask = useCreateScheduledTask();

  const fg = isDark ? '#f8f8f8' : '#121215';
  const muted = isDark ? 'rgba(248,248,248,0.5)' : 'rgba(18,18,21,0.5)';
  const inputBg = isDark ? 'rgba(248,248,248,0.06)' : 'rgba(18,18,21,0.04)';
  const borderColor = isDark ? 'rgba(248,248,248,0.1)' : 'rgba(18,18,21,0.08)';
  const chipBg = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)';
  const chipActiveBg = isDark ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.1)';

  // Step: 'source' = pick type + configure schedule/webhook, 'config' = name + prompt
  const [step, setStep] = useState<'source' | 'config'>('source');

  // Source type
  const [sourceType, setSourceType] = useState<'cron' | 'webhook'>('cron');

  // Cron state
  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');
  const [frequency, setFrequency] = useState<Frequency>('daily');
  const [interval, setInterval] = useState(15);
  const [hour, setHour] = useState(9);
  const [minute, setMinute] = useState(0);
  const [weekdays, setWeekdays] = useState<number[]>([1, 2, 3, 4, 5]);
  const [monthDay, setMonthDay] = useState(1);
  const [timezone, setTimezone] = useState(() => {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return 'UTC'; }
  });
  const [showTimezones, setShowTimezones] = useState(false);

  // Webhook state
  const [webhookPath, setWebhookPath] = useState('/hooks/');
  const [webhookSecret, setWebhookSecret] = useState('');

  const reset = () => {
    setStep('source');
    setSourceType('cron');
    setName('');
    setPrompt('');
    setFrequency('daily');
    setInterval(15);
    setHour(9);
    setMinute(0);
    setWeekdays([1, 2, 3, 4, 5]);
    setMonthDay(1);
    setShowTimezones(false);
    setWebhookPath('/hooks/');
    setWebhookSecret('');
  };

  const toggleWeekday = (day: number) => {
    setWeekdays((prev) => prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day]);
  };

  const cronExpr = buildCronFromState(frequency, interval, hour, minute, weekdays, monthDay);
  const scheduleDesc = describeScheduleState(frequency, interval, hour, minute, weekdays, monthDay);

  const canProceedToConfig = sourceType === 'cron' || webhookPath.trim().length > 0;

  const isValid = useMemo(() => {
    if (!name.trim() || !prompt.trim()) return false;
    if (sourceType === 'webhook' && !webhookPath.trim()) return false;
    return true;
  }, [name, prompt, sourceType, webhookPath]);

  const handleCreate = async () => {
    if (!isValid) return;
    Keyboard.dismiss();
    try {
      await createTask.mutateAsync({
        name: name.trim(),
        source: sourceType === 'cron'
          ? { type: 'cron', cron_expr: cronExpr, timezone }
          : { type: 'webhook', path: webhookPath.trim(), method: 'POST', ...(webhookSecret ? { secret: webhookSecret } : {}) },
        action: {
          type: 'prompt',
          prompt: prompt.trim(),
          session_mode: 'new',
        },
      });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      sheetRef.current?.dismiss();
      reset();
    } catch (err: any) {
      Alert.alert('Error', err?.message || 'Failed to create trigger');
    }
  };

  const inputStyle = {
    backgroundColor: inputBg,
    borderWidth: 1,
    borderColor,
    borderRadius: 14,
    paddingHorizontal: 16,
    paddingVertical: 14,
    fontSize: 16,
    fontFamily: 'Roobert',
    color: fg,
  };

  const tzLabel = useMemo(() => {
    if (timezone === 'UTC') return 'UTC';
    const parts = timezone.split('/');
    return parts[parts.length - 1].replace(/_/g, ' ');
  }, [timezone]);

  return (
    <BottomSheetModal
      ref={sheetRef}
      snapPoints={['85%']}
      enablePanDownToClose
      backdropComponent={renderBackdrop}
      keyboardBehavior="interactive"
      keyboardBlurBehavior="restore"
      android_keyboardInputMode="adjustResize"
      onDismiss={reset}
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
      <BottomSheetScrollView
        contentContainerStyle={{
          paddingHorizontal: 24,
          paddingTop: 8,
          paddingBottom: sheetPadding,
        }}
        keyboardShouldPersistTaps="handled"
      >
        {/* Header */}
        <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 20 }}>
          <View style={{ width: 40, height: 40, borderRadius: 12, backgroundColor: chipBg, alignItems: 'center', justifyContent: 'center', marginRight: 12 }}>
            <Timer size={20} color={fg} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 18, fontFamily: 'Roobert-Semibold', color: fg }}>
              Create Trigger
            </Text>
            <Text style={{ fontSize: 12, fontFamily: 'Roobert', color: muted, marginTop: 2 }}>
              {step === 'source' ? 'Choose when this trigger should fire.' : 'Configure what this trigger does.'}
            </Text>
          </View>
        </View>

        {/* ═══ STEP 1: Source ═══ */}
        {step === 'source' && (<>
          {/* Trigger Source */}
          <Text style={{ fontSize: 13, fontFamily: 'Roobert-Medium', color: muted, marginBottom: 8 }}>Trigger Source</Text>
          <View style={{ flexDirection: 'row', gap: 10, marginBottom: 20 }}>
            <Pressable
              onPress={() => { setSourceType('cron'); Haptics.selectionAsync(); }}
              style={{
                flex: 1, paddingVertical: 14, paddingHorizontal: 14, borderRadius: 14, borderWidth: 2, alignItems: 'center', gap: 6,
                borderColor: sourceType === 'cron' ? theme.primary : borderColor,
                backgroundColor: sourceType === 'cron' ? (isDark ? 'rgba(190,24,93,0.06)' : 'rgba(190,24,93,0.04)') : 'transparent',
              }}
            >
              <Timer size={20} color={sourceType === 'cron' ? theme.primary : muted} />
              <Text style={{ fontSize: 13, fontFamily: 'Roobert-Medium', color: sourceType === 'cron' ? fg : muted }}>Cron Schedule</Text>
              <Text style={{ fontSize: 11, fontFamily: 'Roobert', color: muted, textAlign: 'center' }}>Runs on a time-based schedule</Text>
            </Pressable>
            <Pressable
              onPress={() => { setSourceType('webhook'); Haptics.selectionAsync(); }}
              style={{
                flex: 1, paddingVertical: 14, paddingHorizontal: 14, borderRadius: 14, borderWidth: 2, alignItems: 'center', gap: 6,
                borderColor: sourceType === 'webhook' ? theme.primary : borderColor,
                backgroundColor: sourceType === 'webhook' ? (isDark ? 'rgba(190,24,93,0.06)' : 'rgba(190,24,93,0.04)') : 'transparent',
              }}
            >
              <Webhook size={20} color={sourceType === 'webhook' ? theme.primary : muted} />
              <Text style={{ fontSize: 13, fontFamily: 'Roobert-Medium', color: sourceType === 'webhook' ? fg : muted }}>Webhook</Text>
              <Text style={{ fontSize: 11, fontFamily: 'Roobert', color: muted, textAlign: 'center' }}>Fires when an HTTP request is received</Text>
            </Pressable>
          </View>

          {/* Cron: Schedule config */}
          {sourceType === 'cron' && (<>
            <Text style={{ fontSize: 13, fontFamily: 'Roobert-Medium', color: muted, marginBottom: 8 }}>Schedule</Text>
            <View style={{ flexDirection: 'row', borderRadius: 10, backgroundColor: chipBg, padding: 3, marginBottom: 12 }}>
              {FREQUENCY_TABS.map((tab) => (
                <Pressable
                  key={tab.value}
                  onPress={() => { setFrequency(tab.value); Haptics.selectionAsync(); }}
                  style={{
                    flex: 1, paddingVertical: 7, alignItems: 'center', borderRadius: 8,
                    backgroundColor: frequency === tab.value ? (isDark ? '#f8f8f8' : '#121215') : 'transparent',
                  }}
                >
                  <Text style={{ fontSize: 12, fontFamily: frequency === tab.value ? 'Roobert-Medium' : 'Roobert', color: frequency === tab.value ? (isDark ? '#121215' : '#f8f8f8') : muted }}>
                    {tab.label}
                  </Text>
                </Pressable>
              ))}
            </View>

            <View style={{ borderRadius: 12, backgroundColor: chipBg, padding: 14, marginBottom: 12 }}>
              {frequency === 'minutes' && (
                <View>
                  <Text style={{ fontSize: 12, fontFamily: 'Roobert', color: muted, marginBottom: 8 }}>Every</Text>
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                    {MINUTE_INTERVALS.map((v) => (
                      <Pressable key={v} onPress={() => setInterval(v)} style={{ paddingHorizontal: 14, paddingVertical: 7, borderRadius: 8, backgroundColor: interval === v ? chipActiveBg : 'transparent', borderWidth: 1, borderColor: interval === v ? (isDark ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.1)') : 'transparent' }}>
                        <Text style={{ fontSize: 13, fontFamily: interval === v ? 'Roobert-Medium' : 'Roobert', color: interval === v ? fg : muted }}>{v} min</Text>
                      </Pressable>
                    ))}
                  </View>
                </View>
              )}
              {frequency === 'hourly' && (
                <View>
                  <Text style={{ fontSize: 12, fontFamily: 'Roobert', color: muted, marginBottom: 8 }}>Every</Text>
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
                    {HOUR_INTERVALS.map((v) => (
                      <Pressable key={v} onPress={() => setInterval(v)} style={{ paddingHorizontal: 14, paddingVertical: 7, borderRadius: 8, backgroundColor: interval === v ? chipActiveBg : 'transparent', borderWidth: 1, borderColor: interval === v ? (isDark ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.1)') : 'transparent' }}>
                        <Text style={{ fontSize: 13, fontFamily: interval === v ? 'Roobert-Medium' : 'Roobert', color: interval === v ? fg : muted }}>{v}h</Text>
                      </Pressable>
                    ))}
                  </View>
                  <Text style={{ fontSize: 12, fontFamily: 'Roobert', color: muted, marginBottom: 6 }}>At minute</Text>
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                    {[0, 15, 30, 45].map((m) => (
                      <Pressable key={m} onPress={() => setMinute(m)} style={{ paddingHorizontal: 14, paddingVertical: 7, borderRadius: 8, backgroundColor: minute === m ? chipActiveBg : 'transparent', borderWidth: 1, borderColor: minute === m ? (isDark ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.1)') : 'transparent' }}>
                        <Text style={{ fontSize: 13, fontFamily: minute === m ? 'Roobert-Medium' : 'Roobert', color: minute === m ? fg : muted }}>:{String(m).padStart(2, '0')}</Text>
                      </Pressable>
                    ))}
                  </View>
                </View>
              )}
              {frequency === 'daily' && (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <Clock size={16} color={muted} />
                  <Text style={{ fontSize: 13, fontFamily: 'Roobert', color: muted }}>at</Text>
                  <Pressable style={{ backgroundColor: chipActiveBg, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 7 }} onPress={() => setHour((h) => (h + 1) % 24)}>
                    <Text style={{ fontSize: 14, fontFamily: 'Roobert-Medium', color: fg }}>{String(hour).padStart(2, '0')}</Text>
                  </Pressable>
                  <Text style={{ fontSize: 14, fontFamily: 'Roobert-Medium', color: muted }}>:</Text>
                  <Pressable style={{ backgroundColor: chipActiveBg, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 7 }} onPress={() => setMinute((m) => { const idx = MINUTES.indexOf(m); return MINUTES[(idx + 1) % MINUTES.length]; })}>
                    <Text style={{ fontSize: 14, fontFamily: 'Roobert-Medium', color: fg }}>{String(minute).padStart(2, '0')}</Text>
                  </Pressable>
                </View>
              )}
              {frequency === 'weekly' && (
                <View>
                  <View style={{ flexDirection: 'row', gap: 6, marginBottom: 12 }}>
                    {WEEKDAY_BUTTONS.map((day) => {
                      const active = weekdays.includes(day.value);
                      return (
                        <Pressable key={day.value} onPress={() => toggleWeekday(day.value)} style={{ flex: 1, paddingVertical: 8, alignItems: 'center', borderRadius: 8, backgroundColor: active ? (isDark ? '#f8f8f8' : '#121215') : 'transparent', borderWidth: 1, borderColor: active ? 'transparent' : (isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)') }}>
                          <Text style={{ fontSize: 12, fontFamily: active ? 'Roobert-Medium' : 'Roobert', color: active ? (isDark ? '#121215' : '#f8f8f8') : muted }}>{day.label}</Text>
                        </Pressable>
                      );
                    })}
                  </View>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                    <Clock size={16} color={muted} />
                    <Text style={{ fontSize: 13, fontFamily: 'Roobert', color: muted }}>at</Text>
                    <Pressable style={{ backgroundColor: chipActiveBg, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 7 }} onPress={() => setHour((h) => (h + 1) % 24)}>
                      <Text style={{ fontSize: 14, fontFamily: 'Roobert-Medium', color: fg }}>{String(hour).padStart(2, '0')}</Text>
                    </Pressable>
                    <Text style={{ fontSize: 14, fontFamily: 'Roobert-Medium', color: muted }}>:</Text>
                    <Pressable style={{ backgroundColor: chipActiveBg, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 7 }} onPress={() => setMinute((m) => { const idx = MINUTES.indexOf(m); return MINUTES[(idx + 1) % MINUTES.length]; })}>
                      <Text style={{ fontSize: 14, fontFamily: 'Roobert-Medium', color: fg }}>{String(minute).padStart(2, '0')}</Text>
                    </Pressable>
                  </View>
                </View>
              )}
              {frequency === 'monthly' && (
                <View>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                    <Text style={{ fontSize: 13, fontFamily: 'Roobert', color: muted }}>On day</Text>
                    <Pressable style={{ backgroundColor: chipActiveBg, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 7 }} onPress={() => setMonthDay((d) => (d % 31) + 1)}>
                      <Text style={{ fontSize: 14, fontFamily: 'Roobert-Medium', color: fg }}>{monthDay}</Text>
                    </Pressable>
                  </View>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                    <Clock size={16} color={muted} />
                    <Text style={{ fontSize: 13, fontFamily: 'Roobert', color: muted }}>at</Text>
                    <Pressable style={{ backgroundColor: chipActiveBg, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 7 }} onPress={() => setHour((h) => (h + 1) % 24)}>
                      <Text style={{ fontSize: 14, fontFamily: 'Roobert-Medium', color: fg }}>{String(hour).padStart(2, '0')}</Text>
                    </Pressable>
                    <Text style={{ fontSize: 14, fontFamily: 'Roobert-Medium', color: muted }}>:</Text>
                    <Pressable style={{ backgroundColor: chipActiveBg, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 7 }} onPress={() => setMinute((m) => { const idx = MINUTES.indexOf(m); return MINUTES[(idx + 1) % MINUTES.length]; })}>
                      <Text style={{ fontSize: 14, fontFamily: 'Roobert-Medium', color: fg }}>{String(minute).padStart(2, '0')}</Text>
                    </Pressable>
                  </View>
                </View>
              )}
              <Text style={{ fontSize: 12, fontFamily: 'Roobert', color: muted, marginTop: 10 }}>{scheduleDesc}</Text>
            </View>

            {/* Timezone */}
            <Text style={{ fontSize: 13, fontFamily: 'Roobert-Medium', color: muted, marginBottom: 6 }}>Timezone</Text>
            <Pressable
              onPress={() => setShowTimezones(!showTimezones)}
              style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 10, backgroundColor: chipBg, alignSelf: 'flex-start', marginBottom: showTimezones ? 8 : 0 }}
            >
              <Text style={{ fontSize: 13, fontFamily: 'Roobert-Medium', color: fg }}>{tzLabel}</Text>
              <ChevronRight size={14} color={muted} style={{ transform: [{ rotate: showTimezones ? '90deg' : '0deg' }] }} />
            </Pressable>
            {showTimezones && (
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 0 }}>
                {TIMEZONES.map((tz) => {
                  const active = timezone === tz;
                  const label = tz === 'UTC' ? 'UTC' : tz.split('/').pop()!.replace(/_/g, ' ');
                  return (
                    <Pressable key={tz} onPress={() => { setTimezone(tz); setShowTimezones(false); Haptics.selectionAsync(); }} style={{ paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8, backgroundColor: active ? (isDark ? '#f8f8f8' : '#121215') : chipBg }}>
                      <Text style={{ fontSize: 12, fontFamily: active ? 'Roobert-Medium' : 'Roobert', color: active ? (isDark ? '#121215' : '#f8f8f8') : muted }}>{label}</Text>
                    </Pressable>
                  );
                })}
              </View>
            )}
          </>)}

          {/* Webhook config */}
          {sourceType === 'webhook' && (<>
            <Text style={{ fontSize: 13, fontFamily: 'Roobert-Medium', color: muted, marginBottom: 6 }}>Webhook Path</Text>
            <BottomSheetTextInput
              value={webhookPath}
              onChangeText={setWebhookPath}
              placeholder="/hooks/my-endpoint"
              placeholderTextColor={isDark ? 'rgba(248,248,248,0.25)' : 'rgba(18,18,21,0.3)'}
              autoCapitalize="none"
              autoCorrect={false}
              style={{ ...inputStyle, marginBottom: 12 }}
            />
            <Text style={{ fontSize: 13, fontFamily: 'Roobert-Medium', color: muted, marginBottom: 6 }}>
              Secret <Text style={{ fontFamily: 'Roobert', color: muted }}>(optional)</Text>
            </Text>
            <BottomSheetTextInput
              value={webhookSecret}
              onChangeText={setWebhookSecret}
              placeholder="shared-secret"
              placeholderTextColor={isDark ? 'rgba(248,248,248,0.25)' : 'rgba(18,18,21,0.3)'}
              autoCapitalize="none"
              autoCorrect={false}
              secureTextEntry
              style={{ ...inputStyle, marginBottom: 8 }}
            />
            <Text style={{ fontSize: 11, fontFamily: 'Roobert', color: muted, lineHeight: 16 }}>
              If set, requests must include the header{'\n'}X-Kortix-Trigger-Secret with this value.
            </Text>
          </>)}

          {/* Next button */}
          <View style={{ marginTop: 20 }}>
            <Pressable
              onPress={() => { setStep('config'); Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); }}
              disabled={!canProceedToConfig}
              style={{
                flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
                paddingVertical: 14, borderRadius: 14,
                backgroundColor: canProceedToConfig ? theme.primary : (isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)'),
              }}
            >
              <Text style={{ fontSize: 16, fontFamily: 'Roobert-Medium', color: canProceedToConfig ? theme.primaryForeground : (isDark ? 'rgba(248,248,248,0.25)' : 'rgba(18,18,21,0.25)') }}>
                Next
              </Text>
              <ChevronRight size={18} color={canProceedToConfig ? theme.primaryForeground : (isDark ? 'rgba(248,248,248,0.25)' : 'rgba(18,18,21,0.25)')} />
            </Pressable>
          </View>
        </>)}

        {/* ═══ STEP 2: Config ═══ */}
        {step === 'config' && (<>
          {/* Source summary */}
          <View style={{ borderRadius: 12, backgroundColor: chipBg, padding: 12, marginBottom: 20, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            {sourceType === 'cron' ? <Timer size={16} color={muted} /> : <Webhook size={16} color={muted} />}
            <Text style={{ fontSize: 13, fontFamily: 'Roobert', color: muted, flex: 1 }}>
              {sourceType === 'cron' ? scheduleDesc : `POST ${webhookPath}`}
            </Text>
            <Pressable onPress={() => setStep('source')} hitSlop={8}>
              <Pencil size={14} color={muted} />
            </Pressable>
          </View>

          {/* Name */}
          <Text style={{ fontSize: 13, fontFamily: 'Roobert-Medium', color: muted, marginBottom: 6 }}>Name</Text>
          <BottomSheetTextInput
            value={name}
            onChangeText={setName}
            placeholder="e.g. Daily report"
            placeholderTextColor={isDark ? 'rgba(248,248,248,0.25)' : 'rgba(18,18,21,0.3)'}
            autoFocus
            style={{ ...inputStyle, marginBottom: 16 }}
          />

          {/* Prompt */}
          <Text style={{ fontSize: 13, fontFamily: 'Roobert-Medium', color: muted, marginBottom: 6 }}>Prompt</Text>
          <BottomSheetTextInput
            value={prompt}
            onChangeText={setPrompt}
            placeholder="What should the agent do?"
            placeholderTextColor={isDark ? 'rgba(248,248,248,0.25)' : 'rgba(18,18,21,0.3)'}
            multiline
            numberOfLines={3}
            style={{ ...inputStyle, height: 80, textAlignVertical: 'top', marginBottom: 20 }}
          />

          {/* Footer buttons */}
          <View style={{ flexDirection: 'row', gap: 10 }}>
            <Pressable
              onPress={() => setStep('source')}
              style={{
                flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 14, borderRadius: 14,
                backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)',
              }}
            >
              <Text style={{ fontSize: 16, fontFamily: 'Roobert-Medium', color: fg }}>Back</Text>
            </Pressable>
            <Pressable
              onPress={handleCreate}
              disabled={!isValid || createTask.isPending}
              style={{
                flex: 2, alignItems: 'center', justifyContent: 'center', paddingVertical: 14, borderRadius: 14,
                backgroundColor: isValid ? theme.primary : (isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)'),
              }}
            >
              {createTask.isPending ? (
                <ActivityIndicator size="small" color={isValid ? theme.primaryForeground : muted} />
              ) : (
                <Text style={{ fontSize: 16, fontFamily: 'Roobert-Medium', color: isValid ? theme.primaryForeground : (isDark ? 'rgba(248,248,248,0.25)' : 'rgba(18,18,21,0.25)') }}>
                  Create Trigger
                </Text>
              )}
            </Pressable>
          </View>
        </>)}
      </BottomSheetScrollView>
    </BottomSheetModal>
  );
}
