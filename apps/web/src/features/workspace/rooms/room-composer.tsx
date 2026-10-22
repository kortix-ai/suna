'use client';

import { Button } from '@kortix/ui/button';
import Hint from '@kortix/ui/hint';
import Loading from '@kortix/ui/loading';
import { errorToast } from '@kortix/ui/toast';
import { MenuCard, MenuRow, MenuSectionHeading } from '@kortix/ui/session/composer/menus/menu-shell';
import { useTranslations } from '@/i18n/use-translations';
import type { ProjectSession, RoomMember, RoomPerson } from '@kortix/sdk';
import { AtIcon, MegaphoneSimpleIcon, PaperPlaneRightIcon } from '@phosphor-icons/react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';

import { ParticipantAvatar } from './room-identity';
import { activeMention, MENTION_ID_CHARS, sessionDisplay } from './room-text';
import { projectSessionTitle } from './use-room-directory';

const MAX_HEIGHT_PX = 240;
const PER_SECTION = 6;

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
  members,
  sessions,
  people,
  viewerId,
  autoFocus = false,
  onSend,
}: {
  placeholder: string;
  roomName: string;
  members: readonly RoomMember[];
  sessions: readonly ProjectSession[];
  people: readonly RoomPerson[];
  viewerId: string | null;
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
    const matches = (label: string, id: string) => !q || label.toLowerCase().includes(q) || id.toLowerCase().startsWith(q);
    const taken = new Set<string>(viewerId ? [viewerId] : []);
    const emailById = new Map(people.map((p) => [p.user_id, p.email]));
    const inMembers: Candidate[] = [];
    for (const m of members) {
      const id = m.session_id ?? m.user_id;
      if (!id || taken.has(id)) continue;
      taken.add(id);
      const title = m.kind === 'session' ? sessionDisplay(m.label).name : m.label;
      if (!matches(title, id)) continue;
      const email = m.kind === 'person' ? emailById.get(id) : null;
      inMembers.push({
        key: id,
        insert: email ? `@${email}` : `@${id.slice(0, MENTION_ID_CHARS)}`,
        title,
        detail: m.kind === 'session' ? sessionDisplay(m.label).detail : null,
        avatar: <ParticipantAvatar kind={m.kind} label={m.label} userId={m.user_id} size="xs" />,
      });
    }
    const agents: Candidate[] = [];
    for (const s of sessions) {
      if (taken.has(s.session_id)) continue;
      taken.add(s.session_id);
      const agent = s.agent_name && s.agent_name !== 'default' ? s.agent_name : null;
      const title = projectSessionTitle(s);
      if (!matches(`${title} ${agent ?? ''}`, s.session_id)) continue;
      agents.push({
        key: s.session_id,
        insert: `@${s.session_id.slice(0, MENTION_ID_CHARS)}`,
        title,
        detail: s.name ? agent : null,
        avatar: <ParticipantAvatar kind="session" label={title} size="xs" />,
      });
    }
    const persons: Candidate[] = [];
    for (const p of people) {
      if (taken.has(p.user_id)) continue;
      taken.add(p.user_id);
      const title = p.name ?? p.email ?? p.user_id.slice(0, 8);
      if (!matches(`${title} ${p.email ?? ''}`, p.user_id)) continue;
      persons.push({
        key: p.user_id,
        insert: p.email ? `@${p.email}` : `@${p.user_id.slice(0, MENTION_ID_CHARS)}`,
        title,
        detail: p.name ? p.email : null,
        avatar: <ParticipantAvatar kind="person" label={title} userId={p.user_id} size="xs" />,
      });
    }
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
  }, [mention, members, sessions, people, viewerId, roomName, t]);

  const flat = useMemo(() => sections.flatMap((s) => s.items), [sections]);
  // The highlight resets to the first row whenever the `@query` changes.
  const mentionKey = mention ? `${mention.start}:${mention.query}` : '';
  const [nav, setNav] = useState({ key: mentionKey, index: 0 });
  const selected = nav.key === mentionKey ? nav.index : 0;
  const setSelected = (next: number | ((i: number) => number)) =>
    setNav({ key: mentionKey, index: typeof next === 'function' ? next(selected) : next });

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
      errorToast(error instanceof Error ? error.message : t('sendFailed'));
    } finally {
      setSending(false);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (menuOpen && flat.length > 0) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const step = event.key === 'ArrowDown' ? 1 : -1;
        setSelected((i) => (i + step + flat.length) % flat.length);
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        const candidate = flat[Math.min(selected, flat.length - 1)];
        if (candidate) pick(candidate);
        return;
      }
    }
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
                  aria-activedescendant={`room-mention-${selected}`}
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
                          selected={item.index === selected}
                          onSelect={() => pick(item)}
                          onHover={() => setSelected(item.index)}
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
        <div className="bg-popover border-border focus-within:border-ring focus-within:ring-ring/15 rounded-md border focus-within:ring-3">
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
            className="text-foreground placeholder:text-muted-foreground block w-full resize-none bg-transparent px-3 pt-2.5 pb-1 text-sm outline-none"
          />
          <div className="flex items-center gap-1 px-1.5 pb-1.5">
            <Hint label={t('mentionSomeone')} side="top">
              <Button variant="ghost" size="icon-xs" aria-label={t('mentionSomeone')} onClick={insertAt}>
                <AtIcon />
              </Button>
            </Hint>
            <span className="text-muted-foreground min-w-0 flex-1 truncate text-right text-xs">
              {text.trim() ? t('newLineHint') : null}
            </span>
            <Hint label={t('send')} side="top">
              <Button
                size="icon-sm"
                aria-label={t('send')}
                disabled={!text.trim() || sending}
                aria-busy={sending}
                onClick={() => void send()}
              >
                {sending ? <Loading className="size-4 shrink-0" /> : <PaperPlaneRightIcon />}
              </Button>
            </Hint>
          </div>
        </div>
      </div>
    </div>
  );
}
