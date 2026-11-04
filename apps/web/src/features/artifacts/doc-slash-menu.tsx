'use client';

import { MENU_PANEL_STATIC, MENU_SEPARATOR, MENU_SHORTCUT, menuRow } from '@kortix/ui/menu-recipe';
import {
  CodeBlockIcon,
  FlowArrowIcon,
  ImageIcon,
  ListBulletsIcon,
  ListChecksIcon,
  ListNumbersIcon,
  MinusIcon,
  QuotesIcon,
  TableIcon,
  TextHOneIcon,
  TextHThreeIcon,
  TextHTwoIcon,
  type Icon,
} from '@phosphor-icons/react';
import { Extension, type Editor, type Range } from '@tiptap/core';
import { Suggestion } from '@tiptap/suggestion';
import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { useTranslations } from '@/i18n/use-translations';

/** An open `/` menu: what was typed after the slash, where it sits, and the range to replace. */
export type SlashState = { query: string; range: Range; rect: DOMRect | null };

type SlashHandlers = {
  /** The menu opened, moved or closed (null). */
  onChange: (state: SlashState | null) => void;
  /** A key while the menu is open: true when the menu used it. */
  onKey: (event: KeyboardEvent) => boolean;
};

/**
 * `/` at the start of a line or after a space opens the block menu. The
 * plugin only reports state; `SlashMenu` draws the list and runs the command.
 * Not inside code: a `/` there is code.
 */
export const SlashCommand = Extension.create<SlashHandlers>({
  name: 'slashCommand',
  addOptions() {
    return { onChange: () => {}, onKey: () => false };
  },
  addProseMirrorPlugins() {
    const report = (p: { query: string; range: Range; clientRect?: (() => DOMRect | null) | null }) =>
      this.options.onChange({ query: p.query, range: p.range, rect: p.clientRect?.() ?? null });
    return [
      Suggestion({
        editor: this.editor,
        char: '/',
        allow: ({ state, range }) => !state.doc.resolve(range.from).parent.type.spec.code && !this.editor.isActive('code'),
        render: () => ({
          onStart: report,
          onUpdate: report,
          onKeyDown: ({ event }) => this.options.onKey(event),
          onExit: () => this.options.onChange(null),
        }),
      }),
    ];
  },
});

type Item = {
  id: string;
  icon: Icon;
  /** Key in the `artifacts` catalog. */
  labelKey: string;
  /** Words that also find it, beside its label. */
  aliases: string;
  /** The editor shortcut, as keys: `mod`, `alt`, `shift` or a character. */
  keys?: string[];
  run: (editor: Editor) => void;
};

const MERMAID_STARTER = 'flowchart LR\n  A[Start] --> B[Finish]';

/** Groups of block commands, in menu order. Shortcuts are the editor's own (StarterKit, TaskList). */
const GROUPS: Item[][] = [
  [
    { id: 'h1', icon: TextHOneIcon, labelKey: 'heading1', aliases: 'h1 title', keys: ['mod', 'alt', '1'], run: (e) => e.chain().focus().setHeading({ level: 1 }).run() },
    { id: 'h2', icon: TextHTwoIcon, labelKey: 'heading2', aliases: 'h2 subtitle', keys: ['mod', 'alt', '2'], run: (e) => e.chain().focus().setHeading({ level: 2 }).run() },
    { id: 'h3', icon: TextHThreeIcon, labelKey: 'heading3', aliases: 'h3', keys: ['mod', 'alt', '3'], run: (e) => e.chain().focus().setHeading({ level: 3 }).run() },
  ],
  [
    { id: 'ul', icon: ListBulletsIcon, labelKey: 'bulletList', aliases: 'ul bullet unordered', keys: ['mod', 'shift', '8'], run: (e) => e.chain().focus().toggleBulletList().run() },
    { id: 'ol', icon: ListNumbersIcon, labelKey: 'numberedList', aliases: 'ol ordered number', keys: ['mod', 'shift', '7'], run: (e) => e.chain().focus().toggleOrderedList().run() },
    { id: 'todo', icon: ListChecksIcon, labelKey: 'taskList', aliases: 'todo checkbox checklist', keys: ['mod', 'shift', '9'], run: (e) => e.chain().focus().toggleTaskList().run() },
  ],
  [
    { id: 'media', icon: ImageIcon, labelKey: 'insertMedia', aliases: 'image video picture photo upload', run: () => {} },
    { id: 'table', icon: TableIcon, labelKey: 'table', aliases: 'grid', run: (e) => e.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run() },
  ],
  [
    { id: 'code', icon: CodeBlockIcon, labelKey: 'codeBlock', aliases: 'pre snippet', keys: ['mod', 'alt', 'C'], run: (e) => e.chain().focus().toggleCodeBlock().run() },
    {
      id: 'diagram',
      icon: FlowArrowIcon,
      labelKey: 'diagram',
      aliases: 'mermaid chart flowchart',
      run: (e) => e.chain().focus().insertContent({ type: 'codeBlock', attrs: { language: 'mermaid' }, content: [{ type: 'text', text: MERMAID_STARTER }] }).run(),
    },
    { id: 'quote', icon: QuotesIcon, labelKey: 'quote', aliases: 'blockquote citation', keys: ['mod', 'shift', 'B'], run: (e) => e.chain().focus().toggleBlockquote().run() },
    { id: 'hr', icon: MinusIcon, labelKey: 'divider', aliases: 'hr rule separator line', run: (e) => e.chain().focus().setHorizontalRule().run() },
  ],
];

const isMac = () => typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

function keyLabel(key: string, mac: boolean): string {
  if (key === 'mod') return mac ? '⌘' : 'Ctrl';
  if (key === 'alt') return mac ? '⌥' : 'Alt';
  if (key === 'shift') return mac ? '⇧' : 'Shift';
  return key;
}

/** First-frame guess of the full list's height, before it is measured. */
const MENU_HEIGHT = 440;
const GAP = 6;

/**
 * The `/` menu: the block types in four groups with their shortcuts. Typing
 * filters it, ↑ ↓ move, Enter or Tab picks, Escape closes (the text stays).
 * `keysRef` is filled with this menu's key handler for `SlashCommand.onKey`.
 */
export function SlashMenu({
  editor,
  state,
  keysRef,
  onPickMedia,
}: {
  editor: Editor;
  state: SlashState;
  keysRef: React.RefObject<(event: KeyboardEvent) => boolean>;
  onPickMedia: () => void;
}) {
  const t = useTranslations('artifacts');
  const [active, setActive] = useState(0);
  const [mac] = useState(isMac);
  const list = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(MENU_HEIGHT);
  const query = state.query.trim().toLowerCase();
  const groups = GROUPS.map((group) =>
    group.filter((item) => !query || `${t(item.labelKey)} ${item.aliases}`.toLowerCase().includes(query)),
  ).filter((group) => group.length);
  const items = groups.flat();

  // A new query starts at the first match.
  const [lastQuery, setLastQuery] = useState(query);
  if (lastQuery !== query) {
    setLastQuery(query);
    setActive(0);
  }

  const pick = (item: Item) => {
    editor.chain().focus().deleteRange(state.range).run();
    if (item.id === 'media') onPickMedia();
    else item.run(editor);
  };

  useEffect(() => {
    keysRef.current = (event) => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        if (!items.length) return false;
        const step = event.key === 'ArrowDown' ? 1 : -1;
        setActive((i) => (i + step + items.length) % items.length);
        return true;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        const item = items[active];
        if (!item) return false;
        pick(item);
        return true;
      }
      // Escape: the suggestion plugin closes the menu and keeps the typed text.
      return false;
    };
  });

  // The list shows every row with no scroll, so placement uses its real height.
  useLayoutEffect(() => {
    if (list.current) setHeight(list.current.offsetHeight);
  }, [items.length]);

  if (!state.rect) return null;
  const below = state.rect.bottom + GAP + height <= window.innerHeight;
  const style: React.CSSProperties = below
    ? { top: state.rect.bottom + GAP, left: state.rect.left }
    : { bottom: window.innerHeight - state.rect.top + GAP, left: state.rect.left };

  // Each group's first row in the flat list, for the active highlight.
  const starts = groups.map((_, g) => groups.slice(0, g).reduce((n, group) => n + group.length, 0));
  return createPortal(
    <div
      ref={list}
      role="listbox"
      aria-label={t('blockMenu')}
      style={style}
      onMouseDown={(e) => e.preventDefault()}
      className={`${MENU_PANEL_STATIC} fixed z-50 w-64 overflow-hidden`}
    >
      {items.length === 0 ? (
        <p className="text-muted-foreground px-2 py-1.5 text-sm">{t('blockMenuEmpty')}</p>
      ) : (
        groups.map((group, g) => (
          <Fragment key={group[0].id}>
            {g > 0 ? <div role="separator" className={MENU_SEPARATOR} /> : null}
            {group.map((item, i) => {
              const mine = starts[g] + i;
              const IconCmp = item.icon;
              return (
                <div
                  key={item.id}
                  role="option"
                  aria-selected={mine === active}
                  data-active={mine === active}
                  data-highlighted={mine === active ? '' : undefined}
                  onMouseMove={() => setActive(mine)}
                  onClick={() => pick(item)}
                  className={menuRow('md', 'default', 'cursor-pointer')}
                >
                  <IconCmp className="text-muted-foreground" />
                  <span className="truncate">{t(item.labelKey)}</span>
                  {item.keys ? (
                    <kbd className={`${MENU_SHORTCUT} font-sans tracking-normal`}>
                      {item.keys.map((k) => keyLabel(k, mac)).join(mac ? '' : '+')}
                    </kbd>
                  ) : null}
                </div>
              );
            })}
          </Fragment>
        ))
      )}
    </div>,
    document.body,
  );
}
