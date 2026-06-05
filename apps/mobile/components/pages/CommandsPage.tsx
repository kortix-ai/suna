/**
 * CommandsPage — the project's OpenCode slash-commands (web parity:
 * customize/sections commands-view). Lists the commands declared under
 * .kortix/opencode/commands/ and, on tap, shows the command's markdown
 * source. Read-only; authoring flows through a session (to be wired next).
 *
 * Mobile branding: PageHeader chrome, square "thing" avatar, design-system
 * typography + colors.
 */

import React, { useMemo, useState, useCallback } from 'react';
import {
  View,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
} from 'react-native';
import { useColorScheme } from 'nativewind';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Clipboard from 'expo-clipboard';
import {
  SquareSlash,
  Copy,
  Check,
  ChevronRight,
  ChevronLeft,
  Pencil,
  Plus,
} from 'lucide-react-native';
import { Text } from '@/components/ui/text';
import { PageHeader } from '@/components/ui/page-header';
import { PageContent } from '@/components/ui/page-content';
import { SearchListHeader } from '@/components/ui/search-list-header';
import { SelectableMarkdownText } from '@/components/ui/selectable-markdown';
import { useProjectDetail, useProjectFile } from '@/lib/projects/hooks';
import type { ProjectConfigEntry } from '@/lib/projects/projects-client';
import { newConfigPrompt, editConfigPrompt } from '@/lib/projects/configure-prompts';
import { haptics } from '@/lib/haptics';

interface PageTabLike {
  id: string;
  label: string;
  icon: string;
}

interface CommandsPageProps {
  page: PageTabLike;
  projectId: string;
  /** Start an agent-led config session seeded with `prompt` (New / Edit). */
  onConfigure: (prompt: string) => void;
  onOpenDrawer?: () => void;
  onOpenRightDrawer?: () => void;
  isDrawerOpen?: boolean;
  isRightDrawerOpen?: boolean;
}

const MONO = 'Menlo';

/** Strip a leading YAML frontmatter block so we render only the body. */
function stripFrontmatter(src: string): string {
  const m = src.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  return (m ? src.slice(m[0].length) : src).trim();
}

// ─── Command detail (markdown source) ────────────────────────────────────────

function CommandDetail({
  projectId,
  command,
  onBack,
  onConfigure,
}: {
  projectId: string;
  command: ProjectConfigEntry;
  onBack: () => void;
  onConfigure: (prompt: string) => void;
}) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const insets = useSafeAreaInsets();
  const [copied, setCopied] = useState(false);

  const fileQuery = useProjectFile(projectId, command.path);
  const body = useMemo(
    () => stripFrontmatter(fileQuery.data?.content ?? ''),
    [fileQuery.data?.content],
  );

  const fg = isDark ? '#F8F8F8' : '#121215';
  const muted = isDark ? '#9b9b9b' : '#6e6e6e';
  const border = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)';

  const handleCopy = useCallback(async () => {
    if (!fileQuery.data?.content) return;
    haptics.tap();
    await Clipboard.setStringAsync(fileQuery.data.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [fileQuery.data?.content]);

  return (
    <View style={{ flex: 1 }}>
      <TouchableOpacity
        onPress={() => { haptics.tap(); onBack(); }}
        activeOpacity={0.6}
        style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12, gap: 4 }}
      >
        <ChevronLeft size={18} color={muted} />
        <Text style={{ fontSize: 14, fontFamily: 'Roobert', color: muted }}>Commands</Text>
      </TouchableOpacity>

      <View style={{ paddingHorizontal: 16, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: border }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Text style={{ flex: 1, fontSize: 18, fontFamily: MONO, color: fg }} numberOfLines={1}>
            /{command.name}
          </Text>
          <TouchableOpacity
            onPress={handleCopy}
            disabled={!fileQuery.data?.content}
            activeOpacity={0.7}
            style={{
              flexDirection: 'row', alignItems: 'center', gap: 5,
              paddingHorizontal: 10, paddingVertical: 6, borderRadius: 999,
              borderWidth: 1, borderColor: border,
              opacity: fileQuery.data?.content ? 1 : 0.4,
            }}
          >
            {copied ? <Check size={13} color="#22C55E" /> : <Copy size={13} color={muted} />}
            <Text style={{ fontSize: 12, fontFamily: 'Roobert-Medium', color: muted }}>
              {copied ? 'Copied' : 'Copy'}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => { haptics.tap(); onConfigure(editConfigPrompt('command', command.name, command.path)); }}
            activeOpacity={0.7}
            style={{
              flexDirection: 'row', alignItems: 'center', gap: 5,
              paddingHorizontal: 10, paddingVertical: 6, borderRadius: 999,
              borderWidth: 1, borderColor: border,
            }}
          >
            <Pencil size={13} color={muted} />
            <Text style={{ fontSize: 12, fontFamily: 'Roobert-Medium', color: muted }}>Edit</Text>
          </TouchableOpacity>
        </View>

        <Text style={{ fontSize: 11, fontFamily: MONO, color: muted, marginTop: 8 }} numberOfLines={1}>
          {command.path}
        </Text>
      </View>

      {/* Description + source body — scroll together so a long description never
          dominates a fixed header. */}
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 40 }}
        showsVerticalScrollIndicator={false}
      >
        {command.description ? (
          <View style={{ marginBottom: 14 }}>
            <Text style={{ fontSize: 14, lineHeight: 21, color: muted }}>{command.description}</Text>
            <View style={{ height: 1, backgroundColor: border, marginTop: 14 }} />
          </View>
        ) : null}
        {fileQuery.isLoading ? (
          <View style={{ paddingVertical: 40, alignItems: 'center' }}>
            <ActivityIndicator size="small" color={muted} />
          </View>
        ) : fileQuery.isError ? (
          <Text style={{ fontSize: 13, color: '#ef4444' }}>
            {(fileQuery.error as Error)?.message ?? 'Failed to read command source'}
          </Text>
        ) : body ? (
          <SelectableMarkdownText isDark={isDark}>{body}</SelectableMarkdownText>
        ) : (
          <Text style={{ fontSize: 13, color: muted }}>No body.</Text>
        )}
      </ScrollView>
    </View>
  );
}

// ─── Command list row ────────────────────────────────────────────────────────

function CommandRow({
  command,
  onPress,
  isDark,
}: {
  command: ProjectConfigEntry;
  onPress: () => void;
  isDark: boolean;
}) {
  const fg = isDark ? '#F8F8F8' : '#121215';
  const muted = isDark ? '#9b9b9b' : '#6e6e6e';
  const iconBg = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)';

  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.6}
      style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12, gap: 12 }}
    >
      <View style={{ width: 38, height: 38, borderRadius: 10, backgroundColor: iconBg, alignItems: 'center', justifyContent: 'center' }}>
        <SquareSlash size={18} color={muted} />
      </View>

      <View style={{ flex: 1 }}>
        <Text style={{ fontSize: 14, fontFamily: MONO, color: fg }} numberOfLines={1}>
          /{command.name}
        </Text>
        {command.description ? (
          <Text style={{ fontSize: 13, lineHeight: 18, color: muted, marginTop: 3 }} numberOfLines={2}>
            {command.description}
          </Text>
        ) : null}
      </View>

      <ChevronRight size={18} color={muted} />
    </TouchableOpacity>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────

export function CommandsPage({
  page,
  projectId,
  onConfigure,
  onOpenDrawer,
  onOpenRightDrawer,
  isDrawerOpen,
  isRightDrawerOpen,
}: CommandsPageProps) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const insets = useSafeAreaInsets();
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<ProjectConfigEntry | null>(null);

  const { data, isLoading, isError, error, refetch } = useProjectDetail(projectId);

  const bgColor = isDark ? '#090909' : '#FFFFFF';
  const fg = isDark ? '#F8F8F8' : '#121215';
  const muted = isDark ? '#9b9b9b' : '#6e6e6e';
  const border = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)';

  const commands = data?.config?.commands ?? [];

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        (c.description ?? '').toLowerCase().includes(q),
    );
  }, [commands, search]);

  return (
    <View style={{ flex: 1, backgroundColor: bgColor }}>
      <PageHeader
        title={page.label}
        onOpenDrawer={onOpenDrawer}
        onOpenRightDrawer={onOpenRightDrawer}
        isDrawerOpen={isDrawerOpen}
        isRightDrawerOpen={isRightDrawerOpen}
      />

      <PageContent>
      {selected ? (
        <CommandDetail projectId={projectId} command={selected} onBack={() => setSelected(null)} onConfigure={onConfigure} />
      ) : (
        <>
          <SearchListHeader
            value={search}
            onChangeText={setSearch}
            placeholder="Search commands"
            onAdd={() => onConfigure(newConfigPrompt('command'))}
          />

          <ScrollView
            style={{ flex: 1 }}
            contentContainerStyle={{ paddingBottom: insets.bottom + 40 }}
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
          >
            {isLoading ? (
              <View style={{ paddingVertical: 48, alignItems: 'center' }}>
                <ActivityIndicator size="small" color={muted} />
              </View>
            ) : isError ? (
              <View style={{ padding: 24, alignItems: 'center', gap: 12 }}>
                <Text style={{ fontSize: 14, color: muted, textAlign: 'center' }}>
                  {(error as Error)?.message ?? 'Failed to load commands'}
                </Text>
                <TouchableOpacity onPress={() => refetch()} style={{ paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999, borderWidth: 1, borderColor: border }}>
                  <Text style={{ fontSize: 13, fontFamily: 'Roobert-Medium', color: fg }}>Retry</Text>
                </TouchableOpacity>
              </View>
            ) : filtered.length === 0 ? (
              <View style={{ padding: 40, alignItems: 'center', gap: 14 }}>
                <Text style={{ fontSize: 14, color: muted, textAlign: 'center' }}>
                  {commands.length === 0 ? 'No commands in this project yet.' : 'No commands match your search.'}
                </Text>
                {commands.length === 0 && (
                  <TouchableOpacity
                    onPress={() => onConfigure(newConfigPrompt('command'))}
                    activeOpacity={0.7}
                    style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 14, paddingVertical: 9, borderRadius: 999, borderWidth: 1, borderColor: border }}
                  >
                    <Plus size={15} color={fg} />
                    <Text style={{ fontSize: 13, fontFamily: 'Roobert-Medium', color: fg }}>New command</Text>
                  </TouchableOpacity>
                )}
              </View>
            ) : (
              filtered.map((command, i) => (
                <View key={command.path}>
                  <CommandRow
                    command={command}
                    isDark={isDark}
                    onPress={() => { haptics.tap(); setSelected(command); }}
                  />
                  {i < filtered.length - 1 && (
                    <View style={{ height: 1, backgroundColor: border, marginLeft: 66 }} />
                  )}
                </View>
              ))
            )}
          </ScrollView>
        </>
      )}
      </PageContent>
    </View>
  );
}
