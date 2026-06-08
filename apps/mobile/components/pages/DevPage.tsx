/**
 * DevPage — "work on this project from your own machine" guide (web parity:
 * customize/sections/dev-view).
 *
 * A project can live entirely in the cloud, so this surface hands you the exact
 * copy-pasteable commands to clone the repo, run the same agent locally, and
 * ship changes back as a change request. Every command is pre-filled with this
 * project's real clone URL, id, and default branch. Managed (Kortix-owned) repos
 * get an extra first step to invite yourself as a GitHub collaborator.
 *
 * Mobile branding: PageHeader + PageContent chrome, design tokens.
 */

import React, { useMemo, useState } from 'react';
import { View, TouchableOpacity, ScrollView, ActivityIndicator, TextInput, Alert } from 'react-native';
import { useColorScheme } from 'nativewind';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useMutation } from '@tanstack/react-query';
import * as Clipboard from 'expo-clipboard';
import { Copy, Check, UserPlus, Github } from 'lucide-react-native';
import { Text } from '@/components/ui/text';
import { PageHeader } from '@/components/ui/page-header';
import { PageContent } from '@/components/ui/page-content';
import { useThemeColors } from '@/lib/theme-colors';
import { useProject } from '@/lib/projects/hooks';
import { inviteRepoCollaborator, isManagedGithubProject } from '@/lib/projects/projects-client';
import type { KortixProject } from '@/lib/projects/projects-client';
import { haptics } from '@/lib/haptics';

const MONO = 'Menlo';

interface PageTabLike {
  id: string;
  label: string;
  icon: string;
}

interface DevPageProps {
  page: PageTabLike;
  projectId: string;
  onOpenDrawer?: () => void;
  onOpenRightDrawer?: () => void;
  isDrawerOpen?: boolean;
  isRightDrawerOpen?: boolean;
}

const LAUNCHERS: { label: string; command: string }[] = [
  { label: 'Claude Code', command: 'claude' },
  { label: 'Cursor', command: 'cursor .' },
  { label: 'Codex', command: 'codex' },
  { label: 'opencode', command: 'opencode' },
];

/** Turn a stored repo URL into something you can `git clone`. */
function cloneUrlFor(repoUrl: string | null | undefined): string {
  const normalized = repoUrl?.trim().replace(/\/+$/, '').replace(/\.git$/i, '');
  if (!normalized) return 'git@github.com:owner/repo.git';
  const ssh = normalized.match(/^git@github\.com:([^/]+)\/([^/]+)$/i);
  if (ssh?.[1] && ssh[2]) return `https://github.com/${ssh[1]}/${ssh[2]}.git`;
  const https = normalized.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)$/i);
  if (https?.[1] && https[2]) return `https://github.com/${https[1]}/${https[2]}.git`;
  return `${normalized}.git`;
}

/** The directory `git clone` drops you into — the repo name. */
function repoDirFor(repoUrl: string | null | undefined): string {
  const normalized = repoUrl?.trim().replace(/\/+$/, '').replace(/\.git$/i, '');
  if (!normalized) return '';
  return normalized.split(/[/:]/).pop() ?? '';
}

// ─── command block ────────────────────────────────────────────────────────────

function CommandBlock({ lines, isDark }: { lines: string[]; isDark: boolean }) {
  const [copied, setCopied] = useState(false);
  const theme = useThemeColors();
  const fg = isDark ? '#F8F8F8' : '#121215';
  const muted = isDark ? '#9b9b9b' : '#6e6e6e';
  const border = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)';
  const bg = isDark ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.025)';

  const copy = async () => {
    haptics.tap();
    await Clipboard.setStringAsync(lines.join('\n'));
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  return (
    <View style={{ borderRadius: 12, borderWidth: 1, borderColor: border, backgroundColor: bg, overflow: 'hidden' }}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingVertical: 11, paddingLeft: 12, paddingRight: 44, minWidth: '100%' }}>
        <View>
          {lines.map((line, i) => (
            <View key={i} style={{ flexDirection: 'row' }}>
              <Text style={{ fontSize: 12.5, lineHeight: 20, fontFamily: MONO, color: muted, opacity: 0.5, paddingRight: 10 }}>$</Text>
              <Text style={{ fontSize: 12.5, lineHeight: 20, fontFamily: MONO, color: fg }}>{line}</Text>
            </View>
          ))}
        </View>
      </ScrollView>
      <TouchableOpacity onPress={copy} hitSlop={8} style={{ position: 'absolute', top: 8, right: 8, width: 30, height: 30, borderRadius: 9999, alignItems: 'center', justifyContent: 'center', backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)' }}>
        {copied ? <Check size={15} color={theme.primary} /> : <Copy size={14} color={muted} />}
      </TouchableOpacity>
    </View>
  );
}

// ─── launcher chips ───────────────────────────────────────────────────────────

function LauncherChip({ label, command, isDark }: { label: string; command: string; isDark: boolean }) {
  const [copied, setCopied] = useState(false);
  const theme = useThemeColors();
  const fg = isDark ? '#F8F8F8' : '#121215';
  const muted = isDark ? '#9b9b9b' : '#6e6e6e';
  const border = isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)';
  const bg = isDark ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.025)';

  const copy = async () => {
    haptics.tap();
    await Clipboard.setStringAsync(command);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  return (
    <TouchableOpacity onPress={copy} activeOpacity={0.7} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: 12, paddingRight: 11, height: 38, borderRadius: 9999, borderWidth: 1, borderColor: border, backgroundColor: bg }}>
      <Text style={{ fontSize: 13.5, fontFamily: 'Roobert-Medium', color: fg }}>{label}</Text>
      <Text style={{ fontSize: 11.5, fontFamily: MONO, color: muted }}>{command}</Text>
      {copied ? <Check size={14} color={theme.primary} /> : <Copy size={13} color={muted} />}
    </TouchableOpacity>
  );
}

// ─── repo-access invite form (managed repos only) ─────────────────────────────

function RepoAccessForm({ projectId, isDark }: { projectId: string; isDark: boolean }) {
  const theme = useThemeColors();
  const [username, setUsername] = useState('');
  const fg = isDark ? '#F8F8F8' : '#121215';
  const muted = isDark ? '#9b9b9b' : '#6e6e6e';
  const border = isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.12)';
  const inputBg = isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.03)';

  const invite = useMutation({
    mutationFn: () => inviteRepoCollaborator(projectId, username.trim(), 'write'),
    onSuccess: (res) => {
      haptics.success();
      setUsername('');
      Alert.alert(
        res.alreadyCollaborator ? 'Already has access' : 'Invite sent',
        res.alreadyCollaborator
          ? `@${res.username} already has access to this repo.`
          : `Invite sent to @${res.username} — accept it on GitHub.`,
      );
    },
    onError: (e: any) => Alert.alert('Failed', e?.message || 'Failed to add collaborator.'),
  });

  const canSubmit = username.trim().length > 0 && !invite.isPending;

  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
      <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8, height: 44, borderRadius: 11, borderWidth: 1, borderColor: border, backgroundColor: inputBg, paddingHorizontal: 12 }}>
        <Github size={15} color={muted} />
        <TextInput
          value={username}
          onChangeText={setUsername}
          placeholder="Your GitHub username"
          placeholderTextColor={muted}
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
          style={{ flex: 1, fontSize: 14, color: fg, fontFamily: 'Roobert', padding: 0 }}
        />
      </View>
      <TouchableOpacity onPress={() => invite.mutate()} disabled={!canSubmit} activeOpacity={0.85} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 14, height: 44, borderRadius: 9999, backgroundColor: theme.primary, opacity: canSubmit ? 1 : 0.5 }}>
        {invite.isPending ? <ActivityIndicator size="small" color={theme.primaryForeground} /> : <UserPlus size={14} color={theme.primaryForeground} />}
        <Text style={{ fontSize: 13.5, fontFamily: 'Roobert-Medium', color: theme.primaryForeground }}>Add me</Text>
      </TouchableOpacity>
    </View>
  );
}

// ─── step ─────────────────────────────────────────────────────────────────────

function Step({ n, title, hint, isDark, children }: { n: number; title: string; hint?: string; isDark: boolean; children: React.ReactNode }) {
  const theme = useThemeColors();
  const fg = isDark ? '#F8F8F8' : '#121215';
  const muted = isDark ? '#9b9b9b' : '#6e6e6e';
  return (
    <View style={{ flexDirection: 'row', gap: 14 }}>
      <View style={{ width: 28, height: 28, borderRadius: 9999, backgroundColor: theme.primaryLight, alignItems: 'center', justifyContent: 'center' }}>
        <Text style={{ fontSize: 13, fontFamily: 'Roobert-Medium', color: fg }}>{n}</Text>
      </View>
      <View style={{ flex: 1, minWidth: 0, paddingTop: 2, gap: 10 }}>
        <View style={{ gap: 4 }}>
          <Text style={{ fontSize: 14.5, fontFamily: 'Roobert-Medium', color: fg }}>{title}</Text>
          {hint && <Text style={{ fontSize: 12.5, lineHeight: 18, color: muted }}>{hint}</Text>}
        </View>
        {children}
      </View>
    </View>
  );
}

// ─── page ─────────────────────────────────────────────────────────────────────

export function DevPage({
  page,
  projectId,
  onOpenDrawer,
  onOpenRightDrawer,
  isDrawerOpen,
  isRightDrawerOpen,
}: DevPageProps) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const insets = useSafeAreaInsets();

  const { data: project, isLoading, isError, error, refetch } = useProject(projectId);

  const bgColor = isDark ? '#090909' : '#FFFFFF';
  const fg = isDark ? '#F8F8F8' : '#121215';
  const muted = isDark ? '#9b9b9b' : '#6e6e6e';
  const border = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)';
  const chipBg = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.05)';

  const steps = useMemo(() => buildSteps(project), [project]);

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
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 6, paddingBottom: insets.bottom + 48 }} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
          <Text style={{ fontSize: 19, fontFamily: 'Roobert-Medium', color: fg, marginBottom: 6 }}>Develop on your own machine</Text>
          <Text style={{ fontSize: 12.5, lineHeight: 18, color: muted, marginBottom: 22 }}>
            This project lives in one git repo. Clone it, open it in your own coding agent — Claude Code, Cursor, Codex, opencode — and send your changes back as a change request, the same way a cloud session does.
          </Text>

          {isLoading ? (
            <View style={{ paddingVertical: 48, alignItems: 'center' }}><ActivityIndicator size="small" color={muted} /></View>
          ) : isError ? (
            <View style={{ padding: 20, borderRadius: 14, borderWidth: 1, borderColor: 'rgba(239,68,68,0.3)', backgroundColor: 'rgba(239,68,68,0.05)', gap: 12 }}>
              <Text style={{ fontSize: 13.5, color: '#ef4444' }}>Couldn't load this project: {(error as Error)?.message}</Text>
              <TouchableOpacity onPress={() => refetch()} style={{ alignSelf: 'flex-start', paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999, borderWidth: 1, borderColor: border }}>
                <Text style={{ fontSize: 13, fontFamily: 'Roobert-Medium', color: fg }}>Retry</Text>
              </TouchableOpacity>
            </View>
          ) : project ? (
            <View style={{ gap: 22 }}>
              {steps.map((s, i) => (
                <Step key={i} n={i + 1} title={s.title} hint={s.hint} isDark={isDark}>
                  {s.kind === 'commands' ? (
                    <CommandBlock lines={s.lines} isDark={isDark} />
                  ) : s.kind === 'launchers' ? (
                    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                      {LAUNCHERS.map((l) => <LauncherChip key={l.label} label={l.label} command={l.command} isDark={isDark} />)}
                    </View>
                  ) : (
                    <RepoAccessForm projectId={projectId} isDark={isDark} />
                  )}
                  {s.footer && (
                    <Text style={{ fontSize: 11.5, lineHeight: 17, color: muted, marginTop: 2 }}>
                      Branches merge into{' '}
                      <Text style={{ fontFamily: MONO, color: fg, fontSize: 11, backgroundColor: chipBg }}> {s.footer} </Text>
                      {' '}through change requests — there's no other path to the main branch.
                    </Text>
                  )}
                </Step>
              ))}
            </View>
          ) : null}
        </ScrollView>
      </PageContent>
    </View>
  );
}

type DevStep =
  | { kind: 'access'; title: string; hint: string; footer?: string }
  | { kind: 'commands'; title: string; hint?: string; lines: string[]; footer?: string }
  | { kind: 'launchers'; title: string; hint?: string; footer?: string };

function buildSteps(project: KortixProject | undefined): DevStep[] {
  if (!project) return [];
  const cloneUrl = cloneUrlFor(project.repo_url);
  const repoDir = repoDirFor(project.repo_url) || 'my-project';
  const branch = project.default_branch || 'main';
  const managed = isManagedGithubProject(project);

  const steps: DevStep[] = [];
  if (managed) {
    steps.push({
      kind: 'access',
      title: 'Get access to the repo',
      hint: 'This repo is private and owned by Kortix. Add your GitHub account as a collaborator, then accept the invite GitHub emails you.',
    });
  }
  steps.push({
    kind: 'commands',
    title: 'Clone the repo',
    hint: managed ? 'Once your invite is accepted, clone it like any other repo.' : 'You need read access to the repo to clone it.',
    lines: [`git clone ${cloneUrl}`, `cd ${repoDir}`],
  });
  steps.push({
    kind: 'commands',
    title: 'Install the Kortix CLI',
    hint: "Manages this project's secrets, sessions, and change requests from your terminal.",
    lines: ['curl -fsSL https://kortix.com/install | bash', 'kortix login'],
  });
  steps.push({
    kind: 'commands',
    title: 'Set up your local dev environment',
    hint: 'Wires the Kortix skill into your coding agent and adds anything your local setup is missing — existing files are kept. The repo is already linked, so kortix commands target it automatically.',
    lines: ['kortix init --force'],
  });
  steps.push({
    kind: 'commands',
    title: 'Pull secrets',
    hint: "Writes a .env with this project's secret names — fill in the values locally. Plaintext never leaves the cloud.",
    lines: ['kortix env pull'],
  });
  steps.push({
    kind: 'launchers',
    title: 'Build it in your coding agent',
    hint: 'Open the repo in the agent you wired up and just talk to it — the Kortix skill is loaded, so it knows how to configure agents, edit kortix.toml, add triggers, and write skills.',
  });
  steps.push({
    kind: 'commands',
    title: 'Ship your changes back',
    hint: 'Open a change request, then review and merge it from the dashboard or with kortix cr merge.',
    lines: [
      'git checkout -b my-change',
      'git commit -am "Describe your change"',
      'git push origin HEAD',
      'kortix cr open --title "Describe your change"',
    ],
    footer: branch,
  });
  return steps;
}
