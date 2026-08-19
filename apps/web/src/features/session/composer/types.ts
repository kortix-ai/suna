/**
 * Shared composer types — split out of `session-chat-input.tsx` so both that
 * file and everything under `composer/` can depend on them without a
 * circular import (the UI pieces that used to live inline there now live in
 * sibling files here). `session-chat-input.tsx` re-exports these so the many
 * existing `from '@/features/session/session-chat-input'` importers across
 * the app keep working unchanged.
 */

export type AttachedFile =
  | {
      kind: 'local';
      file: File;
      localUrl: string;
      isImage: boolean;
    }
  | {
      kind: 'remote';
      url: string;
      filename: string;
      mime: string;
      isImage: boolean;
    };

export type MentionKind = 'file' | 'agent' | 'session';

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
  value?: string; // session ID for session mentions
}
