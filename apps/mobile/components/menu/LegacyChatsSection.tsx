import * as React from 'react';
import { View, Pressable, Modal, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Text } from '@/components/ui/text';
import { Button } from '@/components/ui/button';
import { useSandboxContext } from '@/contexts/SandboxContext';
import {
  useLegacyThreads,
  useMigrateAllLegacyThreads,
  useMigrateAllStatus,
} from '@/lib/legacy/use-legacy-threads';
import { haptics } from '@/lib/haptics';
import { THEME } from '@/lib/utils/theme';

interface LegacyChatsSectionProps {
  iconColor: string;
  mutedColor: string;
  isDark: boolean;
}

/**
 * Drawer section listing pre-OpenCode chats with a bulk-convert action.
 * Mirrors the web sidebar's "Previous Chats" section (apps/web sidebar-left.tsx).
 */
export function LegacyChatsSection({ iconColor, mutedColor }: LegacyChatsSectionProps) {
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
        <Pressable
          onPress={() => { haptics.selection(); setExpanded((v) => !v); }}
          className="flex-row items-center flex-1 px-2 py-2.5 rounded-lg active:opacity-60"
        >
          <Ionicons name="time-outline" size={18} color={iconColor} />
          <Text className="flex-1 text-sm font-medium ml-3 text-foreground">Previous Chats</Text>
          <View className="bg-muted rounded-full px-2 py-0.5 mr-1">
            <Text className="text-muted-foreground" style={{ fontSize: 12, lineHeight: 16 }}>{total}</Text>
          </View>
          <Ionicons
            name="chevron-down"
            size={16}
            color={mutedColor}
            style={{ transform: [{ rotate: expanded ? '0deg' : '-90deg' }] }}
          />
        </Pressable>
        <Button
          variant="ghost"
          size="icon"
          onPress={() => { haptics.tap(); setConfirmOpen(true); }}
          disabled={buttonBusy || !sandboxId}
          className="h-8 w-8 ml-1"
          hitSlop={6}
        >
          {migrateDone ? (
            <Ionicons name="checkmark-circle" size={16} color={THEME.accent.green} />
          ) : isMigrating || migrateAll.isPending ? (
            <ActivityIndicator size="small" color={mutedColor} />
          ) : (
            <Ionicons name="swap-horizontal" size={16} color={mutedColor} />
          )}
        </Button>
      </View>

      {(isMigrating || migrateAll.isPending) && migrateStatus && migrateStatus.total > 0 && (
        <View className="px-6 pb-1.5">
          <Text className="text-muted-foreground mb-1" style={{ fontSize: 10 }}>
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
          <Text className="text-kortix-green" style={{ fontSize: 10 }}>
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
        <View className="flex-1 items-center justify-center px-6 bg-black/50">
          <View className="w-full max-w-md rounded-2xl bg-background p-6">
            <Text className="text-lg font-semibold text-foreground mb-2">
              Convert all previous chats?
            </Text>
            <Text className="text-sm text-muted-foreground mb-6 leading-5">
              This will convert {total} previous {total === 1 ? 'chat' : 'chats'} into sessions. The process runs in the background, but may take a few minutes depending on the number of chats.
            </Text>
            <View className="flex-row justify-end gap-2">
              <Button
                variant="outline"
                size="sm"
                onPress={() => { haptics.tap(); setConfirmOpen(false); }}
                className="rounded-full"
              >
                <Text>Cancel</Text>
              </Button>
              <Button
                variant="default"
                size="sm"
                onPress={() => { haptics.medium(); handleConfirm(); }}
                disabled={!sandboxId}
                className="rounded-full"
              >
                <Text>Convert all</Text>
              </Button>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}
