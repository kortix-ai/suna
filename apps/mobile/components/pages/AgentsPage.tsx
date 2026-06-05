/**
 * AgentsPage — the project's OpenCode agents (web parity: customize/sections
 * agents-view). Lists the agents declared under .kortix/opencode/agents/ and,
 * on tap, shows the agent's markdown source. Read-only; agent authoring flows
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
  Bot,
  Star,
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
import type { ProjectAgentEntry } from '@/lib/projects/projects-client';
import { newConfigPrompt, editConfigPrompt } from '@/lib/projects/configure-prompts';
import { haptics } from '@/lib/haptics';

interface PageTabLike {
  id: string;
  label: string;
  icon: string;
}

interface AgentsPageProps {
  page: PageTabLike;
  projectId: string;
  /** Start an agent-led config session seeded with `prompt` (New / Edit). */
  onConfigure: (prompt: string) => void;
  onOpenDrawer?: () => void;
  onOpenRightDrawer?: () => void;
  isDrawerOpen?: boolean;
  isRightDrawerOpen?: boolean;
}

/** Strip a leading YAML frontmatter block so we render only the prompt body. */
function stripFrontmatter(src: string): string {
  const m = src.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  return (m ? src.slice(m[0].length) : src).trim();
}

function modeLabel(mode: string | null): string | null {
  if (!mode) return null;
  if (mode === 'primary') return 'Primary';
  if (mode === 'subagent') return 'Subagent';
  return mode.charAt(0).toUpperCase() + mode.slice(1);
}

// ─── Agent detail (markdown source) ──────────────────────────────────────────

function AgentDetail({
  projectId,
  agent,
  isDefault,
  onBack,
  onConfigure,
}: {
  projectId: string;
  agent: ProjectAgentEntry;
  isDefault: boolean;
  onBack: () => void;
  onConfigure: (prompt: string) => void;
}) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const insets = useSafeAreaInsets();
  const [copied, setCopied] = useState(false);

  const fileQuery = useProjectFile(projectId, agent.path);
  const body = useMemo(
    () => stripFrontmatter(fileQuery.data?.content ?? ''),
    [fileQuery.data?.content],
  );

  const fg = isDark ? '#F8F8F8' : '#121215';
  const muted = isDark ? '#9b9b9b' : '#6e6e6e';
  const border = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)';
  const mode = modeLabel(agent.mode);

  const handleCopy = useCallback(async () => {
    if (!fileQuery.data?.content) return;
    haptics.tap();
    await Clipboard.setStringAsync(fileQuery.data.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [fileQuery.data?.content]);

  return (
    <View style={{ flex: 1 }}>
      {/* Back row */}
      <TouchableOpacity
        onPress={() => { haptics.tap(); onBack(); }}
        activeOpacity={0.6}
        style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12, gap: 4 }}
      >
        <ChevronLeft size={18} color={muted} />
        <Text style={{ fontSize: 14, fontFamily: 'Roobert', color: muted }}>Agents</Text>
      </TouchableOpacity>

      {/* Title + meta */}
      <View style={{ paddingHorizontal: 16, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: border }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Text style={{ flex: 1, fontSize: 19, fontFamily: 'Roobert-Medium', color: fg }} numberOfLines={1}>
            {agent.name}
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
            onPress={() => { haptics.tap(); onConfigure(editConfigPrompt('agent', agent.name, agent.path)); }}
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

        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
          {mode && <Badge label={mode} isDark={isDark} />}
          {isDefault && <Badge label="Default" icon="star" isDark={isDark} />}
          <Text style={{ fontSize: 11, fontFamily: 'Menlo', color: muted }} numberOfLines={1}>
            {agent.path}
          </Text>
        </View>
      </View>

      {/* Description + source body — scroll together so a long description never
          dominates a fixed header. */}
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 40 }}
        showsVerticalScrollIndicator={false}
      >
        {agent.description ? (
          <View style={{ marginBottom: 14 }}>
            <Text style={{ fontSize: 14, lineHeight: 21, color: muted }}>{agent.description}</Text>
            <View style={{ height: 1, backgroundColor: border, marginTop: 14 }} />
          </View>
        ) : null}
        {fileQuery.isLoading ? (
          <View style={{ paddingVertical: 40, alignItems: 'center' }}>
            <ActivityIndicator size="small" color={muted} />
          </View>
        ) : fileQuery.isError ? (
          <Text style={{ fontSize: 13, color: '#ef4444' }}>
            {(fileQuery.error as Error)?.message ?? 'Failed to read agent source'}
          </Text>
        ) : body ? (
          <SelectableMarkdownText isDark={isDark}>{body}</SelectableMarkdownText>
        ) : (
          <Text style={{ fontSize: 13, color: muted }}>No prompt body.</Text>
        )}
      </ScrollView>
    </View>
  );
}

function Badge({ label, icon, isDark }: { label: string; icon?: 'star'; isDark: boolean }) {
  const muted = isDark ? '#cfcfcf' : '#444';
  const bg = isDark ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.05)';
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999, backgroundColor: bg }}>
      {icon === 'star' && <Star size={10} color="#F59E0B" fill="#F59E0B" />}
      <Text style={{ fontSize: 11, fontFamily: 'Roobert-Medium', color: muted }}>{label}</Text>
    </View>
  );
}

// ─── Agent list row ──────────────────────────────────────────────────────────

function AgentRow({
  agent,
  isDefault,
  onPress,
  isDark,
}: {
  agent: ProjectAgentEntry;
  isDefault: boolean;
  onPress: () => void;
  isDark: boolean;
}) {
  const fg = isDark ? '#F8F8F8' : '#121215';
  const muted = isDark ? '#9b9b9b' : '#6e6e6e';
  const iconBg = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)';
  const mode = modeLabel(agent.mode);

  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.6}
      style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12, gap: 12 }}
    >
      {/* Square "thing" avatar */}
      <View style={{ width: 38, height: 38, borderRadius: 10, backgroundColor: iconBg, alignItems: 'center', justifyContent: 'center' }}>
        <Bot size={19} color={muted} />
      </View>

      <View style={{ flex: 1 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Text style={{ fontSize: 15, fontFamily: 'Roobert-Medium', color: fg }} numberOfLines={1}>
            {agent.name}
          </Text>
          {isDefault && <Star size={12} color="#F59E0B" fill="#F59E0B" />}
          {mode && (
            <Text style={{ fontSize: 11, fontFamily: 'Roobert', color: muted }}>· {mode}</Text>
          )}
        </View>
        {agent.description ? (
          <Text style={{ fontSize: 13, lineHeight: 18, color: muted, marginTop: 2 }} numberOfLines={2}>
            {agent.description}
          </Text>
        ) : null}
      </View>

      <ChevronRight size={18} color={muted} />
    </TouchableOpacity>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────

export function AgentsPage({
  page,
  projectId,
  onConfigure,
  onOpenDrawer,
  onOpenRightDrawer,
  isDrawerOpen,
  isRightDrawerOpen,
}: AgentsPageProps) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const insets = useSafeAreaInsets();
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<ProjectAgentEntry | null>(null);

  const { data, isLoading, isError, error, refetch } = useProjectDetail(projectId);

  const bgColor = isDark ? '#090909' : '#FFFFFF';
  const fg = isDark ? '#F8F8F8' : '#121215';
  const muted = isDark ? '#9b9b9b' : '#6e6e6e';
  const border = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)';

  const agents = data?.config?.agents ?? [];
  const defaultAgent = data?.config?.open_code_default_agent ?? null;

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return agents;
    return agents.filter(
      (a) =>
        a.name.toLowerCase().includes(q) ||
        (a.description ?? '').toLowerCase().includes(q),
    );
  }, [agents, search]);

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
        <AgentDetail
          projectId={projectId}
          agent={selected}
          isDefault={selected.name === defaultAgent}
          onBack={() => setSelected(null)}
          onConfigure={onConfigure}
        />
      ) : (
        <>
          <SearchListHeader
            value={search}
            onChangeText={setSearch}
            placeholder="Search agents"
            onAdd={() => onConfigure(newConfigPrompt('agent'))}
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
                  {(error as Error)?.message ?? 'Failed to load agents'}
                </Text>
                <TouchableOpacity onPress={() => refetch()} style={{ paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999, borderWidth: 1, borderColor: border }}>
                  <Text style={{ fontSize: 13, fontFamily: 'Roobert-Medium', color: fg }}>Retry</Text>
                </TouchableOpacity>
              </View>
            ) : filtered.length === 0 ? (
              <View style={{ padding: 40, alignItems: 'center' }}>
                <Text style={{ fontSize: 14, color: muted, textAlign: 'center' }}>
                  {agents.length === 0 ? 'No agents in this project yet.' : 'No agents match your search.'}
                </Text>
              </View>
            ) : (
              filtered.map((agent, i) => (
                <View key={agent.path}>
                  <AgentRow
                    agent={agent}
                    isDefault={agent.name === defaultAgent}
                    isDark={isDark}
                    onPress={() => { haptics.tap(); setSelected(agent); }}
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
