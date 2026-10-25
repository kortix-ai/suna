'use client';

import { ApiError, type ProjectSpace, type ProjectSpaceLink } from '@kortix/sdk';
import { safeHttpUrl } from '@kortix/shared';
import {
  useAddProjectSpaceLink,
  usePinProjectSpaceLink,
  useProjectSpaceLinks,
  useRemoveProjectSpaceLink,
} from '@kortix/sdk/react';
import {
  ChatTeardropTextIcon,
  LinkSimpleIcon,
  MagnifyingGlassIcon,
  PlusIcon,
  PushPinIcon,
  PushPinSlashIcon,
  TrashIcon,
  XIcon,
} from '@phosphor-icons/react';
import { type ReactNode, useId, useMemo, useState } from 'react';

import { useLocale, useTranslations } from '../../i18n';
import { Copy } from '../../icons/copy';
import { useCopy } from '../../internal/hooks/use-copy';
import { SolidCheckIcon } from '../../internal/icons/solid-check-icon';
import { relativeTime } from '../../internal/lib/relative-time';
import { Button } from '../../primitives/button';
import { ButtonGroup } from '../../primitives/button-group';
import { ConfirmDialog } from '../../primitives/confirm-dialog';
import { DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator } from '../../primitives/dropdown-menu';
import { EmptyArt } from '../../primitives/empty-art';
import { EmptyState } from '../../primitives/empty-state';
import { ErrorState } from '../../primitives/error-state';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '../../primitives/field';
import Hint from '../../primitives/hint';
import { Input } from '../../primitives/input';
import Loading from '../../primitives/loading';
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalDescription,
  ModalFooter,
  ModalHeader,
  ModalTitle,
} from '../../primitives/modal';
import { FaviconAvatar } from '../../primitives/favicon-avatar';
import { errorToast, successToast } from '../../primitives/toast';
import { UserAvatar } from '../../primitives/user-avatar';
import { useUiViewerId } from '../../providers/ui-provider';
import { participantLabel } from '../../session/participants/session-participants';
import {
  filterLinks,
  LINK_ADDED,
  type LinkAdded,
  linkFiltersFromParams,
  linkHost,
  linkTitle,
} from './space-link-label';
import { dayKind } from './space-timeline';
import { Facet, FilterMenu, FilterSearch, type FilterToken, FilterTokens } from './space-threads-tab';

/** The API's limits: an http(s) URL of at most 2,048 characters, a title of at most 200. */
const URL_MAX = 2048;
const TITLE_MAX = 200;

/** The URL keys of the search and the filters. */
const FILTER_PARAMS = ['q', 'pinned', 'by', 'added'] as const;
type FilterParam = (typeof FILTER_PARAMS)[number];
/** The radio value of a facet's "Any" row (Radix needs a non-empty value). */
const ANY = 'any';

/** "example.com/x" becomes "https://example.com/x"; a value with a scheme is kept as typed. */
function withScheme(value: string): string {
  return /^[a-z][a-z\d+.-]*:\/\//i.test(value) ? value : `https://${value}`;
}

/** An http(s) URL whose host has a dot ("localhost" and "foo" are not links). */
function isWebUrl(value: string): boolean {
  try {
    const { protocol, hostname } = new URL(value);
    return (protocol === 'http:' || protocol === 'https:') && hostname.includes('.');
  } catch {
    return false;
  }
}

const personName = (name: string | null) => (name ? participantLabel({ name, email: null }) : '');

type LinkGroup = { key: string; label: string; links: ProjectSpaceLink[] };

/**
 * A channel's Links tab, laid out like its Threads tab: one toolbar (search,
 * the Filter menu, the active filters, "Add link"), then one list on one left
 * edge. Pinned links come first under "Pinned"; the others follow by the day
 * they were last shared (Today, Yesterday, Earlier). The channel's links all
 * load at once, so search and filters read the loaded list. The URL holds
 * them (`?q=&pinned=1&by=&added=`).
 */
export function SpaceLinks({
  projectId,
  space,
  place,
  onOpenThread,
  params,
  setParams,
}: {
  projectId: string;
  space: ProjectSpace;
  place: string;
  onOpenThread?: (sessionId: string) => void;
  params: { get(name: string): string | null };
  setParams: (change: (params: URLSearchParams) => void) => void;
}) {
  const t = useTranslations('spaces.view');
  const tf = useTranslations('spaces.view.threadFilter');
  const viewerId = useUiViewerId();
  const links = useProjectSpaceLinks(projectId, space.space_id);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<ProjectSpaceLink | null>(null);
  const remove = useRemoveProjectSpaceLink(projectId, space.space_id);
  const pin = usePinProjectSpaceLink(projectId, space.space_id);

  const filters = linkFiltersFromParams(params);
  const setParam = (key: FilterParam, value: string | null) =>
    setParams((next) => (value ? next.set(key, value) : next.delete(key)));
  const clearAll = () => setParams((next) => FILTER_PARAMS.forEach((key) => next.delete(key)));

  // Everyone who shared a link here, by name; the viewer is "Me".
  const people = useMemo(() => {
    const byId = new Map<string, string>();
    for (const link of links.data ?? []) {
      if (link.created_by && link.created_by !== viewerId && !byId.has(link.created_by)) {
        byId.set(link.created_by, personName(link.created_by_name) || t('authorFallback'));
      }
    }
    return [...byId].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  }, [links.data, viewerId, t]);

  const groups = useMemo(() => {
    const now = new Date();
    const shown = filterLinks(links.data ?? [], filters, viewerId, now);
    const pinned = shown
      .filter((link) => link.pinned)
      .sort((a, b) => Date.parse(b.pinned_at ?? b.created_at) - Date.parse(a.pinned_at ?? a.created_at));
    const result: LinkGroup[] = pinned.length ? [{ key: 'pinned', label: t('links.pinnedLabel'), links: pinned }] : [];
    for (const link of shown) {
      if (link.pinned) continue;
      const kind = dayKind(new Date(link.last_shared_at), now);
      let group = result.find((g) => g.key === kind);
      if (!group) {
        group = { key: kind, label: kind === 'earlier' ? t('links.earlier') : t(kind), links: [] };
        result.push(group);
      }
      group.links.push(link);
    }
    return result;
    // `filters` is rebuilt each render from the URL; its fields are the inputs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [links.data, filters.q, filters.pinned, filters.by, filters.added, viewerId, t]);

  const byLabel = (by: string) =>
    by === 'me' || by === viewerId ? tf('me') : (people.find((p) => p.id === by)?.name ?? t('authorFallback'));
  const addedLabel = (added: LinkAdded) => tf(`activityValue.${added}`);
  const tokens: FilterToken<FilterParam>[] = [];
  if (filters.pinned) tokens.push({ key: 'pinned', facet: t('links.show'), label: t('links.pinnedLabel') });
  if (filters.by) tokens.push({ key: 'by', facet: t('links.sharedBy'), label: byLabel(filters.by) });
  if (filters.added) tokens.push({ key: 'added', facet: t('links.added'), label: addedLabel(filters.added) });
  const pick = (key: FilterParam) => (value: string) => setParam(key, value === ANY ? null : value);

  const setPinned = (link: ProjectSpaceLink, next: boolean) => {
    pin.mutate(
      { linkId: link.link_id, pinned: next },
      {
        onSuccess: (result) =>
          // `null` only from an older server, where unpinning an added link removed it.
          successToast(result === null ? t('links.removed') : next ? t('links.pinnedToast') : t('links.unpinnedToast')),
        onError: (err) =>
          errorToast(
            err instanceof ApiError && err.code === 'link_limit'
              ? t('links.limit')
              : next
                ? t('links.pinFailed')
                : t('links.unpinFailed'),
          ),
      },
    );
  };

  let body;
  if (links.isError && !links.data) {
    body = (
      <div className="px-5 py-8">
        <ErrorState
          size="sm"
          title={t('links.loadError')}
          action={
            <Button variant="outline" size="sm" onClick={() => links.refetch()}>
              {t('retry')}
            </Button>
          }
        />
      </div>
    );
  } else if (!links.data) {
    body = null;
  } else if (links.data.length === 0) {
    body = (
      <EmptyState
        className="min-h-full"
        media={<EmptyArt icon={LinkSimpleIcon} />}
        title={t('empty.links.title')}
        description={t('empty.links.description', { place })}
        action={
          <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setAdding(true)}>
            <PlusIcon className="size-3.5 shrink-0" />
            {t('links.add')}
          </Button>
        }
      />
    );
  } else if (groups.length === 0) {
    body = (
      <EmptyState
        className="min-h-full"
        media={<EmptyArt icon={MagnifyingGlassIcon} />}
        title={t('links.noMatch')}
        description={tf('noMatchHint')}
        action={
          <Button variant="outline" size="sm" className="gap-1.5" onClick={clearAll}>
            <XIcon className="size-3.5 shrink-0" />
            {tf('clearFilters')}
          </Button>
        }
      />
    );
  } else {
    body = (
      <div className="py-2">
        {groups.map((group, index) => (
          <section key={group.key} aria-labelledby={`links-${group.key}`}>
            <h3
              id={`links-${group.key}`}
              className={`text-muted-foreground px-5 pb-1 text-xs font-medium ${index === 0 ? 'pt-1' : 'pt-4'}`}
            >
              {group.label}
            </h3>
            <ul>
              {group.links.map((link) => (
                <LinkRow
                  key={link.link_id}
                  link={link}
                  busy={pin.isPending}
                  onPin={() => setPinned(link, !link.pinned)}
                  onOpenThread={link.session_id && onOpenThread ? () => onOpenThread(link.session_id!) : undefined}
                  onRemove={link.can_delete ? () => setRemoving(link) : undefined}
                />
              ))}
            </ul>
          </section>
        ))}
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {links.data?.length ? (
        <div className="flex shrink-0 flex-wrap items-center gap-2 px-5 pt-3 pb-1">
          <FilterSearch value={filters.q} placeholder={t('links.search')} onSearch={(q) => setParam('q', q || null)} />
          <FilterMenu>
            <Facet label={t('links.show')} value={filters.pinned ? t('links.pinnedLabel') : t('links.all')}>
              <DropdownMenuRadioGroup value={filters.pinned ? '1' : ANY} onValueChange={pick('pinned')}>
                <DropdownMenuRadioItem value={ANY}>{t('links.all')}</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="1">{t('links.pinnedLabel')}</DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </Facet>
            <Facet label={t('links.sharedBy')} value={filters.by ? byLabel(filters.by) : tf('anyone')} wide>
              <DropdownMenuRadioGroup value={filters.by ?? ANY} onValueChange={pick('by')}>
                <DropdownMenuRadioItem value={ANY}>{tf('anyone')}</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="me">{tf('me')}</DropdownMenuRadioItem>
                {people.length > 0 ? <DropdownMenuSeparator /> : null}
                {people.map((person) => (
                  <DropdownMenuRadioItem key={person.id} value={person.id}>
                    <UserAvatar size="xs" name={person.name} email="" />
                    <span className="min-w-0 truncate">{person.name}</span>
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </Facet>
            <Facet label={t('links.added')} value={filters.added ? addedLabel(filters.added) : tf('anyTime')}>
              <DropdownMenuRadioGroup value={filters.added ?? ANY} onValueChange={pick('added')}>
                <DropdownMenuRadioItem value={ANY}>{tf('anyTime')}</DropdownMenuRadioItem>
                {LINK_ADDED.map((added) => (
                  <DropdownMenuRadioItem key={added} value={added}>
                    {addedLabel(added)}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </Facet>
          </FilterMenu>
          <FilterTokens tokens={tokens} onRemove={(key) => setParam(key, null)} onClear={clearAll} />
          <Button variant="outline" size="sm" className="ml-auto gap-1.5" onClick={() => setAdding(true)}>
            <PlusIcon className="size-3.5 shrink-0" />
            {t('links.add')}
          </Button>
        </div>
      ) : null}
      <div className="min-h-0 flex-1 overflow-y-auto">{body}</div>
      <AddLinkModal projectId={projectId} space={space} place={place} open={adding} onOpenChange={setAdding} />
      <ConfirmDialog
        open={!!removing}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={t('links.removeTitle')}
        description={t('links.removeDescription', { link: removing ? linkTitle(removing) : '', place })}
        confirmLabel={t('links.remove')}
        confirmVariant="destructive"
        isPending={remove.isPending}
        onConfirm={() => {
          if (!removing) return;
          remove.mutate(removing.link_id, {
            onSuccess: () => {
              setRemoving(null);
              successToast(t('links.removed'));
            },
            onError: () => errorToast(t('links.removeFailed')),
          });
        }}
      />
    </div>
  );
}

/**
 * One link on one line, at the Threads row's height and padding: the site's
 * favicon (the app's favicon service, never the stored `icon_url`), the title, the site muted,
 * and who shared it and when at the right. Hover or focus swaps that for the
 * actions: Pin / Unpin, Copy link, Open thread, Remove. The row opens the link.
 */
function LinkRow({
  link,
  busy,
  onPin,
  onOpenThread,
  onRemove,
}: {
  link: ProjectSpaceLink;
  busy: boolean;
  onPin: () => void;
  onOpenThread?: () => void;
  onRemove?: () => void;
}) {
  const t = useTranslations('spaces.view');
  const locale = useLocale();
  const { copy, copied } = useCopy({ successMessage: t('links.linkCopied') });
  const host = linkHost(link.url);
  const site = link.site_name && link.site_name.toLowerCase() !== host.toLowerCase() ? link.site_name : host;
  const name = personName(link.created_by_name);
  const when = relativeTime(link.last_shared_at, locale);
  const pinLabel = link.pinned ? t('links.unpin') : t('links.pin');
  const action = (label: string, hint: string, onClick: () => void, icon: ReactNode, disabled?: boolean) => (
    <Hint label={hint} side="top">
      <Button variant="outline" size="icon-xs" aria-label={label} disabled={disabled} onClick={onClick}>
        {icon}
      </Button>
    </Hint>
  );
  return (
    <li className="group hover:bg-hover focus-within:bg-hover relative flex items-center gap-3 px-5 py-2">
      <FaviconAvatar value={link.url} size="xs" className="shrink-0" />
      <div className="flex min-w-0 flex-1 items-baseline gap-2">
        <a
          // A row another writer stored with a non-http(s) URL is shown, never linked.
          href={safeHttpUrl(link.url) ? link.url : undefined}
          target="_blank"
          rel="noopener noreferrer"
          title={link.url}
          className="focus-visible:after:ring-ring min-w-0 truncate text-sm font-medium outline-none after:absolute after:inset-0 focus-visible:after:ring-2 focus-visible:after:ring-inset"
        >
          {linkTitle(link)}
        </a>
        <span className="text-muted-foreground max-w-48 shrink-0 truncate text-xs">{site}</span>
      </div>
      <span className="text-muted-foreground shrink-0 text-xs tabular-nums group-focus-within:invisible group-hover:invisible pointer-coarse:hidden">
        {name ? `${name} · ${when}` : when}
      </span>
      <ButtonGroup className="absolute inset-y-0 right-5 z-10 my-auto hidden h-fit group-focus-within:flex group-hover:flex pointer-coarse:static pointer-coarse:flex">
        {action(
          pinLabel,
          link.pinned ? t('links.unpinHint') : t('links.pinHint'),
          onPin,
          link.pinned ? <PushPinSlashIcon className="size-3.5 shrink-0" /> : <PushPinIcon className="size-3.5 shrink-0" />,
          busy,
        )}
        {action(
          t('links.copyLink'),
          copied ? t('links.linkCopied') : t('links.copyLink'),
          () => void copy(link.url),
          copied ? <SolidCheckIcon className="size-3.5 shrink-0" /> : <Copy className="size-3.5 shrink-0" />,
        )}
        {onOpenThread
          ? action(t('links.openThread'), t('links.openThread'), onOpenThread, <ChatTeardropTextIcon className="size-3.5 shrink-0" />)
          : null}
        {onRemove
          ? action(
              t('links.remove'),
              t('links.remove'),
              onRemove,
              <TrashIcon className="size-3.5 shrink-0" />,
            )
          : null}
      </ButtonGroup>
    </li>
  );
}

function AddLinkModal({
  projectId,
  space,
  place,
  open,
  onOpenChange,
}: {
  projectId: string;
  space: ProjectSpace;
  place: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations('spaces.view');
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const id = useId();
  const add = useAddProjectSpaceLink(projectId, space.space_id);
  const [url, setUrl] = useState('');
  const [title, setTitle] = useState('');
  const [error, setError] = useState<'invalid' | 'limit' | 'failed' | null>(null);

  const close = () => {
    if (add.isPending) return;
    setUrl('');
    setTitle('');
    setError(null);
    onOpenChange(false);
  };

  const submit = () => {
    if (add.isPending) return;
    const trimmed = withScheme(url.trim());
    if (!isWebUrl(trimmed)) return setError('invalid');
    add.mutate(
      { url: trimmed, ...(title.trim() ? { title: title.trim() } : {}) },
      {
        onSuccess: () => {
          successToast(t('links.added'));
          setUrl('');
          setTitle('');
          setError(null);
          onOpenChange(false);
        },
        onError: (err) => setError(err instanceof ApiError && err.code === 'link_limit' ? 'limit' : 'failed'),
      },
    );
  };

  return (
    <Modal open={open} onOpenChange={(next) => !next && close()}>
      <ModalContent className="lg:max-w-md">
        <ModalHeader>
          <ModalTitle>{t('links.add')}</ModalTitle>
          <ModalDescription>{t('links.addDescription', { place })}</ModalDescription>
        </ModalHeader>
        <form
          // The URL check below says what is wrong, in the viewer's language.
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <ModalBody>
            <FieldGroup className="gap-5">
              <Field className="gap-1.5">
                <FieldLabel htmlFor={`${id}-url`}>{t('links.urlLabel')}</FieldLabel>
                <Input
                  id={`${id}-url`}
                  type="url"
                  inputMode="url"
                  autoComplete="off"
                  spellCheck={false}
                  autoFocus
                  value={url}
                  maxLength={URL_MAX}
                  placeholder="https://"
                  aria-invalid={error === 'invalid' ? true : undefined}
                  aria-describedby={`${id}-url-hint`}
                  onChange={(event) => {
                    setUrl(event.target.value);
                    if (error) setError(null);
                  }}
                />
                <FieldDescription id={`${id}-url-hint`} className="text-destructive">
                  <span aria-live="polite">
                    {error === 'invalid'
                      ? t('links.invalidUrl')
                      : error === 'limit'
                        ? t('links.addLimit')
                        : error === 'failed'
                          ? t('links.addFailed')
                          : null}
                  </span>
                </FieldDescription>
              </Field>
              <Field className="gap-1.5">
                <FieldLabel htmlFor={`${id}-title`}>{t('links.titleLabel')}</FieldLabel>
                <Input
                  id={`${id}-title`}
                  autoComplete="off"
                  value={title}
                  maxLength={TITLE_MAX}
                  placeholder={t('links.titlePlaceholder')}
                  onChange={(event) => setTitle(event.target.value)}
                />
              </Field>
            </FieldGroup>
          </ModalBody>
          <ModalFooter className="sm:justify-between">
            <Button type="button" variant="outline-ghost" onClick={close} disabled={add.isPending}>
              {tI18nComplete.raw('text19766ed6ccb2')}
            </Button>
            <Button type="submit" disabled={add.isPending} aria-busy={add.isPending || undefined}>
              {add.isPending ? <Loading className="size-4 shrink-0" /> : null}
              {t('links.add')}
            </Button>
          </ModalFooter>
        </form>
      </ModalContent>
    </Modal>
  );
}
