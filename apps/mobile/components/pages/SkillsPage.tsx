/**
 * SkillsPage — the project's OpenCode skills (web parity: customize/sections
 * skills-view). Lists the skills declared under .kortix/opencode/skills/ and,
 * on tap, shows the skill's markdown source. Read-only; skill authoring flows
 * through a session (to be wired next).
 *
 * Mobile branding: PageHeader chrome, square "thing" avatar, design-system
 * typography + colors.
 */

import React, { useMemo, useState, useCallback } from 'react';
import {
  View,
  Pressable,
  ScrollView,
  ActivityIndicator,
} from 'react-native';
import { useColorScheme } from 'nativewind';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Clipboard from 'expo-clipboard';
import {
  Sparkles,
  Copy,
  Check,
  ChevronRight,
  ChevronLeft,
  Pencil,
  Plus,
} from 'lucide-react-native';
import { Text } from '@/components/ui/text';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/kortix/page-header';
import { PageContent } from '@/components/kortix/page-content';
import { SearchListHeader } from '@/components/kortix/search-list-header';
import { SelectableMarkdownText } from '@/components/kortix/selectable-markdown';
import { useProjectDetail, useProjectFile } from '@/lib/projects/hooks';
import type { ProjectConfigEntry } from '@/lib/projects/projects-client';
import { newConfigPrompt, editConfigPrompt } from '@/lib/projects/configure-prompts';
import { haptics } from '@/lib/haptics';
import { THEME, withAlpha } from '@/lib/utils/theme';

interface PageTabLike {
  id: string;
  label: string;
  icon: string;
}

interface SkillsPageProps {
  page: PageTabLike;
  projectId: string;
  /** Start an agent-led config session seeded with `prompt` (New / Edit). */
  onConfigure: (prompt: string) => void;
  onOpenDrawer?: () => void;
  onOpenRightDrawer?: () => void;
  isDrawerOpen?: boolean;
  isRightDrawerOpen?: boolean;
}

/** Strip a leading YAML frontmatter block so we render only the body. */
function stripFrontmatter(src: string): string {
  const m = src.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  return (m ? src.slice(m[0].length) : src).trim();
}

// ─── Skill detail (markdown source) ──────────────────────────────────────────

function SkillDetail({
  projectId,
  skill,
  onBack,
  onConfigure,
}: {
  projectId: string;
  skill: ProjectConfigEntry;
  onBack: () => void;
  onConfigure: (prompt: string) => void;
}) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const insets = useSafeAreaInsets();
  const [copied, setCopied] = useState(false);

  const fileQuery = useProjectFile(projectId, skill.path);
  const body = useMemo(
    () => stripFrontmatter(fileQuery.data?.content ?? ''),
    [fileQuery.data?.content],
  );

  const fg = isDark ? THEME.dark.foreground : THEME.light.foreground;
  const muted = isDark ? THEME.dark.mutedForeground : THEME.light.mutedForeground;
  const border = withAlpha(fg, 0.08);
  const destructiveColor = isDark ? THEME.dark.destructive : THEME.light.destructive;

  const handleCopy = useCallback(async () => {
    if (!fileQuery.data?.content) return;
    haptics.tap();
    await Clipboard.setStringAsync(fileQuery.data.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [fileQuery.data?.content]);

  return (
    <View style={{ flex: 1 }}>
      <Pressable
        onPress={() => { haptics.tap(); onBack(); }}
        style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12, gap: 4, opacity: pressed ? 0.6 : 1 })}
      >
        <ChevronLeft size={18} color={muted} />
        <Text style={{ fontSize: 14, fontFamily: 'Roobert', color: muted }}>Skills</Text>
      </Pressable>

      <View style={{ paddingHorizontal: 16, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: border }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Text style={{ flex: 1, fontSize: 19, fontFamily: 'Roobert-Medium', color: fg }} numberOfLines={1}>
            {skill.name}
          </Text>
          <Button
            variant="outline"
            size="sm"
            className="rounded-full"
            onPress={handleCopy}
            disabled={!fileQuery.data?.content}
            style={{ borderColor: border, opacity: fileQuery.data?.content ? 1 : 0.4 }}
          >
            {copied ? <Check size={13} color={THEME.accent.green} /> : <Copy size={13} color={muted} />}
            <Text style={{ fontSize: 12, fontFamily: 'Roobert-Medium', color: muted }}>
              {copied ? 'Copied' : 'Copy'}
            </Text>
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="rounded-full"
            onPress={() => { haptics.tap(); onConfigure(editConfigPrompt('skill', skill.name, skill.path)); }}
            style={{ borderColor: border }}
          >
            <Pencil size={13} color={muted} />
            <Text style={{ fontSize: 12, fontFamily: 'Roobert-Medium', color: muted }}>Edit</Text>
          </Button>
        </View>

        <Text style={{ fontSize: 11, fontFamily: 'Menlo', color: muted, marginTop: 8 }} numberOfLines={1}>
          {skill.path}
        </Text>
      </View>

      {/* Description + source body — scroll together so a long description never
          dominates a fixed header. */}
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 40 }}
        showsVerticalScrollIndicator={false}
      >
        {skill.description ? (
          <View style={{ marginBottom: 14 }}>
            <Text style={{ fontSize: 14, lineHeight: 21, color: muted }}>{skill.description}</Text>
            <View style={{ height: 1, backgroundColor: border, marginTop: 14 }} />
          </View>
        ) : null}
        {fileQuery.isLoading ? (
          <View style={{ paddingVertical: 40, alignItems: 'center' }}>
            <ActivityIndicator size="small" color={muted} />
          </View>
        ) : fileQuery.isError ? (
          <Text style={{ fontSize: 13, color: destructiveColor }}>
            {(fileQuery.error as Error)?.message ?? 'Failed to read skill source'}
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

// ─── Skill list row ──────────────────────────────────────────────────────────

function SkillRow({
  skill,
  onPress,
  isDark,
}: {
  skill: ProjectConfigEntry;
  onPress: () => void;
  isDark: boolean;
}) {
  const fg = isDark ? THEME.dark.foreground : THEME.light.foreground;
  const muted = isDark ? THEME.dark.mutedForeground : THEME.light.mutedForeground;
  const iconBg = withAlpha(fg, isDark ? 0.06 : 0.04);

  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12, gap: 12, opacity: pressed ? 0.6 : 1 })}
    >
      <View style={{ width: 38, height: 38, borderRadius: 10, backgroundColor: iconBg, alignItems: 'center', justifyContent: 'center' }}>
        <Sparkles size={18} color={muted} />
      </View>

      <View style={{ flex: 1 }}>
        <Text style={{ fontSize: 15, fontFamily: 'Roobert-Medium', color: fg }} numberOfLines={1}>
          {skill.name}
        </Text>
        {skill.description ? (
          <Text style={{ fontSize: 13, lineHeight: 18, color: muted, marginTop: 2 }} numberOfLines={2}>
            {skill.description}
          </Text>
        ) : null}
      </View>

      <ChevronRight size={18} color={muted} />
    </Pressable>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────

export function SkillsPage({
  page,
  projectId,
  onConfigure,
  onOpenDrawer,
  onOpenRightDrawer,
  isDrawerOpen,
  isRightDrawerOpen,
}: SkillsPageProps) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const insets = useSafeAreaInsets();
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<ProjectConfigEntry | null>(null);

  const { data, isLoading, isError, error, refetch } = useProjectDetail(projectId);

  const bgColor = isDark ? THEME.dark.background : THEME.light.background;
  const fg = isDark ? THEME.dark.foreground : THEME.light.foreground;
  const muted = isDark ? THEME.dark.mutedForeground : THEME.light.mutedForeground;
  const border = withAlpha(fg, 0.08);

  const skills = data?.config?.skills ?? [];

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return skills;
    return skills.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        (s.description ?? '').toLowerCase().includes(q),
    );
  }, [skills, search]);

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
        <SkillDetail projectId={projectId} skill={selected} onBack={() => setSelected(null)} onConfigure={onConfigure} />
      ) : (
        <>
          <SearchListHeader
            value={search}
            onChangeText={setSearch}
            placeholder="Search skills"
            onAdd={() => onConfigure(newConfigPrompt('skill'))}
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
                  {(error as Error)?.message ?? 'Failed to load skills'}
                </Text>
                <Button variant="outline" size="sm" className="rounded-full" onPress={() => { haptics.tap(); refetch(); }} style={{ borderColor: border }}>
                  <Text style={{ fontSize: 13, fontFamily: 'Roobert-Medium', color: fg }}>Retry</Text>
                </Button>
              </View>
            ) : filtered.length === 0 ? (
              <View style={{ padding: 40, alignItems: 'center', gap: 14 }}>
                <Text style={{ fontSize: 14, color: muted, textAlign: 'center' }}>
                  {skills.length === 0 ? 'No skills in this project yet.' : 'No skills match your search.'}
                </Text>
                {skills.length === 0 && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="rounded-full"
                    onPress={() => { haptics.tap(); onConfigure(newConfigPrompt('skill')); }}
                    style={{ borderColor: border }}
                  >
                    <Plus size={15} color={fg} />
                    <Text style={{ fontSize: 13, fontFamily: 'Roobert-Medium', color: fg }}>New skill</Text>
                  </Button>
                )}
              </View>
            ) : (
              filtered.map((skill, i) => (
                <View key={skill.path}>
                  <SkillRow
                    skill={skill}
                    isDark={isDark}
                    onPress={() => { haptics.tap(); setSelected(skill); }}
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
