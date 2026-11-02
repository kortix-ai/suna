'use client';

/**
 * The document editor's two menus: one over selected text (marks, headings,
 * quote, table rows) and a `+` menu on an empty line (blocks). Markdown
 * shortcuts (`# `, `- `, `1. `, `[ ] `, `> `, ``` ```) work without them.
 * `blockMenu={false}` drops the `+` menu, for an editor with a `/` block menu.
 * `canComment` puts a labeled Comment button first over selected text (with
 * `editable={false}` it is the only button) and turns on its shortcut, ⌘⌥M on
 * a Mac and Ctrl+Alt+M elsewhere.
 */

import {
  ChatCircleIcon,
  CheckSquareIcon,
  CodeBlockIcon,
  CodeIcon,
  type Icon,
  LinkSimpleIcon,
  ListBulletsIcon,
  ListNumbersIcon,
  MinusIcon,
  PlusIcon,
  QuotesIcon,
  TableIcon,
  TextBIcon,
  TextHOneIcon,
  TextHThreeIcon,
  TextHTwoIcon,
  TextItalicIcon,
  TextStrikethroughIcon,
  TrashIcon,
} from '@phosphor-icons/react';
import { type EditorState, TextSelection } from '@tiptap/pm/state';
import { type Editor, useEditorState } from '@tiptap/react';
import { BubbleMenu, FloatingMenu } from '@tiptap/react/menus';
import { useEffect, useRef, useState } from 'react';

import { useTranslations } from '../../i18n';
import { Button } from '../../primitives/button';
import Hint from '../../primitives/hint';
import { Kbd, KbdGroup } from '../../primitives/kbd';
import Loading from '../../primitives/loading';

const isMac = () => typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

/**
 * ⌘⌥M on a Mac, Ctrl+Alt+M elsewhere: comment on the selected text (the
 * Google Docs key). Matched by the physical key too: ⌥M types `µ` on a Mac,
 * and Windows treats Ctrl+Alt as AltGr, so `key` is often not `m`.
 */
export function isCommentShortcut(
  event: Pick<KeyboardEvent, 'key' | 'code' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'repeat'>,
  mac: boolean,
): boolean {
  if (!event.altKey || event.shiftKey || event.repeat) return false;
  if (mac ? !event.metaKey || event.ctrlKey : !event.ctrlKey || event.metaKey) return false;
  return event.code === 'KeyM' || event.key.toLowerCase() === 'm';
}

/** Selected text a comment can quote: a non-blank text range, not an image or a video. */
function commentableSelection(editor: Editor, state: EditorState): boolean {
  const { selection } = state;
  return (
    selection instanceof TextSelection &&
    selection.from !== selection.to &&
    !!state.doc.textBetween(selection.from, selection.to).trim() &&
    !editor.isActive('image') &&
    !editor.isActive('video')
  );
}

function MenuButton({
  icon: IconCmp,
  label,
  active,
  onClick,
  disabled,
}: {
  icon: Icon;
  label: string;
  active?: boolean;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <Hint label={label} side="top" sideOffset={6}>
      <Button
        type="button"
        size="icon-sm"
        variant="ghost"
        aria-label={label}
        aria-pressed={active}
        aria-busy={disabled || undefined}
        disabled={disabled}
        onMouseDown={(e) => e.preventDefault()}
        onClick={onClick}
        className="data-[active=true]:bg-active data-[active=true]:text-foreground text-muted-foreground"
        data-active={active || undefined}
      >
        <IconCmp className="size-4" />
      </Button>
    </Hint>
  );
}

/**
 * The first item over selected text: a labeled button, so a first-time reader
 * finds comments. Its hint closes with the menu: the shortcut hides the menu
 * under a still pointer, and an open hint would lose its anchor.
 */
function CommentButton({
  label,
  busy,
  shown,
  onClick,
}: {
  label: string;
  busy: boolean;
  shown: boolean;
  onClick: () => void;
}) {
  const [mac] = useState(isMac);
  const [hint, setHint] = useState(false);
  if (hint && !shown) setHint(false);
  const keys = mac ? ['⌘', '⌥', 'M'] : ['Ctrl', 'Alt', 'M'];
  return (
    <Hint
      open={hint && shown && !busy}
      onOpenChange={setHint}
      side="top"
      sideOffset={6}
      label={
        <span className="flex items-center gap-1.5">
          {label}
          <KbdGroup>
            {keys.map((key) => (
              <Kbd key={key} className="h-4 w-auto min-w-4">
                {key}
              </Kbd>
            ))}
          </KbdGroup>
        </span>
      }
    >
      <Button
        type="button"
        size="xs"
        variant="ghost"
        aria-keyshortcuts={mac ? 'Meta+Alt+M' : 'Control+Alt+M'}
        aria-busy={busy || undefined}
        disabled={busy}
        onMouseDown={(e) => e.preventDefault()}
        onClick={onClick}
      >
        {busy ? <Loading className="size-4" /> : <ChatCircleIcon className="size-4" />}
        {label}
      </Button>
    </Hint>
  );
}

const MENU = 'bg-popover text-popover-foreground flex items-center gap-0.5 rounded-lg border p-1 shadow-md';

export function DocMenus({
  editor,
  blockMenu = true,
  editable = true,
  canComment = false,
  commenting = false,
  onComment,
}: {
  editor: Editor;
  blockMenu?: boolean;
  editable?: boolean;
  canComment?: boolean;
  commenting?: boolean;
  onComment?: () => void;
}) {
  const t = useTranslations('artifacts');
  const state = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive('bold'),
      italic: e.isActive('italic'),
      strike: e.isActive('strike'),
      code: e.isActive('code'),
      link: e.isActive('link'),
      h1: e.isActive('heading', { level: 1 }),
      h2: e.isActive('heading', { level: 2 }),
      h3: e.isActive('heading', { level: 3 }),
      quote: e.isActive('blockquote'),
      table: e.isActive('table'),
    }),
  });
  // ⌘⌥M / Ctrl+Alt+M comments on the selection in this editor, while comments are on.
  const comment = useRef({ onComment, commenting });
  useEffect(() => {
    comment.current = { onComment, commenting };
  });
  const commentsOn = canComment && !!onComment;
  // One options object for the menu's life: it reports when the menu shows and hides.
  const [bubbleShown, setBubbleShown] = useState(false);
  const [bubbleOptions] = useState(() => ({
    placement: 'top' as const,
    onShow: () => setBubbleShown(true),
    onHide: () => setBubbleShown(false),
  }));
  useEffect(() => {
    if (!commentsOn) return;
    const mac = isMac();
    const onKey = (event: KeyboardEvent) => {
      const { onComment: run, commenting: busy } = comment.current;
      if (event.defaultPrevented || !run || !isCommentShortcut(event, mac)) return;
      const selected = editor.view.dom.ownerDocument.getSelection()?.anchorNode;
      if (!selected || !editor.view.dom.contains(selected) || !commentableSelection(editor, editor.state)) return;
      event.preventDefault();
      if (!busy) run();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [editor, commentsOn]);
  const chain = () => editor.chain().focus();
  const setLink = () => {
    const previous = editor.getAttributes('link').href as string | undefined;
    const url = window.prompt(t('linkPrompt'), previous ?? 'https://');
    if (url === null) return;
    if (url.trim() === '') chain().extendMarkRange('link').unsetLink().run();
    else chain().extendMarkRange('link').setLink({ href: url.trim() }).run();
  };

  return (
    <>
      <BubbleMenu
        editor={editor}
        options={bubbleOptions}
        shouldShow={({ editor: e, state: s }) => (editable || canComment) && commentableSelection(e, s)}
      >
        <div className={MENU}>
          {canComment && onComment ? (
            <>
              <CommentButton
                label={t('discussion.commentSelection')}
                busy={commenting}
                shown={bubbleShown}
                onClick={onComment}
              />
              {editable ? <span className="bg-border mx-0.5 h-5 w-px" /> : null}
            </>
          ) : null}
          {editable ? (
            <>
              <MenuButton icon={TextBIcon} label={t('bold')} active={state.bold} onClick={() => chain().toggleBold().run()} />
              <MenuButton icon={TextItalicIcon} label={t('italic')} active={state.italic} onClick={() => chain().toggleItalic().run()} />
              <MenuButton icon={TextStrikethroughIcon} label={t('strike')} active={state.strike} onClick={() => chain().toggleStrike().run()} />
              <MenuButton icon={CodeIcon} label={t('inlineCode')} active={state.code} onClick={() => chain().toggleCode().run()} />
              <MenuButton icon={LinkSimpleIcon} label={t('link')} active={state.link} onClick={setLink} />
              <span className="bg-border mx-0.5 h-5 w-px" />
              <MenuButton icon={TextHOneIcon} label={t('heading1')} active={state.h1} onClick={() => chain().toggleHeading({ level: 1 }).run()} />
              <MenuButton icon={TextHTwoIcon} label={t('heading2')} active={state.h2} onClick={() => chain().toggleHeading({ level: 2 }).run()} />
              <MenuButton icon={TextHThreeIcon} label={t('heading3')} active={state.h3} onClick={() => chain().toggleHeading({ level: 3 }).run()} />
              <MenuButton icon={QuotesIcon} label={t('quote')} active={state.quote} onClick={() => chain().toggleBlockquote().run()} />
              {state.table ? (
                <>
                  <span className="bg-border mx-0.5 h-5 w-px" />
                  <MenuButton icon={PlusIcon} label={t('addRow')} onClick={() => chain().addRowAfter().run()} />
                  <MenuButton icon={ListBulletsIcon} label={t('addColumn')} onClick={() => chain().addColumnAfter().run()} />
                  <MenuButton icon={MinusIcon} label={t('deleteRow')} onClick={() => chain().deleteRow().run()} />
                  <MenuButton icon={TrashIcon} label={t('deleteTable')} onClick={() => chain().deleteTable().run()} />
                </>
              ) : null}
            </>
          ) : null}
        </div>
      </BubbleMenu>
      {editable && blockMenu ? (
        <FloatingMenu editor={editor} options={{ placement: 'bottom-start', offset: 6 }}>
          <div className={MENU}>
            <MenuButton icon={TextHOneIcon} label={t('heading1')} onClick={() => chain().setHeading({ level: 1 }).run()} />
            <MenuButton icon={TextHTwoIcon} label={t('heading2')} onClick={() => chain().setHeading({ level: 2 }).run()} />
            <MenuButton icon={TextHThreeIcon} label={t('heading3')} onClick={() => chain().setHeading({ level: 3 }).run()} />
            <MenuButton icon={ListBulletsIcon} label={t('bulletList')} onClick={() => chain().toggleBulletList().run()} />
            <MenuButton icon={ListNumbersIcon} label={t('numberedList')} onClick={() => chain().toggleOrderedList().run()} />
            <MenuButton icon={CheckSquareIcon} label={t('taskList')} onClick={() => chain().toggleTaskList().run()} />
            <MenuButton icon={QuotesIcon} label={t('quote')} onClick={() => chain().toggleBlockquote().run()} />
            <MenuButton icon={CodeBlockIcon} label={t('codeBlock')} onClick={() => chain().toggleCodeBlock().run()} />
            <MenuButton icon={TableIcon} label={t('table')} onClick={() => chain().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()} />
            <MenuButton icon={MinusIcon} label={t('divider')} onClick={() => chain().setHorizontalRule().run()} />
          </div>
        </FloatingMenu>
      ) : null}
    </>
  );
}
