'use client';

import { CaretDownIcon, CheckIcon } from '@phosphor-icons/react';
import { useProjectSessions } from '@kortix/sdk/react';
import { useState } from 'react';

import {
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandPopover,
  CommandPopoverContent,
  CommandPopoverTrigger,
} from '@kortix/ui/command';
import { TRIGGER_CARET_CLASS, TRIGGER_ICON_SIZE, triggerVariants } from '@kortix/ui/trigger-variants';
import { useDebounce } from '@kortix/ui/internal/hooks/use-debounced-value';
import { useTranslations } from '@/i18n/use-translations';
import { cn } from '@kortix/ui';

/** Rows one page of a search shows. Load more reads the next page. */
export const AUDIT_SESSION_SEARCH_LIMIT = 20;

/** A Kortix session id (`randomUUID()`): only such text is offered as a pasted id. */
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The audit log's Session filter (KRTX-1727).
 *
 * It was a `<Select>` over the first page of the project's sessions, so a
 * session past that page could not be picked. Now the text field searches the
 * project's sessions on the server (`q`: title, starter or session-id prefix),
 * a page at a time (`useProjectSessions`). The server drops sessions the
 * reader cannot open after a bounded scan, so a page can be empty and still
 * carry a cursor: the hook reads past such pages on its own, then Load more
 * offers the next one. "No sessions matched" shows only at the end of the
 * list. A pasted session id is a filter of its own: the audit read filters by
 * any id, also one of a deleted session that no list returns, and with no
 * project picked.
 */
export function AuditSessionPicker({
  projectId,
  value,
  onChange,
}: {
  /** The project filter; `''` when none is picked (no search, a pasted id only). */
  projectId: string;
  value: string;
  onChange: (sessionId: string) => void;
}) {
  const t = useTranslations('hardcodedUi.i18nComplete');
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  // The name of the row picked last: the filter state holds the id only.
  const [picked, setPicked] = useState<{ id: string; name: string } | null>(null);
  const label = !value ? t.raw('text78648d4d6649') : picked?.id === value ? picked.name : value;

  const choose = (sessionId: string, name: string) => {
    setPicked(sessionId ? { id: sessionId, name } : null);
    onChange(sessionId);
    setOpen(false);
    setSearch('');
  };

  return (
    <CommandPopover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setSearch('');
      }}
    >
      <CommandPopoverTrigger>
        <button type="button" className={cn(triggerVariants(), 'h-9 w-[220px]')}>
          <span>{label}</span>
          <CaretDownIcon className={cn(TRIGGER_CARET_CLASS, TRIGGER_ICON_SIZE.sm)} />
        </button>
      </CommandPopoverTrigger>
      <CommandPopoverContent side="bottom" align="start" className="w-80">
        <SessionResults
          projectId={projectId}
          value={value}
          search={search}
          onSearchChange={setSearch}
          onChoose={choose}
        />
      </CommandPopoverContent>
    </CommandPopover>
  );
}

/** The popover body. Mounted only while the popover is open, so a closed picker sends nothing. */
function SessionResults({
  projectId,
  value,
  search,
  onSearchChange,
  onChoose,
}: {
  projectId: string;
  value: string;
  search: string;
  onSearchChange: (search: string) => void;
  onChoose: (sessionId: string, name: string) => void;
}) {
  const t = useTranslations('hardcodedUi.i18nComplete');
  const text = search.trim();
  const q = useDebounce(text, 250);
  const sessionsQuery = useProjectSessions(projectId, {
    scope: 'project',
    q: q || undefined,
    limit: AUDIT_SESSION_SEARCH_LIMIT,
    enabled: !!projectId,
  });
  const sessions = projectId ? sessionsQuery.sessions : [];
  // Stored ids are lowercase and the audit read matches one exactly.
  const id = text.toLowerCase();
  const pastedId =
    SESSION_ID.test(id) && !sessions.some((session) => session.session_id === id) ? id : null;
  // A next page the hook does not read on its own: after a page with rows,
  // past the scan limit, or after a failed page (the retry).
  const canLoadMore =
    !!projectId && sessionsQuery.hasNextPage && !sessionsQuery.isFetchingNextPage && !sessionsQuery.isScanning;
  const emptyText = !projectId
    ? t.raw('textf7b9225a1fdc')
    : q !== text || sessionsQuery.isFetching || sessionsQuery.isScanning
      ? t.raw('textc31723ab3302')
      : sessionsQuery.isError
        ? t.raw('textda6efefb0490')
        : t('text1fc03af173f4', { value0: text });

  return (
    <>
      <CommandInput
        compact
        placeholder={t.raw('text8b7811603173')}
        value={search}
        onValueChange={onSearchChange}
      />
      <CommandList>
        <CommandEmpty>{emptyText}</CommandEmpty>
        <CommandGroup>
          {text ? null : (
            <CommandItem value="all" onSelect={() => onChoose('', '')}>
              <span className="min-w-0 flex-1 truncate">{t.raw('text78648d4d6649')}</span>
              {value ? null : <CheckIcon className="size-3.5" />}
            </CommandItem>
          )}
          {pastedId ? (
            <CommandItem value={`id:${pastedId}`} onSelect={() => onChoose(pastedId, pastedId)}>
              <span className="min-w-0 flex-1 truncate font-mono text-xs">{pastedId}</span>
              <span className="text-muted-foreground shrink-0 text-xs">{t.raw('textcb9ac5c561da')}</span>
            </CommandItem>
          ) : null}
          {sessions.map((session) => {
            const name = session.name || session.session_id.slice(0, 8);
            return (
              <CommandItem
                key={session.session_id}
                value={session.session_id}
                onSelect={() => onChoose(session.session_id, name)}
              >
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate">{name}</span>
                  <span className="text-muted-foreground truncate font-mono text-xs">
                    {session.session_id}
                  </span>
                </span>
                {session.session_id === value ? <CheckIcon className="size-3.5" /> : null}
              </CommandItem>
            );
          })}
          {canLoadMore ? (
            <CommandItem value="load-more" onSelect={() => void sessionsQuery.fetchNextPage()}>
              <span className="text-muted-foreground">{t.raw('textac8991ef0101')}</span>
            </CommandItem>
          ) : null}
        </CommandGroup>
      </CommandList>
    </>
  );
}
