'use client';

import { ApiError, type ProjectSpace, type ProjectSpaceLink } from '@kortix/sdk';
import {
  useAddProjectSpaceLink,
  usePinProjectSpaceLink,
  useProjectSpaceLinks,
  useRemoveProjectSpaceLink,
} from '@kortix/sdk/react';
import { PushPinIcon, TrashIcon } from '@phosphor-icons/react';
import { Fragment, useId, useMemo, useState } from 'react';

import { useLocale, useTranslations } from '../../i18n';
import { relativeTime } from '../../internal/lib/relative-time';
import { cn } from '../../internal/lib/utils';
import { Button } from '../../primitives/button';
import { ConfirmDialog } from '../../primitives/confirm-dialog';
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
import { errorToast, successToast } from '../../primitives/toast';
import { sessionDisplayLabel } from '../../session/actions/session-label';
import { participantLabel } from '../../session/participants/session-participants';
import { linkHost, linkTitle } from './space-link-label';
import { dayKind } from './space-timeline';
import { useSpaceThreads } from './space-timeline-view';

/** The API's limits: an http(s) URL of at most 2,048 characters, a title of at most 200. */
const URL_MAX = 2048;
const TITLE_MAX = 200;

function isHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

/** Unpinning a link no thread shared ("Add link" only) removes it. */
function unpinRemoves(link: ProjectSpaceLink): boolean {
  return link.source === 'manual' && link.session_id === null;
}

const personName = (name: string | null) => (name ? participantLabel({ name, email: null }) : '');

type SharedDay = { key: string; label: string; links: ProjectSpaceLink[] };

/**
 * A channel's Links tab: "Pinned · agents read these" (added with "Add link",
 * or shared and pinned by a member), then "Shared in threads" (collected from
 * people's messages), by day. Pin and Unpin move a link between the two.
 */
export function SpaceLinks({ projectId, space, place }: { projectId: string; space: ProjectSpace; place: string }) {
  const t = useTranslations('spaces.view');
  const locale = useLocale();
  const links = useProjectSpaceLinks(projectId, space.space_id);
  // The space view already reads these; the thread titles come from that cache.
  const threads = useSpaceThreads(projectId, space.space_id);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<ProjectSpaceLink | null>(null);
  const remove = useRemoveProjectSpaceLink(projectId, space.space_id);
  const pin = usePinProjectSpaceLink(projectId, space.space_id);

  const threadTitles = useMemo(() => {
    const titles = new Map<string, string>();
    for (const session of threads.sessions) titles.set(session.session_id, sessionDisplayLabel(session));
    return titles;
  }, [threads.sessions]);

  const { pinned, shared } = useMemo(() => {
    const all = links.data ?? [];
    const pinnedLinks = all
      .filter((link) => link.pinned)
      .sort((a, b) => Date.parse(b.pinned_at ?? b.created_at) - Date.parse(a.pinned_at ?? a.created_at));
    const now = new Date();
    const days: SharedDay[] = [];
    for (const link of all) {
      if (link.pinned) continue;
      const date = new Date(link.last_shared_at);
      const kind = dayKind(date, now);
      const key = kind === 'earlier' ? date.toDateString() : kind;
      let day = days.find((d) => d.key === key);
      if (!day) {
        const label =
          kind === 'today'
            ? t('today')
            : kind === 'yesterday'
              ? t('yesterday')
              : date.toLocaleDateString(locale, { weekday: 'long', month: 'long', day: 'numeric' });
        day = { key, label, links: [] };
        days.push(day);
      }
      day.links.push(link);
    }
    return { pinned: pinnedLinks, shared: days };
  }, [links.data, locale, t]);

  const setPinned = (link: ProjectSpaceLink, next: boolean) => {
    pin.mutate(
      { linkId: link.link_id, pinned: next },
      {
        onSuccess: (result) =>
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

  const addButton = (
    <Button variant="secondary" size="sm" className="shrink-0" onClick={() => setAdding(true)}>
      {t('links.add')}
    </Button>
  );

  let body;
  if (links.isError && !links.data) {
    body = (
      <ErrorState
        size="sm"
        title={t('links.loadError')}
        action={
          <Button variant="outline" size="sm" onClick={() => links.refetch()}>
            {t('retry')}
          </Button>
        }
      />
    );
  } else if (!links.data) {
    body = null;
  } else if (links.data.length === 0) {
    body = (
      <EmptyState
        size="sm"
        title={t('empty.links.title')}
        description={t('empty.links.description', { place })}
        action={addButton}
      />
    );
  } else {
    const rowProps = { threadTitles, busy: pin.isPending };
    body = (
      <div className="flex max-w-4xl flex-col gap-8">
        <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
          <p className="text-muted-foreground text-sm">{t('links.intro', { place })}</p>
          {addButton}
        </header>
        {pinned.length > 0 ? (
          <section aria-label={t('links.pinnedTitle')} className="flex flex-col gap-1">
            <h3 className="text-muted-foreground flex items-center gap-1.5 pb-1.5 text-xs font-medium">
              <PushPinIcon aria-hidden className="size-3.5" />
              {t('links.pinnedTitle')}
            </h3>
            <ul className="flex flex-col gap-1">
              {pinned.map((link) => (
                <LinkRow
                  key={link.link_id}
                  link={link}
                  {...rowProps}
                  onPin={() => (unpinRemoves(link) ? setRemoving(link) : setPinned(link, false))}
                />
              ))}
            </ul>
          </section>
        ) : null}
        {shared.length > 0 ? (
          <section aria-label={t('links.sharedTitle')} className="flex flex-col">
            <div className="flex items-center justify-between gap-3 pb-1.5">
              <h3 className="text-muted-foreground text-xs font-medium">{t('links.sharedTitle')}</h3>
              <p className="text-muted-foreground text-xs max-sm:hidden">{t('links.sharedNote')}</p>
            </div>
            {shared.map((day, index) => (
              <div key={day.key}>
                <p className={cn('text-muted-foreground px-3 pb-1 text-xs', index === 0 ? 'pt-2.5' : 'pt-3.5')}>
                  {day.label}
                </p>
                <ul className="flex flex-col">
                  {day.links.map((link) => (
                    <LinkRow
                      key={link.link_id}
                      link={link}
                      {...rowProps}
                      onPin={() => setPinned(link, true)}
                      onRemove={link.can_delete ? () => setRemoving(link) : undefined}
                    />
                  ))}
                </ul>
              </div>
            ))}
          </section>
        ) : null}
      </div>
    );
  }

  return (
    <div className={links.data?.length ? 'p-6' : 'px-5 py-16'}>
      {body}
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
 * One link: a tile with the site's first letter, the title over the host, who
 * shared or pinned it, and Pin / Unpin. The columns have fixed widths, so the
 * rows line up. A shared row shows Pin on hover (always without hover).
 */
function LinkRow({
  link,
  threadTitles,
  busy,
  onPin,
  onRemove,
}: {
  link: ProjectSpaceLink;
  threadTitles: Map<string, string>;
  busy: boolean;
  onPin: () => void;
  onRemove?: () => void;
}) {
  const t = useTranslations('spaces.view');
  const locale = useLocale();
  const host = linkHost(link.url);
  const thread = link.session_id ? threadTitles.get(link.session_id) : undefined;
  // Who and when, joined by " · ". Only the thread part may truncate.
  const threadPart = thread ? t(link.pinned ? 'links.fromThread' : 'links.inThread', { thread }) : '';
  let meta: string[];
  if (link.pinned) {
    const name = personName(link.pinned_by_name);
    const when =
      threadPart ||
      new Date(link.pinned_at ?? link.created_at).toLocaleDateString(locale, { month: 'short', day: 'numeric' });
    meta = [name ? t('links.pinnedBy', { name }) : t('links.pinnedLabel'), when];
  } else {
    meta = [
      personName(link.created_by_name),
      threadPart,
      link.share_count > 1
        ? t('links.sharedTimes', { count: link.share_count })
        : relativeTime(link.last_shared_at, locale),
    ].filter(Boolean);
  }
  // Pinned rows sit on a lifted fill; shared rows lift on hover.
  const reveal =
    'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 pointer-coarse:opacity-100 [@media(hover:none)]:opacity-100';
  return (
    <li
      className={cn(
        'group relative flex items-center gap-3 rounded-md px-3 py-2',
        link.pinned ? 'bg-card' : 'hover:bg-hover',
      )}
    >
      <span
        aria-hidden
        className="bg-muted text-muted-foreground flex size-6 shrink-0 items-center justify-center rounded-sm text-xs font-medium"
      >
        {host.charAt(0).toUpperCase()}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <a
          // A row another writer stored with a non-http(s) URL is shown, never linked.
          href={isHttpUrl(link.url) ? link.url : undefined}
          target="_blank"
          rel="noopener noreferrer"
          title={link.url}
          className="focus-visible:ring-ring block truncate text-sm font-medium outline-none after:absolute after:inset-0 after:rounded-md focus-visible:ring-2"
        >
          {linkTitle(link)}
        </a>
        <p className="text-muted-foreground truncate text-xs">{host}</p>
      </div>
      {/* A long thread title truncates; the name and the time stay whole. */}
      <p className="text-muted-foreground flex w-72 shrink-0 text-xs whitespace-pre max-sm:hidden">
        {meta.map((part, i) => (
          <Fragment key={i}>
            {i > 0 ? <span className="shrink-0">{' · '}</span> : null}
            <span className={part === threadPart ? 'min-w-0 truncate' : 'shrink-0'}>{part}</span>
          </Fragment>
        ))}
      </p>
      <div className="relative z-10 flex w-20 shrink-0 items-center justify-end gap-1">
        {link.pinned ? (
          link.can_delete || !unpinRemoves(link) ? (
            <Button variant="ghost" size="xs" className="text-muted-foreground" disabled={busy} onClick={onPin}>
              {t('links.unpin')}
            </Button>
          ) : null
        ) : (
          <>
            {onRemove ? (
              <Hint label={t('links.remove')}>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={t('links.remove')}
                  onClick={onRemove}
                  className={reveal}
                >
                  <TrashIcon aria-hidden />
                </Button>
              </Hint>
            ) : null}
            <Button variant="secondary" size="xs" disabled={busy} onClick={onPin} className={reveal}>
              {t('links.pin')}
            </Button>
          </>
        )}
      </div>
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
    const trimmed = url.trim();
    if (!isHttpUrl(trimmed)) return setError('invalid');
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
                        ? t('links.limit')
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
