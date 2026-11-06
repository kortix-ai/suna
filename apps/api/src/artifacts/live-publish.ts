/**
 * What the Artifact write paths call after a commit (KRTX-3669): a `changed`
 * ping for the viewers of an Artifact, an access re-check of its sockets, and
 * the agent presence a comment hand-off or an agent reply implies.
 *
 * Light on purpose: `artifacts/service.ts`, `comments-service.ts` and
 * `comment-delivery.ts` import it, so it imports neither of them. The sockets
 * of this process are reached through the sink `live-hub.ts` registers; every
 * other process through `kortix_artifact_live`. Nothing here throws, and
 * nothing here can fail the write that called it.
 */
import { randomBytes } from 'node:crypto';
import type { ArtifactCommentAnchor } from '@kortix/shared/artifact-comments';
import { artifactLivePositionSchema, type ArtifactLiveChange, type ArtifactLivePosition } from '@kortix/shared/artifact-live';
import { logger } from '../lib/logger';
import { publishArtifactLive } from '../shared/pg-broadcast';
import { clipText } from './live-rooms';

/** This process on `kortix_artifact_live`: every replica drops its own echo. */
export const ARTIFACT_LIVE_ORIGIN = randomBytes(6).toString('hex');

/** pg_notify refuses a payload of 8000 bytes or more. */
export const ARTIFACT_LIVE_NOTIFY_MAX_BYTES = 7_900;

interface LocalSink {
  changed(artifactId: string, what: ArtifactLiveChange, version: string | null): void;
  recheck(artifactId: string): void;
}

let sink: LocalSink | null = null;

/** `live-hub.ts` registers the sockets of this process. */
export function setArtifactLiveSink(next: LocalSink | null): void {
  sink = next;
}

/** One delta on the channel, when it fits; else nothing (never a partial payload). */
export function sendArtifactLiveDelta(delta: Record<string, unknown>): boolean {
  const payload = JSON.stringify({ o: ARTIFACT_LIVE_ORIGIN, ...delta });
  if (Buffer.byteLength(payload) > ARTIFACT_LIVE_NOTIFY_MAX_BYTES) return false;
  publishArtifactLive(payload);
  return true;
}

function safely(what: string, run: () => void): void {
  try {
    run();
  } catch (error) {
    logger.warn('[artifact-live] publish failed', { what, error: error instanceof Error ? error.message : String(error) });
  }
}

/** Tell every viewer of the Artifact to refetch `what` through REST. */
export function publishArtifactLiveChange(artifactId: string, what: ArtifactLiveChange, version: string | null = null): void {
  const v = typeof version === 'string' && version.length > 0 && version.length <= 512 ? version : null;
  const a = artifactId.toLowerCase();
  safely('changed', () => {
    sink?.changed(a, what, v);
    sendArtifactLiveDelta({ k: 'ch', a, w: what, v });
  });
}

/** Sharing changed or the Artifact is gone: every socket on it re-checks its access now. */
export function requestArtifactLiveRecheck(artifactId: string): void {
  const a = artifactId.toLowerCase();
  safely('recheck', () => {
    sink?.recheck(a);
    sendArtifactLiveDelta({ k: 'chk', a });
  });
}

/** Where an agent shows for a comment anchor: a doc quote or a page point. */
export function artifactLiveAnchorCursor(anchor: ArtifactCommentAnchor | null | undefined): ArtifactLivePosition | null {
  if (!anchor) return null;
  let position: unknown = null;
  if (anchor.type === 'text') {
    position = { kind: 'doc', quote: clipText(anchor.quote, 64), prefix: anchor.prefix, offset: 0 };
  } else if (anchor.type === 'point') {
    position = { kind: 'page', selector: anchor.selector, x: anchor.offset.x, y: anchor.offset.y };
  } else if (anchor.type === 'region') {
    position = { kind: 'page', selector: anchor.selector, x: anchor.offset.x + anchor.offset.width / 2, y: anchor.offset.y + anchor.offset.height / 2 };
  }
  const parsed = artifactLivePositionSchema.safeParse(position);
  return parsed.success ? parsed.data : null;
}

/** A comment hand-off reached `sessionId`: its agent shows reading at the first thread. */
export function announceArtifactLiveDelivery(input: {
  artifactId: string;
  projectId: string;
  sessionId: string;
  agentName: string;
  threadId: string;
  anchor: ArtifactCommentAnchor | null;
}): void {
  const cursor = artifactLiveAnchorCursor(input.anchor);
  void import('./live-hub')
    .then((hub) => hub.artifactLiveAgentDelivered({ ...input, cursor }))
    .catch((error) => logger.warn('[artifact-live] delivery presence failed', { error: error instanceof Error ? error.message : String(error) }));
}

/** `sessionId` wrote a comment on the Artifact: its "writing" ends. */
export function announceArtifactLiveAgentWrote(artifactId: string, sessionId: string | null): void {
  if (!sessionId) return;
  void import('./live-hub')
    .then((hub) => hub.artifactLiveAgentWrote(artifactId, sessionId))
    .catch((error) => logger.warn('[artifact-live] agent reply presence failed', { error: error instanceof Error ? error.message : String(error) }));
}
