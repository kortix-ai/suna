import type {
	Message,
	Part,
	SnapshotFileDiff,
} from "@opencode-ai/sdk/v2/client";

// Inlined from web's `@/ui/types` (FileDiff is a derived type, not exported by
// the OpenCode SDK). Type-only — zero runtime impact, byte-identical behavior.
export type FileDiff = Omit<SnapshotFileDiff, "patch"> & {
	patch?: string;
	before?: string;
	after?: string;
};

// ============================================================================
// MessageWithParts — the shape components consume
// ============================================================================

export interface MessageWithParts {
	info: Message;
	parts: Part[];
}
