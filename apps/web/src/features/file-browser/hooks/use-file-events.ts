'use client';

/**
 * DEPRECATED: This hook previously opened a separate SSE connection to the
 * old `/event` endpoint for file change events. That duplicate connection
 * caused `ERR_INCOMPLETE_CHUNKED_ENCODING` errors and interfered with the
 * main SSE stream (`/global/event`).
 *
 * File events (file.edited, file.watcher.updated) are now handled by the
 * main event stream in `use-opencode-events.ts`. This hook is kept as a
 * no-op so existing imports don't break.
 */
export function useFileEventInvalidation() {
  // No-op — file events are handled by the global SSE stream
}
