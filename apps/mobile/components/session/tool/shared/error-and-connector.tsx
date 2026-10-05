/**
 * Error parsing and connector payload pieces.
 *
 * Mirrors apps/web `tool/shared/error-and-connector.tsx`:
 * - `parseErrorContent` / `ValidationIssue` (re-exported from
 *   `lib/session/activity.ts`, which already ports them for `ToolError`);
 * - `parseConnectorOutput` (from `lib/session/tool-output-parsers.ts`);
 * - `ConnectorRiskBadge` — `text-[10px] font-semibold tracking-wide
 *   uppercase`, success for `read`, destructive for `destructive`, warning
 *   otherwise;
 * - `ConnectorJson` — `{}` in mono `text-xs text-muted-foreground/60` for an
 *   empty value, else pretty JSON in an `OutputBlock`.
 */

import { Text } from '@/components/ui/text';
import { FONT_SEMIBOLD, TURN_TYPE, monoFont, useTurnPalette } from './styles';
import { OutputBlock } from './output-block';

export { parseErrorContent, type ValidationIssue } from '@/lib/session/activity';
export { parseConnectorOutput } from '@/lib/session/tool-output-parsers';

export function ConnectorRiskBadge({ risk }: { risk?: unknown }) {
  const palette = useTurnPalette();
  if (typeof risk !== 'string' || !risk) return null;
  const color = risk === 'read' ? palette.success : risk === 'destructive' ? palette.destructive : palette.warning;
  return (
    <Text
      variant="small"
      style={[
        TURN_TYPE.label10,
        { flexShrink: 0, fontFamily: FONT_SEMIBOLD, letterSpacing: 0.25, textTransform: 'uppercase', color },
      ]}
    >
      {risk}
    </Text>
  );
}

export function ConnectorJson({ value }: { value: unknown }) {
  const palette = useTurnPalette();
  if (value == null || (typeof value === 'object' && Object.keys(value as object).length === 0)) {
    return (
      <Text variant="muted" style={[TURN_TYPE.xs, { fontFamily: monoFont, color: palette.muted60 }]}>
        {'{}'}
      </Text>
    );
  }
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return <OutputBlock text={text} />;
}
