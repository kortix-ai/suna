'use client';

import { ApiError, type ProjectSpace } from '@kortix/sdk';
import { useCreateProjectSpace, usePrivateChannelsAvailable, useUpdateProjectSpace } from '@kortix/sdk/react';
import { spaceSlug } from '@kortix/shared';
import { LockSimpleIcon } from '@phosphor-icons/react';
import { useId, useState, type ReactNode } from 'react';

import { useTranslations } from '../../i18n';
import { uiRoutes } from '../../lib/routes';
import { Button } from '../../primitives/button';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '../../primitives/field';
import { Input } from '../../primitives/input';
import { Switch } from '../../primitives/switch';
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
import { useOptionalSidebar } from '../../primitives/sidebar';
import { successToast } from '../../primitives/toast';
import { UiLink as Link, useUiRouter } from '../../providers/ui-provider';

/** The API accepts up to 80; the slug keeps the first 40 slug characters. */
const NAME_MAX = 80;
const DESCRIPTION_MAX = 160;

/**
 * Which inline error the name field shows. `taken` carries the slug the server
 * refused and, for an archived channel, its id and whether the caller may edit
 * it (the link offers to unarchive, or says who may).
 */
type NameError =
  | { kind: 'empty' }
  | { kind: 'invalid' }
  | { kind: 'taken'; slug: string; archivedId: string | null; canEdit: boolean }
  | { kind: 'unavailable' }
  | { kind: 'failed' };

/**
 * "Create a channel": a name with a live `#slug` preview, an optional
 * description and "Private" (only the people added to it see it), shown
 * only where the spaces list says `private_channels_available`. Every error stays in the dialog (the SDK call does not toast).
 * On success the dialog closes and the new channel opens.
 *
 * With `space` it renames that channel instead: the same fields, filled in,
 * and the page follows the new slug.
 */
export function CreateChannelDialog({
  projectId,
  open,
  onOpenChange,
  space,
}: {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  space?: ProjectSpace;
}) {
  const t = useTranslations('spaces.create');
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const id = useId();
  const router = useUiRouter();
  const sidebar = useOptionalSidebar();
  const create = useCreateProjectSpace(projectId);
  const update = useUpdateProjectSpace(projectId);
  const pending = create.isPending || update.isPending;
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [isPrivate, setIsPrivate] = useState(false);
  // "Private" shows only where the server allows it.
  const privateAvailable = usePrivateChannelsAvailable(projectId).data === true;
  const [error, setError] = useState<NameError | null>(null);

  // A rename opens on the channel's current name and description (set while
  // rendering, the moment it opens, so the first frame already shows them).
  const fillFor = open && space ? space.space_id : null;
  const [filledFor, setFilledFor] = useState<string | null>(null);
  if (fillFor !== filledFor) {
    setFilledFor(fillFor);
    if (space && fillFor) {
      setName(space.name);
      setDescription(space.description ?? '');
    }
  }

  const slug = spaceSlug(name);
  // A manager outside a private channel renames it and nothing else (D1), from the private-channel list.
  const nameOnly = space?.visibility === 'private' && space.is_member === false;

  const close = () => {
    if (pending) return;
    setName('');
    setDescription('');
    setIsPrivate(false);
    setError(null);
    onOpenChange(false);
  };

  const onError = (err: Error) => {
    if (err instanceof ApiError && err.status === 409 && err.code === 'slug_taken') {
      const archivedId = err.data?.archived === true && typeof err.data.space_id === 'string' ? err.data.space_id : null;
      setError({ kind: 'taken', slug, archivedId, canEdit: err.data?.can_edit !== false });
    } else if (err instanceof ApiError && err.status === 400 && err.code === 'invalid_name') {
      setError({ kind: 'invalid' });
    } else if (err instanceof ApiError && err.status === 409 && err.code === 'private_channels_unavailable') {
      setError({ kind: 'unavailable' });
    } else {
      setError({ kind: 'failed' });
    }
  };

  const submit = () => {
    if (pending) return;
    if (!name.trim()) return setError({ kind: 'empty' });
    if (!slug) return setError({ kind: 'invalid' });
    const done = (saved: ProjectSpace) => {
      setName('');
      setDescription('');
      setIsPrivate(false);
      setError(null);
      onOpenChange(false);
      const href = uiRoutes().channel(projectId, saved.slug ?? slug);
      if (space) {
        successToast(t('renamed'));
        if (saved.slug !== space.slug && !nameOnly) router.replace(href);
        return;
      }
      successToast(t('created'));
      // On a phone the dialog opens from the sidebar sheet: close it so the channel shows.
      sidebar?.setOpenMobile(false);
      router.push(href);
    };
    if (space) {
      update.mutate(
        {
          spaceId: space.space_id,
          input: {
            name: name.trim(),
            // Only a changed description is sent.
            ...(description.trim() !== (space.description ?? '') ? { description: description.trim() || null } : {}),
          },
        },
        { onSuccess: done, onError },
      );
      return;
    }
    create.mutate(
      {
        name: name.trim(),
        ...(description.trim() ? { description: description.trim() } : {}),
        ...(isPrivate ? { visibility: 'private' as const } : {}),
      },
      { onSuccess: done, onError },
    );
  };

  let errorText: ReactNode = null;
  if (error?.kind === 'empty') errorText = t('nameRequired');
  else if (error?.kind === 'invalid') errorText = t('invalidName');
  else if (error?.kind === 'failed') errorText = t(space ? 'renameFailed' : 'failed');
  else if (error?.kind === 'unavailable') errorText = t('privateUnavailable');
  else if (error?.kind === 'taken') {
    const { slug: takenSlug, archivedId, canEdit } = error;
    // An archived channel's page offers Unarchive when it knows the channel's id
    // and the caller may edit the channel; otherwise it says who may.
    const takenHref = uiRoutes().channel(projectId, takenSlug);
    const archivedQuery = archivedId ? `?archived=${encodeURIComponent(archivedId)}${canEdit ? '' : '&locked=1'}` : '';
    errorText = t.rich('slugTaken', {
      slug: takenSlug,
      link: (chunks) => (
        <Link
          href={`${takenHref}${archivedQuery}`}
          onClick={close}
          className="text-foreground underline underline-offset-4"
        >
          {chunks}
        </Link>
      ),
    });
  }

  return (
    <Modal open={open} onOpenChange={(next) => !next && close()}>
      <ModalContent className="lg:max-w-md">
        <ModalHeader>
          <ModalTitle>{t(space ? 'renameTitle' : 'title')}</ModalTitle>
          <ModalDescription>{t(space ? 'renameDescription' : isPrivate ? 'descriptionPrivate' : 'description')}</ModalDescription>
        </ModalHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <ModalBody>
            <FieldGroup className="gap-5">
              <Field className="gap-1.5">
                <FieldLabel htmlFor={`${id}-name`}>{t('nameLabel')}</FieldLabel>
                <Input
                  id={`${id}-name`}
                  autoComplete="off"
                  spellCheck={false}
                  autoFocus
                  value={name}
                  maxLength={NAME_MAX}
                  placeholder={t('namePlaceholder')}
                  // A network failure, or private channels being off, is not the name's fault.
                  aria-invalid={error && error.kind !== 'failed' && error.kind !== 'unavailable' ? true : undefined}
                  aria-describedby={`${id}-name-hint`}
                  onChange={(event) => {
                    setName(event.target.value);
                    if (error) setError(null);
                  }}
                />
                <FieldDescription id={`${id}-name-hint`} className={error ? 'text-destructive' : 'font-mono'}>
                  {/* Always mounted, so a screen reader hears each error; the preview is not announced. */}
                  <span aria-live="polite">{errorText}</span>
                  {errorText ? null : `#${slug || t('slugPlaceholder')}`}
                </FieldDescription>
              </Field>
              {nameOnly ? null : <Field className="gap-1.5">
                <FieldLabel htmlFor={`${id}-description`}>{t('descriptionLabel')}</FieldLabel>
                <Input
                  id={`${id}-description`}
                  autoComplete="off"
                  value={description}
                  maxLength={DESCRIPTION_MAX}
                  placeholder={t('descriptionPlaceholder')}
                  onChange={(event) => setDescription(event.target.value)}
                />
              </Field>}
              {space || !privateAvailable ? null : (
                <Field orientation="horizontal" className="items-start justify-between gap-4">
                  <div className="min-w-0 space-y-0.5">
                    <FieldLabel htmlFor={`${id}-private`} className="flex items-center gap-1.5">
                      <LockSimpleIcon className="size-3.5 shrink-0" />
                      {t('privateLabel')}
                    </FieldLabel>
                    <FieldDescription id={`${id}-private-hint`}>
                      {t('privateHint')} {t('privateLimits')}
                    </FieldDescription>
                  </div>
                  <Switch
                    id={`${id}-private`}
                    checked={isPrivate}
                    aria-describedby={`${id}-private-hint`}
                    onCheckedChange={(next) => {
                      setIsPrivate(next);
                      if (error?.kind === 'unavailable') setError(null);
                    }}
                    disabled={pending}
                    className="mt-0.5 shrink-0"
                  />
                </Field>
              )}
            </FieldGroup>
          </ModalBody>
          <ModalFooter className="sm:justify-between">
            <Button
              type="button"
              variant="outline-ghost"
              onClick={close}
              disabled={pending}
            >
              {tI18nComplete.raw('text19766ed6ccb2')}
            </Button>
            <Button type="submit" disabled={pending} aria-busy={pending || undefined}>
              {pending ? <Loading className="size-4 shrink-0" /> : null}
              {t(space ? 'save' : 'submit')}
            </Button>
          </ModalFooter>
        </form>
      </ModalContent>
    </Modal>
  );
}
