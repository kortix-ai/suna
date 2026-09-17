/**
 * ToolError — the body of a failed tool row.
 *
 * Mirrors apps/web `tool/tool-error.tsx` inside `ToolResultCard`:
 * - plain error: summary `font-mono text-xs leading-relaxed text-muted-foreground/80
 *   px-2 py-1.5`; when a traceback exists, a "Stack trace" toggle row
 *   (caret `size-3.5` rotating, `text-xs font-medium text-muted-foreground/60`,
 *   `px-2 py-1.5 gap-1.5 rounded-sm`) opens the trace (`text-muted-foreground/50`,
 *   mono `text-xs leading-relaxed`, `px-2 pb-1.5`);
 * - validation issues: header (Prohibit `size-3.5` muted/70, type medium muted,
 *   tool name mono muted/50) and one line per issue (WarningCircle muted/60,
 *   path badge, message foreground/80, expected values).
 *
 * Not ported: web's `StructuredOutput` (warning / install / traceback
 * sections). Such errors render through the plain branch.
 */

import { memo, useMemo, useState } from 'react';
import { Pressable, View } from 'react-native';
import { Badge } from '@/components/ui/badge';
import { Text } from '@/components/ui/text';
import { ProhibitIcon, WarningCircleIcon } from '@/lib/icons';
import { parseErrorContent } from '@/lib/session/activity';
import { webSpace } from '@/lib/session/user-message';
import { disclosureKey, useDisclosureChoice, useDisclosureStore } from '@/lib/session/disclosure-store';
import { DisclosureCaret } from '@/components/session/chain-of-thought';
import { FONT_MEDIUM, TURN_SPACE, TURN_TYPE, monoFont, useTurnPalette } from './shared/styles';
import { ToolCardFrame } from './shared/surface';

function ToolErrorImpl({
  error,
  toolName,
  partId,
}: {
  error: string;
  toolName?: string;
  /** Keys the stack-trace toggle in the disclosure store so it survives list recycling. */
  partId?: string;
}) {
  const palette = useTurnPalette();
  const { summary, traceback, errorType, validationIssues } = useMemo(
    () => parseErrorContent(error),
    [error],
  );
  const key = partId ? disclosureKey('trace', partId) : undefined;
  const storedChoice = useDisclosureChoice(key ?? '');
  const [localOpen, setLocalOpen] = useState(false);
  const showTrace = key ? (storedChoice ?? false) : localOpen;
  const toggleTrace = () => {
    if (key) useDisclosureStore.getState().setChoice(key, !showTrace);
    else setLocalOpen((v) => !v);
  };

  if (validationIssues && validationIssues.length > 0) {
    return (
      <ToolCardFrame padded={false} framePad={TURN_SPACE.resultFramePad}>
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: TURN_SPACE.gap2,
            paddingHorizontal: TURN_SPACE.errorPadX,
            paddingTop: TURN_SPACE.errorPadY,
            paddingBottom: webSpace(1),
          }}
        >
          <ProhibitIcon size={TURN_SPACE.caret} color={palette.muted70} />
          <Text variant="small" style={[TURN_TYPE.xs, { fontFamily: FONT_MEDIUM, color: palette.mutedForeground }]}>
            {errorType || 'Error'}
          </Text>
          {toolName ? (
            <Text variant="muted"
              numberOfLines={1}
              style={[TURN_TYPE.xs, { marginLeft: 'auto', fontFamily: monoFont, color: palette.muted50 }]}
            >
              {toolName}
            </Text>
          ) : null}
        </View>
        <View
          style={{
            rowGap: webSpace(2.5),
            paddingHorizontal: TURN_SPACE.errorPadX,
            paddingTop: webSpace(1),
            paddingBottom: TURN_SPACE.errorPadX,
          }}
        >
          {validationIssues.map((issue) => (
            <View key={`${issue.path.join('.')}:${issue.message}`} style={{ rowGap: TURN_SPACE.gap1_5 }}>
              <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: TURN_SPACE.gap2 }}>
                <View style={{ marginTop: webSpace(0.5) }}>
                  <WarningCircleIcon size={TURN_SPACE.caret} color={palette.muted60} />
                </View>
                <View style={{ flex: 1, minWidth: 0, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center' }}>
                  {issue.path.length > 0 ? (
                    <Badge variant="secondary" style={{ marginRight: TURN_SPACE.gap1_5 }}>
                      <Text style={{ fontFamily: monoFont }}>{issue.path.join('.')}</Text>
                    </Badge>
                  ) : null}
                  <Text style={[TURN_TYPE.xs, { color: palette.foreground80 }]}>{issue.message}</Text>
                </View>
              </View>
              {issue.values && issue.values.length > 0 ? (
                <View style={{ marginLeft: webSpace(5.5) }}>
                  <Text variant="muted" style={[TURN_TYPE.xs, { marginBottom: webSpace(1), color: palette.muted50 }]}>
                    Expected one of:
                  </Text>
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: webSpace(1) }}>
                    {issue.values.map((value, i) => (
                      <Badge key={i} variant="secondary">
                        <Text style={{ fontFamily: monoFont }}>{value}</Text>
                      </Badge>
                    ))}
                  </View>
                </View>
              ) : null}
            </View>
          ))}
        </View>
      </ToolCardFrame>
    );
  }

  return (
    <ToolCardFrame padded={false} framePad={TURN_SPACE.resultFramePad}>
      <Text variant="muted"
        selectable
        style={[
          TURN_TYPE.xsRelaxed,
          {
            fontFamily: monoFont,
            color: palette.muted80,
            paddingHorizontal: TURN_SPACE.errorPadX,
            paddingVertical: TURN_SPACE.errorPadY,
          },
        ]}
      >
        {summary}
      </Text>
      {traceback ? (
        <>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded: showTrace }}
            onPress={toggleTrace}
            style={({ pressed }) => ({
              flexDirection: 'row',
              alignItems: 'center',
              gap: TURN_SPACE.gap1_5,
              paddingHorizontal: TURN_SPACE.errorPadX,
              paddingVertical: TURN_SPACE.errorPadY,
              borderRadius: TURN_SPACE.radiusSm,
              backgroundColor: pressed ? palette.muted : undefined,
            })}
          >
            <DisclosureCaret open={showTrace} color={palette.muted60} />
            <Text variant="small" style={[TURN_TYPE.xs, { fontFamily: FONT_MEDIUM, color: palette.muted60 }]}>
              Stack trace
            </Text>
          </Pressable>
          {showTrace ? (
            <Text variant="muted"
              selectable
              style={[
                TURN_TYPE.xsRelaxed,
                {
                  fontFamily: monoFont,
                  color: palette.muted50,
                  paddingHorizontal: TURN_SPACE.errorPadX,
                  paddingBottom: TURN_SPACE.errorPadY,
                },
              ]}
            >
              {traceback}
            </Text>
          ) : null}
        </>
      ) : null}
    </ToolCardFrame>
  );
}

export const ToolError = memo(ToolErrorImpl);
ToolError.displayName = 'ToolError';
