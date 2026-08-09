import Document from '@tiptap/extension-document';
import HardBreak from '@tiptap/extension-hard-break';
import Paragraph from '@tiptap/extension-paragraph';
import Placeholder from '@tiptap/extension-placeholder';
import Text from '@tiptap/extension-text';
import { UndoRedo } from '@tiptap/extensions';

/**
 * Deliberately NOT @tiptap/starter-kit — it pulls tables, images and
 * horizontal rules, none of which belong in a chat composer. Every extension
 * here is MIT and already installed.
 *
 * Deliberately NOT the rich-text formatting extensions either (Task 15,
 * bundle-budget cut — see task-15-report.md): `Bold`, `Italic`, `Strike`,
 * `Code`, `CodeBlock`, `Link`, `BulletList`/`OrderedList`/`ListItem` and
 * `Blockquote` were in the extension list through Task 14 but are cut here.
 * None of them back a compat-matrix row — the pre-rebuild composer was a
 * plain `<textarea>` with zero rich-text formatting, so this is a reduction
 * of *new* capability the rebuild added, not a regression against the old
 * composer. No test in `composer/` references any of these extensions by
 * name (verified by grep before cutting). Measured cost at Task 14: these
 * ten extensions plus their ProseMirror dependents (`prosemirror-schema-list`,
 * `linkifyjs`, `prosemirror-dropcursor`, `prosemirror-gapcursor`) were part of
 * a single 136 KB gz composer chunk — the whole rich-text surface, not just
 * these declarations — and no per-extension byte breakdown was recoverable
 * from the production bundle (Turbopack strips module paths and this repo
 * ships no bundle analyzer). Restore individually only after a real
 * measurement shows headroom.
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
  ];
}
