/**
 * One agent row: the grammar every MyKortix agent surface shares on mobile, a
 * port of apps/web `session/agents/agent-surface.tsx`. An agent call, an
 * agent's finish, a message to or from another agent: one tool row.
 *
 *   [face] Title  what it is about…                    ◔ State
 *          │ the detail, on a rail in the icon lane, when the row opens
 *
 * The state is the session list's glyph and a muted word: the hue is on the
 * glyph, never on the words. Never a card of its own.
 */

import { useState, type ReactNode } from 'react';
import { View } from 'react-native';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { ArrowUpRightIcon } from '@/lib/icons';
import { Text } from '@/components/ui/text';
import { SessionStatusMark } from '@/components/session/SessionStatusMark';
import type { SessionDisplayStatus } from '@/lib/session/session-list';
import { AgentPixelMark, agentSlugOfHandle } from './agent-pixel-mark';
import { BasicTool } from './infrastructure';
import { TURN_TYPE, useTurnPalette } from './styles';
import { webSpace } from '@/lib/session/user-message';
import { ToolError } from '../tool-error';

/** The rail an open agent row's detail sits on: the centre of the 16pt face, text on the title's edge. */
export function AgentRowBody({ children }: { children: ReactNode }) {
  const palette = useTurnPalette();
  return (
    <View style={{ marginLeft: webSpace(2), paddingLeft: webSpace(3), borderLeftWidth: 1, borderLeftColor: palette.border, gap: webSpace(2.5), paddingVertical: webSpace(1) }}>
      {children}
    </View>
  );
}

/** "Open ↗" on an open agent row: the agent's own session. */
export function OpenAgentAction({ onPress, label = 'Open' }: { onPress: () => void; label?: string }) {
  return (
    <Button variant="ghost" size="sm" className="self-start" accessibilityLabel={label} onPress={onPress}>
      <Text>Open</Text>
      <Icon as={ArrowUpRightIcon} className="text-muted-foreground" size={14} />
    </Button>
  );
}

/**
 * Why an agent or a run did not finish (web `AgentFailure`): one sentence in ink,
 * and the platform's raw text behind "Details".
 */
export function AgentFailure({ sentence, raw, toolName }: { sentence: string; raw?: string | null; toolName: string }) {
  const palette = useTurnPalette();
  const [open, setOpen] = useState(false);
  const detail = raw?.trim();
  return (
    <View style={{ gap: webSpace(1) }}>
      <Text style={[TURN_TYPE.sm, { color: palette.foreground }]}>{sentence}</Text>
      {detail ? (
        <Button variant="ghost" size="sm" className="self-start" accessibilityState={{ expanded: open }} onPress={() => setOpen((value) => !value)}>
          <Text>Details</Text>
        </Button>
      ) : null}
      {detail && open ? <ToolError error={detail} toolName={toolName} /> : null}
    </View>
  );
}

export function AgentRow({
  handle,
  title,
  subtitle,
  state,
  glyph,
  body,
  text,
  defaultOpen,
  testID,
}: {
  /** The agent's handle: its face is the row's icon. */
  handle: string | null;
  title: string;
  subtitle?: string | null;
  /** The muted word at the right edge ("Delivered", "Finished"). */
  state?: string;
  /** The session-list glyph beside the word. */
  glyph?: SessionDisplayStatus;
  /** What the row opens onto. */
  body?: ReactNode;
  /** Plain text the row opens onto, when there is no `body`. */
  text?: string | null;
  defaultOpen?: boolean;
  testID?: string;
}) {
  const palette = useTurnPalette();
  const content =
    body ??
    (text?.trim() ? (
      <AgentRowBody>
        <Text selectable style={[TURN_TYPE.sm, { color: palette.foreground }]}>
          {text}
        </Text>
      </AgentRowBody>
    ) : undefined);
  return (
    <View testID={testID}>
      <BasicTool
        icon={handle ? <AgentPixelMark slug={agentSlugOfHandle(handle)} size={14} tile={16} /> : undefined}
        defaultOpen={defaultOpen}
        trigger={
          <>
            <Text numberOfLines={1} style={[TURN_TYPE.sm, { flexShrink: 0, maxWidth: '60%', color: palette.foreground }]}>
              {title}
            </Text>
            {subtitle ? (
              <Text numberOfLines={1} style={[TURN_TYPE.sm, { flex: 1, color: palette.mutedForeground }]}>
                {subtitle}
              </Text>
            ) : (
              <View style={{ flex: 1 }} />
            )}
            {state ? (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: webSpace(1.5), flexShrink: 0, paddingLeft: webSpace(3) }}>
                {glyph ? <SessionStatusMark status={glyph} /> : null}
                <Text style={[TURN_TYPE.xs, { color: palette.mutedForeground }]}>{state}</Text>
              </View>
            ) : null}
          </>
        }
      >
        {content}
      </BasicTool>
    </View>
  );
}

/** The earlier name: a message row is an agent row. */
export const MessageRow = AgentRow;
