'use client';

/**
 * ACP turns are owned by their sandbox process and their envelopes are durable
 * through the session-scoped API. Background tabs no longer need one hidden
 * OpenCode SSE client per sandbox to keep a turn alive.
 */
export function SessionStreamKeeper(_props: { projectId: string }) {
  return null;
}
