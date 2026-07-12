'use client';
// Re-export the SDK's pending store so the web shares ONE instance with the SDK's
// event stream + useSession (the SSE writes questions/permissions here, the chat
// reads them). Previously a local fork; the SDK now carries its `resolvedQuestionIds`
// guard too (a resolved question can't be resurrected by a stale SSE re-add).
export * from '@kortix/sdk/opencode-pending-store';
