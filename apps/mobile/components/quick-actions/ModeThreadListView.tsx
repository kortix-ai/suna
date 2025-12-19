/**
 * ModeThreadListView Component
 *
 * Displays a list of threads for a specific mode, grouped by month.
 * Includes an input field at the bottom for creating new threads.
 */

import * as React from 'react';
import { View, ScrollView } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useColorScheme } from 'nativewind';
import { Text } from '@/components/ui/text';
import { useLanguage } from '@/contexts';
import { useThreads } from '@/lib/chat/hooks';
import { formatConversationDate, formatMonthYear } from '@/lib/utils/date';
import { SelectableListItem } from '@/components/shared/SelectableListItem';
import { ThreadAvatar } from '@/components/ui/ThreadAvatar';
import { QUICK_ACTIONS } from './quickActions';
import type { Thread } from '@/api/types';
import { MessageCircle } from 'lucide-react-native';

/**
 * Mapping between mode IDs and possible icon names from the backend
 * Includes common auto-generated icons that might be assigned to threads
 */
const MODE_TO_ICON_NAMES: Record<string, string[]> = {
  image: ['image', 'camera', 'photo', 'picture'],
  slides: ['presentation', 'presentation-icon', 'slides', 'layers'],
  data: ['database', 'table', 'data', 'chart', 'bar-chart', 'pie-chart', 'line-chart'],
  docs: ['file-text', 'file', 'document', 'docs', 'book', 'book-open', 'edit', 'pencil'],
  people: ['user', 'users', 'people', 'contact'],
  research: ['search', 'research', 'info', 'help-circle', 'globe', 'magnifying-glass'],
};

/**
 * Reverse mapping: icon name to mode ID
 */
const ICON_NAME_TO_MODE: Record<string, string> = {};
Object.entries(MODE_TO_ICON_NAMES).forEach(([modeId, iconNames]) => {
  iconNames.forEach((iconName) => {
    ICON_NAME_TO_MODE[iconName] = modeId;
  });
});

/**
 * Get the mode ID for a thread based on metadata.mode or project.icon_name
 */
function getThreadModeId(thread: Thread): string | null {
  // First check metadata.mode (new threads)
  if (thread.metadata?.mode) {
    return thread.metadata.mode;
  }

  // Fall back to project.icon_name mapping (existing threads)
  const iconName = thread.project?.icon_name?.toLowerCase();
  if (iconName && ICON_NAME_TO_MODE[iconName]) {
    return ICON_NAME_TO_MODE[iconName];
  }

  return null;
}

interface ModeThreadListViewProps {
  /** Current mode ID (e.g., 'data', 'docs', 'slides') */
  modeId: string;
  /** Callback when a thread is pressed */
  onThreadPress: (threadId: string) => void;
  /** Callback when user starts typing (to create new thread) */
  onStartNewThread?: () => void;
}

interface ThreadSection {
  id: string;
  timestamp: Date;
  threads: Thread[];
}

/**
 * Groups threads by month
 */
function groupThreadsByMonth(threads: Thread[]): ThreadSection[] {
  if (!threads || threads.length === 0) {
    return [];
  }

  // Sort threads by created_at descending (newest first)
  const sortedThreads = [...threads].sort((a, b) => {
    return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
  });

  // Group by year-month
  const grouped = new Map<string, Thread[]>();

  sortedThreads.forEach((thread) => {
    const date = new Date(thread.created_at);
    const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;

    if (!grouped.has(monthKey)) {
      grouped.set(monthKey, []);
    }
    grouped.get(monthKey)!.push(thread);
  });

  // Convert to ThreadSection format
  return Array.from(grouped.entries()).map(([key, threads]) => ({
    id: key,
    timestamp: new Date(threads[0].created_at),
    threads,
  }));
}

/**
 * Thread Item Component
 */
function ThreadItem({ thread, onPress }: { thread: Thread; onPress: () => void }) {
  const { currentLanguage } = useLanguage();
  const { colorScheme } = useColorScheme();
  const isDarkMode = colorScheme === 'dark';

  const formattedDate = React.useMemo(
    () => formatConversationDate(new Date(thread.created_at), currentLanguage),
    [thread.created_at, currentLanguage]
  );

  const title = thread.project?.name || thread.title || 'Untitled Chat';

  // Use the thread's icon_name (same as side menu) - fallback to mode-based icon
  const threadIcon = thread.project?.icon_name || MessageCircle;

  return (
    <SelectableListItem
      avatar={
        <ThreadAvatar
          title={title}
          icon={threadIcon}
          size={48}
          backgroundColor={isDarkMode ? '#1C1D20' : '#ECECEC'}
          className="flex-row items-center justify-center"
          style={{
            borderWidth: 0,
          }}
        />
      }
      title={title}
      meta={formattedDate}
      hideIndicator
      onPress={onPress}
      accessibilityLabel={`Open thread: ${title}`}
    />
  );
}

/**
 * Thread Section Component
 */
function ThreadSection({
  section,
  onThreadPress,
}: {
  section: ThreadSection;
  onThreadPress: (threadId: string) => void;
}) {
  const { currentLanguage } = useLanguage();

  const sectionTitle = React.useMemo(
    () => formatMonthYear(section.timestamp, currentLanguage),
    [section.timestamp, currentLanguage]
  );

  return (
    <View className="w-full gap-3">
      <Text className="font-roobert-medium text-sm text-foreground opacity-50">{sectionTitle}</Text>
      <View className="gap-4">
        {section.threads.map((thread) => (
          <ThreadItem
            key={thread.thread_id}
            thread={thread}
            onPress={() => onThreadPress(thread.thread_id)}
          />
        ))}
      </View>
    </View>
  );
}

/**
 * Mode Header Component
 */
function ModeHeader({ modeIcon: ModeIcon, modeLabel }: { modeIcon: React.ComponentType<any>; modeLabel: string }) {
  const { colorScheme } = useColorScheme();
  
  // Get icon color based on theme
  // Foreground: #121215 (light) / #F8F8F8 (dark)
  const iconColor = React.useMemo(() => {
    return colorScheme === 'dark' ? '#F8F8F8' : '#121215';
  }, [colorScheme]);

  return (
    <View className="mb-6 flex-row items-center gap-3">
      <ModeIcon size={28} strokeWidth={2} color={iconColor} />
      <Text className="font-roobert-semibold text-3xl text-foreground">{modeLabel}</Text>
    </View>
  );
}

/**
 * Empty State Component
 */
function EmptyState({ modeLabel }: { modeLabel: string }) {
  const { t } = useLanguage();
  const { colorScheme } = useColorScheme();

  return (
    <View className="items-center px-8 pt-16">
      <View
        className="mb-6 h-20 w-20 items-center justify-center rounded-full"
        style={{
          backgroundColor:
            colorScheme === 'dark' ? 'rgba(248, 248, 248, 0.1)' : 'rgba(18, 18, 21, 0.05)',
        }}>
        <MessageCircle size={40} color={colorScheme === 'dark' ? '#666' : '#999'} />
      </View>
      <Text className="mb-2 text-center font-roobert-semibold text-xl text-foreground">
        {t('modes.noThreadsYet', { defaultValue: `No ${modeLabel} threads yet` })}
      </Text>
      <Text className="text-center font-roobert text-base text-muted-foreground">
        {t('modes.startTyping', { defaultValue: 'Start typing below to create your first thread' })}
      </Text>
    </View>
  );
}

/**
 * ModeThreadListView Component
 */
export function ModeThreadListView({
  modeId,
  onThreadPress,
  onStartNewThread,
}: ModeThreadListViewProps) {
  const insets = useSafeAreaInsets();
  const { t } = useLanguage();

  // Get mode info
  const mode = React.useMemo(() => QUICK_ACTIONS.find((a) => a.id === modeId), [modeId]);

  const modeLabel = mode ? t(`quickActions.${mode.id}`, { defaultValue: mode.label }) : modeId;

  const modeIcon = mode?.icon || MessageCircle;

  // Fetch and filter threads
  const { data: allThreads = [] } = useThreads();

  // Filter threads that belong to this mode (check both metadata.mode and project.icon_name)
  // Removed console.log statements that could cause side effects during render
  const modeThreads = React.useMemo(() => {
    return allThreads.filter((thread: Thread) => {
      const threadModeId = getThreadModeId(thread);
      return threadModeId === modeId;
    });
  }, [allThreads, modeId]);

  const sections = React.useMemo(() => groupThreadsByMonth(modeThreads), [modeThreads]);

  const hasThreads = modeThreads.length > 0;

  const ModeIcon = modeIcon;

  return (
    <View className="flex-1">
      <ScrollView
        className="flex-1"
        contentContainerStyle={{
          paddingHorizontal: 16,
          paddingTop: Math.max(insets.top, 16) + 80,
          paddingBottom: 220,
        }}
        showsVerticalScrollIndicator={false}>
        {/* Mode Header */}
        <ModeHeader modeIcon={ModeIcon} modeLabel={modeLabel} />

        {hasThreads ? (
          <View style={{ gap: 24 }}>
            {sections.map((section) => (
              <ThreadSection key={section.id} section={section} onThreadPress={onThreadPress} />
            ))}
          </View>
        ) : (
          <EmptyState modeLabel={modeLabel} />
        )}
      </ScrollView>
    </View>
  );
}
