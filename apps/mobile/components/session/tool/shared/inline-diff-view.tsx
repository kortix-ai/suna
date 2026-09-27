/**
 * Unified diffs under a tool row.
 *
 * Mirrors apps/web `components/diff/diff-view.tsx` (`@pierre/diffs`
 * `PatchDiff`) as `InlineDiffView` / `RawPatchDiffView` call it:
 * `layout="unified"`, `hideFileHeader`, line numbers on, row washes on,
 * `text-[0.8rem] leading-[1.55]` mono, Shiki colours (`min-light` /
 * `min-dark`) on every line, and a collapsed "N unmodified lines" row between
 * hunks. Pierre's default change marker is a coloured bar; mobile draws the
 * `+` / `−` sign in that gutter in the same success / destructive tones.
 *
 * Rows come from `lib/session/unified-diff.ts` (3 context lines, the
 * `createTwoFilesPatch` default). Long lines scroll horizontally. The view is
 * frameless: wrap it in `ToolResultCard`, as web's edit and memory tools do.
 */

import React, { memo, useMemo } from 'react';
import { Text as RNText, ScrollView, View } from 'react-native';
import { useColorScheme } from 'nativewind';
import { Text } from '@/components/ui/text';
import { normalizeLanguage } from '@/lib/code-theme';
import type { CodeLine } from '@/lib/highlight/shiki';
import { useCodeTokens } from '@/lib/highlight/use-code-tokens';
import { languageFromPath } from '@/lib/session/tool-part-accessors';
import {
  buildUnifiedDiff,
  parseUnifiedPatch,
  type DiffRow,
  type UnifiedDiff,
} from '@/lib/session/unified-diff';
import { webSpace } from '@/lib/session/user-message';
import { TURN_TYPE, monoFont, useTurnPalette } from './styles';

type LineRow = Extract<DiffRow, { kind: 'line' }>;

function sideText(rows: DiffRow[], side: 'old' | 'new'): string {
  const lines: string[] = [];
  for (const row of rows) {
    if (row.kind !== 'line') continue;
    if (side === 'old' ? row.type !== 'add' : row.type !== 'del') lines.push(row.text);
  }
  return lines.join('\n');
}

/**
 * Token lines for each row. With the full file text, each row reads its own
 * line number; from a patch, each side is highlighted as the run of lines the
 * patch carries (a hunk boundary can break a multi-line construct).
 */
function useRowTokens(
  diff: UnifiedDiff,
  language: string,
  full?: { oldText: string; newText: string },
): (CodeLine | undefined)[] {
  const { colorScheme } = useColorScheme();
  const scheme = colorScheme === 'dark' ? 'dark' : 'light';
  const oldSource = full ? full.oldText : sideText(diff.rows, 'old');
  const newSource = full ? full.newText : sideText(diff.rows, 'new');
  const lang = normalizeLanguage(language);
  const oldTokens = useCodeTokens(oldSource, lang, scheme).lines;
  const newTokens = useCodeTokens(newSource, lang, scheme).lines;

  return useMemo(() => {
    let oldIndex = 0;
    let newIndex = 0;
    return diff.rows.map((row) => {
      if (row.kind !== 'line') return undefined;
      if (full) {
        return row.type === 'del'
          ? oldTokens[(row.oldLine ?? 1) - 1]
          : newTokens[(row.newLine ?? 1) - 1];
      }
      if (row.type === 'del') return oldTokens[oldIndex++];
      if (row.type === 'add') return newTokens[newIndex++];
      oldIndex++;
      return newTokens[newIndex++];
    });
  }, [diff.rows, full, oldTokens, newTokens]);
}

const DiffLine = memo(function DiffLine({
  row,
  tokens,
  numberWidth,
}: {
  row: LineRow;
  tokens: CodeLine | undefined;
  numberWidth: number;
}) {
  const palette = useTurnPalette();
  const background =
    row.type === 'add' ? palette.diffAddBg : row.type === 'del' ? palette.diffDelBg : undefined;
  const signColor =
    row.type === 'add' ? palette.success : row.type === 'del' ? palette.destructive : palette.muted0;
  const lineNumber = row.type === 'del' ? row.oldLine : row.newLine;
  const text = [TURN_TYPE.diff, { fontFamily: monoFont }];

  return (
    <View style={{ flexDirection: 'row', backgroundColor: background }}>
      <RNText
        selectable={false}
        style={[text, { width: numberWidth, paddingRight: webSpace(2), textAlign: 'right', color: palette.muted50 }]}
      >
        {lineNumber ?? ''}
      </RNText>
      <RNText selectable={false} style={[text, { width: webSpace(4), color: signColor }]}>
        {row.type === 'add' ? '+' : row.type === 'del' ? '−' : ' '}
      </RNText>
      <RNText selectable style={[text, { paddingRight: webSpace(3), color: palette.foreground }]}>
        {tokens && tokens.length > 0
          ? tokens.map((token, i) => (
              <RNText key={i} style={{ color: token.color }}>
                {token.content}
              </RNText>
            ))
          : row.text}
      </RNText>
    </View>
  );
});

function DiffRows({
  diff,
  language,
  full,
}: {
  diff: UnifiedDiff;
  language: string;
  full?: { oldText: string; newText: string };
}) {
  const palette = useTurnPalette();
  const tokens = useRowTokens(diff, language, full);
  const maxLine = diff.rows.reduce(
    (max, row) => (row.kind === 'line' ? Math.max(max, row.oldLine ?? 0, row.newLine ?? 0) : max),
    0,
  );
  // One digit is ~0.6em in a monospace face; `pr-2` sits after it.
  const numberWidth = Math.max(2, String(maxLine).length) * TURN_TYPE.diff.fontSize * 0.62 + webSpace(2);

  if (diff.rows.length === 0) return null;

  // Frameless, like Pierre's `PatchDiff`: callers put it in `ToolResultCard`
  // (edit, memory) or their own bordered box (apply_patch), which own the
  // edge and the `max-h-96` cap.
  return (
    <ScrollView horizontal nestedScrollEnabled showsHorizontalScrollIndicator={false}>
      <View style={{ minWidth: '100%' }}>
        {diff.rows.map((row, index) =>
          row.kind === 'separator' ? (
            <View
              key={`sep-${index}`}
              style={{ paddingVertical: webSpace(1), paddingHorizontal: webSpace(3), backgroundColor: palette.muted40Bg }}
            >
              <Text variant="muted" style={[TURN_TYPE.xs, { color: palette.mutedForeground }]}>
                {row.hiddenLines} unmodified {row.hiddenLines === 1 ? 'line' : 'lines'}
              </Text>
            </View>
          ) : (
            <DiffLine key={index} row={row} tokens={tokens[index]} numberWidth={numberWidth} />
          ),
        )}
      </View>
    </ScrollView>
  );
}

/** Web `DiffView` — `patch`, or a `before` / `after` file pair. Unified only. */
export function DiffView(
  props:
    | { patch: string; language?: string }
    | { before: { name: string; contents: string }; after: { name: string; contents: string } },
) {
  const isPatch = 'patch' in props;
  const patch = isPatch ? props.patch : '';
  const before = isPatch ? '' : props.before.contents;
  const after = isPatch ? '' : props.after.contents;
  const diff = useMemo(
    () => (isPatch ? parseUnifiedPatch(patch) : buildUnifiedDiff(before, after)),
    [isPatch, patch, before, after],
  );
  const full = useMemo(() => (isPatch ? undefined : { oldText: before, newText: after }), [isPatch, before, after]);
  const language = isPatch ? (props.language ?? 'text') : languageFromPath(props.after.name || props.before.name);
  return <DiffRows diff={diff} language={language} full={full} />;
}

export function InlineDiffView({
  oldValue,
  newValue,
  filename,
}: {
  oldValue: string;
  newValue: string;
  filename: string;
}) {
  if (!oldValue && !newValue) return null;
  return (
    <DiffView
      before={{ name: filename, contents: oldValue || '' }}
      after={{ name: filename, contents: newValue || '' }}
    />
  );
}
