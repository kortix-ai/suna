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
import Typography from '@tiptap/extension-typography';
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
 */
export function baseExtensions(placeholder: string) {
  return [
    Document,
    Paragraph,
    Text,
    HardBreak,
    UndoRedo,
    Placeholder.configure({ placeholder }),
    Typography,
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
