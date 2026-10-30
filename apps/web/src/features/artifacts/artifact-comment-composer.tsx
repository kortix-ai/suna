'use client';

import { cn } from '@kortix/ui';
import { Button } from '@kortix/ui/button';
import { Command, CommandGroup, CommandItem, CommandList } from '@kortix/ui/command';
import { MentionNode } from '@kortix/ui/composer';
import { EntityAvatar } from '@kortix/ui/entity-avatar';
import { Field, FieldLabel } from '@kortix/ui/field';
import { inputFocusClasses, inputSurfaceClasses } from '@kortix/ui/input';
import { Popover, PopoverAnchor, PopoverContent } from '@kortix/ui/popover';
import { UserAvatar } from '@kortix/ui/user-avatar';
import { RobotIcon } from '@phosphor-icons/react';
import { Placeholder } from '@tiptap/extensions';
import { EditorContent, useEditor, type Editor, type JSONContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { useCallback, useEffect, useId, useRef, useState } from 'react';

import { useTranslations } from '@/i18n/use-translations';
import { commentEnterAction, mentionAtCaret } from './artifact-discussion-logic';

export interface CommentMentionOption {
  key: string;
  kind: 'user' | 'session' | 'agent';
  label: string;
  token: string;
  avatarUrl?: string | null;
}

interface Props {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  mentions: readonly CommentMentionOption[];
  label: string;
  placeholder: string;
  submitLabel: string;
  pending?: boolean;
  submitDisabled?: boolean;
  error?: string | null;
  autoFocus?: boolean;
  focusKey?: string;
  onCancel?: () => void;
}

const CommentMention = MentionNode.extend({
  renderText({ node }) {
    return String(node.attrs.value ?? '');
  },
  renderHTML(props) {
    const [tag, attributes, text] = this.parent!(props) as [string, Record<string, string>, string];
    return [
      tag,
      {
        ...attributes,
        class: cn(attributes.class, 'inline-block max-w-full break-words whitespace-normal'),
      },
      text,
    ];
  },
});

function draftContent(value: string, mentions: readonly CommentMentionOption[]): JSONContent {
  const tokens = [...mentions]
    .filter((item) => !!item.token)
    .sort((a, b) => b.token.length - a.token.length);
  const content: JSONContent[] = [];
  let plain = '';
  const flush = () => {
    if (plain) content.push({ type: 'text', text: plain });
    plain = '';
  };
  for (let index = 0; index < value.length;) {
    const token = tokens.find(
      (item) =>
        value.startsWith(item.token, index) &&
        (index === 0 || !/[\w@]/.test(value[index - 1]!)) &&
        !/[\w@.+-]/.test(value[index + item.token.length] ?? ''),
    );
    if (token) {
      flush();
      content.push({
        type: 'mention',
        attrs: { kind: token.kind, label: token.label, value: token.token },
      });
      index += token.token.length;
    } else if (value[index] === '\n') {
      flush();
      content.push({ type: 'hardBreak' });
      index++;
    } else {
      plain += value[index];
      index++;
    }
  }
  flush();
  return { type: 'doc', content: [{ type: 'paragraph', content }] };
}

function activeMention(editor: Editor) {
  if (!editor.state.selection.empty) return null;
  const position = editor.state.selection.$from;
  const before = position.parent.textBetween(0, position.parentOffset, '', () => '\ufffc');
  const found = mentionAtCaret(before, before.length);
  return found
    ? { query: found.query, from: position.pos - found.query.length - 1, to: position.pos }
    : null;
}

export function ArtifactCommentComposer(props: Props) {
  const t = useTranslations('artifacts.discussion');
  const id = useId();
  const latest = useRef(props);
  const editorRef = useRef<Editor | null>(null);
  const [menu, setMenu] = useState<{ query: string; from: number; to: number } | null>(null);
  const [selected, setSelected] = useState(0);
  const menuRef = useRef(menu);
  const selectedRef = useRef(selected);
  const visible = menu
    ? props.mentions
        .filter((item) =>
          `${item.label} ${item.token}`
            .toLocaleLowerCase()
            .includes(menu.query.toLocaleLowerCase()),
        )
        .slice(0, 12)
    : [];
  const optionsRef = useRef(visible);
  const listRef = useRef<HTMLDivElement | null>(null);
  const optionElementsRef = useRef(new Map<string, HTMLDivElement>());
  const syncMentionAria = useCallback(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const options = optionsRef.current;
    const option = options[Math.min(selectedRef.current, options.length - 1)];
    const active = option && optionElementsRef.current.get(option.key);
    editor.view.dom.setAttribute('aria-expanded', String(!!menuRef.current && options.length > 0));
    if (menuRef.current && listRef.current?.id && active?.id) {
      editor.view.dom.setAttribute('aria-controls', listRef.current.id);
      editor.view.dom.setAttribute('aria-activedescendant', active.id);
    } else {
      editor.view.dom.removeAttribute('aria-controls');
      editor.view.dom.removeAttribute('aria-activedescendant');
    }
  }, []);
  useEffect(() => {
    latest.current = props;
    menuRef.current = menu;
    selectedRef.current = selected;
    optionsRef.current = visible;
    syncMentionAria();
  });
  const choose = (option: CommentMentionOption) => {
    const range = menuRef.current;
    const editor = editorRef.current;
    if (!range || !editor) return;
    editor
      .chain()
      .focus()
      .deleteRange({ from: range.from, to: range.to })
      .insertContent([
        { type: 'mention', attrs: { kind: option.kind, label: option.label, value: option.token } },
        { type: 'text', text: ' ' },
      ])
      .run();
    setMenu(null);
    setSelected(0);
  };
  const chooseRef = useRef(choose);
  useEffect(() => {
    chooseRef.current = choose;
  });
  const editor = useEditor(
    {
      immediatelyRender: false,
      autofocus: props.autoFocus ? 'end' : false,
      extensions: [
        StarterKit.configure({
          heading: false,
          blockquote: false,
          bulletList: false,
          orderedList: false,
          listItem: false,
          codeBlock: false,
          code: false,
          horizontalRule: false,
          bold: false,
          italic: false,
          strike: false,
          underline: false,
          link: false,
        }),
        CommentMention,
        Placeholder.configure({ placeholder: props.placeholder }),
      ],
      content: draftContent(props.value, props.mentions),
      editorProps: {
        attributes: {
          id,
          role: 'textbox',
          'aria-multiline': 'true',
          'aria-labelledby': `${id}-label`,
          'aria-autocomplete': 'list',
          class:
            'min-h-20 max-h-52 overflow-y-auto px-3 py-2 text-sm outline-none whitespace-pre-wrap break-words [&_p.is-editor-empty:first-child::before]:text-muted-foreground [&_p.is-editor-empty:first-child::before]:pointer-events-none [&_p.is-editor-empty:first-child::before]:float-left [&_p.is-editor-empty:first-child::before]:h-0 [&_p.is-editor-empty:first-child::before]:content-[attr(data-placeholder)]',
        },
        handleKeyDown: (_view, event) => {
          if (event.isComposing || event.keyCode === 229) return false;
          const options = optionsRef.current;
          if (menuRef.current && options.length) {
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              setSelected(
                (index) =>
                  (index + (event.key === 'ArrowDown' ? 1 : options.length - 1)) % options.length,
              );
              return true;
            }
            if (event.key === 'Escape') {
              setMenu(null);
              return true;
            }
          }
          const action = commentEnterAction(event, !!menuRef.current && options.length > 0);
          if (action === 'mention') {
            chooseRef.current(options[Math.min(selectedRef.current, options.length - 1)]!);
            return true;
          }
          if (action === 'submit') {
            if (
              !latest.current.pending &&
              !latest.current.submitDisabled &&
              latest.current.value.trim() &&
              latest.current.value.length <= 10_000
            )
              latest.current.onSubmit();
            return true;
          }
          return false;
        },
      },
      onCreate: ({ editor: ready }) => {
        editorRef.current = ready;
      },
      onUpdate: ({ editor: current }) => {
        latest.current.onChange(current.getText({ blockSeparator: '\n' }));
        setMenu(activeMention(current));
        setSelected(0);
      },
      onSelectionUpdate: ({ editor: current }) => {
        setMenu(activeMention(current));
        setSelected(0);
      },
      onFocus: ({ editor: current }) => {
        setMenu(activeMention(current));
      },
    },
    [props.placeholder],
  );
  useEffect(() => {
    if (!editor) return;
    editorRef.current = editor;
    editor.setEditable(!props.pending, false);
    if (editor.getText({ blockSeparator: '\n' }) !== props.value)
      editor.commands.setContent(draftContent(props.value, props.mentions), { emitUpdate: false });
  }, [editor, props.pending, props.value, props.mentions]);
  useEffect(() => {
    if (editor && props.autoFocus) editor.commands.focus('end');
  }, [editor, props.autoFocus, props.focusKey]);
  const selectedOption = visible[Math.min(selected, visible.length - 1)];
  return (
    <form
      className="space-y-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (
          props.value.trim() &&
          props.value.length <= 10_000 &&
          !props.pending &&
          !props.submitDisabled
        )
          props.onSubmit();
      }}
    >
      <Field className="gap-0">
        <FieldLabel id={`${id}-label`} className="sr-only">
          {props.label}
        </FieldLabel>
        <Popover
          open={!!menu && visible.length > 0}
          onOpenChange={(open) => {
            if (!open) setMenu(null);
          }}
        >
          <PopoverAnchor asChild>
            <div
              className={`${inputSurfaceClasses} ${inputFocusClasses} focus-within:border-ring focus-within:ring-ring/15 focus-within:ring-3`}
            >
              <EditorContent editor={editor} />
            </div>
          </PopoverAnchor>
          <PopoverContent
            side="top"
            align="start"
            className="w-72 p-0"
            onOpenAutoFocus={(event) => event.preventDefault()}
            onCloseAutoFocus={(event) => event.preventDefault()}
            onInteractOutside={(event) => {
              if (editor?.view.dom.contains(event.target as Node)) event.preventDefault();
            }}
          >
            <Command shouldFilter={false} value={selectedOption?.key}>
              <CommandList
                ref={(node) => {
                  listRef.current = node;
                  syncMentionAria();
                }}
              >
                {(['user', 'agent'] as const).map((group) => {
                  const options = visible.filter((option) =>
                    group === 'user' ? option.kind === 'user' : option.kind !== 'user',
                  );
                  return options.length ? (
                    <CommandGroup
                      key={group}
                      heading={t(group === 'user' ? 'mentionPeople' : 'mentionAgents')}
                    >
                      {options.map((option) => (
                        <CommandItem
                          ref={(node) => {
                            if (node) optionElementsRef.current.set(option.key, node);
                            else optionElementsRef.current.delete(option.key);
                            syncMentionAria();
                          }}
                          key={option.key}
                          value={option.key}
                          onMouseDown={(event) => event.preventDefault()}
                          onSelect={() => choose(option)}
                          onMouseMove={() => setSelected(visible.indexOf(option))}
                        >
                          {option.kind === 'user' ? (
                            <UserAvatar
                              email={option.token.includes('@', 1) ? option.token.slice(1) : ''}
                              name={option.label}
                              avatarUrl={option.avatarUrl}
                              size="sm"
                            />
                          ) : (
                            <EntityAvatar icon={RobotIcon} label={option.label} size="sm" />
                          )}
                          <span className="min-w-0 truncate">{option.label}</span>
                          {option.kind === 'session' ? (
                            <span className="text-muted-foreground ml-auto text-xs">
                              {t('sourceSession')}
                            </span>
                          ) : null}
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  ) : null;
                })}
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
      </Field>
      {props.error ? (
        <p role="alert" className="text-muted-foreground text-xs">
          {props.error}
        </p>
      ) : null}
      <div className="flex items-center justify-between gap-2">
        <span className="text-muted-foreground min-w-0 text-xs">{t('composerKeys')}</span>
        <span className="flex shrink-0 gap-1">
          {props.onCancel ? (
            <Button
              size="xs"
              type="button"
              variant="ghost"
              disabled={props.pending}
              onClick={props.onCancel}
            >
              {t('cancel')}
            </Button>
          ) : null}
          <Button
            type="submit"
            size="xs"
            disabled={
              !editor ||
              !props.value.trim() ||
              props.value.length > 10_000 ||
              props.pending ||
              props.submitDisabled
            }
            aria-busy={props.pending}
          >
            {props.submitLabel}
          </Button>
        </span>
      </div>
    </form>
  );
}
