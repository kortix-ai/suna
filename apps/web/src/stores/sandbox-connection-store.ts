'use client';
// Re-export the SDK's sandbox-connection-store so the web shares ONE instance
// with the SDK's useSessionSync / event-stream / useSession (which gate on the
// same `healthy` flag). Previously this was a byte-identical local fork — a
// separate Zustand store — which split readiness across two instances held
// together only by a shared sessionStorage flag + connSwitchReset registration
// order. One store removes that split-brain. See docs/specs/sdk-session-collapse.md §11.
export * from '@kortix/sdk/sandbox-connection-store';
