/**
 * WorkspacePage — browse all workspace items (agents, skills, commands, projects, tools, MCP).
 *
 * Mirrors the frontend /workspace page with mobile-native UI:
 * - Kind filter chips (All, Projects, Agents, Skills, Commands, Tools, MCP)
 * - Scope sub-filter pills (Project, Global, External, Built-in)
 * - Search across name / description / meta
 * - Tap item → bottom sheet with full detail view
 * - Quick actions section for creating new items
 */

import React, { useState, useMemo, useCallback, useRef, forwardRef, useImperativeHandle } from 'react';
import {
  View,
  TouchableOpacity,
  FlatList,
  TextInput,
  Pressable,
  RefreshControl,
  ScrollView,
  ActivityIndicator,
} from 'react-native';
import { Text } from '@/components/ui/text';
import { Text as RNText } from 'react-native';
import {
  Search,
  X,
  Bot,
  Sparkles,
  Terminal,
  FolderOpen,
  Wrench,
  Plug,
  Link as LinkIcon,
  ChevronRight,
  Copy,
  Check,
  FileText,
  Blocks,
  ArrowUpRight,
} from 'lucide-react-native';
import { useColorScheme } from 'nativewind';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import * as Clipboard from 'expo-clipboard';
import {
  BottomSheetModal,
  BottomSheetView,
  BottomSheetBackdrop,
  BottomSheetScrollView,
} from '@gorhom/bottom-sheet';

import { useThemeColors, getSheetBg } from '@/lib/theme-colors';
import { useSandboxContext } from '@/contexts/SandboxContext';
import type { PageTab } from '@/stores/tab-store';
import { PageHeader } from '@/components/ui/page-header';
import { PageContent } from '@/components/ui/page-content';
import {
  useOpenCodeAgents,
  useOpenCodeCommands,
  useOpenCodeSkills,
  useOpenCodeProjects,
  useOpenCodeToolIds,
  useOpenCodeMcpStatus,
  type Agent,
  type Skill,
  type Command,
  type Project,
  type McpStatus,
} from '@/lib/opencode/hooks/use-opencode-data';
import { useKortixConnectors, type KortixConnector } from '@/lib/kortix';
import { WorkspaceSettingsSheet, type WorkspaceSettingsSheetRef } from './WorkspaceSettingsSheet';

// ─── Types ──────────────────────────────────────────────────────────────────

type ItemKind = 'project' | 'agent' | 'skill' | 'command' | 'tool' | 'mcp' | 'connector';
type ItemScope = 'project' | 'global' | 'external' | 'built-in';
type KindFilter = 'all' | ItemKind;

interface WorkspaceItem {
  id: string;
  name: string;
  description?: string;
  kind: ItemKind;
  scope: ItemScope;
  meta?: string;
  raw?: Agent | Skill | Command | Project | KortixConnector | { toolId: string; server?: string } | { serverName: string; status: McpStatus };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function getSkillSource(location: string): 'project' | 'global' | 'external' {
  if (location.includes('.opencode/skill') || location.includes('.opencode/skills')) return 'project';
  if (location.includes('/global/') || location.includes('/.config/')) return 'global';
  return 'external';
}

function mcpToolName(id: string): string {
  return id.startsWith('mcp_') ? id.split('_').slice(2).join('_') : id;
}
function mcpServerName(id: string): string | undefined {
  return id.startsWith('mcp_') ? id.split('_')[1] : undefined;
}

function commandScope(source?: string): ItemScope {
  if (!source || source === 'command') return 'project';
  return 'external';
}

const KIND_CONFIG: Record<ItemKind, { label: string; iconName: string }> = {
  project: { label: 'Project', iconName: 'folder-open' },
  agent: { label: 'Agent', iconName: 'bot' },
  skill: { label: 'Skill', iconName: 'sparkles' },
  command: { label: 'Command', iconName: 'terminal' },
  tool: { label: 'Tool', iconName: 'wrench' },
  mcp: { label: 'MCP', iconName: 'plug' },
  connector: { label: 'Connector', iconName: 'link' },
};

const SCOPE_LABEL: Record<ItemScope, string> = {
  project: 'Project',
  global: 'Global',
  external: 'External',
  'built-in': 'Built-in',
};

const KIND_ICON_MAP: Record<ItemKind, React.ComponentType<any>> = {
  project: FolderOpen,
  agent: Bot,
  skill: Sparkles,
  command: Terminal,
  tool: Wrench,
  mcp: Plug,
  connector: LinkIcon,
};

// ─── Kind filter chips ──────────────────────────────────────────────────────

const KIND_TABS: { value: KindFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'project', label: 'Projects' },
  { value: 'agent', label: 'Agents' },
  { value: 'skill', label: 'Skills' },
  { value: 'command', label: 'Commands' },
  { value: 'tool', label: 'Tools' },
  { value: 'mcp', label: 'MCP' },
  { value: 'connector', label: 'Connectors' },
];

// ─── Quick action presets (same as frontend) ────────────────────────────────

const COMPOSER_PRESETS: Record<string, { title: string; prompt: string }> = {
  agent:   { title: 'New agent',   prompt: "HEY let's build a new agent. Ask what job it should own, then scaffold it in the right workspace location and wire up any supporting skills." },
  skill:   { title: 'New skill',   prompt: "HEY let's build a new skill. Ask what should trigger it, then create the SKILL.md and any supporting files in the right workspace location." },
  command: { title: 'New command', prompt: "HEY let's build a new slash command. Ask what the command should do, then add it in the right workspace location and connect it to the correct agent." },
  project: { title: 'New project', prompt: "HEY let's set up a new project. Ask for the name and purpose, then create it in the right workspace location with a clean starting structure." },
};

// ─── Props ──────────────────────────────────────────────────────────────────

export interface WorkspacePageRef {
  refetch: () => void;
  openSettings: (tab?: 'general' | 'providers' | 'permissions' | 'mcp') => void;
}

interface WorkspacePageProps {
  page: PageTab;
  onBack: () => void;
  onOpenDrawer?: () => void;
  onOpenRightDrawer?: () => void;
  isDrawerOpen?: boolean;
  isRightDrawerOpen?: boolean;
  onCreateSessionWithPrompt?: (title: string, prompt: string) => void;
}

// ─── Component ──────────────────────────────────────────────────────────────

export const WorkspacePage = forwardRef<WorkspacePageRef, WorkspacePageProps>(function WorkspacePage({ page, onBack, onOpenDrawer, onOpenRightDrawer, isDrawerOpen, isRightDrawerOpen, onCreateSessionWithPrompt }, ref) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const insets = useSafeAreaInsets();
  const theme = useThemeColors();
  const { sandboxUrl } = useSandboxContext();

  const fg = isDark ? '#F8F8F8' : '#121215';
  const bg = isDark ? '#121215' : '#F8F8F8';
  const muted = isDark ? 'rgba(255,255,255,0.4)' : 'rgba(0,0,0,0.4)';
  const inputBg = isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.03)';
  const cardBg = isDark ? 'rgba(255,255,255,0.03)' : '#FFFFFF';
  const borderColor = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)';
  const chipBg = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)';
  const chipActiveBg = theme.primary;
  const chipActiveFg = theme.primaryForeground;

  // State
  const [searchQuery, setSearchQuery] = useState('');
  const [kindFilter, setKindFilter] = useState<KindFilter>('all');
  const [selectedItem, setSelectedItem] = useState<WorkspaceItem | null>(null);
  const detailSheetRef = useRef<BottomSheetModal>(null);
  const settingsSheetRef = useRef<WorkspaceSettingsSheetRef>(null);

  // Data
  const { data: agents, isLoading: lAgents, refetch: rAgents } = useOpenCodeAgents(sandboxUrl);
  const { data: skills, isLoading: lSkills, refetch: rSkills } = useOpenCodeSkills(sandboxUrl);
  const { data: commands, isLoading: lCommands, refetch: rCommands } = useOpenCodeCommands(sandboxUrl);
  const { data: projects, isLoading: lProjects, refetch: rProjects } = useOpenCodeProjects(sandboxUrl);
  const { data: toolIds, isLoading: lTools, refetch: rTools } = useOpenCodeToolIds(sandboxUrl);
  const { data: mcpStatus, isLoading: lMcp, refetch: rMcp } = useOpenCodeMcpStatus(sandboxUrl);
  const { data: connectors, isLoading: lConnectors, refetch: rConnectors } = useKortixConnectors(sandboxUrl);

  const isLoading = lAgents || lSkills || lCommands || lProjects || lTools || lMcp || lConnectors;

  const refetchAll = useCallback(async () => {
    await Promise.all([rAgents(), rSkills(), rCommands(), rProjects(), rTools(), rMcp(), rConnectors()]);
  }, [rAgents, rSkills, rCommands, rProjects, rTools, rMcp, rConnectors]);

  // Build unified items list (same logic as frontend)
  const allItems = useMemo<WorkspaceItem[]>(() => {
    const items: WorkspaceItem[] = [];

    if (projects && Array.isArray(projects)) {
      const sorted = [...projects].sort((a, b) => {
        const ag = a.id === 'global' || a.worktree === '/';
        const bg2 = b.id === 'global' || b.worktree === '/';
        if (ag && !bg2) return -1;
        if (!ag && bg2) return 1;
        return (b.time?.updated ?? 0) - (a.time?.updated ?? 0);
      });
      for (const p of sorted) {
        const name = p.name || (p.worktree === '/' || p.id === 'global' ? 'Global' : p.worktree.split('/').pop() || p.worktree);
        items.push({
          id: `project:${p.id}`,
          name,
          description: p.worktree && p.worktree !== '/' ? p.worktree : undefined,
          kind: 'project',
          scope: p.id === 'global' || p.worktree === '/' ? 'global' : 'project',
          raw: p,
        });
      }
    }

    agents?.forEach((a) => {
      items.push({ id: `agent:${a.name}`, name: a.name, description: a.description, kind: 'agent', scope: 'project', meta: a.model?.modelID, raw: a });
    });

    skills?.forEach((s) => {
      const src = getSkillSource(s.location);
      const scope: ItemScope = src === 'project' ? 'project' : src === 'global' ? 'global' : 'external';
      items.push({ id: `skill:${s.name}`, name: s.name, description: s.description, kind: 'skill', scope, raw: s });
    });

    commands?.filter((c) => !c.subtask).forEach((c) => {
      items.push({ id: `command:${c.name}`, name: `/${c.name}`, description: c.description, kind: 'command', scope: commandScope(c.source), meta: c.agent, raw: c });
    });

    if (toolIds) {
      [...new Set(toolIds)].filter((id) => !id.startsWith('_') && !id.startsWith('.')).forEach((id) => {
        const isMcp = id.startsWith('mcp_');
        items.push({ id: `tool:${id}`, name: isMcp ? mcpToolName(id) : id, kind: 'tool', scope: isMcp ? 'external' : 'built-in', meta: isMcp ? mcpServerName(id) : undefined, raw: { toolId: id, server: isMcp ? mcpServerName(id) : undefined } });
      });
    }

    if (mcpStatus) {
      Object.entries(mcpStatus).filter(([, s]) => s.status !== 'disabled').forEach(([name, status]) => {
        const label = status.status === 'connected' ? 'Connected' : status.status === 'failed' ? 'Failed' : status.status === 'needs_auth' ? 'Needs Auth' : 'Pending';
        items.push({ id: `mcp:${name}`, name, description: status.status === 'failed' ? status.error : undefined, kind: 'mcp', scope: 'external', meta: label, raw: { serverName: name, status } });
      });
    }

    if (connectors && Array.isArray(connectors)) {
      for (const c of connectors) {
        items.push({
          id: `connector:${c.id}`,
          name: c.name,
          description: c.description || undefined,
          kind: 'connector',
          scope: 'project',
          meta: c.source || 'custom',
          raw: c,
        });
      }
    }

    return items;
  }, [projects, agents, skills, commands, toolIds, mcpStatus, connectors]);

  // Kind counts
  const kindCounts = useMemo(() => {
    const c: Record<KindFilter, number> = { all: allItems.length, project: 0, agent: 0, skill: 0, command: 0, tool: 0, mcp: 0, connector: 0 };
    allItems.forEach((i) => c[i.kind]++);
    return c;
  }, [allItems]);

  // Expose refetch and openSettings for BottomBar menu
  useImperativeHandle(ref, () => ({
    refetch: refetchAll,
    openSettings: (tab) => settingsSheetRef.current?.present(tab),
  }), [refetchAll]);

  // Filtered items
  const filteredItems = useMemo(() => {
    let r = allItems;
    if (kindFilter !== 'all') r = r.filter((i) => i.kind === kindFilter);
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase().trim();
      r = r.filter((i) => i.name.toLowerCase().includes(q) || i.description?.toLowerCase().includes(q) || i.meta?.toLowerCase().includes(q));
    }
    return r;
  }, [allItems, kindFilter, searchQuery]);

  // Detail sheet
  const handleItemPress = useCallback((item: WorkspaceItem) => {
    setSelectedItem(item);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    detailSheetRef.current?.present();
  }, []);

  const renderBackdrop = useCallback(
    (props: any) => <BottomSheetBackdrop {...props} disappearsOnIndex={-1} appearsOnIndex={0} opacity={0.5} />,
    [],
  );

  // ─── Render item card ───────────────────────────────────────────────
  const renderItem = useCallback(({ item }: { item: WorkspaceItem }) => {
    const Icon = KIND_ICON_MAP[item.kind];
    const kindLabel = KIND_CONFIG[item.kind].label;

    const statusColor = item.kind === 'mcp'
      ? item.meta === 'Connected' ? '#22C55E' : item.meta === 'Failed' ? '#EF4444' : muted
      : undefined;

    return (
      <Pressable
        onPress={() => handleItemPress(item)}
        style={{
          backgroundColor: cardBg,
          borderRadius: 16,
          borderWidth: 1,
          borderColor,
          marginBottom: 10,
          marginHorizontal: 20,
        }}
      >
        <View style={{ padding: 16, flexDirection: 'row', alignItems: 'center' }}>
          {/* Icon */}
          <View style={{
            width: 40, height: 40, borderRadius: 12,
            backgroundColor: theme.primaryLight,
            alignItems: 'center', justifyContent: 'center',
            marginRight: 12,
          }}>
            <Icon size={18} color={theme.primary} />
          </View>

          {/* Content */}
          <View style={{ flex: 1, minWidth: 0 }}>
            <RNText
              style={{
                fontSize: 14, fontFamily: item.kind === 'command' ? 'monospace' : 'Roobert-Medium',
                color: fg,
              }}
              numberOfLines={1}
            >
              {item.name}
            </RNText>
            <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 3, gap: 6 }}>
              <View style={{ backgroundColor: chipBg, borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2 }}>
                <RNText style={{ fontSize: 10, fontFamily: 'Roobert-Medium', color: muted }}>{kindLabel}</RNText>
              </View>
              <View style={{ backgroundColor: chipBg, borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2 }}>
                <RNText style={{ fontSize: 10, fontFamily: 'Roobert-Medium', color: muted }}>{SCOPE_LABEL[item.scope]}</RNText>
              </View>
              {item.meta && item.kind === 'mcp' && statusColor && (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                  <View style={{ width: 5, height: 5, borderRadius: 3, backgroundColor: statusColor }} />
                  <RNText style={{ fontSize: 10, fontFamily: 'Roobert', color: muted }}>{item.meta}</RNText>
                </View>
              )}
              {item.meta && item.kind !== 'mcp' && (
                <RNText style={{ fontSize: 10, fontFamily: 'Roobert', color: muted }} numberOfLines={1}>{item.meta}</RNText>
              )}
            </View>
            {item.description && (
              <RNText style={{ fontSize: 12, fontFamily: 'Roobert', color: muted, marginTop: 4 }} numberOfLines={2}>
                {item.description}
              </RNText>
            )}
          </View>

          {/* Chevron */}
          <ChevronRight size={16} color={muted} style={{ marginLeft: 8 }} />
        </View>
      </Pressable>
    );
  }, [fg, muted, cardBg, borderColor, chipBg, theme, handleItemPress]);

  // ─── Detail sheet content ───────────────────────────────────────────
  const DetailContent = useCallback(() => {
    if (!selectedItem) return null;

    const item = selectedItem;
    const Icon = KIND_ICON_MAP[item.kind];
    const kindLabel = KIND_CONFIG[item.kind].label;

    const rows: Array<{ label: string; value: string; mono?: boolean }> = [];
    let content: string | null = null;

    if (item.kind === 'agent' && item.raw) {
      const a = item.raw as Agent;
      if (a.model) rows.push({ label: 'Model', value: `${a.model.providerID}/${a.model.modelID}`, mono: true });
      rows.push({ label: 'Mode', value: a.mode });
      if (a.variant) rows.push({ label: 'Variant', value: a.variant });
      if (a.steps !== undefined) rows.push({ label: 'Max Steps', value: String(a.steps) });
      if (a.prompt) content = a.prompt;
    }
    if (item.kind === 'skill' && item.raw) {
      const s = item.raw as Skill;
      rows.push({ label: 'Location', value: s.location, mono: true });
      if (s.content) content = s.content;
    }
    if (item.kind === 'command' && item.raw) {
      const c = item.raw as Command;
      if (c.source) rows.push({ label: 'Source', value: c.source });
      if (c.agent) rows.push({ label: 'Agent', value: c.agent });
      if (c.model) rows.push({ label: 'Model', value: c.model, mono: true });
      if (c.hints?.length) rows.push({ label: 'Hints', value: c.hints.join(', ') });
      if (c.template) content = c.template;
    }
    if (item.kind === 'project' && item.raw) {
      const p = item.raw as Project;
      rows.push({ label: 'ID', value: p.id, mono: true });
      if (p.worktree) rows.push({ label: 'Worktree', value: p.worktree, mono: true });
      if (p.vcs) rows.push({ label: 'VCS', value: p.vcs });
    }
    if (item.kind === 'tool' && item.raw) {
      const t = item.raw as { toolId: string; server?: string };
      rows.push({ label: 'Tool ID', value: t.toolId, mono: true });
      if (t.server) rows.push({ label: 'MCP Server', value: t.server });
    }
    if (item.kind === 'mcp' && item.raw) {
      const m = item.raw as { serverName: string; status: McpStatus };
      rows.push({ label: 'Server', value: m.serverName });
      rows.push({ label: 'Status', value: m.status.status });
      if (m.status.tools?.length) rows.push({ label: 'Tools', value: String(m.status.tools.length) });
      if (m.status.status === 'failed' && m.status.error) {
        rows.push({ label: 'Error', value: m.status.error });
      }
    }
    if (item.kind === 'connector' && item.raw) {
      const c = item.raw as KortixConnector;
      if (c.source) rows.push({ label: 'Source', value: c.source });
      if (c.pipedream_slug) rows.push({ label: 'Pipedream', value: c.pipedream_slug, mono: true });
      if (c.env_keys?.length) rows.push({ label: 'Env', value: c.env_keys.join(', '), mono: true });
      if (c.auto_generated) rows.push({ label: 'Auto', value: 'Created by Pipedream OAuth' });
      if (c.updated_at) rows.push({ label: 'Updated', value: new Date(c.updated_at).toLocaleString() });
      if (c.notes) content = c.notes;
    }

    const contentLabel =
      item.kind === 'skill' ? 'SKILL.md' :
      item.kind === 'command' ? 'Template' :
      item.kind === 'agent' ? 'System Prompt' :
      item.kind === 'connector' ? 'Notes' :
      'Content';

    return (
      <View style={{ paddingBottom: insets.bottom + 20 }}>
        {/* Header */}
        <View style={{ paddingHorizontal: 20, paddingTop: 8, paddingBottom: 16 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 12 }}>
            <View style={{
              width: 44, height: 44, borderRadius: 14,
              backgroundColor: theme.primaryLight,
              alignItems: 'center', justifyContent: 'center',
              marginRight: 12,
            }}>
              <Icon size={20} color={theme.primary} />
            </View>
            <View style={{ flex: 1 }}>
              <RNText
                style={{
                  fontSize: 17, fontFamily: item.kind === 'command' ? 'monospace' : 'Roobert-SemiBold',
                  color: fg,
                }}
                numberOfLines={2}
              >
                {item.name}
              </RNText>
              <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 4, gap: 6 }}>
                <View style={{ backgroundColor: theme.primaryLight, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3 }}>
                  <RNText style={{ fontSize: 11, fontFamily: 'Roobert-Medium', color: theme.primary }}>{kindLabel}</RNText>
                </View>
                <View style={{ backgroundColor: chipBg, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3 }}>
                  <RNText style={{ fontSize: 11, fontFamily: 'Roobert-Medium', color: muted }}>{SCOPE_LABEL[item.scope]}</RNText>
                </View>
              </View>
            </View>
          </View>
          {item.description && (
            <RNText style={{ fontSize: 13, fontFamily: 'Roobert', color: muted, lineHeight: 18 }}>
              {item.description}
            </RNText>
          )}
        </View>

        {/* Properties */}
        {rows.length > 0 && (
          <View style={{ paddingHorizontal: 20, paddingBottom: 12 }}>
            <RNText style={{ fontSize: 10, fontFamily: 'Roobert-SemiBold', color: muted, letterSpacing: 1, textTransform: 'uppercase', marginBottom: 10 }}>
              Properties
            </RNText>
            {rows.map((row) => (
              <Pressable
                key={row.label}
                onPress={() => {
                  Clipboard.setStringAsync(row.value);
                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                }}
                style={{
                  flexDirection: 'row',
                  justifyContent: 'space-between',
                  alignItems: 'flex-start',
                  backgroundColor: cardBg,
                  borderWidth: 1,
                  borderColor,
                  borderRadius: 12,
                  padding: 14,
                  marginBottom: 6,
                }}
              >
                <RNText style={{ fontSize: 13, fontFamily: 'Roobert', color: muted, marginRight: 12, minWidth: 80 }}>{row.label}</RNText>
                <RNText
                  style={{
                    fontSize: 13,
                    fontFamily: row.mono ? 'monospace' : 'Roobert-Medium',
                    color: fg,
                    flex: 1,
                    textAlign: 'right',
                  }}
                  numberOfLines={3}
                  selectable
                >
                  {row.value}
                </RNText>
              </Pressable>
            ))}
          </View>
        )}

        {/* Content preview */}
        {content && (
          <View style={{ paddingHorizontal: 20, paddingTop: 4 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <FileText size={12} color={muted} />
                <RNText style={{ fontSize: 10, fontFamily: 'Roobert-SemiBold', color: muted, letterSpacing: 1, textTransform: 'uppercase' }}>
                  {contentLabel}
                </RNText>
              </View>
              <CopyButton text={content} fg={fg} muted={muted} chipBg={chipBg} />
            </View>
            <View style={{ backgroundColor: cardBg, borderWidth: 1, borderColor, borderRadius: 12, padding: 14, maxHeight: 260 }}>
              <ScrollView nestedScrollEnabled showsVerticalScrollIndicator>
                <TextInput
                  value={content}
                  editable={false}
                  multiline
                  scrollEnabled={false}
                  style={{ fontSize: 12, fontFamily: 'monospace', color: fg, lineHeight: 18, padding: 0 }}
                />
              </ScrollView>
            </View>
          </View>
        )}
      </View>
    );
  }, [selectedItem, fg, muted, cardBg, borderColor, chipBg, theme, insets.bottom]);

  // ─── Render ─────────────────────────────────────────────────────────

  return (
    <View style={{ flex: 1, backgroundColor: bg }}>
      <PageHeader
        title={page.label}
        onOpenDrawer={onOpenDrawer}
        onOpenRightDrawer={onOpenRightDrawer}
        isDrawerOpen={isDrawerOpen}
        isRightDrawerOpen={isRightDrawerOpen}
      />

      <PageContent>
      {/* Search */}
      <View style={{ paddingHorizontal: 20, paddingBottom: 8 }}>
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            backgroundColor: inputBg,
            borderRadius: 9999,
            paddingHorizontal: 16,
            height: 42,
          }}
        >
          <Search size={16} color={isDark ? '#71717a' : '#a1a1aa'} />
          <TextInput
            value={searchQuery}
            onChangeText={setSearchQuery}
            placeholder="Search workspace..."
            placeholderTextColor={isDark ? '#71717a' : '#a1a1aa'}
            style={{ flex: 1, marginLeft: 8, fontSize: 15, fontFamily: 'Roobert', color: fg, paddingVertical: 0 }}
          />
          {searchQuery.length > 0 && (
            <Pressable onPress={() => setSearchQuery('')} hitSlop={10}>
              <X size={16} color={isDark ? '#71717a' : '#a1a1aa'} />
            </Pressable>
          )}
        </View>
      </View>

      {/* Kind filter chips */}
      <View style={{ paddingBottom: 8 }}>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ paddingHorizontal: 20, gap: 6 }}
        >
          {KIND_TABS.map((tab) => {
            const isActive = kindFilter === tab.value;
            const count = kindCounts[tab.value];
            return (
              <Pressable
                key={tab.value}
                onPress={() => {
                  setKindFilter(tab.value);
                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                }}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  paddingHorizontal: 14,
                  paddingVertical: 7,
                  borderRadius: 10,
                  backgroundColor: isActive ? chipActiveBg : chipBg,
                }}
              >
                <RNText style={{
                  fontSize: 13,
                  fontFamily: 'Roobert-Medium',
                  color: isActive ? chipActiveFg : fg,
                }}>
                  {tab.label}
                </RNText>
                {count > 0 && (
                  <RNText style={{
                    fontSize: 11,
                    fontFamily: 'Roobert',
                    color: isActive ? chipActiveFg : muted,
                    marginLeft: 5,
                    opacity: isActive ? 0.8 : 0.6,
                  }}>
                    {count}
                  </RNText>
                )}
              </Pressable>
            );
          })}
        </ScrollView>
      </View>

      {/* Count label */}
      {!isLoading && allItems.length > 0 && (
        <View style={{ paddingHorizontal: 20, paddingBottom: 8, paddingTop: 4 }}>
          <RNText style={{ fontSize: 11, fontFamily: 'Roobert-SemiBold', color: muted, letterSpacing: 1, textTransform: 'uppercase' }}>
            {kindFilter === 'all' ? 'All items' : kindFilter === 'mcp' ? 'MCP Servers' : `${KIND_CONFIG[kindFilter as ItemKind].label}s`}
            {'  '}
            <RNText style={{ color: isDark ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.2)' }}>{filteredItems.length}</RNText>
          </RNText>
        </View>
      )}

      {/* List */}
      {isLoading ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingBottom: 60 }}>
          <ActivityIndicator color={muted} />
        </View>
      ) : filteredItems.length === 0 ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingBottom: 60, paddingHorizontal: 40 }}>
          <Blocks size={32} color={isDark ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.12)'} />
          <RNText style={{ fontSize: 15, fontFamily: 'Roobert-Medium', color: fg, marginTop: 12, textAlign: 'center' }}>
            {searchQuery.trim() || kindFilter !== 'all' ? 'No items match your filters' : 'Nothing here yet'}
          </RNText>
          <RNText style={{ fontSize: 13, fontFamily: 'Roobert', color: muted, marginTop: 4, textAlign: 'center', lineHeight: 18 }}>
            {searchQuery.trim() || kindFilter !== 'all'
              ? 'Try adjusting your search or filter.'
              : 'Agents, skills, commands, projects, and tools will appear here.'
            }
          </RNText>
          {(searchQuery.trim() || kindFilter !== 'all') && (
            <Pressable
              onPress={() => { setSearchQuery(''); setKindFilter('all'); }}
              style={{ marginTop: 12, paddingHorizontal: 16, paddingVertical: 8, borderRadius: 10, backgroundColor: chipBg }}
            >
              <RNText style={{ fontSize: 13, fontFamily: 'Roobert-Medium', color: fg }}>Clear filters</RNText>
            </Pressable>
          )}
        </View>
      ) : (
        <FlatList
          data={filteredItems}
          keyExtractor={(item) => item.id}
          renderItem={renderItem}
          contentContainerStyle={{ paddingTop: 4, paddingBottom: insets.bottom + 20 }}
          showsVerticalScrollIndicator={false}
          initialNumToRender={15}
          maxToRenderPerBatch={10}
          windowSize={5}
          removeClippedSubviews
          getItemLayout={undefined}
          refreshControl={
            <RefreshControl refreshing={false} onRefresh={refetchAll} tintColor={muted} />
          }
        />
      )}

      {/* Detail bottom sheet */}
      <BottomSheetModal
        ref={detailSheetRef}
        enableDynamicSizing
        enablePanDownToClose
        maxDynamicContentSize={600}
        backdropComponent={renderBackdrop}
        backgroundStyle={{ backgroundColor: getSheetBg(isDark), borderRadius: 24 }}
        handleIndicatorStyle={{ backgroundColor: isDark ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.15)', width: 36 }}
        onDismiss={() => setSelectedItem(null)}
      >
        <BottomSheetScrollView showsVerticalScrollIndicator={false}>
          <DetailContent />
        </BottomSheetScrollView>
      </BottomSheetModal>

      {/* Settings bottom sheet */}
      <WorkspaceSettingsSheet ref={settingsSheetRef} />
      </PageContent>
    </View>
  );
});

// ─── Small components ───────────────────────────────────────────────────────

function CopyButton({ text, fg, muted, chipBg }: { text: string; fg: string; muted: string; chipBg: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    await Clipboard.setStringAsync(text);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [text]);

  return (
    <Pressable
      onPress={handleCopy}
      style={{ flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: chipBg, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 5 }}
    >
      {copied ? <Check size={12} color={fg} /> : <Copy size={12} color={muted} />}
      <RNText style={{ fontSize: 11, fontFamily: 'Roobert-Medium', color: copied ? fg : muted }}>
        {copied ? 'Copied' : 'Copy'}
      </RNText>
    </Pressable>
  );
}
