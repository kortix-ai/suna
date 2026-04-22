/**
 * MentionSuggestions — dropdown list that appears above the input
 * when the user types "@" in SessionChatInput.
 *
 * Visual styling mirrors the web MentionPopover
 * (apps/web/src/components/session/session-chat-input.tsx):
 *   - Neutral muted icons (no category tint)
 *   - @ badge for agents, MessageSquare for sessions, file-type icons for files
 *   - Section headers: 10px uppercase, muted-foreground/50
 *   - Selected row: bg-accent / text-accent-foreground
 */

import React from 'react';
import {
  View,
  Pressable,
  Platform,
  ScrollView,
} from 'react-native';
import { Text } from '@/components/ui/text';
import { Icon } from '@/components/ui/icon';
import { useColorScheme } from 'nativewind';
import { MessageSquare, Folder, Loader } from 'lucide-react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
  Easing,
  cancelAnimation,
} from 'react-native-reanimated';
import { getFileIconComponent } from '@/components/files/FileItem';
import type { MentionItem } from './useMentions';

// ─── Constants ───────────────────────────────────────────────────────────────

const CATEGORY_LABELS: Record<MentionItem['kind'], string> = {
  agent: 'Agents',
  session: 'Sessions',
  file: 'Files',
};

const KIND_ORDER: MentionItem['kind'][] = ['agent', 'session', 'file'];

// ─── Component ───────────────────────────────────────────────────────────────

interface MentionSuggestionsProps {
  items: MentionItem[];
  selectedIndex: number;
  isLoading?: boolean;
  onSelect: (item: MentionItem) => void;
}

export function MentionSuggestions({
  items,
  selectedIndex,
  isLoading,
  onSelect,
}: MentionSuggestionsProps) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';

  // Theme tokens — mirror web's bg-popover / border-border/60 / bg-accent / muted-foreground
  const bgColor = isDark ? '#1F1F1F' : '#FFFFFF';
  const borderColor = isDark ? 'rgba(58,58,58,0.6)' : 'rgba(220,221,222,0.6)';
  const fgColor = isDark ? '#EBEBEB' : '#121215';
  const mutedFg = isDark ? 'rgba(235,235,235,0.5)' : 'rgba(18,18,21,0.5)';
  const mutedFg35 = isDark ? 'rgba(235,235,235,0.35)' : 'rgba(18,18,21,0.35)';
  const accentBg = isDark ? '#212121' : '#E5E7EB';
  const iconMuted = isDark ? 'rgba(235,235,235,0.5)' : 'rgba(18,18,21,0.5)';
  const agentBadgeBg = isDark ? 'rgba(235,235,235,0.1)' : 'rgba(18,18,21,0.08)';
  const agentBadgeFg = isDark ? 'rgba(235,235,235,0.6)' : 'rgba(18,18,21,0.6)';

  // Hooks must run on every render — declare before any early return.
  const spin = useSharedValue(0);
  React.useEffect(() => {
    if (!isLoading) {
      cancelAnimation(spin);
      spin.value = 0;
      return;
    }
    spin.value = 0;
    spin.value = withRepeat(
      withTiming(1, { duration: 900, easing: Easing.linear }),
      -1,
      false,
    );
    return () => {
      cancelAnimation(spin);
    };
  }, [isLoading, spin]);
  const spinnerStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${spin.value * 360}deg` }],
  }));

  if (items.length === 0 && !isLoading) return null;

  // Group items by kind preserving canonical order
  const groups: { kind: MentionItem['kind']; entries: { item: MentionItem; globalIdx: number }[] }[] = [];
  for (const kind of KIND_ORDER) {
    const entries: { item: MentionItem; globalIdx: number }[] = [];
    items.forEach((item, originalIdx) => {
      if (item.kind === kind) entries.push({ item, globalIdx: originalIdx });
    });
    if (entries.length > 0) groups.push({ kind, entries });
  }
  // Re-index so the visual order matches selectedIndex expectations
  let running = 0;
  for (const group of groups) {
    for (const entry of group.entries) {
      entry.globalIdx = running++;
    }
  }

  return (
    <View
      style={{
        backgroundColor: bgColor,
        borderWidth: 1,
        borderColor,
        borderRadius: 8,
        marginHorizontal: 16,
        marginBottom: 8,
        maxHeight: 288,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: -4 },
        shadowOpacity: isDark ? 0.3 : 0.08,
        shadowRadius: 12,
        elevation: 8,
        overflow: 'hidden',
      }}
    >
      <ScrollView
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="always"
        contentContainerStyle={{ paddingVertical: 4 }}
      >
        {groups.map((group) => (
          <View key={group.kind}>
            {/* Section header — web: px-3 py-1 text-[10px] font-semibold text-muted-foreground/50 uppercase tracking-wider */}
            <Text
              style={{
                color: mutedFg,
                fontSize: 10,
                fontFamily: 'Roobert-SemiBold',
                textTransform: 'uppercase',
                letterSpacing: 1,
                paddingHorizontal: 12,
                paddingTop: 6,
                paddingBottom: 2,
              }}
            >
              {CATEGORY_LABELS[group.kind]}
            </Text>

            {group.entries.map(({ item, globalIdx: gi }) => {
              const isSelected = gi === selectedIndex;
              return (
                <MentionRow
                  key={`${item.kind}-${gi}-${item.label}`}
                  item={item}
                  isSelected={isSelected}
                  onPress={() => onSelect(item)}
                  accentBg={accentBg}
                  fgColor={fgColor}
                  mutedFg={mutedFg}
                  mutedFg35={mutedFg35}
                  iconMuted={iconMuted}
                  agentBadgeBg={agentBadgeBg}
                  agentBadgeFg={agentBadgeFg}
                />
              );
            })}
          </View>
        ))}

        {/* Loading indicator for file search */}
        {isLoading && items.filter((i) => i.kind === 'file').length === 0 && (
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 8,
              paddingHorizontal: 12,
              paddingVertical: 8,
            }}
          >
            <Animated.View style={spinnerStyle}>
              <Icon as={Loader} size={14} color={mutedFg} strokeWidth={2} />
            </Animated.View>
            <Text style={{ color: mutedFg, fontSize: 12, fontFamily: 'Roobert' }}>
              Searching…
            </Text>
          </View>
        )}
      </ScrollView>
    </View>
  );
}

// ─── Row ─────────────────────────────────────────────────────────────────────

function MentionRow({
  item,
  isSelected,
  onPress,
  accentBg,
  fgColor,
  mutedFg,
  mutedFg35,
  iconMuted,
  agentBadgeBg,
  agentBadgeFg,
}: {
  item: MentionItem;
  isSelected: boolean;
  onPress: () => void;
  accentBg: string;
  fgColor: string;
  mutedFg: string;
  mutedFg35: string;
  iconMuted: string;
  agentBadgeBg: string;
  agentBadgeFg: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingHorizontal: 12,
        paddingVertical: 6,
        backgroundColor: isSelected ? accentBg : pressed ? accentBg : 'transparent',
      })}
    >
      {renderLeadingIcon(item, iconMuted, agentBadgeBg, agentBadgeFg)}
      {renderLabel(item, fgColor, mutedFg35)}
    </Pressable>
  );
}

// ─── Leading icon (matches web variants) ─────────────────────────────────────

function renderLeadingIcon(
  item: MentionItem,
  iconMuted: string,
  agentBadgeBg: string,
  agentBadgeFg: string,
) {
  if (item.kind === 'agent') {
    // Web: <span className="size-4 rounded bg-foreground/10 text-foreground/60 text-[10px] font-semibold">@</span>
    return (
      <View
        style={{
          width: 16,
          height: 16,
          borderRadius: 4,
          backgroundColor: agentBadgeBg,
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
        }}
      >
        <Text
          style={{
            color: agentBadgeFg,
            fontSize: 10,
            fontFamily: 'Roobert-SemiBold',
            lineHeight: 12,
          }}
        >
          @
        </Text>
      </View>
    );
  }

  if (item.kind === 'session') {
    return (
      <Icon as={MessageSquare} size={16} color={iconMuted} strokeWidth={2} />
    );
  }

  // File — re-use the same monochrome mapping as the files browser.
  const filePath = item.value || item.label;
  const isDir = filePath.endsWith('/');
  const cleanPath = isDir ? filePath.slice(0, -1) : filePath;
  const fileName = cleanPath.split('/').pop() || cleanPath;

  if (isDir) {
    return <Icon as={Folder} size={16} color={iconMuted} strokeWidth={2} />;
  }

  const IconComponent = getFileIconComponent({
    name: fileName,
    path: cleanPath,
    type: 'file',
  } as any);
  return <Icon as={IconComponent} size={16} color={iconMuted} strokeWidth={2} />;
}

// ─── Label / description (matches web layout per kind) ───────────────────────

function renderLabel(item: MentionItem, fgColor: string, mutedFg35: string) {
  if (item.kind === 'agent') {
    return (
      <View style={{ flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Text
          style={{
            color: fgColor,
            fontSize: 14,
            fontFamily: 'Roobert-Medium',
            textTransform: 'capitalize',
            flexShrink: 1,
          }}
          numberOfLines={1}
        >
          {item.label}
        </Text>
        {item.description ? (
          <Text
            style={{
              color: mutedFg35,
              fontSize: 10,
              fontFamily: 'Roobert',
              flexShrink: 1,
            }}
            numberOfLines={1}
          >
            {item.description}
          </Text>
        ) : null}
      </View>
    );
  }

  if (item.kind === 'session') {
    return (
      <View style={{ flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center' }}>
        <Text
          style={{
            color: fgColor,
            fontSize: 14,
            fontFamily: 'Roobert-Medium',
            flexShrink: 1,
          }}
          numberOfLines={1}
        >
          {item.label}
        </Text>
        {item.description ? (
          <Text
            style={{
              color: mutedFg35,
              fontSize: 10,
              fontFamily: 'Roobert',
              marginLeft: 'auto',
              paddingLeft: 8,
            }}
            numberOfLines={1}
          >
            {item.description}
          </Text>
        ) : null}
      </View>
    );
  }

  // File: "filename.ext  /rel/path/to/file"
  const filePath = item.value || item.label;
  const isDir = filePath.endsWith('/');
  const cleanPath = isDir ? filePath.slice(0, -1) : filePath;
  const fileName = cleanPath.split('/').pop() || cleanPath;
  const displayPath = cleanPath.replace(/^\/workspace\//, '');

  return (
    <View
      style={{
        flex: 1,
        minWidth: 0,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
      }}
    >
      <Text
        style={{
          color: fgColor,
          fontSize: 14,
          fontFamily: 'Roobert-Medium',
          flexShrink: 0,
          maxWidth: '55%',
        }}
        numberOfLines={1}
      >
        {fileName}
      </Text>
      <Text
        style={{
          color: mutedFg35,
          fontSize: 10,
          fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }),
          flex: 1,
          minWidth: 0,
          textAlign: 'left',
        }}
        numberOfLines={1}
      >
        {displayPath}
      </Text>
    </View>
  );
}
