/**
 * SettingsNavPage — project settings (web parity: customize/sections/
 * settings-view).
 *
 * Cards:
 *   • General — rename the project.
 *   • Repository — the git repo backing the project: open on GitHub, edit the
 *     default branch + manifest path, and (managed repos) invite GitHub
 *     collaborators.
 *   • Experimental / WIP Features — collapsible per-project toggles driven by the
 *     API catalog (project.experimental_features).
 *   • Danger zone (managers) — archive the project.
 *
 * Mobile branding: PageHeader + PageContent chrome, design tokens.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { View, TouchableOpacity, ScrollView, ActivityIndicator, TextInput, Alert, Switch, Linking, LayoutAnimation, Platform, UIManager } from 'react-native';
import { useColorScheme } from 'nativewind';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  GitBranch,
  ExternalLink,
  FlaskConical,
  ChevronDown,
  Trash2,
  UserPlus,
  Github,
  Check,
} from 'lucide-react-native';
import { Text } from '@/components/ui/text';
import { PageHeader } from '@/components/ui/page-header';
import { PageContent } from '@/components/ui/page-content';
import { useThemeColors } from '@/lib/theme-colors';
import {
  useProject,
  useUpdateProject,
  useUpdateExperimentalFeature,
  useArchiveProject,
} from '@/lib/projects/hooks';
import { inviteRepoCollaborator, isManagedGithubProject } from '@/lib/projects/projects-client';
import type { KortixProject, ExperimentalFeatureView } from '@/lib/projects/projects-client';
import { useMutation } from '@tanstack/react-query';
import { haptics } from '@/lib/haptics';

const MONO = 'Menlo';

if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

interface PageTabLike {
  id: string;
  label: string;
  icon: string;
}

interface SettingsNavPageProps {
  page: PageTabLike;
  projectId: string;
  onOpenDrawer?: () => void;
  onOpenRightDrawer?: () => void;
  isDrawerOpen?: boolean;
  isRightDrawerOpen?: boolean;
}

function githubRepoWebUrl(repoUrl: string | null | undefined): string | null {
  const normalized = repoUrl?.trim().replace(/\/+$/, '').replace(/\.git$/i, '');
  if (!normalized) return null;
  const ssh = normalized.match(/^git@github\.com:([^/]+)\/([^/]+)$/i);
  if (ssh?.[1] && ssh[2]) return `https://github.com/${ssh[1]}/${ssh[2]}`;
  const https = normalized.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)$/i);
  if (https?.[1] && https[2]) return `https://github.com/${https[1]}/${https[2]}`;
  return null;
}

// ─── reusable bits ────────────────────────────────────────────────────────────

function useColors(isDark: boolean) {
  return {
    fg: isDark ? '#F8F8F8' : '#121215',
    muted: isDark ? '#9b9b9b' : '#6e6e6e',
    border: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)',
    inputBorder: isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.12)',
    inputBg: isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.03)',
    cardBg: isDark ? 'rgba(255,255,255,0.02)' : 'rgba(0,0,0,0.015)',
  };
}

function Card({ title, description, tone, isDark, children }: { title?: string; description?: string; tone?: 'destructive'; isDark: boolean; children: React.ReactNode }) {
  const c = useColors(isDark);
  const borderColor = tone === 'destructive' ? 'rgba(239,68,68,0.3)' : c.border;
  const bg = tone === 'destructive' ? 'rgba(239,68,68,0.04)' : c.cardBg;
  const titleColor = tone === 'destructive' ? '#ef4444' : c.fg;
  return (
    <View style={{ borderRadius: 16, borderWidth: 1, borderColor, backgroundColor: bg, padding: 16 }}>
      {title && <Text style={{ fontSize: 15, fontFamily: 'Roobert-Medium', color: titleColor }}>{title}</Text>}
      {description && <Text style={{ fontSize: 12.5, lineHeight: 18, color: c.muted, marginTop: 4 }}>{description}</Text>}
      {children}
    </View>
  );
}

function FieldLabel({ children, color }: { children: React.ReactNode; color: string }) {
  return <Text style={{ fontSize: 12, fontFamily: 'Roobert-Medium', color, marginBottom: 6 }}>{children}</Text>;
}

function SaveButton({ onPress, disabled, pending }: { onPress: () => void; disabled: boolean; pending: boolean }) {
  const theme = useThemeColors();
  return (
    <TouchableOpacity onPress={onPress} disabled={disabled} activeOpacity={0.85} style={{ alignSelf: 'flex-end', flexDirection: 'row', alignItems: 'center', gap: 7, paddingHorizontal: 18, height: 40, borderRadius: 9999, backgroundColor: theme.primary, opacity: disabled ? 0.5 : 1 }}>
      {pending && <ActivityIndicator size="small" color={theme.primaryForeground} />}
      <Text style={{ fontSize: 14, fontFamily: 'Roobert-Medium', color: theme.primaryForeground }}>Save</Text>
    </TouchableOpacity>
  );
}

// ─── General ──────────────────────────────────────────────────────────────────

function GeneralCard({ project, canManage, isDark }: { project: KortixProject; canManage: boolean; isDark: boolean }) {
  const c = useColors(isDark);
  const update = useUpdateProject(project.project_id);
  const [name, setName] = useState(project.name);
  useEffect(() => { setName(project.name); }, [project.name]);

  const dirty = name.trim() !== project.name && name.trim().length > 0;
  const save = () => {
    if (!dirty || !canManage) return;
    haptics.tap();
    update.mutate({ name: name.trim() }, {
      onSuccess: () => haptics.success(),
      onError: (e: any) => Alert.alert('Failed', e?.message || 'Failed to update project.'),
    });
  };

  return (
    <Card title="General" isDark={isDark}>
      <View style={{ marginTop: 14 }}>
        <FieldLabel color={c.muted}>Project name</FieldLabel>
        <TextInput
          value={name}
          onChangeText={setName}
          editable={canManage && !update.isPending}
          maxLength={120}
          placeholderTextColor={c.muted}
          style={{ height: 44, borderRadius: 11, borderWidth: 1, borderColor: c.inputBorder, backgroundColor: c.inputBg, paddingHorizontal: 12, fontSize: 14, color: c.fg, fontFamily: 'Roobert' }}
        />
        <View style={{ marginTop: 14 }}>
          <SaveButton onPress={save} disabled={!dirty || !canManage || update.isPending} pending={update.isPending} />
        </View>
      </View>
    </Card>
  );
}

// ─── Repository ───────────────────────────────────────────────────────────────

function RepositoryCard({ project, canManage, isDark }: { project: KortixProject; canManage: boolean; isDark: boolean }) {
  const c = useColors(isDark);
  const update = useUpdateProject(project.project_id);
  const githubUrl = githubRepoWebUrl(project.repo_url);
  const repoLabel = githubUrl?.replace('https://github.com/', '') || project.repo_url || '-';
  const managed = isManagedGithubProject(project);

  const [branch, setBranch] = useState(project.default_branch);
  const [manifest, setManifest] = useState(project.manifest_path);
  useEffect(() => { setBranch(project.default_branch); setManifest(project.manifest_path); }, [project.default_branch, project.manifest_path]);

  const dirty = branch.trim() !== project.default_branch || manifest.trim() !== project.manifest_path;
  const save = () => {
    if (!dirty || !canManage) return;
    haptics.tap();
    update.mutate({ default_branch: branch.trim(), manifest_path: manifest.trim() }, {
      onSuccess: () => haptics.success(),
      onError: (e: any) => Alert.alert('Failed', e?.message || 'Failed to update repository.'),
    });
  };

  const inputStyle = { height: 44, borderRadius: 11, borderWidth: 1, borderColor: c.inputBorder, backgroundColor: c.inputBg, paddingHorizontal: 12, fontSize: 13, color: c.fg, fontFamily: MONO } as const;

  return (
    <Card title="Repository" description="The git repo backing this project. Every session branches from it." isDark={isDark}>
      {/* Repo row */}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 14 }}>
        {githubUrl ? <Github size={15} color={c.muted} /> : <GitBranch size={15} color={c.muted} />}
        <Text style={{ flex: 1, fontSize: 13, fontFamily: MONO, color: c.fg }} numberOfLines={1}>{repoLabel}</Text>
        {githubUrl && (
          <TouchableOpacity onPress={() => { haptics.tap(); Linking.openURL(githubUrl); }} activeOpacity={0.7} style={{ flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 11, height: 32, borderRadius: 9999, borderWidth: 1, borderColor: c.border }}>
            <ExternalLink size={13} color={c.muted} />
            <Text style={{ fontSize: 12.5, fontFamily: 'Roobert-Medium', color: c.fg }}>GitHub</Text>
          </TouchableOpacity>
        )}
      </View>

      <View style={{ marginTop: 16 }}>
        <FieldLabel color={c.muted}>Default branch</FieldLabel>
        <TextInput value={branch} onChangeText={setBranch} editable={canManage && !update.isPending} autoCapitalize="none" autoCorrect={false} style={inputStyle} />
      </View>
      <View style={{ marginTop: 12 }}>
        <FieldLabel color={c.muted}>Manifest path</FieldLabel>
        <TextInput value={manifest} onChangeText={setManifest} editable={canManage && !update.isPending} autoCapitalize="none" autoCorrect={false} style={inputStyle} />
      </View>
      <View style={{ marginTop: 14 }}>
        <SaveButton onPress={save} disabled={!dirty || !canManage || update.isPending} pending={update.isPending} />
      </View>

      {managed && canManage && <RepoCollaboratorInvite projectId={project.project_id} isDark={isDark} />}
    </Card>
  );
}

function RepoCollaboratorInvite({ projectId, isDark }: { projectId: string; isDark: boolean }) {
  const c = useColors(isDark);
  const theme = useThemeColors();
  const [username, setUsername] = useState('');
  const [permission, setPermission] = useState<'read' | 'write'>('write');

  const invite = useMutation({
    mutationFn: () => inviteRepoCollaborator(projectId, username.trim(), permission),
    onSuccess: (res) => {
      haptics.success();
      setUsername('');
      Alert.alert(
        res.alreadyCollaborator ? 'Already has access' : 'Invite sent',
        res.alreadyCollaborator ? `@${res.username} already has access to this repo.` : `Invite sent to @${res.username} — they accept it on GitHub to get access.`,
      );
    },
    onError: (e: any) => Alert.alert('Failed', e?.message || 'Failed to add collaborator.'),
  });
  const canSubmit = username.trim().length > 0 && !invite.isPending;

  return (
    <View style={{ marginTop: 22, paddingTop: 18, borderTopWidth: 1, borderTopColor: c.border }}>
      <Text style={{ fontSize: 14, fontFamily: 'Roobert-Medium', color: c.fg }}>Add people to this repo</Text>
      <Text style={{ fontSize: 12, lineHeight: 17, color: c.muted, marginTop: 4 }}>
        Kortix owns this repo. Add GitHub users as collaborators so they can clone, browse, and work on it directly on github.com.
      </Text>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 12 }}>
        <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8, height: 44, borderRadius: 11, borderWidth: 1, borderColor: c.inputBorder, backgroundColor: c.inputBg, paddingHorizontal: 12 }}>
          <Github size={15} color={c.muted} />
          <TextInput value={username} onChangeText={setUsername} placeholder="GitHub username" placeholderTextColor={c.muted} autoCapitalize="none" autoCorrect={false} spellCheck={false} style={{ flex: 1, fontSize: 14, color: c.fg, fontFamily: 'Roobert', padding: 0 }} />
        </View>
        <TouchableOpacity onPress={() => invite.mutate()} disabled={!canSubmit} activeOpacity={0.85} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 14, height: 44, borderRadius: 9999, backgroundColor: theme.primary, opacity: canSubmit ? 1 : 0.5 }}>
          {invite.isPending ? <ActivityIndicator size="small" color={theme.primaryForeground} /> : <UserPlus size={14} color={theme.primaryForeground} />}
          <Text style={{ fontSize: 13.5, fontFamily: 'Roobert-Medium', color: theme.primaryForeground }}>Add</Text>
        </TouchableOpacity>
      </View>
      {/* Permission toggle */}
      <View style={{ flexDirection: 'row', gap: 8, marginTop: 10 }}>
        {(['write', 'read'] as const).map((p) => {
          const active = permission === p;
          return (
            <TouchableOpacity key={p} onPress={() => { haptics.tap(); setPermission(p); }} activeOpacity={0.8} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, height: 32, borderRadius: 9999, borderWidth: 1, borderColor: active ? theme.primary : c.border, backgroundColor: active ? theme.primaryLight : 'transparent' }}>
              {active && <Check size={13} color={theme.primary} />}
              <Text style={{ fontSize: 12.5, fontFamily: 'Roobert-Medium', color: active ? c.fg : c.muted }}>{p === 'write' ? 'Can edit' : 'Can view'}</Text>
            </TouchableOpacity>
          );
        })}
      </View>
    </View>
  );
}

// ─── Experimental ─────────────────────────────────────────────────────────────

function ExperimentalCard({ project, canManage, isDark }: { project: KortixProject; canManage: boolean; isDark: boolean }) {
  const c = useColors(isDark);
  const features = (project.experimental_features ?? []).filter((f) => f.available);
  const [expanded, setExpanded] = useState(false);

  if (features.length === 0) return null;
  const enabledCount = features.filter((f) => f.enabled).length;

  const toggle = () => {
    haptics.tap();
    LayoutAnimation.configureNext(LayoutAnimation.create(180, LayoutAnimation.Types.easeInEaseOut, LayoutAnimation.Properties.opacity));
    setExpanded((v) => !v);
  };

  return (
    <View style={{ borderRadius: 16, borderWidth: 1, borderStyle: 'dashed', borderColor: c.border, backgroundColor: c.cardBg, padding: 16 }}>
      <TouchableOpacity onPress={toggle} activeOpacity={0.7} style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10 }}>
        <FlaskConical size={16} color={c.muted} style={{ marginTop: 1 }} />
        <View style={{ flex: 1 }}>
          <Text style={{ fontSize: 14.5, fontFamily: 'Roobert-Medium', color: c.fg }}>
            Experimental / WIP Features
            {enabledCount > 0 && <Text style={{ fontFamily: 'Roobert', color: c.muted }}> · {enabledCount} on</Text>}
          </Text>
          {!expanded && (
            <Text style={{ fontSize: 12, lineHeight: 17, color: c.muted, marginTop: 3 }}>
              Soft-released, still-moving features. Expand to opt this project in — they may change or break.
            </Text>
          )}
        </View>
        <ChevronDown size={17} color={c.muted} style={{ transform: [{ rotate: expanded ? '180deg' : '0deg' }] }} />
      </TouchableOpacity>

      {expanded && (
        <View style={{ marginTop: 12 }}>
          <Text style={{ fontSize: 12, lineHeight: 17, color: c.muted }}>
            These are real but unfinished. Turning one on enables it for this project only — it may change shape or break between versions, and stays off until you turn it on.
          </Text>
          <View style={{ marginTop: 8, borderTopWidth: 1, borderTopColor: c.border }}>
            {features.map((f) => (
              <ExperimentalRow key={f.key} projectId={project.project_id} feature={f} canManage={canManage} isDark={isDark} />
            ))}
          </View>
        </View>
      )}
    </View>
  );
}

function ExperimentalRow({ projectId, feature, canManage, isDark }: { projectId: string; feature: ExperimentalFeatureView; canManage: boolean; isDark: boolean }) {
  const c = useColors(isDark);
  const { colorScheme } = useColorScheme();
  const update = useUpdateExperimentalFeature(projectId);
  const isBeta = feature.stability === 'beta';

  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 14, borderTopWidth: 1, borderTopColor: c.border }}>
      <View style={{ flex: 1 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Text style={{ fontSize: 14, fontFamily: 'Roobert-Medium', color: c.fg }}>{feature.name}</Text>
          <View style={{ paddingHorizontal: 7, paddingVertical: 2, borderRadius: 999, backgroundColor: isBeta ? 'rgba(59,130,246,0.14)' : 'rgba(139,92,246,0.14)' }}>
            <Text style={{ fontSize: 10, fontFamily: 'Roobert-Medium', color: isBeta ? '#3b82f6' : '#8b5cf6' }}>{isBeta ? 'Beta' : 'Experimental'}</Text>
          </View>
        </View>
        <Text style={{ fontSize: 12, lineHeight: 17, color: c.muted, marginTop: 3 }}>{feature.description}</Text>
      </View>
      <Switch
        value={feature.enabled}
        disabled={!canManage || update.isPending}
        onValueChange={(v) => {
          haptics.tap();
          update.mutate({ feature: feature.key, enabled: v }, {
            onError: (e: any) => Alert.alert('Failed', e?.message || `Failed to update ${feature.name}.`),
          });
        }}
        trackColor={{ false: colorScheme === 'dark' ? '#3A3A3C' : '#E5E5E7', true: '#34C759' }}
        thumbColor="#FFFFFF"
        ios_backgroundColor={colorScheme === 'dark' ? '#3A3A3C' : '#E5E5E7'}
      />
    </View>
  );
}

// ─── Danger zone ──────────────────────────────────────────────────────────────

function DangerCard({ project, isDark }: { project: KortixProject; isDark: boolean }) {
  const c = useColors(isDark);
  const archive = useArchiveProject();

  const confirm = () => {
    Alert.alert('Archive project', `Archive ${project.name}? Current sessions remain recoverable.`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Archive', style: 'destructive', onPress: () => {
        haptics.medium();
        archive.mutate(project.project_id, {
          onSuccess: () => { haptics.success(); Alert.alert('Archived', 'Project archived.'); },
          onError: (e: any) => Alert.alert('Failed', e?.message || 'Failed to archive project.'),
        });
      } },
    ]);
  };

  return (
    <Card title="Danger zone" description="Irreversible and destructive actions." tone="destructive" isDark={isDark}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 14 }}>
        <View style={{ flex: 1 }}>
          <Text style={{ fontSize: 14, fontFamily: 'Roobert-Medium', color: c.fg }}>Archive project</Text>
          <Text style={{ fontSize: 12, color: c.muted, marginTop: 2 }}>Hide this project from the active project list.</Text>
        </View>
        <TouchableOpacity onPress={confirm} disabled={archive.isPending} activeOpacity={0.8} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 14, height: 38, borderRadius: 9999, borderWidth: 1, borderColor: 'rgba(239,68,68,0.4)' }}>
          {archive.isPending ? <ActivityIndicator size="small" color="#ef4444" /> : <Trash2 size={14} color="#ef4444" />}
          <Text style={{ fontSize: 13, fontFamily: 'Roobert-Medium', color: '#ef4444' }}>Archive</Text>
        </TouchableOpacity>
      </View>
    </Card>
  );
}

// ─── page ─────────────────────────────────────────────────────────────────────

export function SettingsNavPage({
  page,
  projectId,
  onOpenDrawer,
  onOpenRightDrawer,
  isDrawerOpen,
  isRightDrawerOpen,
}: SettingsNavPageProps) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const insets = useSafeAreaInsets();
  const c = useColors(isDark);

  const { data: project, isLoading, isError, error, refetch } = useProject(projectId);
  const canManage = project?.effective_project_role === 'manager';
  const bgColor = isDark ? '#090909' : '#FFFFFF';

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
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 10, paddingBottom: insets.bottom + 48, gap: 16 }} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
          {isLoading ? (
            <View style={{ paddingVertical: 48, alignItems: 'center' }}><ActivityIndicator size="small" color={c.muted} /></View>
          ) : isError ? (
            <Card title="Failed to load project" description={(error as Error)?.message} tone="destructive" isDark={isDark}>
              <TouchableOpacity onPress={() => refetch()} style={{ alignSelf: 'flex-start', marginTop: 12, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999, borderWidth: 1, borderColor: c.border }}>
                <Text style={{ fontSize: 13, fontFamily: 'Roobert-Medium', color: c.fg }}>Retry</Text>
              </TouchableOpacity>
            </Card>
          ) : project ? (
            <>
              <GeneralCard project={project} canManage={canManage} isDark={isDark} />
              <RepositoryCard project={project} canManage={canManage} isDark={isDark} />
              <ExperimentalCard project={project} canManage={canManage} isDark={isDark} />
              {canManage && <DangerCard project={project} isDark={isDark} />}
            </>
          ) : null}
        </ScrollView>
      </PageContent>
    </View>
  );
}
