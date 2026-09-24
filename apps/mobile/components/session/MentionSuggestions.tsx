/**
 * The suggestion list above the chat input: `@` mentions, `#` skills, and `/`
 * commands (Jay, 2026-09-24).
 *
 * One look for all three, the `Composer` card's: `rounded-3xl border
 * border-border bg-background p-2`, on the composer's 16pt edge, no shadow.
 * Rows are the question prompt's option rows — 16pt label, radius 16, the
 * `secondary` fill when highlighted or pressed. No section headers, no
 * descriptions. A mention keeps one muted glyph (agent, session, folder, file
 * type, skill) so the kinds stay apart; a file adds its folder, muted.
 */

import React from 'react';
import { ScrollView, View } from 'react-native';
import { useColorScheme } from 'nativewind';
import { PressableSurface } from '@/components/kortix/pressable-surface';
import { KortixLoader } from '@/components/kortix/kortix-loader';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { getFileIconComponent } from '@/components/files/FileItem';
import {
  ChatIcon as MessageSquare,
  FolderIcon as Folder,
  RobotIcon as Robot,
  SparkleIcon as Sparkle,
} from '@/lib/icons';
import type { AppIcon } from '@/lib/icons';
import { THEME } from '@/lib/utils/theme';
import type { MentionItem } from './useMentions';

/** About five rows, then the list scrolls. */
const MAX_LIST_HEIGHT = 260;

// ─── Shared card + row ───────────────────────────────────────────────────────

/** The composer card, floating above the input on the composer's edge. */
export function SuggestionCard({ children }: { children: React.ReactNode }) {
  return (
    <View className="mx-4 mb-2 overflow-hidden rounded-3xl border border-border bg-background">
      <ScrollView
        style={{ maxHeight: MAX_LIST_HEIGHT }}
        keyboardShouldPersistTaps="always"
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ padding: 8 }}
      >
        {children}
      </ScrollView>
    </View>
  );
}

export function SuggestionRow({
  label,
  detail,
  icon,
  selected,
  onPress,
}: {
  label: string;
  /** One muted line after the label (a file's folder). */
  detail?: string;
  icon?: React.ReactNode;
  selected: boolean;
  onPress: () => void;
}) {
  const { colorScheme } = useColorScheme();
  const colors = THEME[colorScheme === 'dark' ? 'dark' : 'light'];
  return (
    <PressableSurface
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        paddingHorizontal: 12,
        paddingVertical: 10,
        borderRadius: 16,
        backgroundColor: selected || pressed ? colors.secondary : 'transparent',
      })}
    >
      {icon}
      <Text className="shrink leading-6" numberOfLines={1}>
        {label}
      </Text>
      {detail ? (
        <Text variant="muted" className="flex-1" numberOfLines={1}>
          {detail}
        </Text>
      ) : null}
    </PressableSurface>
  );
}

// ─── Mentions and skills ─────────────────────────────────────────────────────

// Kinds never interleave: the list shows agents, then sessions, then files.
// `skill` only ever comes from `useSkillMentions.ts`'s own `#` list.
const KIND_ORDER: MentionItem['kind'][] = ['agent', 'session', 'file', 'skill'];

interface MentionSuggestionsProps {
  items: MentionItem[];
  selectedIndex: number;
  isLoading?: boolean;
  onSelect: (item: MentionItem) => void;
}

export function MentionSuggestions({ items, selectedIndex, isLoading, onSelect }: MentionSuggestionsProps) {
  if (items.length === 0 && !isLoading) return null;

  // Canonical kind order; `selectedIndex` counts rows in this visual order.
  const ordered = KIND_ORDER.flatMap((kind) => items.filter((item) => item.kind === kind));
  const searchingFiles = isLoading && !items.some((item) => item.kind === 'file');

  return (
    <SuggestionCard>
      {ordered.map((item, index) => {
        const { label, detail, icon } = mentionRowContent(item);
        return (
          <SuggestionRow
            key={`${item.kind}-${index}-${item.label}`}
            label={label}
            detail={detail}
            icon={<Icon as={icon} size={18} className="text-muted-foreground" />}
            selected={index === selectedIndex}
            onPress={() => onSelect(item)}
          />
        );
      })}
      {searchingFiles ? (
        <View className="flex-row items-center gap-2 px-3 py-2.5">
          <KortixLoader customSize={16} />
          <Text variant="muted">Searching files</Text>
        </View>
      ) : null}
    </SuggestionCard>
  );
}

function mentionRowContent(item: MentionItem): { label: string; detail?: string; icon: AppIcon } {
  if (item.kind === 'agent') return { label: item.label, icon: Robot };
  if (item.kind === 'session') return { label: item.label, icon: MessageSquare };
  if (item.kind === 'skill') return { label: item.label, icon: Sparkle };

  const filePath = item.value || item.label;
  const isDir = filePath.endsWith('/');
  const cleanPath = (isDir ? filePath.slice(0, -1) : filePath).replace(/^\/workspace\//, '');
  const slash = cleanPath.lastIndexOf('/');
  const name = slash === -1 ? cleanPath : cleanPath.slice(slash + 1);
  const folder = slash === -1 ? undefined : cleanPath.slice(0, slash);
  const icon = isDir
    ? Folder
    : (getFileIconComponent({ name, path: cleanPath, type: 'file' } as never) as AppIcon);
  return { label: name, detail: folder, icon };
}
