/**
 * The agent asked for permission and the tool call is held open until it is
 * answered.
 *
 * The card shows the FULL arguments of the gated call — never a summary, never
 * a truncation. An approval gate that hides what is being approved is not a
 * gate (memory `approval-gate-must-show-arguments`). The request itself
 * carries only `{messageID, callID}` plus match patterns, so the transcript
 * resolves the call out of the messages it already has (`findToolCall`) and
 * passes it in.
 *
 * Keys (only while `focused`):
 *   y  allow once      → answerPermission(id, 'once')
 *   a  allow always    → answerPermission(id, 'always')
 *   n  deny            → answerPermission(id, 'reject')
 *
 * `Esc` is deliberately inert: the safe default here is "no answer yet", and a
 * key people press to dismiss things must not double as a decision.
 */

import type { PermissionRequest } from '@kortix/sdk';
import { useKeyboard } from '@opentui/react';

import { type GatedToolCall, clip, formatArguments } from '../../../lib/turn-layout.ts';
import { theme } from '../../../theme.ts';

export type PermissionReply = 'once' | 'always' | 'reject';

export interface PermissionPromptProps {
  permission: PermissionRequest;
  /** `session.answerPermission`. */
  onReply: (requestId: string, reply: PermissionReply) => void;
  focused: boolean;
  width: number;
  /** The call this request gates, resolved from the transcript. */
  toolCall?: GatedToolCall | null;
}

export function PermissionPrompt({
  permission,
  onReply,
  focused,
  width,
  toolCall = null,
}: PermissionPromptProps) {
  useKeyboard((key) => {
    if (!focused) return;
    if (key.ctrl || key.option) return;
    if (key.name === 'y') return onReply(permission.id, 'once');
    if (key.name === 'a') return onReply(permission.id, 'always');
    if (key.name === 'n') return onReply(permission.id, 'reject');
  });

  const body = Math.max(width - 4, 12);
  const argumentLines = formatArguments(toolCall?.input);
  const patterns = permission.patterns ?? [];

  return (
    <box
      flexDirection="column"
      border
      borderStyle="single"
      borderColor={focused ? theme.danger : theme.border}
      title="Permission"
      titleColor={focused ? theme.fg : theme.dim}
      paddingLeft={1}
      paddingRight={1}
      width={Math.max(width, 16)}
    >
      <text fg={theme.fg}>
        {clip(`${toolCall?.name ?? permission.permission} needs permission`, body)}
      </text>
      {patterns.map((pattern) => (
        <text key={pattern} fg={theme.dim} wrapMode="word" width={body}>
          {pattern}
        </text>
      ))}
      {argumentLines.length > 0 ? <text fg={theme.faint}>arguments</text> : null}
      {argumentLines.map((line, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: JSON lines carry no id
        <text key={`arg-${index}`} fg={theme.dim} wrapMode="word" width={body}>
          {line}
        </text>
      ))}
      <text fg={theme.faint}>{clip('y allow once · a allow always · n deny', body)}</text>
    </box>
  );
}
