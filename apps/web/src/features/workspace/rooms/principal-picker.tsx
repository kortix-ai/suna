'use client';

import { InputGroupSearch, InputGroupSearchIcon, InputGroupSearchInput } from '@kortix/ui/input-group';
import { Label } from '@kortix/ui/label';
import Loading from '@kortix/ui/loading';
import { Skeleton } from '@kortix/ui/skeleton';
import { useTranslations } from '@/i18n/use-translations';
import { cn } from '@kortix/ui';
import { MagnifyingGlassIcon } from '@phosphor-icons/react';
import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';

import { ParticipantAvatar, sessionStatusKey } from './room-identity';
import { principalRows, useListNavigation, useRoomPeople, useRoomSessions, type PrincipalRow } from './use-room-directory';

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
  onPick: (row: PrincipalRow) => void;
}) {
  const t = useTranslations('rooms');
  const [query, setQuery] = useState('');
  const q = useDeferredValue(query.trim());
  const people = useRoomPeople(projectId, q);
  const sessions = useRoomSessions(projectId, q);

  const groups = useMemo(() => {
    const rows = principalRows([], sessions.sessions, people.data ?? [], viewerId).filter(
      (row) => !row.self && !exclude?.has(row.id),
    );
    let index = 0;
    return [
      { key: 'people', heading: t('people'), rows: rows.filter((row) => row.kind === 'person') },
      {
        key: 'agents',
        heading: t('agents'),
        // A session row adds its status to the detail.
        rows: rows
          .filter((row) => row.kind === 'session')
          .map((row) => ({ ...row, detail: [row.detail, t(sessionStatusKey(row.status))].filter(Boolean).join(' · ') })),
      },
    ]
      .filter((g) => g.rows.length > 0)
      .map((g) => ({ ...g, rows: g.rows.map((row) => ({ ...row, index: index++ })) }));
  }, [people.data, sessions.sessions, viewerId, exclude, t]);

  const flat = useMemo(() => groups.flatMap((g) => g.rows), [groups]);
  const { active, setActive, onKeyDown } = useListNavigation(flat, q, (row) => {
    if (pendingId === null) onPick(row);
  });
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const loading = (people.isLoading || sessions.isLoading) && flat.length === 0;
  const failed = people.isError && sessions.isError;

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
          onKeyDown={(event) => void onKeyDown(event)}
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
                        onClick={() => onPick(row)}
                        onPointerMove={() => setActive(i)}
                        className={cn(
                          'flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left disabled:opacity-50',
                          i === active && 'bg-active',
                        )}
                      >
                        <ParticipantAvatar kind={row.kind} label={row.avatarLabel} userId={row.id} status={row.status} size="sm" />
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
