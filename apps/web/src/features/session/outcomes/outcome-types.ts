/**
 * The Outcome domain model — a durable, status-carrying consequence of a turn.
 *
 * Three properties define one, and all three are required: it OUTLIVES the turn
 * that produced it, its status CHANGES after the message is written, and a human
 * can ACT on it. That triple is what disqualifies prose — prose is immutable and
 * outcomes are not.
 *
 * Deliberately not React: every decision that can be wrong lives in a pure
 * module `bun test` can reach, because `apps/web` has no DOM harness.
 *
 * NOT to be confused with what the Show tool renders. Show answers "look at
 * this"; an Outcome answers "this now exists". See the design doc, §2.2.
 */

import type { StatusTone } from '@/components/ui/status';

/**
 * Only ONE kind is produced by a session turn: a change request.
 *
 * Three others were built and removed, each because nothing proved they
 * belonged to the turn that rendered them:
 *
 * - `deliverable` (files) — a file is CONTENT, and content is the Show tool's
 *   job. It needs no decision.
 * - `schedule` — triggers live in `kortix.yaml`, so an agent creates one by
 *   editing the manifest rather than calling a tool, and `ProjectTrigger`
 *   carries no `origin_session_id` to tie one to a turn anyway.
 * - `background_session`, and `external` links derived from connector output —
 *   real, but they made the footer a mixed bag. A change request is the one
 *   outcome that always wants a decision, and `origin_session_id` proves it
 *   came from this session.
 *
 * `external` stays in the union with NO transcript producer. Its only caller is
 * `components/setup-links/setup-link-button.tsx`, which renders this same card
 * inline in prose for a secret or connector link — a different surface, not a
 * turn outcome.
 */
export type OutcomeKind = 'change_request' | 'external';

export type OutcomeTone = StatusTone;

/**
 * Exactly one per card. Two competing buttons on a chat row is where these
 * designs fail — the reader stops reading and starts choosing.
 *
 * `open` asks the host to mount a modal; `link` navigates. The card itself
 * never knows which modal, so it stays presentational and testable.
 */
export interface OutcomeAction {
  label: string;
  intent: 'open' | 'link';
  /** Required when `intent` is `link`; ignored otherwise. */
  href?: string;
}

export interface Outcome {
  /**
   * Stable across a refetch AND across a re-derive — this is the React key and
   * the identity the host matches when opening a modal. Format is
   * `<kind-prefix>:<source id>`, e.g. `cr:cr_01H…`, `sched:daily-digest`.
   */
  id: string;
  kind: OutcomeKind;
  /** Plain language. Never a git word, never a raw path. */
  title: string;
  /** One line of consequence. Never a path dump. */
  description: string;
  /** The live word. "Waiting for you", not "open". */
  status: { label: string; tone: OutcomeTone };
  /** Epoch ms. Orders the list and anchors it to a turn. */
  at: number;
  /** At most three muted facts under the title. Rendered comma-separated. */
  meta: string[];
  action: OutcomeAction;
  /** The addressable URL for this outcome, when one exists. */
  resourceHref: string | null;
}
