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
    // `command` chips share the `mention` atom node (see mention-node.ts) but
    // are NOT references: they leave the composer as `onCommand(command,
    // args)`, never as a `<file_ref>`/`<agent_ref>`/`<session_ref>` block. If
    // they fell through here they would reach `buildFileRefsBlock` as a file
    // named after the command and the agent would be asked to read a path
    // that does not exist.
    if (node.attrs?.kind === 'command') continue;
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

/**
 * The name of the FIRST `/` command chip in the document, or `undefined`.
 *
 * First, not last, and not a list: a message runs at most one command, and the
 * first chip is the one the user picked to lead the message. A second chip is
 * left in the text as a no-op rather than silently changing which command
 * runs — inserting one is a deliberate keystroke, and reordering the user's
 * intent behind their back is worse than ignoring the extra.
 */
export function collectCommandName(nodes: SerializableNode[]): string | undefined {
  for (const node of nodes) {
    if (node.type !== 'mention') continue;
    if (node.attrs?.kind !== 'command') continue;
    const label = node.attrs?.label ?? '';
    if (label) return label;
  }
  return undefined;
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
  /**
   * The `/` command chip leading this message, if there is one. Structured,
   * exactly like `mentions` — and for the same reason: `text` is the
   * human-readable body, and a command is not body. What `text` holds when
   * this is set IS the command's arguments, with no stripping needed at the
   * call site.
   */
  commandName?: string;
} {
  const flat = flattenDocument(doc);
  const text = doc.textBetween(0, doc.content.size, '\n', (node) => {
    // A command chip contributes no text — see `MentionNode.renderText`'s
    // doc comment. The remainder of the paragraph is the args verbatim.
    if (node.type.name === 'mention' && node.attrs.kind === 'command') return '';
    if (node.type.name === 'mention') return `@${node.attrs.label}`;
    // Shift+Enter (and Mod+Enter) insert a `hardBreak` inline leaf —
    // `@tiptap/extension-hard-break`'s keymap, and the node
    // `insertTextAtCursor` builds for an embedded `\n`. It MUST serialize to
    // a newline. Returning '' here dropped the break entirely and glued the
    // lines together on the wire: "line one" + Shift+Enter + "line two" was
    // sent as "line oneline two" (matrix row 10). Two things make this a
    // silent failure rather than an obvious one. First, an explicit
    // `leafText` FUNCTION argument makes `textBetween` ignore
    // `node.type.spec.leafText` for every inline leaf, and `hardBreak` has
    // no `spec.leafText` of its own anyway — so the fallback that would
    // otherwise cover this does not exist. Second, `blockSeparator` (the
    // '\n' above) applies only at block boundaries, so multi-PARAGRAPH text
    // serialized correctly and hid the single-paragraph case. TipTap's own
    // `editor.getText()` walks the doc by a different route and still
    // reported "line one\nline two", which is why the pre-existing
    // `getText()`-based assertions could not see this.
    if (node.type.name === 'hardBreak') return '\n';
    return '';
  });
  return {
    text: text.trim(),
    mentions: collectMentions(flat),
    commandName: collectCommandName(flat),
  };
}
