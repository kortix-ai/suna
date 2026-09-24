/**
 * OpenCRSheet — open a change request: pick the "from" and "into" versions,
 * preview the diff size, add a title and an optional description. The
 * Review page's `+` opens it (`ReviewPage`).
 *
 * Moved from the deleted Changes page (`components/pages/ChangesPage`,
 * COR-156), which had no entry point; only this sheet and `shortRef` were
 * still used. Unchanged except the branch pills' mono text, which now uses
 * `MONO_FONT_FAMILY` in place of Menlo.
 */

import { useEffect, useMemo, useState } from 'react';
import { View, Pressable, ScrollView, ActivityIndicator } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BottomSheetScrollView, BottomSheetTextInput } from '@gorhom/bottom-sheet';
import { GitBranchIcon as GitBranch, GitDiffIcon as GitCompare } from '@/lib/icons';
import { Text } from '@/components/ui/text';
import { SheetTitleRow } from '@/components/kortix/sheet';
import { useThemeColors } from '@/lib/theme-colors';
import { THEME, withAlpha } from '@/lib/utils/theme';
import { MONO_FONT_FAMILY } from '@/lib/utils/mono-font';
import { useOpenChangeRequest, useProjectBranches, useVersionDiff } from '@/lib/projects/hooks';
import type { ProjectBranch } from '@/lib/projects/projects-client';
import { haptics } from '@/lib/haptics';
import { useToast } from '@/components/kortix/toast-provider';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A branch name for display: a UUID branch shows its first 8 characters. */
export const shortRef = (ref: string) => (UUID_RE.test(ref) ? ref.slice(0, 8) : ref);

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
  const fg = isDark ? THEME.dark.foreground : THEME.light.foreground;
  const muted = isDark ? THEME.dark.mutedForeground : THEME.light.mutedForeground;
  const border = isDark ? withAlpha(THEME.dark.foreground, 0.12) : withAlpha(THEME.light.foreground, 0.12);
  if (options.length === 0) {
    return <Text style={{ fontSize: 13, color: muted }}>No other versions.</Text>;
  }
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingVertical: 2 }} keyboardShouldPersistTaps="handled">
      {options.map((b) => {
        const on = value === b.name;
        return (
          <Pressable
            key={b.name}
            onPress={() => { haptics.selection(); onSelect(b.name); }}
            style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 9999, borderWidth: 1.5, borderColor: on ? theme.primary : border, backgroundColor: on ? theme.primaryLight : 'transparent' }}
          >
            <GitBranch size={13} color={on ? theme.primary : muted} />
            <Text style={{ fontSize: 13, fontFamily: MONO_FONT_FAMILY, color: on ? theme.primary : fg }}>{shortRef(b.name)}</Text>
            {b.is_default && <Text style={{ fontSize: 10, fontFamily: 'Roobert-Medium', color: muted }}>default</Text>}
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

export function OpenCRSheet({
  projectId,
  onClose,
  onCreated,
  isDark,
  initialHeadRef,
  initialBaseRef,
  initialTitle,
}: {
  projectId: string;
  onClose: () => void;
  onCreated: (crId: string, number: number) => void;
  isDark: boolean;
  initialHeadRef?: string | null;
  initialBaseRef?: string | null;
  initialTitle?: string;
}) {
  const theme = useThemeColors();
  const insets = useSafeAreaInsets();
  const branchesQuery = useProjectBranches(projectId, true);
  const createMut = useOpenChangeRequest(projectId);
  const toast = useToast();

  const defaultBranch = branchesQuery.data?.default_branch ?? '';
  const allBranches = branchesQuery.data?.branches ?? [];
  const headOptions = useMemo(() => allBranches.filter((b) => !b.is_default), [allBranches]);

  const [headRef, setHeadRef] = useState<string | null>(initialHeadRef ?? null);
  const [baseRef, setBaseRef] = useState<string | null>(initialBaseRef ?? null);
  const [title, setTitle] = useState(initialTitle ?? '');
  const [description, setDescription] = useState('');

  useEffect(() => {
    setHeadRef(initialHeadRef ?? null);
  }, [initialHeadRef]);

  useEffect(() => {
    setTitle(initialTitle ?? '');
    setDescription('');
  }, [initialTitle, initialHeadRef, initialBaseRef]);

  useEffect(() => {
    if (initialBaseRef) {
      setBaseRef(initialBaseRef);
    } else if (!baseRef && defaultBranch) {
      setBaseRef(defaultBranch);
    }
  }, [initialBaseRef, defaultBranch, baseRef]);

  const vdiff = useVersionDiff(projectId, headRef ?? '', baseRef ?? '', !!headRef && !!baseRef && headRef !== baseRef);
  const preview = vdiff.data;
  const hasChanges = !!preview && !preview.is_same_ref && !preview.is_up_to_date && preview.files_changed > 0;
  const canSubmit = title.trim().length > 0 && !!headRef && !!baseRef && headRef !== baseRef && !vdiff.isLoading && hasChanges && !createMut.isPending;

  const fg = isDark ? THEME.dark.foreground : THEME.light.foreground;
  const muted = isDark ? THEME.dark.mutedForeground : THEME.light.mutedForeground;
  const border = isDark ? withAlpha(THEME.dark.foreground, 0.1) : withAlpha(THEME.light.foreground, 0.12);
  const inputBg = isDark ? withAlpha(THEME.dark.foreground, 0.05) : withAlpha(THEME.light.foreground, 0.03);

  const submit = () => {
    if (!canSubmit || !headRef || !baseRef) return;
    haptics.tap();
    createMut.mutate(
      { title: title.trim(), description: description.trim() || undefined, head_ref: headRef, base_ref: baseRef },
      {
        onSuccess: (cr) => { haptics.success(); onCreated(cr.cr_id, cr.number); },
        onError: (e: any) => toast.error(e?.message || 'Could not open change request.'),
      },
    );
  };

  return (
    <View style={{ flex: 1 }}>
      <SheetTitleRow title="Open a change request" onClose={() => { haptics.tap(); onClose(); }} />

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
                    <Text style={{ color: THEME.accent.green, fontFamily: 'Roobert-Medium' }}>+{preview!.additions}</Text>{' '}
                    <Text style={{ color: isDark ? THEME.dark.destructive : THEME.light.destructive, fontFamily: 'Roobert-Medium' }}>−{preview!.deletions}</Text>
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

      <View style={{ paddingHorizontal: 16, paddingTop: 8, paddingBottom: insets.bottom + 8, borderTopWidth: 1, borderTopColor: isDark ? withAlpha(THEME.dark.foreground, 0.08) : withAlpha(THEME.light.foreground, 0.08) }}>
        <Pressable
          onPress={submit}
          disabled={!canSubmit}
          style={{ height: 46, borderRadius: 9999, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 8, backgroundColor: theme.primary, opacity: canSubmit ? 1 : 0.5 }}
        >
          {createMut.isPending && <ActivityIndicator size="small" color={theme.primaryForeground} />}
          <Text style={{ fontSize: 15, fontFamily: 'Roobert-Medium', color: theme.primaryForeground }}>Open change request</Text>
        </Pressable>
      </View>
    </View>
  );
}
