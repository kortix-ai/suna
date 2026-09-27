import { useMemo } from 'react';
import { Text } from '@/components/ui/text';
import { THEME, withAlpha } from '@/lib/utils/theme';
import type { DiffLine } from '@/lib/opencode/diff-utils';
import { tokenizeLine, type CodeTokenType } from '@/lib/session/highlight-tokens';
import { fg, monoFont, muted, mutedStrong } from './styles';

/** Syntax-highlighted diff line with inline +/- prefix */
export function DiffCodeLine({ text, lineType, ext, isDark, fs, lh }: {
  text: string;
  lineType: DiffLine['type'];
  ext: string;
  isDark: boolean;
  fs: number;
  lh: number;
}) {
  const tokens = useMemo(() => tokenizeLine(text, ext), [text, ext]);

  const getColor = (tokenType: CodeTokenType): string => {
    const syntaxMap: Record<CodeTokenType, string> = {
      keyword: THEME.accent.purple,
      string: THEME.accent.green,
      comment: muted(isDark),
      number: THEME.accent.orange,
      heading: THEME.accent.blue,
      bold: fg(isDark),
      bullet: THEME.accent.orange,
      operator: mutedStrong(isDark),
      property: THEME.accent.blue,
      tag: THEME.accent.red,
      attr: THEME.accent.orange,
      plain: fg(isDark),
    };
    const base = syntaxMap[tokenType];
    if (lineType === 'unchanged') {
      // base is now a THEME `hsl(...)` string, not hex — hex-slicing it
      // would silently break (this is the concatenation trap called out
      // for MENTION_COLORS; withAlpha is the correct token-safe way to
      // dim a THEME color for the "unchanged" diff line tint).
      return withAlpha(base, 0.45);
    }
    return base;
  };

  const prefixChar = lineType === 'removed' ? '− ' : lineType === 'added' ? '+ ' : '  ';
  const prefixColor = lineType === 'removed'
    ? THEME.accent.red
    : lineType === 'added'
    ? THEME.accent.green
    : 'transparent';

  return (
    <Text style={{ fontSize: fs, fontFamily: monoFont, lineHeight: lh, paddingVertical: 1, paddingHorizontal: 8 }}>
      <Text style={{ color: prefixColor, fontSize: fs, fontFamily: monoFont, fontWeight: '600' }}>{prefixChar}</Text>
      {tokens.map((token, i) => (
        <Text key={i} style={{ color: getColor(token.type), fontSize: fs, fontFamily: monoFont }}>
          {token.text}
        </Text>
      ))}
    </Text>
  );
}
