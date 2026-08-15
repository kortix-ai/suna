import type {
	AssistantMessage,
	Message,
	Part,
	SnapshotFileDiff,
} from "@opencode-ai/sdk/v2/client";
import type { AbortReason } from "../../../core/http/abort-error";
export type { SessionRewindState } from "../../../core/session/rewind";

// Inlined from web's `@/ui/types` (FileDiff is a derived type, not exported by
// the OpenCode SDK). Type-only — zero runtime impact, byte-identical behavior.
export type FileDiff = Omit<SnapshotFileDiff, "patch"> & {
	patch?: string;
	before?: string;
	after?: string;
};

/**
 * A locally-synthesized "operation aborted" marker — distinct from (and not
 * present in) the opencode SDK's `AssistantMessage['error']` union. The React
 * layer fabricates this shape both for a real user Stop and when a runtime
 * disposes mid-stream (there's no real SSE event for either case); consumers
 * duck-type on `.name`/`.data.message` exactly like the real wire errors, so
 * it only needs to match that access pattern, not the SDK's exact error
 * union.
 *
 * `data.reason` is the machine-readable WHY — read via `abortErrorReason`
 * (`core/http/abort-error.ts`), which is also where the closed `AbortReason`
 * union and its "not yet emitted" members are documented. Optional because a
 * real wire `MessageAbortedError` (which shares this duck-typed access
 * pattern but is a different TS type) never carries one.
 */
export interface SyntheticAbortError {
	name: "AbortError";
	data: { message: string; reason?: AbortReason };
}

/** Every shape `AssistantMessage.error` (and `session.error`'s `error`
 *  property) can carry — the SDK's wire union plus the client-synthesized
 *  abort marker above. */
export type MessageError = NonNullable<AssistantMessage["error"]> | SyntheticAbortError;

// ============================================================================
// MessageWithParts — the shape components consume
// ============================================================================

export interface MessageWithParts {
	info: Message;
	parts: Part[];
}
