/**
 * ChangesPage — project Change Requests (web parity:
 * customize/sections/changes-view). A CR proposes merging head_ref → base_ref.
 * Two tabs: Change requests (open/merged/closed, with merge / reject / reopen
 * and a full diff view) and Versions (the project's branches).
 *
 * Mobile branding: PageHeader + PageContent chrome, bottom-sheet CR detail with
 * a unified-diff renderer, design-system typography + colors.
 */

import React, { useEffect, useMemo, useState } from 'react';
import {
  View,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { useColorScheme } from 'nativewind';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  BottomSheetModal,
  BottomSheetBackdrop,
  BottomSheetScrollView,
  BottomSheetTextInput,
} from '@gorhom/bottom-sheet';
import {
  GitPullRequest,
  GitMerge,
  GitPullRequestClosed,
  GitBranch,
  FilePlus,
  FileMinus,
  FilePen,
  TriangleAlert,
  CircleCheck,
  Check,
  X,
  ChevronRight,
  Plus,
  GitCompare,
  type LucideIcon,
} from 'lucide-react-native';
import { Text } from '@/components/ui/text';
import { PageHeader } from '@/components/ui/page-header';
import { PageContent } from '@/components/ui/page-content';
import { useThemeColors, getSheetBg } from '@/lib/theme-colors';
import { MarkdownRenderer } from '@/components/chat/tool-views/file-operation/MarkdownRenderer';
import { parsePatch, DiffFile } from '@/components/diff/PatchDiffView';
import { relativeTime } from '@/lib/projects/triggers-format';
import {
  useChangeRequests,
  useChangeRequest,
  useChangeRequestDiff,
  useChangeRequestMergePreview,
  useMergeChangeRequest,
  useCloseChangeRequest,
  useReopenChangeRequest,
  useProjectBranches,
  useVersionDiff,
  useOpenChangeRequest,
} from '@/lib/projects/hooks';
import type {
  ChangeRequest,
  ChangeRequestStatus,
  ChangeRequestDiff,
  ProjectCommitFile,
  ProjectBranch,
} from '@/lib/projects/projects-client';
import { haptics } from '@/lib/haptics';

interface PageTabLike {
  id: string;
  label: string;
  icon: string;
}

interface ChangesPageProps {
  page: PageTabLike;
  projectId: string;
  onOpenDrawer?: () => void;
  onOpenRightDrawer?: () => void;
  isDrawerOpen?: boolean;
  isRightDrawerOpen?: boolean;
}

const MONO = 'Menlo';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const shortRef = (ref: string) => (UUID_RE.test(ref) ? ref.slice(0, 8) : ref);
const shortSha = (sha: string | null) => (sha ? sha.slice(0, 7) : '');

const STATUS_META: Record<ChangeRequestStatus, { label: string; color: string; icon: LucideIcon }> = {
  open: { label: 'Open', color: '#22c55e', icon: GitPullRequest },
  merged: { label: 'Merged', color: '#8b5cf6', icon: GitMerge },
  closed: { label: 'Closed', color: '#9ca3af', icon: GitPullRequestClosed },
};

function statusTime(cr: ChangeRequest): string {
  if (cr.status === 'merged') return `merged ${relativeTime(cr.merged_at)}`;
  if (cr.status === 'closed') return `closed ${relativeTime(cr.closed_at)}`;
  return `opened ${relativeTime(cr.created_at)}`;
}

// ─── Merge-preview banner ─────────────────────────────────────────────────────

function MergeBanner({ cr, projectId, isDark }: { cr: ChangeRequest; projectId: string; isDark: boolean }) {
  const muted = isDark ? '#9b9b9b' : '#6e6e6e';
  const fg = isDark ? '#F8F8F8' : '#121215';
  const preview = useChangeRequestMergePreview(projectId, cr.cr_id, cr.status === 'open');

  if (cr.status === 'merged') {
    return (
      <Banner tone="info" isDark={isDark}>
        <Text style={{ flex: 1, fontSize: 12.5, color: fg }}>
          Merged as <Text style={{ fontFamily: MONO }}>{shortSha(cr.merge_commit_sha)}</Text> · {relativeTime(cr.merged_at)}
        </Text>
      </Banner>
    );
  }
  if (cr.status !== 'open') return null;
  if (preview.isLoading) {
    return <Banner tone="neutral" isDark={isDark}><ActivityIndicator size="small" color={muted} /><Text style={{ fontSize: 12.5, color: muted, marginLeft: 8 }}>Checking merge…</Text></Banner>;
  }
  const p = preview.data;
  if (!p) return null;
  if (p.is_up_to_date) {
    return <Banner tone="neutral" isDark={isDark}><Text style={{ flex: 1, fontSize: 12.5, color: muted }}>Already at the base — nothing to merge.</Text></Banner>;
  }
  if (p.can_merge) {
    return (
      <Banner tone="success" isDark={isDark}>
        <CircleCheck size={15} color="#16a34a" />
        <Text style={{ flex: 1, fontSize: 12.5, color: '#16a34a', marginLeft: 8 }}>
          Mergeable cleanly ({p.can_fast_forward ? 'fast-forward' : '3-way merge'})
        </Text>
      </Banner>
    );
  }
  return (
    <Banner tone="warn" isDark={isDark} column>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <TriangleAlert size={15} color="#d97706" />
        <Text style={{ fontSize: 12.5, fontFamily: 'Roobert-Medium', color: '#d97706' }}>
          Conflicts in {p.conflicts.length} {p.conflicts.length === 1 ? 'file' : 'files'}
        </Text>
      </View>
      {p.conflicts.map((c) => (
        <Text key={c} style={{ fontSize: 11.5, fontFamily: MONO, color: '#d97706', marginTop: 3 }} numberOfLines={1}>{c}</Text>
      ))}
    </Banner>
  );
}

function Banner({ tone, isDark, column, children }: { tone: 'success' | 'warn' | 'neutral' | 'info'; isDark: boolean; column?: boolean; children: React.ReactNode }) {
  const bg =
    tone === 'success' ? 'rgba(34,197,94,0.08)' :
    tone === 'warn' ? 'rgba(217,119,6,0.08)' :
    tone === 'info' ? 'rgba(139,92,246,0.08)' :
    (isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.03)');
  return (
    <View style={{ flexDirection: column ? 'column' : 'row', alignItems: column ? 'flex-start' : 'center', borderRadius: 12, padding: 12, backgroundColor: bg, marginBottom: 14 }}>
      {children}
    </View>
  );
}

// ─── CR detail sheet ──────────────────────────────────────────────────────────

function CRDetailSheet({
  projectId,
  crId,
  onClose,
  isDark,
}: {
  projectId: string;
  crId: string;
  onClose: () => void;
  isDark: boolean;
}) {
  const theme = useThemeColors();
  const insets = useSafeAreaInsets();
  const crQuery = useChangeRequest(projectId, crId);
  const diffQuery = useChangeRequestDiff(projectId, crId);
  const preview = useChangeRequestMergePreview(projectId, crId, crQuery.data?.status === 'open');
  const mergeMut = useMergeChangeRequest(projectId);
  const closeMut = useCloseChangeRequest(projectId);
  const reopenMut = useReopenChangeRequest(projectId);

  const fg = isDark ? '#F8F8F8' : '#121215';
  const muted = isDark ? '#9b9b9b' : '#6e6e6e';
  const border = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)';
  const closeBg = isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.04)';

  const cr = crQuery.data;
  const parsed = useMemo(() => (diffQuery.data ? parsePatch(diffQuery.data.patch) : null), [diffQuery.data]);

  const doMerge = () => {
    if (!cr) return;
    haptics.tap();
    mergeMut.mutate(
      { crId },
      {
        onSuccess: (r) => {
          haptics.success();
          Alert.alert('Merged', r.merge.fast_forward ? 'Merged (fast-forward).' : `Merged ${shortSha(r.merge.merge_commit_sha)}.`);
        },
        onError: (e: any) => Alert.alert('Merge failed', e?.message || 'Could not merge.'),
      },
    );
  };
  const doClose = () => {
    haptics.medium();
    closeMut.mutate(crId, { onError: (e: any) => Alert.alert('Failed', e?.message || 'Could not reject.') });
  };
  const doReopen = () => {
    haptics.tap();
    reopenMut.mutate(crId, { onError: (e: any) => Alert.alert('Failed', e?.message || 'Could not reopen.') });
  };

  if (crQuery.isLoading || !cr) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 60 }}>
        <ActivityIndicator size="small" color={muted} />
      </View>
    );
  }

  const sm = STATUS_META[cr.status];
  const SIcon = sm.icon;
  const mergeBlocked = cr.status === 'open' && preview.data ? !preview.data.can_merge : false;
  const busy = mergeMut.isPending || closeMut.isPending || reopenMut.isPending;
  const diff = diffQuery.data;

  return (
    <View style={{ flex: 1 }}>
      {/* Header */}
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 12, paddingHorizontal: 16, paddingTop: 4, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: border }}>
        <View style={{ flex: 1 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999, backgroundColor: `${sm.color}22` }}>
              <SIcon size={12} color={sm.color} />
              <Text style={{ fontSize: 11, fontFamily: 'Roobert-Medium', color: sm.color }}>{sm.label}</Text>
            </View>
            <Text style={{ fontSize: 13, fontFamily: 'Roobert-Medium', color: muted }}>#{cr.number}</Text>
          </View>
          <Text style={{ fontSize: 17, fontFamily: 'Roobert-Medium', color: fg }} numberOfLines={2}>{cr.title}</Text>
          <Text style={{ fontSize: 12, color: muted, marginTop: 3 }} numberOfLines={1}>
            {shortRef(cr.head_ref)} → {shortRef(cr.base_ref)} · {statusTime(cr)}
          </Text>
        </View>
        <TouchableOpacity onPress={() => { haptics.tap(); onClose(); }} hitSlop={8} style={{ width: 30, height: 30, borderRadius: 15, backgroundColor: closeBg, alignItems: 'center', justifyContent: 'center' }}>
          <X size={17} color={muted} />
        </TouchableOpacity>
      </View>

      <BottomSheetScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16, paddingBottom: 16 }} showsVerticalScrollIndicator={false}>
        <MergeBanner cr={cr} projectId={projectId} isDark={isDark} />

        {cr.description?.trim() ? (
          <View style={{ marginHorizontal: -16, marginBottom: 10 }}>
            <MarkdownRenderer content={cr.description.trim()} />
          </View>
        ) : null}

        {/* Files changed */}
        {diffQuery.isLoading ? (
          <View style={{ paddingVertical: 30, alignItems: 'center' }}><ActivityIndicator size="small" color={muted} /></View>
        ) : diffQuery.isError ? (
          <Text style={{ fontSize: 13, color: muted }}>Couldn't load the diff.</Text>
        ) : diff && diff.files.length > 0 ? (
          <>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10 }}>
              <Text style={{ fontSize: 11, fontFamily: 'Roobert-Medium', color: muted, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                {diff.files_changed} {diff.files_changed === 1 ? 'file' : 'files'} changed
              </Text>
              <View style={{ flex: 1 }} />
              {diff.additions > 0 && <Text style={{ fontSize: 12, fontFamily: 'Roobert-Medium', color: '#22c55e' }}>+{diff.additions}</Text>}
              {diff.deletions > 0 && <Text style={{ fontSize: 12, fontFamily: 'Roobert-Medium', color: '#ef4444' }}>−{diff.deletions}</Text>}
            </View>
            {diff.files.map((f) => (
              <DiffFile key={f.path} file={f} parsed={parsed?.byPath.get(f.path)} isDark={isDark} />
            ))}
            {parsed?.truncated && (
              <Text style={{ fontSize: 12, color: muted, textAlign: 'center', marginTop: 4 }}>Diff truncated — open on desktop to see the rest.</Text>
            )}
          </>
        ) : (
          <View style={{ paddingVertical: 24, alignItems: 'center' }}>
            <Text style={{ fontSize: 13, color: muted }}>No changes detected.</Text>
          </View>
        )}
      </BottomSheetScrollView>

      {/* Actions footer */}
      {cr.status !== 'merged' && (
        <View style={{ flexDirection: 'row', gap: 10, paddingHorizontal: 16, paddingTop: 8, paddingBottom: insets.bottom + 8, borderTopWidth: 1, borderTopColor: border }}>
          {cr.status === 'open' ? (
            <>
              <TouchableOpacity
                onPress={doClose}
                disabled={busy}
                activeOpacity={0.7}
                style={{ flex: 1, height: 44, borderRadius: 9999, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, borderWidth: 1, borderColor: border, opacity: busy ? 0.5 : 1 }}
              >
                {closeMut.isPending ? <ActivityIndicator size="small" color={muted} /> : <X size={15} color={muted} />}
                <Text style={{ fontSize: 14, fontFamily: 'Roobert-Medium', color: muted }}>Reject</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={doMerge}
                disabled={busy || mergeBlocked}
                activeOpacity={0.85}
                style={{ flex: 1.4, height: 44, borderRadius: 9999, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, backgroundColor: theme.primary, opacity: busy || mergeBlocked ? 0.5 : 1 }}
              >
                {mergeMut.isPending ? <ActivityIndicator size="small" color={theme.primaryForeground} /> : <GitMerge size={15} color={theme.primaryForeground} />}
                <Text style={{ fontSize: 14, fontFamily: 'Roobert-Medium', color: theme.primaryForeground }}>Merge</Text>
              </TouchableOpacity>
            </>
          ) : (
            <TouchableOpacity
              onPress={doReopen}
              disabled={busy}
              activeOpacity={0.85}
              style={{ flex: 1, height: 44, borderRadius: 9999, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, borderWidth: 1, borderColor: border, opacity: busy ? 0.5 : 1 }}
            >
              {reopenMut.isPending ? <ActivityIndicator size="small" color={fg} /> : <GitPullRequest size={15} color={fg} />}
              <Text style={{ fontSize: 14, fontFamily: 'Roobert-Medium', color: fg }}>Reopen</Text>
            </TouchableOpacity>
          )}
        </View>
      )}
    </View>
  );
}

// ─── Rows ─────────────────────────────────────────────────────────────────────

function CRRow({
  cr,
  onPress,
  onMerge,
  onReject,
  onReopen,
  busy,
  isDark,
}: {
  cr: ChangeRequest;
  onPress: () => void;
  onMerge: () => void;
  onReject: () => void;
  onReopen: () => void;
  busy: boolean;
  isDark: boolean;
}) {
  const theme = useThemeColors();
  const fg = isDark ? '#F8F8F8' : '#121215';
  const muted = isDark ? '#9b9b9b' : '#6e6e6e';
  const border = isDark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.12)';
  const sm = STATUS_META[cr.status];
  const Icon = sm.icon;
  return (
    <TouchableOpacity onPress={onPress} activeOpacity={0.6} style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 13, gap: 10 }}>
      <Icon size={20} color={sm.color} />
      <View style={{ flex: 1 }}>
        <Text style={{ fontSize: 15, fontFamily: 'Roobert-Medium', color: fg }} numberOfLines={1}>
          <Text style={{ color: muted }}>#{cr.number} </Text>{cr.title}
        </Text>
        <Text style={{ fontSize: 12.5, color: muted, marginTop: 2 }} numberOfLines={1}>
          {shortRef(cr.head_ref)} → {shortRef(cr.base_ref)} · {statusTime(cr)}
        </Text>
      </View>

      {cr.status === 'open' ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7 }}>
          {busy ? (
            <ActivityIndicator size="small" color={muted} />
          ) : (
            <>
              <TouchableOpacity onPress={onReject} hitSlop={6} style={{ width: 30, height: 30, borderRadius: 15, borderWidth: 1, borderColor: border, alignItems: 'center', justifyContent: 'center' }}>
                <X size={15} color={muted} />
              </TouchableOpacity>
              <TouchableOpacity onPress={onMerge} activeOpacity={0.85} style={{ flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 12, height: 30, borderRadius: 9999, backgroundColor: theme.primary }}>
                <GitMerge size={13} color={theme.primaryForeground} />
                <Text style={{ fontSize: 12.5, fontFamily: 'Roobert-Medium', color: theme.primaryForeground }}>Merge</Text>
              </TouchableOpacity>
            </>
          )}
        </View>
      ) : cr.status === 'closed' ? (
        busy ? (
          <ActivityIndicator size="small" color={muted} />
        ) : (
          <TouchableOpacity onPress={onReopen} activeOpacity={0.7} style={{ paddingHorizontal: 12, height: 30, borderRadius: 9999, borderWidth: 1, borderColor: border, alignItems: 'center', justifyContent: 'center' }}>
            <Text style={{ fontSize: 12.5, fontFamily: 'Roobert-Medium', color: fg }}>Reopen</Text>
          </TouchableOpacity>
        )
      ) : (
        <ChevronRight size={18} color={muted} />
      )}
    </TouchableOpacity>
  );
}

function BranchRow({ branch, isDark }: { branch: ProjectBranch; isDark: boolean }) {
  const theme = useThemeColors();
  const fg = isDark ? '#F8F8F8' : '#121215';
  const muted = isDark ? '#9b9b9b' : '#6e6e6e';
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12, gap: 12 }}>
      <GitBranch size={18} color={muted} />
      <View style={{ flex: 1 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Text style={{ fontSize: 14, fontFamily: MONO, color: fg }} numberOfLines={1}>{shortRef(branch.name)}</Text>
          {branch.is_default && (
            <View style={{ paddingHorizontal: 7, paddingVertical: 1.5, borderRadius: 999, backgroundColor: theme.primaryLight }}>
              <Text style={{ fontSize: 10, fontFamily: 'Roobert-Medium', color: theme.primary }}>default</Text>
            </View>
          )}
        </View>
        <Text style={{ fontSize: 12.5, color: muted, marginTop: 2 }} numberOfLines={1}>
          {branch.subject || 'No commits'}{branch.committed_at ? ` · ${relativeTime(branch.committed_at)}` : ''}
        </Text>
      </View>
      {!branch.is_default && (branch.ahead != null || branch.behind != null) && (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          {branch.ahead ? <Text style={{ fontSize: 12, fontFamily: 'Roobert-Medium', color: '#22c55e' }}>↑{branch.ahead}</Text> : null}
          {branch.behind ? <Text style={{ fontSize: 12, fontFamily: 'Roobert-Medium', color: '#ef4444' }}>↓{branch.behind}</Text> : null}
        </View>
      )}
    </View>
  );
}

// ─── Open a change request (create) ───────────────────────────────────────────

function BranchPills({
  options,
  value,
  onSelect,
  isDark,
}: {
  options: ProjectBranch[];
  value: string | null;
  onSelect: (name: string) => void;
  isDark: boolean;
}) {
  const theme = useThemeColors();
  const fg = isDark ? '#F8F8F8' : '#121215';
  const muted = isDark ? '#9b9b9b' : '#6e6e6e';
  const border = isDark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.12)';
  if (options.length === 0) {
    return <Text style={{ fontSize: 13, color: muted }}>No other versions.</Text>;
  }
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingVertical: 2 }} keyboardShouldPersistTaps="handled">
      {options.map((b) => {
        const on = value === b.name;
        return (
          <TouchableOpacity
            key={b.name}
            onPress={() => { haptics.selection(); onSelect(b.name); }}
            activeOpacity={0.7}
            style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 9999, borderWidth: 1.5, borderColor: on ? theme.primary : border, backgroundColor: on ? theme.primaryLight : 'transparent' }}
          >
            <GitBranch size={13} color={on ? theme.primary : muted} />
            <Text style={{ fontSize: 13, fontFamily: MONO, color: on ? theme.primary : fg }}>{shortRef(b.name)}</Text>
            {b.is_default && <Text style={{ fontSize: 10, fontFamily: 'Roobert-Medium', color: muted }}>default</Text>}
          </TouchableOpacity>
        );
      })}
    </ScrollView>
  );
}

function OpenCRSheet({
  projectId,
  onClose,
  onCreated,
  isDark,
}: {
  projectId: string;
  onClose: () => void;
  onCreated: (crId: string, number: number) => void;
  isDark: boolean;
}) {
  const theme = useThemeColors();
  const insets = useSafeAreaInsets();
  const branchesQuery = useProjectBranches(projectId, true);
  const createMut = useOpenChangeRequest(projectId);

  const defaultBranch = branchesQuery.data?.default_branch ?? '';
  const allBranches = branchesQuery.data?.branches ?? [];
  const headOptions = useMemo(() => allBranches.filter((b) => !b.is_default), [allBranches]);

  const [headRef, setHeadRef] = useState<string | null>(null);
  const [baseRef, setBaseRef] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');

  useEffect(() => {
    if (!baseRef && defaultBranch) setBaseRef(defaultBranch);
  }, [defaultBranch, baseRef]);

  const vdiff = useVersionDiff(projectId, headRef ?? '', baseRef ?? '', !!headRef && !!baseRef && headRef !== baseRef);
  const preview = vdiff.data;
  const hasChanges = !!preview && !preview.is_same_ref && !preview.is_up_to_date && preview.files_changed > 0;
  const canSubmit = title.trim().length > 0 && !!headRef && !!baseRef && headRef !== baseRef && !vdiff.isLoading && hasChanges && !createMut.isPending;

  const fg = isDark ? '#F8F8F8' : '#121215';
  const muted = isDark ? '#9b9b9b' : '#6e6e6e';
  const border = isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.12)';
  const inputBg = isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.03)';
  const closeBg = isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.04)';

  const submit = () => {
    if (!canSubmit || !headRef || !baseRef) return;
    haptics.tap();
    createMut.mutate(
      { title: title.trim(), description: description.trim() || undefined, head_ref: headRef, base_ref: baseRef },
      {
        onSuccess: (cr) => { haptics.success(); onCreated(cr.cr_id, cr.number); },
        onError: (e: any) => Alert.alert('Failed', e?.message || 'Could not open change request.'),
      },
    );
  };

  return (
    <View style={{ flex: 1 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingTop: 4, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)' }}>
        <Text style={{ flex: 1, fontSize: 18, fontFamily: 'Roobert-Medium', color: fg }}>Open a change request</Text>
        <TouchableOpacity onPress={() => { haptics.tap(); onClose(); }} hitSlop={8} style={{ width: 30, height: 30, borderRadius: 15, backgroundColor: closeBg, alignItems: 'center', justifyContent: 'center' }}>
          <X size={17} color={muted} />
        </TouchableOpacity>
      </View>

      <BottomSheetScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16 }} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
        {branchesQuery.isLoading ? (
          <View style={{ paddingVertical: 40, alignItems: 'center' }}><ActivityIndicator size="small" color={muted} /></View>
        ) : headOptions.length === 0 ? (
          <View style={{ paddingVertical: 30, alignItems: 'center', gap: 8 }}>
            <GitCompare size={24} color={muted} />
            <Text style={{ fontSize: 13.5, color: muted, textAlign: 'center' }}>No other versions to propose. Start a session to make changes first.</Text>
          </View>
        ) : (
          <>
            <Text style={{ fontSize: 12, fontFamily: 'Roobert-Medium', color: muted, marginBottom: 8 }}>From version</Text>
            <BranchPills options={headOptions} value={headRef} onSelect={setHeadRef} isDark={isDark} />

            <Text style={{ fontSize: 12, fontFamily: 'Roobert-Medium', color: muted, marginTop: 16, marginBottom: 8 }}>Into</Text>
            <BranchPills options={allBranches} value={baseRef} onSelect={setBaseRef} isDark={isDark} />

            {/* Diff preview */}
            {headRef && baseRef && headRef !== baseRef && (
              <View style={{ marginTop: 14, padding: 12, borderRadius: 12, backgroundColor: inputBg }}>
                {vdiff.isLoading ? (
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}><ActivityIndicator size="small" color={muted} /><Text style={{ fontSize: 12.5, color: muted }}>Comparing…</Text></View>
                ) : !hasChanges ? (
                  <Text style={{ fontSize: 12.5, color: muted }}>
                    {preview?.is_same_ref ? 'Same version — pick a different one.' : 'Nothing to merge — these versions are already in sync.'}
                  </Text>
                ) : (
                  <Text style={{ fontSize: 12.5, color: fg }}>
                    {preview!.files_changed} {preview!.files_changed === 1 ? 'file' : 'files'} changed{'  '}
                    <Text style={{ color: '#22c55e', fontFamily: 'Roobert-Medium' }}>+{preview!.additions}</Text>{' '}
                    <Text style={{ color: '#ef4444', fontFamily: 'Roobert-Medium' }}>−{preview!.deletions}</Text>
                  </Text>
                )}
              </View>
            )}

            <Text style={{ fontSize: 12, fontFamily: 'Roobert-Medium', color: muted, marginTop: 18, marginBottom: 6 }}>Title</Text>
            <BottomSheetTextInput
              value={title}
              onChangeText={setTitle}
              placeholder={headRef ? `Changes from ${shortRef(headRef)}` : 'What does this change?'}
              placeholderTextColor={muted}
              style={{ height: 44, borderRadius: 11, borderWidth: 1, borderColor: border, backgroundColor: inputBg, paddingHorizontal: 12, fontSize: 14, color: fg, fontFamily: 'Roobert' }}
            />

            <Text style={{ fontSize: 12, fontFamily: 'Roobert-Medium', color: muted, marginTop: 14, marginBottom: 6 }}>Description  ·  optional</Text>
            <BottomSheetTextInput
              value={description}
              onChangeText={setDescription}
              placeholder="Add context for reviewers…"
              placeholderTextColor={muted}
              multiline
              style={{ minHeight: 88, borderRadius: 11, borderWidth: 1, borderColor: border, backgroundColor: inputBg, paddingHorizontal: 12, paddingTop: 10, paddingBottom: 10, fontSize: 14, color: fg, fontFamily: 'Roobert', textAlignVertical: 'top' }}
            />
          </>
        )}
      </BottomSheetScrollView>

      <View style={{ paddingHorizontal: 16, paddingTop: 8, paddingBottom: insets.bottom + 8, borderTopWidth: 1, borderTopColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)' }}>
        <TouchableOpacity
          onPress={submit}
          disabled={!canSubmit}
          activeOpacity={0.85}
          style={{ height: 46, borderRadius: 9999, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 8, backgroundColor: theme.primary, opacity: canSubmit ? 1 : 0.5 }}
        >
          {createMut.isPending && <ActivityIndicator size="small" color={theme.primaryForeground} />}
          <Text style={{ fontSize: 15, fontFamily: 'Roobert-Medium', color: theme.primaryForeground }}>Open change request</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

const STATUS_FILTERS: ChangeRequestStatus[] = ['open', 'merged', 'closed'];

export function ChangesPage({
  page,
  projectId,
  onOpenDrawer,
  onOpenRightDrawer,
  isDrawerOpen,
  isRightDrawerOpen,
}: ChangesPageProps) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const insets = useSafeAreaInsets();
  const [tab, setTab] = useState<'requests' | 'versions'>('requests');
  const [status, setStatus] = useState<ChangeRequestStatus>('open');
  const [selectedCrId, setSelectedCrId] = useState<string | null>(null);
  const detailSheetRef = React.useRef<BottomSheetModal>(null);
  const createSheetRef = React.useRef<BottomSheetModal>(null);

  const crs = useChangeRequests(projectId, status);
  const branches = useProjectBranches(projectId, tab === 'versions');
  const mergeMut = useMergeChangeRequest(projectId);
  const closeMut = useCloseChangeRequest(projectId);
  const reopenMut = useReopenChangeRequest(projectId);

  const rowBusy = (cr: ChangeRequest) =>
    (mergeMut.isPending && mergeMut.variables?.crId === cr.cr_id) ||
    (closeMut.isPending && closeMut.variables === cr.cr_id) ||
    (reopenMut.isPending && reopenMut.variables === cr.cr_id);

  const rowMerge = (cr: ChangeRequest) => {
    haptics.tap();
    mergeMut.mutate({ crId: cr.cr_id }, {
      onSuccess: (r) => { haptics.success(); Alert.alert('Merged', r.merge.fast_forward ? 'Merged (fast-forward).' : `Merged ${shortSha(r.merge.merge_commit_sha)}.`); },
      onError: (e: any) => Alert.alert('Merge failed', e?.message || 'Could not merge.'),
    });
  };
  const rowReject = (cr: ChangeRequest) => {
    haptics.medium();
    closeMut.mutate(cr.cr_id, { onError: (e: any) => Alert.alert('Failed', e?.message || 'Could not reject.') });
  };
  const rowReopen = (cr: ChangeRequest) => {
    haptics.tap();
    reopenMut.mutate(cr.cr_id, { onError: (e: any) => Alert.alert('Failed', e?.message || 'Could not reopen.') });
  };

  const bgColor = isDark ? '#090909' : '#FFFFFF';
  const fg = isDark ? '#F8F8F8' : '#121215';
  const muted = isDark ? '#9b9b9b' : '#6e6e6e';
  const border = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)';
  const segBg = isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.04)';
  const segOn = isDark ? 'rgba(255,255,255,0.12)' : '#FFFFFF';

  const list = crs.data?.change_requests ?? [];

  const openRow = (cr: ChangeRequest) => {
    haptics.tap();
    setSelectedCrId(cr.cr_id);
    detailSheetRef.current?.present();
  };

  return (
    <View style={{ flex: 1, backgroundColor: bgColor }}>
      <PageHeader
        title={page.label}
        onOpenDrawer={onOpenDrawer}
        onOpenRightDrawer={onOpenRightDrawer}
        isDrawerOpen={isDrawerOpen}
        isRightDrawerOpen={isRightDrawerOpen}
        rightActions={
          tab === 'requests' ? (
            <TouchableOpacity onPress={() => { haptics.tap(); createSheetRef.current?.present(); }} className="p-1 mr-1" hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Plus size={20} color={isDark ? '#F8F8F8' : '#121215'} />
            </TouchableOpacity>
          ) : undefined
        }
      />

      <PageContent>
        {/* Tabs */}
        <View style={{ paddingHorizontal: 16, paddingTop: 8 }}>
          <View style={{ flexDirection: 'row', backgroundColor: segBg, borderRadius: 9999, padding: 3 }}>
            {(['requests', 'versions'] as const).map((t) => {
              const on = tab === t;
              return (
                <TouchableOpacity key={t} onPress={() => { haptics.selection(); setTab(t); }} activeOpacity={0.7}
                  style={{ flex: 1, paddingVertical: 8, borderRadius: 9999, alignItems: 'center', backgroundColor: on ? segOn : 'transparent' }}>
                  <Text style={{ fontSize: 13, fontFamily: on ? 'Roobert-Medium' : 'Roobert', color: on ? fg : muted }}>
                    {t === 'requests' ? 'Change requests' : 'Versions'}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>

        {tab === 'requests' ? (
          <>
            {/* Status filter pills */}
            <View style={{ flexDirection: 'row', gap: 8, paddingHorizontal: 16, paddingTop: 12, paddingBottom: 4 }}>
              {STATUS_FILTERS.map((s) => {
                const on = status === s;
                const sm = STATUS_META[s];
                return (
                  <TouchableOpacity key={s} onPress={() => { haptics.selection(); setStatus(s); }} activeOpacity={0.7}
                    style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, paddingVertical: 7, borderRadius: 9999, borderWidth: 1.5, borderColor: on ? sm.color : border, backgroundColor: on ? `${sm.color}1a` : 'transparent' }}>
                    <Text style={{ fontSize: 13, fontFamily: 'Roobert-Medium', color: on ? sm.color : muted }}>{sm.label}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: insets.bottom + 40 }} showsVerticalScrollIndicator={false}>
              {crs.isLoading ? (
                <View style={{ paddingVertical: 48, alignItems: 'center' }}><ActivityIndicator size="small" color={muted} /></View>
              ) : crs.isError ? (
                <View style={{ padding: 24, alignItems: 'center', gap: 12 }}>
                  <Text style={{ fontSize: 14, color: muted, textAlign: 'center' }}>{(crs.error as Error)?.message ?? 'Failed to load change requests'}</Text>
                  <TouchableOpacity onPress={() => crs.refetch()} style={{ paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999, borderWidth: 1, borderColor: border }}>
                    <Text style={{ fontSize: 13, fontFamily: 'Roobert-Medium', color: fg }}>Retry</Text>
                  </TouchableOpacity>
                </View>
              ) : list.length === 0 ? (
                <View style={{ padding: 40, alignItems: 'center', gap: 10 }}>
                  <GitPullRequest size={26} color={muted} />
                  <Text style={{ fontSize: 15, fontFamily: 'Roobert-Medium', color: fg, textAlign: 'center' }}>No {status} change requests</Text>
                  <Text style={{ fontSize: 13, lineHeight: 19, color: muted, textAlign: 'center', paddingHorizontal: 12 }}>
                    {status === 'open'
                      ? 'When a session proposes changes, they show up here to review and merge into the base branch.'
                      : `Nothing ${status} yet.`}
                  </Text>
                </View>
              ) : (
                list.map((cr, i) => (
                  <View key={cr.cr_id}>
                    <CRRow
                      cr={cr}
                      onPress={() => openRow(cr)}
                      onMerge={() => rowMerge(cr)}
                      onReject={() => rowReject(cr)}
                      onReopen={() => rowReopen(cr)}
                      busy={rowBusy(cr)}
                      isDark={isDark}
                    />
                    {i < list.length - 1 && <View style={{ height: 1, backgroundColor: border, marginLeft: 48 }} />}
                  </View>
                ))
              )}
            </ScrollView>
          </>
        ) : (
          <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingTop: 6, paddingBottom: insets.bottom + 40 }} showsVerticalScrollIndicator={false}>
            {branches.isLoading ? (
              <View style={{ paddingVertical: 48, alignItems: 'center' }}><ActivityIndicator size="small" color={muted} /></View>
            ) : branches.isError ? (
              <View style={{ padding: 24, alignItems: 'center', gap: 12 }}>
                <Text style={{ fontSize: 14, color: muted, textAlign: 'center' }}>{(branches.error as Error)?.message ?? 'Failed to load versions'}</Text>
                <TouchableOpacity onPress={() => branches.refetch()} style={{ paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999, borderWidth: 1, borderColor: border }}>
                  <Text style={{ fontSize: 13, fontFamily: 'Roobert-Medium', color: fg }}>Retry</Text>
                </TouchableOpacity>
              </View>
            ) : (branches.data?.branches.length ?? 0) === 0 ? (
              <View style={{ padding: 40, alignItems: 'center', gap: 10 }}>
                <GitBranch size={26} color={muted} />
                <Text style={{ fontSize: 14, color: muted, textAlign: 'center' }}>No versions.</Text>
              </View>
            ) : (
              (branches.data?.branches ?? []).map((b, i) => (
                <View key={b.name}>
                  <BranchRow branch={b} isDark={isDark} />
                  {i < (branches.data?.branches.length ?? 0) - 1 && <View style={{ height: 1, backgroundColor: border, marginLeft: 48 }} />}
                </View>
              ))
            )}
          </ScrollView>
        )}
      </PageContent>

      {/* CR detail */}
      <BottomSheetModal
        ref={detailSheetRef}
        snapPoints={['94%']}
        enableDynamicSizing={false}
        onDismiss={() => setSelectedCrId(null)}
        backgroundStyle={{ backgroundColor: getSheetBg(isDark) }}
        handleIndicatorStyle={{ backgroundColor: isDark ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.2)' }}
        backdropComponent={(props) => <BottomSheetBackdrop {...props} disappearsOnIndex={-1} appearsOnIndex={0} opacity={0.5} />}
      >
        {selectedCrId ? (
          <CRDetailSheet projectId={projectId} crId={selectedCrId} onClose={() => detailSheetRef.current?.dismiss()} isDark={isDark} />
        ) : (
          <View style={{ height: 1 }} />
        )}
      </BottomSheetModal>

      {/* Open a change request */}
      <BottomSheetModal
        ref={createSheetRef}
        snapPoints={['88%']}
        enableDynamicSizing={false}
        backgroundStyle={{ backgroundColor: getSheetBg(isDark) }}
        handleIndicatorStyle={{ backgroundColor: isDark ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.2)' }}
        keyboardBehavior="interactive"
        keyboardBlurBehavior="restore"
        backdropComponent={(props) => <BottomSheetBackdrop {...props} disappearsOnIndex={-1} appearsOnIndex={0} opacity={0.5} />}
      >
        <OpenCRSheet
          projectId={projectId}
          onClose={() => createSheetRef.current?.dismiss()}
          onCreated={(crId, number) => {
            createSheetRef.current?.dismiss();
            setStatus('open');
            setSelectedCrId(crId);
            setTimeout(() => detailSheetRef.current?.present(), 250);
            Alert.alert('Change request opened', `Opened change request #${number}.`);
          }}
          isDark={isDark}
        />
      </BottomSheetModal>
    </View>
  );
}
