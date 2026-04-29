import * as React from 'react';
import { View, TouchableOpacity, Modal, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Text } from '@/components/ui/text';
import { useSandboxContext } from '@/contexts/SandboxContext';
import {
  useLegacyThreads,
  useMigrateAllLegacyThreads,
  useMigrateAllStatus,
} from '@/lib/legacy/use-legacy-threads';

interface LegacyChatsSectionProps {
  iconColor: string;
  mutedColor: string;
  isDark: boolean;
}

/**
 * Drawer section listing pre-OpenCode chats with a bulk-convert action.
 * Mirrors the web sidebar's "Previous Chats" section (apps/web sidebar-left.tsx).
 */
export function LegacyChatsSection({ iconColor, mutedColor, isDark }: LegacyChatsSectionProps) {
  const { sandboxId } = useSandboxContext();
  const { data: legacyData, isLoading } = useLegacyThreads();
  const migrateAll = useMigrateAllLegacyThreads();
  const [migrateStarted, setMigrateStarted] = React.useState(false);
  const { data: migrateStatus } = useMigrateAllStatus(migrateStarted);
  const [expanded, setExpanded] = React.useState(false);
  const [confirmOpen, setConfirmOpen] = React.useState(false);

  const total = legacyData?.total ?? 0;
  const hasLegacy = !isLoading && total > 0;
  const isMigrating = migrateStatus?.status === 'running';
  const migrateDone = migrateStatus?.status === 'done';
  const buttonBusy = isMigrating || migrateDone || migrateAll.isPending;

  const handleConfirm = React.useCallback(async () => {
    setConfirmOpen(false);
    if (!sandboxId) return;
    setMigrateStarted(true);
    try {
      await migrateAll.mutateAsync({ sandboxExternalId: sandboxId });
    } catch {
      // status query surfaces failures
    }
  }, [sandboxId, migrateAll]);

  if (!hasLegacy) return null;

  const progress = migrateStatus && migrateStatus.total > 0
    ? Math.round(((migrateStatus.completed + migrateStatus.failed) / migrateStatus.total) * 100)
    : 0;

  return (
    <View>
      <View className="flex-row items-center px-3">
        <TouchableOpacity
          onPress={() => setExpanded((v) => !v)}
          className="flex-row items-center flex-1 px-2 py-2.5 rounded-lg"
          activeOpacity={0.6}
        >
          <Ionicons name="time-outline" size={18} color={iconColor} />
          <Text className="flex-1 text-sm font-medium ml-3 text-foreground">Previous Chats</Text>
          <View className="bg-muted rounded-full px-2 py-0.5 mr-1">
            <Text className="text-xs text-muted-foreground">{total}</Text>
          </View>
          <Ionicons
            name="chevron-down"
            size={16}
            color={mutedColor}
            style={{ transform: [{ rotate: expanded ? '0deg' : '-90deg' }] }}
          />
        </TouchableOpacity>
        <TouchableOpacity
          onPress={() => setConfirmOpen(true)}
          disabled={buttonBusy || !sandboxId}
          className="items-center justify-center h-8 w-8 rounded-lg ml-1"
          activeOpacity={0.6}
          hitSlop={6}
        >
          {migrateDone ? (
            <Ionicons name="checkmark-circle" size={16} color="#10b981" />
          ) : isMigrating || migrateAll.isPending ? (
            <ActivityIndicator size="small" color={mutedColor} />
          ) : (
            <Ionicons name="swap-horizontal" size={16} color={mutedColor} />
          )}
        </TouchableOpacity>
      </View>

      {(isMigrating || migrateAll.isPending) && migrateStatus && migrateStatus.total > 0 && (
        <View className="px-6 pb-1.5">
          <Text className="text-[10px] text-muted-foreground mb-1">
            Converting {migrateStatus.completed}/{migrateStatus.total}
            {migrateStatus.failed > 0 && (
              <Text className="text-destructive"> · {migrateStatus.failed} failed</Text>
            )}
          </Text>
          <View className="h-1 w-full rounded-full bg-muted overflow-hidden">
            <View
              className="h-full rounded-full bg-primary"
              style={{ width: `${progress}%` }}
            />
          </View>
        </View>
      )}

      {migrateDone && migrateStatus && (
        <View className="px-6 pb-1.5">
          <Text className="text-[10px]" style={{ color: '#10b981' }}>
            Converted {migrateStatus.completed} chats
            {migrateStatus.failed > 0 && (
              <Text className="text-destructive"> · {migrateStatus.failed} failed</Text>
            )}
          </Text>
        </View>
      )}

      {expanded && legacyData && (
        <View className="px-2 pb-2">
          {legacyData.threads.map((thread) => (
            <View
              key={thread.thread_id}
              className="flex-row items-center rounded-lg px-4 py-2 mb-0.5"
            >
              <Text className="flex-1 text-sm text-muted-foreground" numberOfLines={1}>
                {thread.name || 'Untitled'}
              </Text>
            </View>
          ))}
        </View>
      )}

      <Modal
        visible={confirmOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setConfirmOpen(false)}
      >
        <View
          className="flex-1 items-center justify-center px-6"
          style={{ backgroundColor: 'rgba(0,0,0,0.5)' }}
        >
          <View className="w-full max-w-md rounded-2xl bg-background p-6">
            <Text className="text-lg font-semibold text-foreground mb-2">
              Convert all previous chats?
            </Text>
            <Text className="text-sm text-muted-foreground mb-6 leading-5">
              This will convert {total} previous {total === 1 ? 'chat' : 'chats'} into sessions. The process runs in the background, but may take a few minutes depending on the number of chats.
            </Text>
            <View className="flex-row justify-end gap-2">
              <TouchableOpacity
                onPress={() => setConfirmOpen(false)}
                className="px-5 py-2.5 rounded-full border border-border"
                activeOpacity={0.7}
              >
                <Text className="text-sm font-medium text-foreground">Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={handleConfirm}
                disabled={!sandboxId}
                className="px-5 py-2.5 rounded-full"
                style={{
                  backgroundColor: isDark ? '#F8F8F8' : '#121215',
                  opacity: !sandboxId ? 0.5 : 1,
                }}
                activeOpacity={0.7}
              >
                <Text
                  className="text-sm font-medium"
                  style={{ color: isDark ? '#121215' : '#F8F8F8' }}
                >
                  Convert all
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}
