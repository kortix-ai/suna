/**
 * Client-side message ids in OpenCode's wire format.
 *
 * The SDK's `mintWireMessageId` is the one implementation
 * (`packages/sdk/src/core/session/wire-message-id.ts`, pinned by
 * tests/spec/wire-message-id.vectors.json). This module keeps the mobile call
 * shape, `knownMessageIds`, for the existing callers; it passes them to the
 * SDK as `after` and holds no arithmetic of its own.
 *
 * The session thread sorts messages by this id as a string, so an optimistic
 * id must use the wire format: an id in any other format that still matches
 * `msg_` + 12 hex digits sorts against real ids by accident.
 */
import { mintWireMessageId as mintSdkWireMessageId } from '@kortix/sdk';

export const mintWireMessageId = ({
  nowMs,
  knownMessageIds,
}: {
  nowMs: number;
  knownMessageIds: readonly string[];
}): string => mintSdkWireMessageId({ nowMs, after: knownMessageIds });
