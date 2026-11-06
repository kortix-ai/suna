/**
 * MyKortix multi-agent messaging and team tools, as mobile draws them: the
 * labels and glyphs of web's English locale (`multiAgent.tools`,
 * `multiAgent.peer`, `multiAgent.strip`). The result parsers and the message
 * rules are the SDK's (`@kortix/sdk`: `parsePeerSend`, `peerMessagePreview`,
 * `heldMessages`, …).
 */

import type { PeerMessageKind } from '@kortix/shared';
import type { PeerMessageStatus, SessionBoardState, TeamTaskRow } from '@kortix/sdk';
import type { SessionDisplayStatus } from '@/lib/session/session-list';

/** Web `multiAgent.peer`: the headline a delivered message draws. */
export function peerHeadline(kind: PeerMessageKind, from: string): string {
  switch (kind) {
    case 'idle_notice':
      return `${from} finished`;
    case 'shutdown_request':
      return `Shutdown request from ${from}`;
    case 'shutdown_response':
      return `Shutdown answer from ${from}`;
    default:
      return `Message from ${from}`;
  }
}

/** Web `multiAgent.tools.peerStatus`. */
export const PEER_STATUS_LABEL: Record<PeerMessageStatus, string> = {
  delivered: 'Delivered',
  held: 'Waiting for approval',
  refused: 'Not sent',
  denied: 'Declined',
  expired: 'Expired',
  dropped: 'Not sent again',
};

/** A team task's status as a session-list glyph. A blocked open task is the stopped ring. */
export function taskGlyph(task: Pick<TeamTaskRow, 'status' | 'blocked'>): SessionDisplayStatus {
  if (task.status === 'completed') return 'done';
  if (task.status === 'in_progress') return 'running';
  return task.blocked ? 'stopped' : 'starting';
}

/** An agent's board state as a session-list glyph. */
export function agentStateGlyph(state: SessionBoardState): SessionDisplayStatus {
  switch (state) {
    case 'working':
      return 'running';
    case 'needs_input':
      return 'needs-you';
    case 'failed':
      return 'failed';
    case 'stopped':
      return 'stopped';
    default:
      return 'done';
  }
}

/** Web `multiAgent.strip.state`. */
export const AGENT_STATE_LABEL: Record<SessionBoardState, string> = {
  working: 'working',
  needs_input: 'needs you',
  idle: 'done',
  completed: 'done',
  failed: 'failed',
  stopped: 'stopped',
};
