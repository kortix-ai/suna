import type { Node as ProseMirrorNode } from '@tiptap/pm/model';

import type { MentionKind, TrackedMention } from '../types';

/**
 * The shape `collectMentions` needs — kept structural so it is testable
 * without constructing a real ProseMirror document.
 */
export interface SerializableNode {
  type: string;
  text?: string;
  attrs?: { kind?: string; label?: string; value?: string };
}

/**
 * Walk a flattened node list and pull out every mention as a
 * `TrackedMention`, in document order, one entry per occurrence.
 *
 * This is the fix for the bug the whole node model exists to kill: the old
 * string-based composer resolved mentions with `text.indexOf(needle)`, which
 * finds only the FIRST match, so two `@README.md` mentions collapsed into
 * one tracked mention. Each mention is its own atom node here, so this just
 * pushes one entry per node — duplicates cannot merge or drop.
 */
export function collectMentions(nodes: SerializableNode[]): TrackedMention[] {
  const mentions: TrackedMention[] = [];
  for (const node of nodes) {
    if (node.type !== 'mention') continue;
    const kind = (node.attrs?.kind ?? 'file') as MentionKind;
    const label = node.attrs?.label ?? '';
    // Only sessions round-trip an id — files and agents are addressed by
    // label, matching TrackedMention's existing shape (types.ts) and what
    // session-chat.tsx's send path already expects.
    mentions.push(
      kind === 'session' ? { kind, label, value: node.attrs?.value ?? '' } : { kind, label },
    );
  }
  return mentions;
}

/** Flatten a ProseMirror document into the structural node list above. */
export function flattenDocument(doc: ProseMirrorNode): SerializableNode[] {
  const nodes: SerializableNode[] = [];
  doc.descendants((node) => {
    if (node.type.name === 'mention') {
      nodes.push({ type: 'mention', attrs: node.attrs as SerializableNode['attrs'] });
      return false;
    }
    if (node.isText) nodes.push({ type: 'text', text: node.text ?? '' });
    return true;
  });
  return nodes;
}

/**
 * Turn the live editor document into the `{ text, mentions }` pair the send
 * path already consumes (`session-chat.tsx`'s `handleSend(rawText, files,
 * mentions)`).
 *
 * `text` keeps every mention inline as `@<label>` — this is the
 * human-readable body a user typed/sees, not a wire-protocol token: the
 * three receiving parsers this task must not drift from
 * (`parseFileMentionReferences`, `parseAgentMentionReferences`,
 * `parseSessionReferences` in `message-parsing.tsx`) do NOT match `@label`
 * substrings at all. They match `<file_ref>`/`<agent_ref>`/`<session_ref>`
 * XML blocks that `session-chat.tsx`'s `handleSend` appends AFTER this text,
 * built from the separate `mentions` array via `buildFileRefsBlock` /
 * `buildAgentRefsBlock` (`lib/project-preamble.ts`) and its own inline
 * `<session_ref>` construction. `mentions` is therefore the half of this
 * return value those parsers actually depend on; `text` only has to stay
 * human-readable and round-trip through `HighlightMentions`-style `@`
 * detection, which this format already satisfies.
 *
 * The `leafText` callback passed to `textBetween` is the ONLY thing that
 * governs a mention node's text here — ProseMirror's `Node.textBetween`
 * prioritises an explicit `leafText` argument over `node.type.spec.leafText`
 * (see prosemirror-model's `Fragment.textBetween`), and TipTap's
 * `renderText()` (mention-node.ts) compiles to `spec.toText`, a distinct
 * field `textBetween` never reads. So `renderText()` is inert on this path;
 * it exists only for TipTap's own `editor.getText()` helper, which walks the
 * doc separately. Both are kept literally identical (`@${label}`) so the two
 * paths can never disagree if something starts calling `getText()` later.
 */
export function serializeDocument(doc: ProseMirrorNode): {
  text: string;
  mentions: TrackedMention[];
} {
  const flat = flattenDocument(doc);
  const text = doc.textBetween(0, doc.content.size, '\n', (node) =>
    node.type.name === 'mention' ? `@${node.attrs.label}` : '',
  );
  return { text: text.trim(), mentions: collectMentions(flat) };
}
