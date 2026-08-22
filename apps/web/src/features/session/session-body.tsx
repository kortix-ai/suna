'use client';

/**
 * The session body's geometry — ONE definition, shared by the two components
 * that draw it.
 *
 * A fresh session paints its body twice: {@link InstantSessionShell} while the
 * computer boots, then {@link SessionChat} once the runtime is healthy, with a
 * 300ms crossfade between them (see the route's dual-layer mount). During that
 * fade both are on screen at once, so any difference between them is not a
 * cosmetic drift — it is a visible double image sliding sideways.
 *
 * They had drifted in three ways, each worth real pixels:
 *
 *  1. Only `SessionChat` rendered {@link SessionActionPanelColumn}. That column
 *     is IN FLOW (28px chevron + 4px margin + 8px gap = 40px), so the chat's
 *     conversation column was 40px narrower than the shell's. Both centre their
 *     content, so the whole thread and the composer jumped 20px left the frame
 *     the chat took over — and the chevron itself popped into existence with it.
 *  2. The transcript column ran `px-3 py-6 sm:px-6` on the shell against
 *     `px-7 pt-6 md:pr-4` on the chat. The shell's comment claimed the geometry
 *     was "copied from SessionChat's scroll area verbatim"; it had not been true
 *     since the chat moved to an asymmetric gutter.
 *  3. The shell docked its composer OUTSIDE the body column, so it centred
 *     against the full width while the chat's centred against width-minus-panel.
 *
 * Comments cannot hold that line — this file is the same answer the codebase
 * already reached for the message bubble (`BUBBLE_SURFACE` in
 * `turn/user-message.tsx`, imported by both renderers rather than copied).
 */

import { SessionActionPanelColumn } from '@/features/session/session-action-panel-column';
import type { ReactNode } from 'react';

/**
 * The conversation column: max width, centring, and gutters.
 *
 * 12px more inset than the composer on both sides (`COMPOSER_SHELL_CLASS` is
 * `px-4 md:pr-1`), so the input card reads slightly WIDER than the conversation
 * and a right-aligned bubble never sits flush with the card's edge. `pt-6` and
 * NO bottom padding: the space under the last message is the auto-scroll
 * spacer's job alone (use-auto-scroll.ts).
 */
export const SESSION_TRANSCRIPT_CLASS = 'mx-auto w-full max-w-3xl min-w-0 px-7 pt-6 md:pr-4';

/**
 * The chat + action-panel row.
 *
 * The panel is a real column, not an overlay: opening it takes width from this
 * row and the chat column re-centres its own content in what is left. An
 * absolutely positioned version floated over the transcript instead of moving
 * it.
 *
 * `actionPanel` is a RENDER gate, not a state one. It is false for the surfaces
 * that have no panel to offer — the read-only sub-session modal, the headerless
 * embed, and the instant shell's pre-submit welcome hero (which is the
 * project-home empty state and must stay centred on the full width, exactly as
 * project home draws it). The moment the shell has a thread to show it turns
 * true, because that thread is what crossfades into `SessionChat`.
 */
export function SessionBodyRow({
  children,
  actionPanel = true,
  transient = false,
}: {
  children: ReactNode;
  actionPanel?: boolean;
  /**
   * This row belongs to the instant boot shell, which the real chat crossfades
   * over. Both rows are mounted for the length of that fade, so the transient
   * one yields the ⌘I binding rather than doubling it — see the column's own
   * `hotkey` doc.
   */
  transient?: boolean;
}) {
  return (
    <div className="flex min-h-0 flex-1 overflow-hidden">
      <div className="relative flex min-w-0 flex-1 flex-col">{children}</div>
      {actionPanel && <SessionActionPanelColumn hotkey={!transient} />}
    </div>
  );
}
