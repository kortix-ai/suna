'use client';

/**
 * The document editor's two menus: one over selected text (marks, headings,
 * quote, table rows) and a `+` menu on an empty line (blocks). Markdown
 * shortcuts (`# `, `- `, `1. `, `[ ] `, `> `, ``` ```) work without them.
 * `onPickMedia` adds Image to the block menu, for an editor that stores files.
 */

import {
  CheckSquareIcon,
  CodeBlockIcon,
  CodeIcon,
  type Icon,
  ImageIcon,
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
import { type Editor, useEditorState } from '@tiptap/react';
import { BubbleMenu, FloatingMenu } from '@tiptap/react/menus';
import { useRef } from 'react';

import { useTranslations } from '../../i18n';
import Hint from '../../primitives/hint';

function MenuButton({ icon: IconCmp, label, active, onClick }: { icon: Icon; label: string; active?: boolean; onClick: () => void }) {
  return (
    <Hint label={label} side="top" sideOffset={6}>
      <button
        type="button"
        aria-label={label}
        aria-pressed={active}
        onMouseDown={(e) => e.preventDefault()}
        onClick={onClick}
        className="hover:bg-accent data-[active=true]:bg-accent data-[active=true]:text-foreground text-muted-foreground grid size-7 place-items-center rounded-sm"
        data-active={active || undefined}
      >
        <IconCmp className="size-4" />
      </button>
    </Hint>
  );
}

const MENU = 'bg-popover text-popover-foreground flex items-center gap-0.5 rounded-md border p-1 shadow-md';

export function DocMenus({ editor, onPickMedia }: { editor: Editor; onPickMedia?: (files: File[]) => void }) {
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
  const picker = useRef<HTMLInputElement>(null);

  return (
    <>
      <BubbleMenu editor={editor} options={{ placement: 'top' }} shouldShow={({ editor: e, from, to }) => from !== to && !e.isActive('image')}>
        <div className={MENU}>
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
        </div>
      </BubbleMenu>
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
          {onPickMedia ? <MenuButton icon={ImageIcon} label={t('image')} onClick={() => picker.current?.click()} /> : null}
          <MenuButton icon={MinusIcon} label={t('divider')} onClick={() => chain().setHorizontalRule().run()} />
        </div>
      </FloatingMenu>
      {onPickMedia ? (
        <input
          ref={picker}
          type="file"
          accept="image/*,video/*"
          multiple
          hidden
          onChange={(e) => {
            onPickMedia(Array.from(e.target.files ?? []));
            e.target.value = '';
          }}
        />
      ) : null}
    </>
  );
}
