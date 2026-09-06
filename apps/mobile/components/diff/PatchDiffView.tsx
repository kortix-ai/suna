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
import { FilePlus, FileMinus, FilePen, type LucideIcon } from 'lucide-react-native';
import type { ProjectCommitFile } from '@/lib/projects/projects-client';
import { THEME, withAlpha } from '@/lib/utils/theme';

const MONO = 'Menlo';
const MAX_DIFF_ROWS = 2000;

export interface DiffRow {
  kind: 'hunk' | 'add' | 'del' | 'ctx';
  num: number | null;
  text: string;
}

export function fileStatusMeta(status: ProjectCommitFile['status'], isDark = false): { icon: LucideIcon; color: string } {
  if (status === 'added') return { icon: FilePlus, color: THEME.accent.green };
  if (status === 'deleted') return { icon: FileMinus, color: isDark ? THEME.dark.destructive : THEME.light.destructive };
  return { icon: FilePen, color: THEME.accent.blue };
}

/** Split the concatenated git patch per-file and parse each into renderable rows. */
export function parsePatch(patch: string): { byPath: Map<string, { binary: boolean; rows: DiffRow[] }>; truncated: boolean } {
  const byPath = new Map<string, { binary: boolean; rows: DiffRow[] }>();
  let total = 0;
  let truncated = false;
  if (!patch) return { byPath, truncated };

  const chunks = patch.split(/^(?=diff --git )/m).filter((c) => c.trim().length > 0);
  for (const chunk of chunks) {
    const header = chunk.match(/^diff --git a\/(?:.*?) b\/(.+?)$/m);
    const path = header?.[1]?.trim();
    if (!path) continue;

    const rows: DiffRow[] = [];
    let binary = false;
    let oldLine = 0;
    let newLine = 0;

    for (const line of chunk.split('\n')) {
      if (
        line.startsWith('diff --git') ||
        line.startsWith('index ') ||
        line.startsWith('--- ') ||
        line.startsWith('+++ ') ||
        line.startsWith('new file mode') ||
        line.startsWith('deleted file mode') ||
        line.startsWith('old mode') ||
        line.startsWith('new mode') ||
        line.startsWith('rename from') ||
        line.startsWith('rename to') ||
        line.startsWith('copy from') ||
        line.startsWith('copy to') ||
        line.startsWith('similarity index') ||
        line.startsWith('dissimilarity index') ||
        line.startsWith('\\ No newline')
      ) {
        if (line.startsWith('Binary files')) binary = true;
        continue;
      }
      if (line.startsWith('Binary files')) {
        binary = true;
        continue;
      }
      if (line.startsWith('@@')) {
        const m = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
        if (m) {
          oldLine = parseInt(m[1], 10);
          newLine = parseInt(m[2], 10);
        }
        rows.push({ kind: 'hunk', num: null, text: line });
        total++;
      } else if (line.startsWith('+')) {
        rows.push({ kind: 'add', num: newLine, text: line.slice(1) });
        newLine++;
        total++;
      } else if (line.startsWith('-')) {
        rows.push({ kind: 'del', num: oldLine, text: line.slice(1) });
        oldLine++;
        total++;
      } else if (line.startsWith(' ')) {
        rows.push({ kind: 'ctx', num: newLine, text: line.slice(1) });
        oldLine++;
        newLine++;
        total++;
      }
      if (total >= MAX_DIFF_ROWS) {
        truncated = true;
        break;
      }
    }
    byPath.set(path, { binary, rows });
    if (truncated) break;
  }
  return { byPath, truncated };
}

export function DiffFile({
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
  const addBg = isDark ? withAlpha(THEME.accent.green, 0.14) : withAlpha(THEME.accent.green, 0.12);
  const delBg = isDark ? withAlpha(THEME.dark.destructive, 0.14) : withAlpha(THEME.light.destructive, 0.10);
  const hunkBg = isDark ? withAlpha(THEME.accent.purple, 0.12) : withAlpha(THEME.accent.purple, 0.08);
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
            {parsed.rows.map((row, i) => {
              const bg = row.kind === 'add' ? addBg : row.kind === 'del' ? delBg : row.kind === 'hunk' ? hunkBg : 'transparent';
              const color = row.kind === 'hunk'
                ? THEME.accent.purple
                : row.kind === 'add'
                  ? THEME.accent.green
                  : row.kind === 'del'
                    ? (isDark ? THEME.dark.destructive : THEME.light.destructive)
                    : fg;
              const sign = row.kind === 'add' ? '+' : row.kind === 'del' ? '−' : row.kind === 'hunk' ? '' : ' ';
              return (
                <View key={i} style={{ flexDirection: 'row', alignItems: 'flex-start', backgroundColor: bg, minHeight: 18 }}>
                  <Text style={{ width: 42, textAlign: 'right', paddingRight: 8, fontSize: 11, lineHeight: 18, fontFamily: MONO, color: muted }}>
                    {row.kind === 'hunk' ? '' : row.num ?? ''}
                  </Text>
                  <Text style={{ fontSize: 12, lineHeight: 18, fontFamily: MONO, color, paddingRight: 14 }}>
                    {row.kind === 'hunk' ? row.text : `${sign} ${row.text}`}
                  </Text>
                </View>
              );
            })}
          </View>
        </ScrollView>
      ) : null}
    </View>
  );
}

/** Render a whole standalone git patch (e.g. a commit's diff). */
export function PatchDiffView({ patch, isDark }: { patch: string; isDark: boolean }) {
  const muted = isDark ? THEME.dark.mutedForeground : THEME.light.mutedForeground;
  const { byPath, truncated } = useMemo(() => parsePatch(patch), [patch]);

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
