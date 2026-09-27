import { View } from 'react-native';
import { Text } from '@/components/ui/text';
import { THEME } from '@/lib/utils/theme';
import {
  getExtFromPath,
  stripCodeFences,
  tokenizeLine,
  type CodeTokenType,
} from '@/lib/session/highlight-tokens';
import { fg, monoFont, muted, mutedStrong } from './styles';

export function HighlightedCode({
  content,
  filePath,
  isDark,
  maxLines = 25,
}: {
  content: string;
  filePath: string;
  isDark: boolean;
  maxLines?: number;
}) {
  const ext = getExtFromPath(filePath);

  const colors: Record<CodeTokenType, string> = {
    keyword: THEME.accent.purple,     // purple
    string: THEME.accent.green,       // green
    comment: muted(isDark),      // gray
    number: THEME.accent.orange,       // orange
    heading: THEME.accent.blue,      // blue
    bold: fg(isDark),         // strong fg
    bullet: THEME.accent.orange,       // orange
    operator: mutedStrong(isDark),     // muted
    property: THEME.accent.blue,     // blue
    tag: THEME.accent.red,          // red
    attr: THEME.accent.orange,         // orange
    plain: mutedStrong(isDark),
  };

  const cleaned = stripCodeFences(content);
  const lines = cleaned.split('\n').slice(0, maxLines);
  const truncated = cleaned.split('\n').length > maxLines;
  const fs = 10;
  const lh = 15;

  return (
    <View>
      {lines.map((line, lineIdx) => {
        const tokens = tokenizeLine(line, ext);
        return (
          <Text key={lineIdx} style={{ fontSize: fs, fontFamily: monoFont, lineHeight: lh }}>
            {tokens.map((token, i) => (
              <Text
                key={i}
                style={{
                  color: colors[token.type],
                  fontSize: fs,
                  fontFamily: monoFont,
                  lineHeight: lh,
                  fontWeight: token.type === 'heading' || token.type === 'bold' ? '600' : undefined,
                }}
              >
                {token.text}
              </Text>
            ))}
          </Text>
        );
      })}
      {truncated && (
        <Text style={{ fontSize: fs, fontFamily: monoFont, lineHeight: lh, color: muted(isDark) }}>
          ...
        </Text>
      )}
    </View>
  );
}
