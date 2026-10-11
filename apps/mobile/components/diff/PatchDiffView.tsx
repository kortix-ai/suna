/**
 * Shared unified-diff renderer for git patches. Used by the Changes page (CR
 * diffs) and the Files page (file-history checkpoint diffs).
 *
 * `parsePatch` splits a concatenated `git diff` per-file into renderable rows;
 * `DiffFile` renders one file given a summary entry; `PatchDiffView` renders a
 * whole standalone patch (no summary needed — counts/status inferred).
 */

import React, { useMemo } from 'react';
import { View, ScrollView } from 'react-native';
import { Text } from '@/components/ui/text';
import { FilePlusIcon as FilePlus, FileMinusIcon as FileMinus, NotePencilIcon as FilePen, type AppIcon } from '@/lib/icons';
import type { ProjectCommitFile } from '@/lib/projects/projects-client';
import { MONO_FONT_FAMILY } from '@/lib/utils/mono-font';
import { THEME, withAlpha } from '@/lib/utils/theme';
import { parsePatch, type DiffRow } from '@/lib/diff/parse-patch';

const MONO = MONO_FONT_FAMILY;

export function fileStatusMeta(status: ProjectCommitFile['status'], isDark = false): { icon: AppIcon; color: string } {
  if (status === 'added') return { icon: FilePlus, color: THEME.accent.green };
  if (status === 'deleted') return { icon: FileMinus, color: isDark ? THEME.dark.destructive : THEME.light.destructive };
  return { icon: FilePen, color: THEME.accent.blue };
}


/**
 * The one diff-row paint for every patch renderer: a right-aligned line-number
 * gutter (44pt), sign-prefixed content in the mono face, and the theme's
 * add/delete/hunk washes. `wrap` flexes the content to the container width
 * (a vertical list); without it the row keeps its natural width and scrolls
 * horizontally.
 */
interface DiffRowPalette {
  fg: string;
  muted: string;
  add: string;
  del: string;
  hunk: string;
  addBg: string;
  delBg: string;
  hunkBg: string;
}

export function diffRowPalette(isDark: boolean): DiffRowPalette {
  const theme = isDark ? THEME.dark : THEME.light;
  return {
    fg: theme.foreground,
    muted: theme.mutedForeground,
    add: THEME.accent.green,
    del: theme.destructive,
    hunk: THEME.accent.purple,
    addBg: withAlpha(THEME.accent.green, isDark ? 0.14 : 0.12),
    delBg: withAlpha(theme.destructive, isDark ? 0.14 : 0.1),
    hunkBg: withAlpha(THEME.accent.purple, isDark ? 0.12 : 0.08),
  };
}

export const DiffRowView = React.memo(function DiffRowView({
  row,
  palette,
  wrap = false,
}: {
  row: DiffRow;
  palette: DiffRowPalette;
  wrap?: boolean;
}) {
  const bg =
    row.kind === 'add' ? palette.addBg : row.kind === 'del' ? palette.delBg : row.kind === 'hunk' ? palette.hunkBg : undefined;
  const color =
    row.kind === 'add' ? palette.add : row.kind === 'del' ? palette.del : row.kind === 'hunk' ? palette.hunk : palette.fg;
  const sign = row.kind === 'add' ? '+' : row.kind === 'del' ? '−' : ' ';
  return (
    <View style={{ flexDirection: 'row', alignItems: 'flex-start', backgroundColor: bg, paddingVertical: 1, minHeight: 18 }}>
      <Text
        style={{ width: 44, textAlign: 'right', paddingRight: 8, fontSize: 11, lineHeight: 18, fontFamily: MONO_FONT_FAMILY, color: palette.muted }}>
        {row.kind === 'hunk' ? '' : (row.num ?? '')}
      </Text>
      <Text style={{ flex: wrap ? 1 : undefined, fontSize: 12, lineHeight: 18, fontFamily: MONO_FONT_FAMILY, color, paddingRight: 12 }}>
        {row.kind === 'hunk' ? row.text : `${sign} ${row.text}`}
      </Text>
    </View>
  );
});

function DiffFile({
  file,
  parsed,
  isDark,
}: {
  file: ProjectCommitFile;
  parsed: { binary: boolean; rows: DiffRow[] } | undefined;
  isDark: boolean;
}) {
  const fg = isDark ? THEME.dark.foreground : THEME.light.foreground;
  const muted = isDark ? THEME.dark.mutedForeground : THEME.light.mutedForeground;
  const border = isDark ? THEME.dark.border : THEME.light.border;
  const codeBg = isDark ? withAlpha(THEME.dark.foreground, 0.02) : withAlpha(THEME.light.foreground, 0.015);
  const palette = useMemo(() => diffRowPalette(isDark), [isDark]);
  const meta = fileStatusMeta(file.status, isDark);
  const Icon = meta.icon;

  return (
    <View style={{ borderWidth: 1, borderColor: border, borderRadius: 12, marginBottom: 10, overflow: 'hidden' }}>
      {/* File header */}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 9, borderBottomWidth: parsed && parsed.rows.length ? 1 : 0, borderBottomColor: border }}>
        <Icon size={14} color={meta.color} />
        <Text style={{ flex: 1, fontSize: 12.5, fontFamily: MONO, color: fg }} numberOfLines={1}>
          {file.old_path && file.old_path !== file.path ? `${file.old_path} → ${file.path}` : file.path}
        </Text>
        {file.additions > 0 && <Text className="text-kortix-green" style={{ fontSize: 11.5, fontFamily: 'Roobert-Medium' }}>+{file.additions}</Text>}
        {file.deletions > 0 && <Text className="text-destructive" style={{ fontSize: 11.5, fontFamily: 'Roobert-Medium' }}>−{file.deletions}</Text>}
      </View>

      {parsed?.binary ? (
        <Text style={{ fontSize: 12, color: muted, padding: 12 }}>Binary file — not shown.</Text>
      ) : parsed && parsed.rows.length > 0 ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ backgroundColor: codeBg }}>
          <View>
            {parsed.rows.map((row, i) => (
              <DiffRowView key={i} row={row} palette={palette} />
            ))}
          </View>
        </ScrollView>
      ) : null}
    </View>
  );
}

/** Render a whole standalone git patch (e.g. a commit's diff). */
export function PatchDiffView({
  patch,
  isDark,
  maxRows,
}: {
  patch: string;
  isDark: boolean;
  /** Row cap across the patch (`parsePatch`). Default `MAX_DIFF_ROWS`. */
  maxRows?: number;
}) {
  const muted = isDark ? THEME.dark.mutedForeground : THEME.light.mutedForeground;
  const { byPath, truncated } = useMemo(() => parsePatch(patch, maxRows), [patch, maxRows]);

  if (byPath.size === 0) {
    return <Text style={{ fontSize: 13, color: muted }}>No changes in this checkpoint.</Text>;
  }
  return (
    <View>
      {[...byPath.entries()].map(([path, parsed]) => {
        const additions = parsed.rows.filter((r) => r.kind === 'add').length;
        const deletions = parsed.rows.filter((r) => r.kind === 'del').length;
        const status: ProjectCommitFile['status'] =
          deletions === 0 && additions > 0 ? 'added' : additions === 0 && deletions > 0 ? 'deleted' : 'modified';
        const file: ProjectCommitFile = { path, old_path: null, status, additions, deletions };
        return <DiffFile key={path} file={file} parsed={parsed} isDark={isDark} />;
      })}
      {truncated && (
        <Text style={{ fontSize: 12, color: muted, textAlign: 'center', marginTop: 4 }}>Diff truncated — open on desktop to see the rest.</Text>
      )}
    </View>
  );
}
