/**
 * ViewChangesSheet — Full-screen bottom sheet showing all file changes in a session.
 * Ported from web's SessionDiffViewer, adapted for mobile.
 *
 * Features:
 * - Fetches diffs from API (GET /session/:id/diff), falls back to message extraction
 * - Unified / side-by-side view toggle
 * - Expandable file cards that fill available space
 */
import React, { forwardRef, useMemo, useState, useCallback, useEffect } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  Platform,
  LayoutAnimation,
  ScrollView,
  ActivityIndicator,
  useWindowDimensions,
} from 'react-native';
import {
  BottomSheetModal,
  BottomSheetBackdrop,
  BottomSheetScrollView,
} from '@gorhom/bottom-sheet';
import type { BottomSheetBackdropProps } from '@gorhom/bottom-sheet';
import { useColorScheme } from 'nativewind';
import {
  X,
  ChevronRight,
  ChevronDown,
  FilePlus2,
  FileX2,
  FileEdit,
  FileCode2,
  Rows3,
  Columns2,
} from 'lucide-react-native';

import { useSyncStore } from '@/lib/opencode/sync-store';
import { useSandboxContext } from '@/contexts/SandboxContext';
import { opencodeFetch } from '@/lib/opencode/hooks/use-opencode-data';
import { extractDiffsFromMessages, type FileDiffData } from '@/lib/opencode/extract-diffs';
import { generateLineDiff, type DiffLine } from '@/lib/opencode/diff-utils';

// ─── Constants ──────────────────────────────────────────────────────────────

const monoFont = Platform.OS === 'ios' ? 'Menlo' : 'monospace';

const BINARY_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'svg',
  'mp3', 'wav', 'ogg', 'mp4', 'mov', 'avi', 'webm',
  'zip', 'tar', 'gz', 'rar', '7z',
  'pdf', 'doc', 'docx', 'xls', 'xlsx',
  'woff', 'woff2', 'ttf', 'otf', 'eot',
]);

function isBinaryFile(filePath: string): boolean {
  const ext = filePath.split('.').pop()?.toLowerCase() || '';
  return BINARY_EXTENSIONS.has(ext);
}

type ViewMode = 'unified' | 'split';

// ─── Lightweight syntax highlighting (shared with SessionTurn) ──────────────

type CodeTokenType = 'keyword' | 'string' | 'comment' | 'number' | 'operator' | 'plain';
interface CodeToken { text: string; type: CodeTokenType }

const CODE_KEYWORDS = new Set([
  'import', 'export', 'from', 'const', 'let', 'var', 'function', 'return',
  'if', 'else', 'for', 'while', 'class', 'extends', 'new', 'this', 'super',
  'try', 'catch', 'finally', 'throw', 'async', 'await', 'yield',
  'default', 'switch', 'case', 'break', 'continue', 'typeof', 'instanceof',
  'in', 'of', 'true', 'false', 'null', 'undefined', 'void',
  'def', 'elif', 'except', 'pass', 'raise', 'with', 'as', 'lambda',
  'None', 'True', 'False', 'self', 'type', 'interface', 'enum',
  'func', 'package', 'struct', 'range', 'defer', 'go', 'chan', 'select',
  'map', 'make', 'append', 'len', 'cap', 'string', 'int', 'float64',
  'bool', 'byte', 'error', 'nil', 'fmt', 'Println', 'Printf', 'Sprintf',
]);

function tokenizeCodeLine(line: string): CodeToken[] {
  const tokens: CodeToken[] = [];
  const commentIdx = line.indexOf('//');
  const hashIdx = line.indexOf('#');
  const commentStart = commentIdx >= 0 ? commentIdx : (hashIdx === 0 ? 0 : -1);

  const codePart = commentStart >= 0 ? line.slice(0, commentStart) : line;
  const commentPart = commentStart >= 0 ? line.slice(commentStart) : '';

  const re = /("[^"]*"|'[^']*'|`[^`]*`|\b\d+\.?\d*\b|\b[a-zA-Z_]\w*\b|[{}()[\]:;,=<>!+\-*/&|?.]+|\s+)/g;
  let m: RegExpExecArray | null;
  let lastIdx = 0;
  while ((m = re.exec(codePart)) !== null) {
    if (m.index > lastIdx) tokens.push({ text: codePart.slice(lastIdx, m.index), type: 'plain' });
    const word = m[0];
    if (/^["'`]/.test(word)) tokens.push({ text: word, type: 'string' });
    else if (/^\d/.test(word)) tokens.push({ text: word, type: 'number' });
    else if (CODE_KEYWORDS.has(word)) tokens.push({ text: word, type: 'keyword' });
    else if (/^[{}()[\]:;,=<>!+\-*/&|?.]+$/.test(word)) tokens.push({ text: word, type: 'operator' });
    else tokens.push({ text: word, type: 'plain' });
    lastIdx = m.index + m[0].length;
  }
  if (lastIdx < codePart.length) tokens.push({ text: codePart.slice(lastIdx), type: 'plain' });
  if (commentPart) tokens.push({ text: commentPart, type: 'comment' });
  if (tokens.length === 0) tokens.push({ text: line, type: 'plain' });
  return tokens;
}

function getExtFromPath(filePath: string): string {
  const dot = filePath.lastIndexOf('.');
  if (dot < 0) return '';
  return filePath.slice(dot + 1).toLowerCase();
}

/** Syntax token colors — same as web's Shiki-style highlighting */
const SYNTAX_COLORS = {
  keyword: (d: boolean) => d ? '#c4b5fd' : '#7c3aed',      // purple
  string: (d: boolean) => d ? '#86efac' : '#16a34a',        // green
  comment: (d: boolean) => d ? '#6b7280' : '#9ca3af',       // gray
  number: (d: boolean) => d ? '#fdba74' : '#ea580c',        // orange
  operator: (d: boolean) => d ? '#a1a1aa' : '#71717a',      // muted
  plain: (d: boolean) => d ? '#e4e4e7' : '#27272a',         // near fg
};

/** Get syntax color — full brightness for changed lines, dimmed for context */
function getTokenColor(tokenType: CodeTokenType, lineType: DiffLine['type'], isDark: boolean): string {
  const base = SYNTAX_COLORS[tokenType](isDark);
  if (lineType === 'unchanged') {
    // Dim context lines
    return isDark
      ? base.replace(/^#/, '') // keep color but add opacity via rgba
        ? `rgba(${parseInt(base.slice(1, 3), 16)},${parseInt(base.slice(3, 5), 16)},${parseInt(base.slice(5, 7), 16)},0.45)`
        : base
      : `rgba(${parseInt(base.slice(1, 3), 16)},${parseInt(base.slice(3, 5), 16)},${parseInt(base.slice(5, 7), 16)},0.5)`;
  }
  return base;
}

// ─── Colors ─────────────────────────────────────────────────────────────────

const colors = {
  bg: (d: boolean) => (d ? '#121215' : '#FFFFFF'),
  cardBg: (d: boolean) => (d ? '#1a1a1f' : '#F9F9FA'),
  cardBorder: (d: boolean) => (d ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)'),
  fg: (d: boolean) => (d ? '#e4e4e7' : '#18181b'),
  muted: (d: boolean) => (d ? '#71717a' : '#a1a1aa'),
  mutedStrong: (d: boolean) => (d ? '#a1a1aa' : '#71717a'),
  divider: (d: boolean) => (d ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)'),
  addedBg: (d: boolean) => (d ? 'rgba(34,197,94,0.10)' : 'rgba(34,197,94,0.07)'),
  addedBorder: (d: boolean) => (d ? '#4ade80' : '#22c55e'),
  addedText: (d: boolean) => (d ? '#bbf7d0' : '#15803d'),
  addedSign: (d: boolean) => (d ? '#4ade80' : '#16a34a'),
  removedBg: (d: boolean) => (d ? 'rgba(239,68,68,0.10)' : 'rgba(239,68,68,0.07)'),
  removedBorder: (d: boolean) => (d ? '#f87171' : '#ef4444'),
  removedText: (d: boolean) => (d ? '#fca5a5' : '#b91c1c'),
  removedSign: (d: boolean) => (d ? '#f87171' : '#dc2626'),
  unchangedText: (d: boolean) => (d ? 'rgba(255,255,255,0.35)' : 'rgba(0,0,0,0.3)'),
  emerald: (d: boolean) => (d ? '#34d399' : '#059669'),
  red: (d: boolean) => (d ? '#f87171' : '#dc2626'),
  blue: (d: boolean) => (d ? '#60a5fa' : '#2563eb'),
};

// ─── Props ──────────────────────────────────────────────────────────────────

interface ViewChangesSheetProps {
  sessionId: string | null;
}

// ─── Unified diff lines ─────────────────────────────────────────────────────

const MAX_DIFF_LINES = 500;

/** Render a single line of code with syntax highlighting, colored by diff type */
function HighlightedDiffLine({
  text,
  lineType,
  ext,
  isDark,
  fs,
  lh,
}: {
  text: string;
  lineType: DiffLine['type'];
  ext: string;
  isDark: boolean;
  fs: number;
  lh: number;
}) {
  const tokens = useMemo(() => tokenizeCodeLine(text), [text]);
  return (
    <Text style={{ flex: 1, fontSize: fs, fontFamily: monoFont, lineHeight: lh, paddingVertical: 1, paddingRight: 8 }}>
      {tokens.map((token, i) => (
        <Text key={i} style={{ color: getTokenColor(token.type, lineType, isDark), fontSize: fs, fontFamily: monoFont }}>
          {token.text}
        </Text>
      ))}
    </Text>
  );
}

function UnifiedDiffView({
  lineDiff,
  isDark,
  filename,
}: {
  lineDiff: DiffLine[];
  isDark: boolean;
  filename: string;
}) {
  const fs = 11;
  const lh = 18;
  const ext = getExtFromPath(filename);

  return (
    <View style={{ paddingVertical: 6 }}>
      {lineDiff.slice(0, MAX_DIFF_LINES).map((line, i) => {
        const isRemoved = line.type === 'removed';
        const isAdded = line.type === 'added';
        return (
          <View
            key={i}
            style={{
              flexDirection: 'row',
              backgroundColor: isRemoved
                ? (isDark ? 'rgba(239,68,68,0.06)' : 'rgba(239,68,68,0.05)')
                : isAdded
                ? (isDark ? 'rgba(34,197,94,0.06)' : 'rgba(34,197,94,0.05)')
                : 'transparent',
            }}
          >
            {/* +/- prefix — colored */}
            <Text
              style={{
                width: 18,
                textAlign: 'center',
                fontSize: fs,
                fontFamily: monoFont,
                lineHeight: lh,
                color: isRemoved
                  ? colors.removedSign(isDark)
                  : isAdded
                  ? colors.addedSign(isDark)
                  : 'transparent',
                fontWeight: '600',
              }}
            >
              {isRemoved ? '−' : isAdded ? '+' : ' '}
            </Text>
            {/* Code — syntax highlighted */}
            <HighlightedDiffLine text={line.text} lineType={line.type} ext={ext} isDark={isDark} fs={fs} lh={lh} />
          </View>
        );
      })}
      {lineDiff.length > MAX_DIFF_LINES && (
        <View style={{ paddingHorizontal: 12, paddingVertical: 8 }}>
          <Text style={{ fontSize: 10, fontFamily: monoFont, color: colors.muted(isDark) }}>
            ... {lineDiff.length - MAX_DIFF_LINES} more lines
          </Text>
        </View>
      )}
    </View>
  );
}

// ─── Side-by-side diff view ─────────────────────────────────────────────────

interface SplitLine {
  left: { text: string; type: 'removed' | 'unchanged' | 'empty' };
  right: { text: string; type: 'added' | 'unchanged' | 'empty' };
}

function buildSplitLines(lineDiff: DiffLine[]): SplitLine[] {
  const result: SplitLine[] = [];
  let i = 0;
  while (i < lineDiff.length) {
    const line = lineDiff[i];
    if (line.type === 'unchanged') {
      result.push({
        left: { text: line.text, type: 'unchanged' },
        right: { text: line.text, type: 'unchanged' },
      });
      i++;
    } else if (line.type === 'removed') {
      // Collect consecutive removals
      const removals: string[] = [];
      while (i < lineDiff.length && lineDiff[i].type === 'removed') {
        removals.push(lineDiff[i].text);
        i++;
      }
      // Collect consecutive additions
      const additions: string[] = [];
      while (i < lineDiff.length && lineDiff[i].type === 'added') {
        additions.push(lineDiff[i].text);
        i++;
      }
      // Pair them
      const maxLen = Math.max(removals.length, additions.length);
      for (let j = 0; j < maxLen; j++) {
        result.push({
          left: j < removals.length
            ? { text: removals[j], type: 'removed' }
            : { text: '', type: 'empty' },
          right: j < additions.length
            ? { text: additions[j], type: 'added' }
            : { text: '', type: 'empty' },
        });
      }
    } else if (line.type === 'added') {
      result.push({
        left: { text: '', type: 'empty' },
        right: { text: line.text, type: 'added' },
      });
      i++;
    }
  }
  return result;
}

function SplitDiffView({
  lineDiff,
  isDark,
  filename,
}: {
  lineDiff: DiffLine[];
  isDark: boolean;
  filename: string;
}) {
  const splitLines = useMemo(() => buildSplitLines(lineDiff), [lineDiff]);
  const fs = 9.5;
  const lh = 15;
  const ext = getExtFromPath(filename);

  const getSideBg = (type: string) => {
    if (type === 'removed') return isDark ? 'rgba(239,68,68,0.06)' : 'rgba(239,68,68,0.05)';
    if (type === 'added') return isDark ? 'rgba(34,197,94,0.06)' : 'rgba(34,197,94,0.05)';
    if (type === 'empty') return isDark ? 'rgba(255,255,255,0.02)' : 'rgba(0,0,0,0.015)';
    return 'transparent';
  };

  // Map split types to DiffLine types for highlighting
  const toDiffType = (type: string): DiffLine['type'] => {
    if (type === 'removed') return 'removed';
    if (type === 'added') return 'added';
    return 'unchanged';
  };

  return (
    <View>
      {/* Column headers */}
      <View style={{ flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: colors.divider(isDark) }}>
        <View style={{ flex: 1, paddingHorizontal: 8, paddingVertical: 4, borderRightWidth: 1, borderRightColor: colors.divider(isDark) }}>
          <Text style={{ fontSize: 9, fontFamily: 'Roobert-Medium', color: colors.removedSign(isDark), textTransform: 'uppercase', letterSpacing: 0.5 }}>
            Before
          </Text>
        </View>
        <View style={{ flex: 1, paddingHorizontal: 8, paddingVertical: 4 }}>
          <Text style={{ fontSize: 9, fontFamily: 'Roobert-Medium', color: colors.addedSign(isDark), textTransform: 'uppercase', letterSpacing: 0.5 }}>
            After
          </Text>
        </View>
      </View>

      {splitLines.slice(0, MAX_DIFF_LINES).map((row, i) => (
        <View key={i} style={{ flexDirection: 'row' }}>
          {/* Left (old) */}
          <View
            style={{
              flex: 1,
              backgroundColor: getSideBg(row.left.type),
              borderRightWidth: 1,
              borderRightColor: colors.divider(isDark),
              paddingHorizontal: 6,
            }}
          >
            {row.left.text ? (
              <HighlightedDiffLine text={row.left.text} lineType={toDiffType(row.left.type)} ext={ext} isDark={isDark} fs={fs} lh={lh} />
            ) : (
              <Text style={{ fontSize: fs, fontFamily: monoFont, lineHeight: lh, paddingVertical: 1 }}> </Text>
            )}
          </View>
          {/* Right (new) */}
          <View
            style={{
              flex: 1,
              backgroundColor: getSideBg(row.right.type),
              paddingHorizontal: 6,
            }}
          >
            {row.right.text ? (
              <HighlightedDiffLine text={row.right.text} lineType={toDiffType(row.right.type)} ext={ext} isDark={isDark} fs={fs} lh={lh} />
            ) : (
              <Text style={{ fontSize: fs, fontFamily: monoFont, lineHeight: lh, paddingVertical: 1 }}> </Text>
            )}
          </View>
        </View>
      ))}
      {splitLines.length > MAX_DIFF_LINES && (
        <View style={{ paddingHorizontal: 12, paddingVertical: 8 }}>
          <Text style={{ fontSize: 10, fontFamily: monoFont, color: colors.muted(isDark) }}>
            ... {splitLines.length - MAX_DIFF_LINES} more lines
          </Text>
        </View>
      )}
    </View>
  );
}

// ─── FileDiffCard ───────────────────────────────────────────────────────────

function FileDiffCard({
  diff,
  isDark,
  viewMode,
}: {
  diff: FileDiffData;
  isDark: boolean;
  viewMode: ViewMode;
}) {
  const [expanded, setExpanded] = useState(false);
  const binary = isBinaryFile(diff.file);
  const hasDiffContent = !binary && (!!diff.before || !!diff.after);

  // Lazy diff computation — only when expanded
  const lineDiff = useMemo<DiffLine[] | null>(() => {
    if (!expanded || !hasDiffContent) return null;
    return generateLineDiff(diff.before, diff.after);
  }, [expanded, hasDiffContent, diff.before, diff.after]);

  const filename = diff.file.split('/').pop() || diff.file;
  const directory = diff.file.includes('/')
    ? diff.file.substring(0, diff.file.lastIndexOf('/'))
    : '';

  const handlePress = useCallback(() => {
    if (!hasDiffContent) return;
    LayoutAnimation.configureNext({
      duration: 200,
      create: { type: LayoutAnimation.Types.easeInEaseOut, property: LayoutAnimation.Properties.opacity },
      update: { type: LayoutAnimation.Types.easeInEaseOut },
      delete: { type: LayoutAnimation.Types.easeInEaseOut, property: LayoutAnimation.Properties.opacity },
    });
    setExpanded(prev => !prev);
  }, [hasDiffContent]);

  const statusConfig = useMemo(() => {
    switch (diff.status) {
      case 'added':
        return {
          icon: FilePlus2,
          label: 'Added',
          color: colors.emerald(isDark),
          badgeBg: isDark ? 'rgba(52,211,153,0.12)' : 'rgba(5,150,105,0.08)',
        };
      case 'deleted':
        return {
          icon: FileX2,
          label: 'Deleted',
          color: colors.red(isDark),
          badgeBg: isDark ? 'rgba(248,113,113,0.12)' : 'rgba(220,38,38,0.08)',
        };
      default:
        return {
          icon: FileEdit,
          label: 'Modified',
          color: colors.blue(isDark),
          badgeBg: isDark ? 'rgba(96,165,250,0.12)' : 'rgba(37,99,235,0.08)',
        };
    }
  }, [diff.status, isDark]);

  const StatusIcon = statusConfig.icon;

  return (
    <View
      style={{
        borderRadius: 12,
        borderWidth: 1,
        borderColor: colors.cardBorder(isDark),
        backgroundColor: colors.cardBg(isDark),
        marginBottom: 8,
        overflow: 'hidden',
      }}
    >
      {/* File header */}
      <TouchableOpacity
        activeOpacity={hasDiffContent ? 0.7 : 1}
        onPress={handlePress}
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          paddingHorizontal: 12,
          paddingVertical: 10,
          gap: 6,
        }}
      >
        {hasDiffContent ? (
          expanded
            ? <ChevronDown size={12} color={colors.muted(isDark)} />
            : <ChevronRight size={12} color={colors.muted(isDark)} />
        ) : (
          <View style={{ width: 12 }} />
        )}

        <StatusIcon size={14} color={statusConfig.color} />

        <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 6, overflow: 'hidden' }}>
          <Text
            numberOfLines={1}
            style={{ fontSize: 12, fontFamily: 'Roobert-Medium', color: colors.fg(isDark) }}
          >
            {filename}
          </Text>
          {!!directory && (
            <Text
              numberOfLines={1}
              style={{ fontSize: 10, fontFamily: monoFont, color: colors.muted(isDark), opacity: 0.6, flexShrink: 1 }}
            >
              {directory}
            </Text>
          )}
        </View>

        <View
          style={{
            paddingHorizontal: 6,
            paddingVertical: 2,
            borderRadius: 4,
            backgroundColor: statusConfig.badgeBg,
          }}
        >
          <Text style={{ fontSize: 10, fontFamily: 'Roobert-Medium', color: statusConfig.color }}>
            {statusConfig.label}
          </Text>
        </View>

        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
          {diff.additions > 0 && (
            <Text style={{ fontSize: 10, fontFamily: monoFont, color: colors.emerald(isDark) }}>+{diff.additions}</Text>
          )}
          {diff.deletions > 0 && (
            <Text style={{ fontSize: 10, fontFamily: monoFont, color: colors.red(isDark) }}>-{diff.deletions}</Text>
          )}
        </View>
      </TouchableOpacity>

      {/* Expanded diff content — fills available space */}
      {expanded && lineDiff && (
        <View style={{ borderTopWidth: 1, borderTopColor: colors.divider(isDark) }}>
          <ScrollView
            style={{ maxHeight: 600 }}
            nestedScrollEnabled
            showsVerticalScrollIndicator
          >
            {viewMode === 'split' ? (
              <SplitDiffView lineDiff={lineDiff} isDark={isDark} filename={diff.file} />
            ) : (
              <UnifiedDiffView lineDiff={lineDiff} isDark={isDark} filename={diff.file} />
            )}
          </ScrollView>
        </View>
      )}

      {binary && (
        <View style={{ paddingHorizontal: 12, paddingBottom: 8 }}>
          <Text style={{ fontSize: 11, fontFamily: 'Roobert', color: colors.muted(isDark), fontStyle: 'italic' }}>
            Binary file
          </Text>
        </View>
      )}
    </View>
  );
}

// ─── Summary header ─────────────────────────────────────────────────────────

function SummaryHeader({
  diffs,
  isDark,
  viewMode,
  onViewModeChange,
  onClose,
}: {
  diffs: FileDiffData[];
  isDark: boolean;
  viewMode: ViewMode;
  onViewModeChange: (mode: ViewMode) => void;
  onClose: () => void;
}) {
  const totals = useMemo(() => {
    let additions = 0;
    let deletions = 0;
    let added = 0;
    let deleted = 0;
    let modified = 0;
    for (const d of diffs) {
      additions += d.additions;
      deletions += d.deletions;
      if (d.status === 'added') added++;
      else if (d.status === 'deleted') deleted++;
      else modified++;
    }
    return { additions, deletions, added, deleted, modified };
  }, [diffs]);

  const ViewModeButton = ({ mode, icon: Icon }: { mode: ViewMode; icon: typeof Rows3 }) => {
    const active = viewMode === mode;
    return (
      <TouchableOpacity
        onPress={() => onViewModeChange(mode)}
        style={{
          padding: 5,
          borderRadius: 6,
          backgroundColor: active
            ? (isDark ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.08)')
            : 'transparent',
        }}
      >
        <Icon
          size={14}
          color={active ? colors.fg(isDark) : colors.muted(isDark)}
        />
      </TouchableOpacity>
    );
  };

  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 20,
        paddingVertical: 12,
        borderBottomWidth: 1,
        borderBottomColor: colors.divider(isDark),
      }}
    >
      {/* Left: file count */}
      <Text style={{ fontSize: 15, fontFamily: 'Roobert-Medium', color: colors.fg(isDark) }}>
        {diffs.length} {diffs.length === 1 ? 'file' : 'files'} changed
      </Text>

      {/* Spacer */}
      <View style={{ flex: 1 }} />

      {/* Stats */}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginRight: 10 }}>
        {totals.added > 0 && (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 2 }}>
            <FilePlus2 size={10} color={colors.emerald(isDark)} />
            <Text style={{ fontSize: 10, fontFamily: 'Roobert', color: colors.emerald(isDark) }}>{totals.added}</Text>
          </View>
        )}
        {totals.modified > 0 && (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 2 }}>
            <FileEdit size={10} color={colors.blue(isDark)} />
            <Text style={{ fontSize: 10, fontFamily: 'Roobert', color: colors.blue(isDark) }}>{totals.modified}</Text>
          </View>
        )}
        {totals.deletions > 0 && (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 2 }}>
            <FileX2 size={10} color={colors.red(isDark)} />
            <Text style={{ fontSize: 10, fontFamily: 'Roobert', color: colors.red(isDark) }}>{totals.deleted}</Text>
          </View>
        )}

        <Text style={{ fontSize: 10, color: colors.muted(isDark), opacity: 0.3 }}>|</Text>

        {totals.additions > 0 && (
          <Text style={{ fontSize: 10, fontFamily: monoFont, color: colors.emerald(isDark) }}>+{totals.additions}</Text>
        )}
        {totals.deletions > 0 && (
          <Text style={{ fontSize: 10, fontFamily: monoFont, color: colors.red(isDark) }}>-{totals.deletions}</Text>
        )}
      </View>

      {/* View mode toggle */}
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 2,
          backgroundColor: isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.04)',
          borderRadius: 8,
          padding: 2,
          marginRight: 10,
        }}
      >
        <ViewModeButton mode="unified" icon={Rows3} />
        <ViewModeButton mode="split" icon={Columns2} />
      </View>

      {/* Close button */}
      <TouchableOpacity
        onPress={onClose}
        hitSlop={12}
        style={{
          width: 28,
          height: 28,
          borderRadius: 14,
          backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.05)',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <X size={14} color={colors.muted(isDark)} />
      </TouchableOpacity>
    </View>
  );
}

// ─── Empty state ────────────────────────────────────────────────────────────

function EmptyState({ isDark }: { isDark: boolean }) {
  return (
    <View style={{ alignItems: 'center', justifyContent: 'center', paddingVertical: 60 }}>
      <View
        style={{
          width: 56,
          height: 56,
          borderRadius: 28,
          backgroundColor: isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.03)',
          alignItems: 'center',
          justifyContent: 'center',
          marginBottom: 12,
        }}
      >
        <FileCode2 size={24} color={colors.muted(isDark)} />
      </View>
      <Text style={{ fontSize: 14, fontFamily: 'Roobert-Medium', color: colors.mutedStrong(isDark), marginBottom: 4 }}>
        No changes yet
      </Text>
      <Text style={{ fontSize: 12, fontFamily: 'Roobert', color: colors.muted(isDark) }}>
        File changes will appear here
      </Text>
    </View>
  );
}

// ─── API diff type (from SDK) ───────────────────────────────────────────────

interface ApiFileDiff {
  file: string;
  before: string;
  after: string;
  additions: number;
  deletions: number;
  status?: 'added' | 'deleted' | 'modified';
}

// ─── Main component ─────────────────────────────────────────────────────────

export const ViewChangesSheet = forwardRef<BottomSheetModal, ViewChangesSheetProps>(
  function ViewChangesSheet({ sessionId }, ref) {
    const { colorScheme } = useColorScheme();
    const isDark = colorScheme === 'dark';
    const { sandboxUrl } = useSandboxContext();
    const [viewMode, setViewMode] = useState<ViewMode>('unified');

    // API-fetched diffs
    const [apiDiffs, setApiDiffs] = useState<FileDiffData[] | null>(null);
    const [apiLoading, setApiLoading] = useState(false);

    // Read messages for this session from sync store (fallback)
    const messages = useSyncStore((s: any) => sessionId ? s.messages[sessionId] : undefined);

    // Fallback: extract diffs from messages
    const messageDiffs = useMemo(() => {
      if (!sessionId || !messages || !Array.isArray(messages)) return [];
      return extractDiffsFromMessages(messages as any);
    }, [sessionId, messages]);

    // Fetch diffs from API when sheet becomes visible
    const fetchApiDiffs = useCallback(async () => {
      if (!sessionId || !sandboxUrl) return;
      setApiLoading(true);
      try {
        const result = await opencodeFetch<ApiFileDiff[]>(
          sandboxUrl,
          `/session/${sessionId}/diff`,
        );
        if (result && Array.isArray(result) && result.length > 0) {
          setApiDiffs(
            result.map((d) => ({
              file: d.file,
              before: d.before || '',
              after: d.after || '',
              additions: d.additions || 0,
              deletions: d.deletions || 0,
              status: (d.status as 'added' | 'deleted' | 'modified') || (d.before ? (d.after ? 'modified' : 'deleted') : 'added'),
            })),
          );
        }
      } catch {
        // API not available — fall back to message extraction
      } finally {
        setApiLoading(false);
      }
    }, [sessionId, sandboxUrl]);

    // Use API diffs if available, else fall back to message extraction
    const diffs = (apiDiffs && apiDiffs.length > 0) ? apiDiffs : messageDiffs;

    const renderBackdrop = useMemo(
      () => (props: BottomSheetBackdropProps) => (
        <BottomSheetBackdrop {...props} appearsOnIndex={0} disappearsOnIndex={-1} opacity={0.35} />
      ),
      [],
    );

    const handleClose = useCallback(() => {
      (ref as React.RefObject<BottomSheetModal>)?.current?.dismiss();
    }, [ref]);

    // Fetch API diffs when sheet opens
    const handleSheetChange = useCallback((index: number) => {
      if (index >= 0) {
        fetchApiDiffs();
      } else {
        // Reset when closed so next open refetches
        setApiDiffs(null);
      }
    }, [fetchApiDiffs]);

    return (
      <BottomSheetModal
        ref={ref}
        index={0}
        snapPoints={['92%']}
        enableDynamicSizing={false}
        enableOverDrag={false}
        enablePanDownToClose
        onChange={handleSheetChange}
        handleIndicatorStyle={{
          backgroundColor: isDark ? '#3F3F46' : '#D4D4D8',
          width: 36,
          height: 5,
          borderRadius: 3,
        }}
        backgroundStyle={{
          backgroundColor: colors.bg(isDark),
          borderTopLeftRadius: 24,
          borderTopRightRadius: 24,
        }}
        backdropComponent={renderBackdrop}
      >
        {/* Header */}
        <SummaryHeader
          diffs={diffs}
          isDark={isDark}
          viewMode={viewMode}
          onViewModeChange={setViewMode}
          onClose={handleClose}
        />

        {/* Content */}
        {apiLoading && diffs.length === 0 ? (
          <View style={{ alignItems: 'center', justifyContent: 'center', paddingVertical: 60 }}>
            <ActivityIndicator size="small" color={colors.muted(isDark)} />
            <Text style={{ fontSize: 12, fontFamily: 'Roobert', color: colors.muted(isDark), marginTop: 12 }}>
              Loading changes...
            </Text>
          </View>
        ) : diffs.length === 0 ? (
          <EmptyState isDark={isDark} />
        ) : (
          <BottomSheetScrollView
            contentContainerStyle={{ padding: 16, paddingBottom: 40 }}
            showsVerticalScrollIndicator={false}
          >
            {diffs.map((diff) => (
              <FileDiffCard
                key={diff.file}
                diff={diff}
                isDark={isDark}
                viewMode={viewMode}
              />
            ))}
          </BottomSheetScrollView>
        )}
      </BottomSheetModal>
    );
  },
);
