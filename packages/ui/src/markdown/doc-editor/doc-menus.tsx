'use client';

/**
 * The document editor's two menus: one over selected text (marks, headings,
 * quote, table rows) and a `+` menu on an empty line (blocks). Markdown
 * shortcuts (`# `, `- `, `1. `, `[ ] `, `> `, ``` ```) work without them.
 * `blockMenu={false}` drops the `+` menu, for an editor with a `/` block menu.
 * `canComment` adds a Comment button over selected text; with `editable={false}`
 * it is the only button.
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
import { TextSelection } from '@tiptap/pm/state';
import { type Editor, useEditorState } from '@tiptap/react';
import { BubbleMenu, FloatingMenu } from '@tiptap/react/menus';

import { useTranslations } from '../../i18n';
import { Button } from '../../primitives/button';
import Hint from '../../primitives/hint';

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
        options={{ placement: 'top' }}
        shouldShow={({ editor: e, state: s, from, to }) =>
          (editable || canComment) &&
          s.selection instanceof TextSelection &&
          from !== to &&
          !!s.doc.textBetween(from, to).trim() &&
          !e.isActive('image') &&
          !e.isActive('video')
        }
      >
        <div className={MENU}>
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
          {canComment && onComment ? (
            <>
              {editable ? <span className="bg-border mx-0.5 h-5 w-px" /> : null}
              <MenuButton icon={ChatCircleIcon} label={t('discussion.commentSelection')} onClick={onComment} disabled={commenting} />
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
