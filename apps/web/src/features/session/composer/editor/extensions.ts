import Blockquote from '@tiptap/extension-blockquote';
import Bold from '@tiptap/extension-bold';
import Code from '@tiptap/extension-code';
import CodeBlock from '@tiptap/extension-code-block';
import Document from '@tiptap/extension-document';
import HardBreak from '@tiptap/extension-hard-break';
import Italic from '@tiptap/extension-italic';
import Link from '@tiptap/extension-link';
import { BulletList, ListItem, OrderedList } from '@tiptap/extension-list';
import Paragraph from '@tiptap/extension-paragraph';
import Placeholder from '@tiptap/extension-placeholder';
import Strike from '@tiptap/extension-strike';
import Text from '@tiptap/extension-text';
import { UndoRedo } from '@tiptap/extensions';

/**
 * Deliberately NOT @tiptap/starter-kit — it pulls tables, images and
 * horizontal rules, none of which belong in a chat composer. Every extension
 * here is MIT and already installed.
 *
 * `UndoRedo`, not `History`: the installed `@tiptap/extensions@3.27.1` does
 * not export a `History` symbol at all (verified against
 * `node_modules/@tiptap/extensions/dist/index.d.ts`) — TipTap 3 renamed the
 * history extension to `UndoRedo`, still under the same `@tiptap/extensions`
 * package. See task-3-report.md for the full import-path verification.
 *
 * Deliberately NOT `@tiptap/extension-typography` either (fix round 1):
 * its default rules rewrite content as you type — `!=` becomes `≠`, `-->`
 * becomes `-→`, `"foo"` gets curly quotes. This composer is where people
 * type shell operators, code fragments and file globs; silently rewriting
 * those characters is the exact class of corruption `setContent`/`clear`
 * were fixed to avoid (see task-3-report.md), just on the typing path
 * instead of the prefill path. Do not add it back.
 *
 * `getPlaceholder` is a function, not a string (fix round 1): TipTap's
 * `Editor.setOptions()` never rebuilds the extension manager or its
 * ProseMirror plugins (verified in `@tiptap/core/dist/index.js` — it only
 * calls `view.setProps`/`view.updateState`), so a `Placeholder.configure({
 * placeholder: someString })` instance is frozen at whatever string it held
 * the moment the plugin was first built. A function value is different: the
 * Placeholder plugin re-invokes it on every decoration recompute
 * (`buildPlaceholderDecorations` -> `createPlaceholderDecoration`, both in
 * `@tiptap/extensions`), so as long as the SAME function reference reads
 * from a live source (a ref updated by the caller), the rendered placeholder
 * stays current across re-renders without needing the plugin itself to be
 * rebuilt.
 */
export function baseExtensions(getPlaceholder: () => string) {
  return [
    Document,
    Paragraph,
    Text,
    HardBreak,
    UndoRedo,
    Placeholder.configure({ placeholder: () => getPlaceholder() }),
    Bold,
    Italic,
    Strike,
    Code,
    CodeBlock,
    Link.configure({ openOnClick: false, autolink: true }),
    BulletList,
    OrderedList,
    ListItem,
    Blockquote,
  ];
}
