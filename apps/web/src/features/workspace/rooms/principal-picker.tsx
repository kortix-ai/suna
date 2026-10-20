'use client';

import { InputGroupSearch, InputGroupSearchIcon, InputGroupSearchInput } from '@/components/ui/input-group';
import { Label } from '@/components/ui/label';
import Loading from '@/components/ui/loading';
import { Skeleton } from '@/components/ui/skeleton';
import { UserAvatar } from '@/components/ui/user-avatar';
import { useTranslations } from '@/i18n/use-translations';
import { cn } from '@/lib/utils';
import { MagnifyingGlassIcon } from '@phosphor-icons/react';
import { useDeferredValue, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';

import { ParticipantAvatar, sessionStatusKey } from './room-identity';
import { projectSessionTitle, useRoomPeople, useRoomSessions } from './use-room-directory';

export type PickedPrincipal =
  | { kind: 'person'; user_id: string; label: string }
  | { kind: 'session'; session_id: string; label: string };

interface PickerRow {
  id: string;
  pick: PickedPrincipal;
  title: string;
  detail: string | null;
  render: () => React.ReactNode;
}

/**
 * One searchable list of the people and agent sessions of a project, grouped
 * "People" then "Agents" (layout.md, lists of principals). Arrow keys move the
 * highlight, Enter picks. Used by "New message" and "Add people and agents".
 */
export function PrincipalPicker({
  projectId,
  viewerId,
  exclude,
  pendingId,
  onPick,
}: {
  projectId: string;
  viewerId: string | null;
  /** Session or user ids that are not offered (current members). */
  exclude?: ReadonlySet<string>;
  /** The id being opened or added: its row shows a spinner and the list is inert. */
  pendingId: string | null;
  onPick: (pick: PickedPrincipal) => void;
}) {
  const t = useTranslations('rooms');
  const [query, setQuery] = useState('');
  const q = useDeferredValue(query.trim());
  const people = useRoomPeople(projectId, q);
  const sessions = useRoomSessions(projectId, q);

  const groups = useMemo(() => {
    const personRows: PickerRow[] = (people.data ?? [])
      .filter((p) => p.user_id !== viewerId && !exclude?.has(p.user_id))
      .map((p) => {
        const title = p.name ?? p.email ?? p.user_id.slice(0, 8);
        return {
          id: p.user_id,
          pick: { kind: 'person', user_id: p.user_id, label: title },
          title,
          detail: p.name && p.email ? p.email : null,
          render: () => <UserAvatar email={p.email ?? p.user_id} name={p.name} size="sm" />,
        };
      });
    const sessionRows: PickerRow[] = sessions.sessions
      .filter((s) => !exclude?.has(s.session_id))
      .map((s) => {
        const title = projectSessionTitle(s);
        const agent = s.agent_name && s.agent_name !== 'default' ? s.agent_name : null;
        return {
          id: s.session_id,
          pick: { kind: 'session', session_id: s.session_id, label: title },
          title,
          detail: [agent, t(sessionStatusKey(s.status))].filter(Boolean).join(' · '),
          render: () => <ParticipantAvatar kind="session" label={title} status={s.status} size="sm" />,
        };
      });
    let index = 0;
    return [
      { key: 'people', heading: t('people'), rows: personRows },
      { key: 'agents', heading: t('agents'), rows: sessionRows },
    ]
      .filter((g) => g.rows.length > 0)
      .map((g) => ({ ...g, rows: g.rows.map((row) => ({ ...row, index: index++ })) }));
  }, [people.data, sessions.sessions, viewerId, exclude, t]);

  const flat = useMemo(() => groups.flatMap((g) => g.rows), [groups]);
  // The highlight resets to the first row whenever the query changes.
  const [nav, setNav] = useState({ q, index: 0 });
  const active = nav.q === q ? nav.index : 0;
  const setActive = (next: number | ((i: number) => number)) =>
    setNav({ q, index: typeof next === 'function' ? next(active) : next });
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const loading = (people.isLoading || sessions.isLoading) && flat.length === 0;
  const failed = people.isError && sessions.isError;

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (flat.length === 0) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setActive((i) => (i + step + flat.length) % flat.length);
    } else if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
      event.preventDefault();
      const row = flat[Math.min(active, flat.length - 1)];
      if (row && pendingId === null) onPick(row.pick);
    }
  };

  return (
    <div className="space-y-4">
      <InputGroupSearch>
        <InputGroupSearchIcon>
          <MagnifyingGlassIcon />
        </InputGroupSearchIcon>
        <InputGroupSearchInput
          size="sm"
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={t('searchPeopleAndAgents')}
          aria-label={t('searchPeopleAndAgents')}
          role="combobox"
          aria-expanded
          aria-controls="room-principal-list"
          aria-activedescendant={flat.length ? `room-principal-${active}` : undefined}
        />
      </InputGroupSearch>
      <div ref={listRef} id="room-principal-list" role="listbox" className="max-h-80 space-y-4 overflow-y-auto">
        {loading ? (
          <div className="space-y-1">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-10 w-full rounded-md" />
            ))}
          </div>
        ) : failed ? (
          <p className="text-muted-foreground px-3 py-6 text-center text-xs">{t('peopleLoadError')}</p>
        ) : flat.length === 0 ? (
          <p className="text-muted-foreground px-3 py-6 text-center text-xs">{t('noMatches')}</p>
        ) : (
          groups.map((group) => (
            <section key={group.key} className="space-y-1">
              <Label className="px-2">{group.heading}</Label>
              <ul>
                {group.rows.map((row) => {
                  const i = row.index;
                  return (
                    <li key={row.id}>
                      <button
                        type="button"
                        id={`room-principal-${i}`}
                        role="option"
                        aria-selected={i === active}
                        data-index={i}
                        disabled={pendingId !== null}
                        onClick={() => onPick(row.pick)}
                        onPointerMove={() => setActive(i)}
                        className={cn(
                          'flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left disabled:opacity-50',
                          i === active && 'bg-active',
                        )}
                      >
                        {row.render()}
                        <span className="min-w-0 flex-1">
                          <span className="text-foreground block truncate text-sm">{row.title}</span>
                          {row.detail ? (
                            <span className="text-muted-foreground block truncate text-xs">{row.detail}</span>
                          ) : null}
                        </span>
                        {pendingId === row.id ? <Loading className="size-4 shrink-0" /> : null}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))
        )}
      </div>
    </div>
  );
}
