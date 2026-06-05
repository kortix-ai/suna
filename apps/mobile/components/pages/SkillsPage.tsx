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
  TouchableOpacity,
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
} from 'lucide-react-native';
import { Text } from '@/components/ui/text';
import { PageHeader } from '@/components/ui/page-header';
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
        <Text style={{ fontSize: 14, fontFamily: 'Roobert', color: muted }}>Skills</Text>
      </TouchableOpacity>

      <View style={{ paddingHorizontal: 16, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: border }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Text style={{ flex: 1, fontSize: 19, fontFamily: 'Roobert-Medium', color: fg }} numberOfLines={1}>
            {skill.name}
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
            onPress={() => { haptics.tap(); onConfigure(editConfigPrompt('skill', skill.name, skill.path)); }}
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

        <Text style={{ fontSize: 11, fontFamily: 'Menlo', color: muted, marginTop: 8 }} numberOfLines={1}>
          {skill.path}
        </Text>

        {skill.description ? (
          <Text style={{ fontSize: 14, lineHeight: 20, color: muted, marginTop: 10 }}>
            {skill.description}
          </Text>
        ) : null}
      </View>

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 40 }}
        showsVerticalScrollIndicator={false}
      >
        {fileQuery.isLoading ? (
          <View style={{ paddingVertical: 40, alignItems: 'center' }}>
            <ActivityIndicator size="small" color={muted} />
          </View>
        ) : fileQuery.isError ? (
          <Text style={{ fontSize: 13, color: '#ef4444' }}>
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
    </TouchableOpacity>
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

  const bgColor = isDark ? '#090909' : '#FFFFFF';
  const fg = isDark ? '#F8F8F8' : '#121215';
  const muted = isDark ? '#9b9b9b' : '#6e6e6e';
  const border = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)';

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
        paddingBottom={12}
      />

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
                <TouchableOpacity onPress={() => refetch()} style={{ paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999, borderWidth: 1, borderColor: border }}>
                  <Text style={{ fontSize: 13, fontFamily: 'Roobert-Medium', color: fg }}>Retry</Text>
                </TouchableOpacity>
              </View>
            ) : filtered.length === 0 ? (
              <View style={{ padding: 40, alignItems: 'center' }}>
                <Text style={{ fontSize: 14, color: muted, textAlign: 'center' }}>
                  {skills.length === 0 ? 'No skills in this project yet.' : 'No skills match your search.'}
                </Text>
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
    </View>
  );
}
