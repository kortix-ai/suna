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

const MONO = 'Menlo';
const MAX_DIFF_ROWS = 2000;

export interface DiffRow {
  kind: 'hunk' | 'add' | 'del' | 'ctx';
  num: number | null;
  text: string;
}

export function fileStatusMeta(status: ProjectCommitFile['status']): { icon: LucideIcon; color: string } {
  if (status === 'added') return { icon: FilePlus, color: '#22c55e' };
  if (status === 'deleted') return { icon: FileMinus, color: '#ef4444' };
  return { icon: FilePen, color: '#3b82f6' };
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
  const fg = isDark ? '#F8F8F8' : '#121215';
  const muted = isDark ? '#9b9b9b' : '#6e6e6e';
  const border = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)';
  const codeBg = isDark ? 'rgba(255,255,255,0.02)' : 'rgba(0,0,0,0.015)';
  const addBg = isDark ? 'rgba(34,197,94,0.14)' : 'rgba(34,197,94,0.12)';
  const delBg = isDark ? 'rgba(239,68,68,0.14)' : 'rgba(239,68,68,0.10)';
  const hunkBg = isDark ? 'rgba(139,92,246,0.12)' : 'rgba(139,92,246,0.08)';
  const meta = fileStatusMeta(file.status);
  const Icon = meta.icon;

  return (
    <View style={{ borderWidth: 1, borderColor: border, borderRadius: 12, marginBottom: 10, overflow: 'hidden' }}>
      {/* File header */}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 9, borderBottomWidth: parsed && parsed.rows.length ? 1 : 0, borderBottomColor: border }}>
        <Icon size={14} color={meta.color} />
        <Text style={{ flex: 1, fontSize: 12.5, fontFamily: MONO, color: fg }} numberOfLines={1}>
          {file.old_path && file.old_path !== file.path ? `${file.old_path} → ${file.path}` : file.path}
        </Text>
        {file.additions > 0 && <Text style={{ fontSize: 11.5, fontFamily: 'Roobert-Medium', color: '#22c55e' }}>+{file.additions}</Text>}
        {file.deletions > 0 && <Text style={{ fontSize: 11.5, fontFamily: 'Roobert-Medium', color: '#ef4444' }}>−{file.deletions}</Text>}
      </View>

      {parsed?.binary ? (
        <Text style={{ fontSize: 12, color: muted, padding: 12 }}>Binary file — not shown.</Text>
      ) : parsed && parsed.rows.length > 0 ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ backgroundColor: codeBg }}>
          <View>
            {parsed.rows.map((row, i) => {
              const bg = row.kind === 'add' ? addBg : row.kind === 'del' ? delBg : row.kind === 'hunk' ? hunkBg : 'transparent';
              const color = row.kind === 'hunk' ? '#8b5cf6' : row.kind === 'add' ? (isDark ? '#86efac' : '#15803d') : row.kind === 'del' ? (isDark ? '#fca5a5' : '#b91c1c') : fg;
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
  const muted = isDark ? '#9b9b9b' : '#6e6e6e';
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
