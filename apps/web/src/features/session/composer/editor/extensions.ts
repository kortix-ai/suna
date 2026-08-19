import Document from '@tiptap/extension-document';
import HardBreak from '@tiptap/extension-hard-break';
import Paragraph from '@tiptap/extension-paragraph';
import Placeholder from '@tiptap/extension-placeholder';
import Text from '@tiptap/extension-text';
import { UndoRedo } from '@tiptap/extensions';

/**
 * The composer's schema: paragraphs, text, line breaks, undo, a placeholder.
 * Nothing else. Mentions and `/` command chips are added on top of this by
 * `composer-editor.tsx` (`MentionNode`) — they are the ONLY non-text node the
 * document can hold.
 *
 * ## No rich text, no markdown — settled, do not restore
 *
 * `Bold`, `Italic`, `Strike`, `Code`, `CodeBlock`, `Link`,
 * `BulletList`/`OrderedList`/`ListItem` and `Blockquote` were in this list
 * and are gone. This is the second time they have been removed; the first cut
 * (bundle budget) was reverted by 0100711f00 on the grounds that markdown was
 * "a stated user requirement" with the budget-vs-requirement trade-off left
 * explicitly open. That question is now closed the other way, by the user, on
 * the requirement side rather than the budget side: the composer is for
 * writing a message, and a message is plain text.
 *
 * Two facts that make this a clean removal rather than a feature regression:
 *
 *  1. **Nothing on the wire changes.** `serialize.ts` builds the sent text
 *     with `doc.textBetween(...)`, which reads text nodes and the `leafText`
 *     callback and ignores marks entirely. Bolding a word in the composer
 *     never produced `**word**` on the way out — it produced `word`. The
 *     formatting was visible while typing and silently discarded on send, so
 *     removing it deletes a mismatch, not a capability. `serialize.test.ts`
 *     pins this.
 *  2. **Nothing rendered it.** No rule in `globals.css` styles a list, code
 *     block or blockquote inside `.kortix-composer-editor` (the only composer
 *     rules there are the placeholder and the `/` trigger hint), so these
 *     nodes were drawn by ProseMirror's bare defaults.
 *
 * The eight `@tiptap/extension-*` packages that backed them are removed from
 * `apps/web/package.json` in the same change — leaving them installed would
 * keep the bytes while deleting the feature, which is the worst of both.
 *
 * Deliberately NOT `@tiptap/starter-kit`: it pulls tables, images and
 * horizontal rules on top of everything above.
 *
 * Deliberately NOT `@tiptap/extension-typography` either (fix round 1): its
 * default rules rewrite content as you type — `!=` becomes `≠`, `-->` becomes
 * `-→`, `"foo"` gets curly quotes. This composer is where people type shell
 * operators, code fragments and file globs; silently rewriting those
 * characters is the exact class of corruption `setContent`/`clear` were fixed
 * to avoid, just on the typing path instead of the prefill path.
 *
 * `UndoRedo`, not `History`: the installed `@tiptap/extensions@3.27.1` does
 * not export a `History` symbol at all (verified against
 * `node_modules/@tiptap/extensions/dist/index.d.ts`) — TipTap 3 renamed the
 * history extension to `UndoRedo`, still under the same `@tiptap/extensions`
 * package.
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
  ];
}
