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

export interface MentionItem {
  kind: 'file' | 'agent' | 'session';
  label: string;
  value?: string;
  description?: string;
}

export interface TrackedMention {
  kind: 'file' | 'agent' | 'session';
  label: string;
  value?: string; // session ID for session mentions
}
