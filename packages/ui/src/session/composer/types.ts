/**
 * Shared composer types — split out of `session-chat-input.tsx` so both that
 * file and everything under `composer/` can depend on them without a
 * circular import (the UI pieces that used to live inline there now live in
 * sibling files here). `session-chat-input.tsx` re-exports these so the many
 * existing `from './session-chat-input'` importers across
 * the app keep working unchanged.
 */

export type AttachedFile =
  | {
      kind: 'local';
      /** SDK controller identity. Absent only for legacy non-composer callers. */
      uploadId?: string;
      /** `Date.now()` when the file entered the composer. The upload ring waits 400 ms from it. */
      attachedAt?: number;
      file: File;
      localUrl: string;
      isImage: boolean;
      /** Staged from the project's Drive by an `@` pick: the file's Drive path. */
      drivePath?: string;
    }
  | {
      kind: 'remote';
      url: string;
      filename: string;
      mime: string;
      isImage: boolean;
    }
  | {
      /**
       * A finished upload a stored draft brought back after a reload: the
       * server holds the bytes, this tab has no File, so the tile shows the
       * name only (`isImage` false). Sent by its handle, like a local upload.
       */
      kind: 'uploaded';
      uploadId: string;
      filename: string;
      mime: string;
      /** Bytes on the server: the tray counts them toward the message limits. */
      size: number;
      isImage: boolean;
      /** Staged from the project's Drive by an `@` pick: the file's Drive path. */
      drivePath?: string;
    };

/**
 * `person`: a member of a space (`@` menu inside a space only); it leaves the composer as plain `@token` text.
 * `drive`: a file in the project's Drive. `label` is its name, `value` its Drive path.
 */
export type MentionKind = 'file' | 'agent' | 'session' | 'person' | 'drive';

/**
 * Every kind of chip the editor document can hold.
 *
 * `command` is the `/` slash-command chip. It is stored as the same atom node
 * as an `@` mention (`editor/mention-node.ts`) — one node type, one insert
 * helper, one serializer walk — but it is NOT a `TrackedMention`: mentions
 * become `<file_ref>`/`<agent_ref>`/`<session_ref>` blocks on the wire, and a
 * command becomes the `onCommand(command, args)` call instead. `collectMentions`
 * (`editor/serialize.ts`) filters it out for exactly that reason.
 */
export type ChipKind = MentionKind | 'command';

export interface MentionItem {
  kind: MentionKind;
  label: string;
  value?: string;
  description?: string;
}

export interface TrackedMention {
  kind: MentionKind;
  label: string;
  value?: string; // session ID for session mentions, Drive path for drive mentions
}
