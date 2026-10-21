'use client';

import { ApiError, type ProjectSpace, type ProjectSpaceLink } from '@kortix/sdk';
import { useAddProjectSpaceLink, useProjectSpaceLinks, useRemoveProjectSpaceLink } from '@kortix/sdk/react';
import { PlusIcon, TrashIcon } from '@phosphor-icons/react';
import { useId, useState } from 'react';

import { useLocale, useTranslations } from '../../i18n';
import { relativeTime } from '../../internal/lib/relative-time';
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
import { participantLabel } from '../../session/participants/session-participants';

/** The API's limits: an http(s) URL of at most 2,048 characters, a title of at most 200. */
const URL_MAX = 2048;
const TITLE_MAX = 200;

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function isHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

/** A channel's Links tab: the pinned links, newest first, and "Add link". */
export function SpaceLinks({ projectId, space, place }: { projectId: string; space: ProjectSpace; place: string }) {
  const t = useTranslations('spaces.view');
  const links = useProjectSpaceLinks(projectId, space.space_id);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<ProjectSpaceLink | null>(null);
  const remove = useRemoveProjectSpaceLink(projectId, space.space_id);

  const addButton = (
    <Button variant="outline" size="sm" onClick={() => setAdding(true)}>
      <PlusIcon aria-hidden />
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
    body = (
      <div className="flex flex-col gap-3">
        <div className="flex justify-end">{addButton}</div>
        <ul className="flex flex-col">
          {links.data.map((link) => (
            <LinkRow key={link.link_id} link={link} onRemove={() => setRemoving(link)} />
          ))}
        </ul>
      </div>
    );
  }

  return (
    <div className={links.data?.length ? 'px-5 py-4' : 'px-5 py-16'}>
      {body}
      <AddLinkModal projectId={projectId} space={space} place={place} open={adding} onOpenChange={setAdding} />
      <ConfirmDialog
        open={!!removing}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={t('links.removeTitle')}
        description={t('links.removeDescription', {
          link: removing ? removing.title || hostnameOf(removing.url) : '',
          place,
        })}
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

function LinkRow({ link, onRemove }: { link: ProjectSpaceLink; onRemove: () => void }) {
  const t = useTranslations('spaces.view');
  const locale = useLocale();
  const name = link.created_by_name ? participantLabel({ name: link.created_by_name, email: null }) : '';
  const time = relativeTime(link.created_at, locale);
  return (
    <li className="group hover:bg-hover relative -mx-2 flex items-center gap-3 rounded-md px-2 py-2">
      <div className="min-w-0 flex-1">
        <a
          // A row another writer stored with a non-http(s) URL is shown, never linked.
          href={isHttpUrl(link.url) ? link.url : undefined}
          target="_blank"
          rel="noopener noreferrer"
          className="focus-visible:ring-ring block truncate text-sm font-medium outline-none after:absolute after:inset-0 after:rounded-md focus-visible:ring-2"
        >
          {link.title || hostnameOf(link.url)}
        </a>
        <p className="text-muted-foreground truncate text-xs">{link.url}</p>
      </div>
      <span className="text-muted-foreground shrink-0 text-xs">
        {name ? t('links.addedBy', { name, time }) : time}
      </span>
      {link.can_delete ? (
        <Hint label={t('links.remove')}>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t('links.remove')}
            onClick={onRemove}
            // Above the row's stretched link; shown on hover, keyboard focus, or always without hover (touch).
            className="relative z-10 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100 [@media(hover:none)]:opacity-100"
          >
            <TrashIcon aria-hidden />
          </Button>
        </Hint>
      ) : null}
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
