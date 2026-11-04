'use client';

import { Button } from '@kortix/ui/button';
import Hint from '@kortix/ui/hint';
import Loading from '@kortix/ui/loading';
import { MenuCard, MenuRow, MenuSectionHeading } from '@kortix/ui/session/composer/menus/menu-shell';
import { useTranslations } from '@/i18n/use-translations';
import { ArrowUpIcon, AtIcon, MegaphoneSimpleIcon } from '@phosphor-icons/react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';

import { ParticipantAvatar } from './room-identity';
import { activeMention, toastError } from './room-text';
import { useListNavigation, type PrincipalRow, type RoomDirectory } from './use-room-directory';

const MAX_HEIGHT_PX = 240;
const PER_SECTION = 6;
const PICK_KEYS = ['Enter', 'Tab'];

interface Candidate {
  key: string;
  /** What the composer inserts: `@` plus 8 id characters, or `@here`. */
  insert: string;
  title: string;
  detail: string | null;
  avatar: React.ReactNode;
}

/**
 * The Slack message box (room timeline and thread panel): Enter sends,
 * Shift+Enter breaks the line, and `@` opens a member → agent → people menu that
 * inserts the token the server resolves: `@3f2a1b9c` for a session,
 * `@ada@example.test` for a person with an email.
 */
export function RoomComposer({
  placeholder,
  roomName,
  directory,
  autoFocus = false,
  onSend,
}: {
  placeholder: string;
  roomName: string;
  directory: RoomDirectory;
  /** The thread composer takes focus when its panel opens. */
  autoFocus?: boolean;
  onSend: (text: string) => Promise<void>;
}) {
  const t = useTranslations('rooms');
  const [text, setText] = useState('');
  const [caret, setCaret] = useState(0);
  const [sending, setSending] = useState(false);
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const pendingCaret = useRef<number | null>(null);

  // Grow with the text up to MAX_HEIGHT_PX, then scroll.
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT_PX)}px`;
    if (pendingCaret.current !== null) {
      el.setSelectionRange(pendingCaret.current, pendingCaret.current);
      pendingCaret.current = null;
    }
  }, [text]);

  useEffect(() => {
    if (autoFocus) textareaRef.current?.focus();
  }, [autoFocus]);

  const mention = activeMention(text, caret);
  const menuOpen = mention !== null && mention.start !== dismissedAt;

  const sections = useMemo(() => {
    if (!mention) return [];
    const q = mention.query.toLowerCase();
    const matches = (row: PrincipalRow) => !q || row.search.toLowerCase().includes(q) || row.id.toLowerCase().startsWith(q);
    const offered = directory.rows.filter((row) => !row.self && matches(row));
    const candidates = (rows: PrincipalRow[]): Candidate[] =>
      rows.map((row) => ({
        key: row.id,
        insert: row.insert,
        title: row.title,
        detail: row.detail,
        avatar: (
          <ParticipantAvatar kind={row.kind} label={row.avatarLabel} userId={row.kind === 'person' ? row.id : null} size="xs" />
        ),
      }));
    const inMembers = candidates(offered.filter((row) => row.member));
    const agents = candidates(offered.filter((row) => !row.member && row.kind === 'session'));
    const persons = candidates(offered.filter((row) => !row.member && row.kind === 'person'));
    const everyone: Candidate[] =
      !q || 'here'.startsWith(q)
        ? [
            {
              key: 'here',
              insert: '@here',
              title: '@here',
              detail: t('mentionHere', { name: roomName }),
              avatar: (
                <span className="bg-muted flex size-5 items-center justify-center rounded-sm">
                  <MegaphoneSimpleIcon className="size-3" />
                </span>
              ),
            },
          ]
        : [];
    let index = 0;
    return [
      { key: 'members', heading: t('inThisRoom'), items: [...inMembers.slice(0, PER_SECTION), ...everyone] },
      { key: 'agents', heading: t('agents'), items: agents.slice(0, PER_SECTION) },
      { key: 'people', heading: t('people'), items: persons.slice(0, PER_SECTION) },
    ]
      .filter((s) => s.items.length > 0)
      .map((s) => ({ ...s, items: s.items.map((item) => ({ ...item, index: index++ })) }));
  }, [mention, directory.rows, roomName, t]);

  const flat = useMemo(() => sections.flatMap((s) => s.items), [sections]);
  // The highlight resets to the first row whenever the `@query` changes.
  const mentionKey = mention ? `${mention.start}:${mention.query}` : '';

  const pick = (candidate: Candidate) => {
    if (!mention) return;
    const before = text.slice(0, mention.start);
    const after = text.slice(caret).replace(/^\S*/, '');
    const inserted = `${candidate.insert} `;
    pendingCaret.current = before.length + inserted.length;
    setCaret(pendingCaret.current);
    setText(`${before}${inserted}${after.replace(/^ /, '')}`);
    textareaRef.current?.focus();
  };

  const send = async () => {
    const body = text.trim();
    if (!body || sending) return;
    setSending(true);
    try {
      await onSend(body);
      setText('');
      setCaret(0);
    } catch (error) {
      toastError(error, t('sendFailed'));
    } finally {
      setSending(false);
    }
  };

  const nav = useListNavigation(flat, mentionKey, pick, PICK_KEYS);

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (menuOpen && nav.onKeyDown(event)) return;
    if (menuOpen && event.key === 'Escape') {
      event.preventDefault();
      setDismissedAt(mention!.start);
      return;
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void send();
    }
  };

  const insertAt = () => {
    const el = textareaRef.current;
    const at = el?.selectionStart ?? text.length;
    const lead = at > 0 && !/\s/.test(text[at - 1]!) ? ' @' : '@';
    pendingCaret.current = at + lead.length;
    setCaret(pendingCaret.current);
    setDismissedAt(null);
    setText(`${text.slice(0, at)}${lead}${text.slice(at)}`);
    el?.focus();
  };

  return (
    <div className="shrink-0 px-5 pb-5">
      <div className="relative">
        {menuOpen ? (
          <div className="absolute inset-x-0 bottom-full z-20 mb-2">
            <MenuCard className="w-96 max-w-full rounded-lg">
              {flat.length === 0 ? (
                <p role="status" className="text-muted-foreground px-3 py-2.5 text-sm">
                  {t('noMatches')}
                </p>
              ) : (
                <div
                  role="listbox"
                  aria-label={t('mentionSuggestions')}
                  aria-activedescendant={`room-mention-${nav.active}`}
                  tabIndex={-1}
                  className="max-h-72 overflow-y-auto p-1.5"
                >
                  {sections.map((section) => (
                    <div key={section.key}>
                      <MenuSectionHeading>{section.heading}</MenuSectionHeading>
                      {section.items.map((item) => (
                        <MenuRow
                          key={item.key}
                          id={`room-mention-${item.index}`}
                          selected={item.index === nav.active}
                          onSelect={() => pick(item)}
                          onHover={() => nav.setActive(item.index)}
                        >
                          {item.avatar}
                          <span className="text-foreground min-w-0 truncate text-sm">{item.title}</span>
                          {item.detail ? (
                            <span className="text-muted-foreground min-w-0 truncate text-xs">{item.detail}</span>
                          ) : null}
                        </MenuRow>
                      ))}
                    </div>
                  ))}
                </div>
              )}
            </MenuCard>
          </div>
        ) : null}
        {/* One row, like the session composer's card: the text grows upward, the two controls sit on its last line. */}
        <div className="bg-background border-border focus-within:border-ring focus-within:ring-ring/15 flex items-end gap-1 rounded-xl border p-1.5 focus-within:ring-3">
          <textarea
            ref={textareaRef}
            value={text}
            rows={1}
            readOnly={sending}
            aria-busy={sending}
            onChange={(event) => {
              setText(event.target.value);
              setCaret(event.target.selectionStart);
            }}
            onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
            onKeyDown={onKeyDown}
            placeholder={placeholder}
            aria-label={placeholder}
            aria-autocomplete="list"
            className="text-foreground placeholder:text-muted-foreground block min-w-0 flex-1 resize-none bg-transparent px-2 py-1.5 text-sm outline-none"
          />
          <Hint label={t('mentionSomeone')} side="top">
            <Button variant="ghost" size="icon-sm" aria-label={t('mentionSomeone')} onClick={insertAt}>
              <AtIcon />
            </Button>
          </Hint>
          <Hint label={`${t('send')} · ${t('newLineHint')}`} side="top">
            <Button
              size="icon-sm"
              aria-label={t('send')}
              disabled={!text.trim() || sending}
              aria-busy={sending}
              onClick={() => void send()}
              className="rounded-full"
            >
              {sending ? <Loading className="size-4 shrink-0" /> : <ArrowUpIcon />}
            </Button>
          </Hint>
        </div>
      </div>
    </div>
  );
}
