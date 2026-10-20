'use client';

import { ApiError, type ProjectSpace } from '@kortix/sdk';
import { useCreateProjectSpace, useUpdateProjectSpace } from '@kortix/sdk/react';
import { spaceSlug } from '@kortix/shared';
import { useId, useState, type ReactNode } from 'react';

import { useTranslations } from '../../i18n';
import { uiRoutes } from '../../lib/routes';
import { Button } from '../../primitives/button';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '../../primitives/field';
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
import { useOptionalSidebar } from '../../primitives/sidebar';
import { successToast } from '../../primitives/toast';
import { UiLink as Link, useUiRouter } from '../../providers/ui-provider';

/** The API accepts up to 80; the slug keeps the first 40 slug characters. */
const NAME_MAX = 80;
const DESCRIPTION_MAX = 160;

/**
 * Which inline error the name field shows. `taken` carries the slug the server
 * refused and, for an archived channel, its id (the link offers to unarchive).
 */
type NameError =
  | { kind: 'empty' }
  | { kind: 'invalid' }
  | { kind: 'taken'; slug: string; archivedId: string | null }
  | { kind: 'failed' };

/**
 * "Create a channel": a name with a live `#slug` preview and an optional
 * description. Every error stays in the dialog (the SDK call does not toast).
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

  const close = () => {
    if (pending) return;
    setName('');
    setDescription('');
    setError(null);
    onOpenChange(false);
  };

  const onError = (err: Error) => {
    if (err instanceof ApiError && err.status === 409 && err.code === 'slug_taken') {
      const archivedId = err.data?.archived === true && typeof err.data.space_id === 'string' ? err.data.space_id : null;
      setError({ kind: 'taken', slug, archivedId });
    } else if (err instanceof ApiError && err.status === 400 && err.code === 'invalid_name') {
      setError({ kind: 'invalid' });
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
      setError(null);
      onOpenChange(false);
      const href = uiRoutes().channel(projectId, saved.slug ?? slug);
      if (space) {
        successToast(t('renamed'));
        if (saved.slug !== space.slug) router.replace(href);
        return;
      }
      successToast(t('created'));
      // On a phone the dialog opens from the sidebar sheet: close it so the channel shows.
      sidebar?.setOpenMobile(false);
      router.push(href);
    };
    if (space) {
      update.mutate(
        { spaceId: space.space_id, input: { name: name.trim(), description: description.trim() || null } },
        { onSuccess: done, onError },
      );
      return;
    }
    create.mutate(
      { name: name.trim(), ...(description.trim() ? { description: description.trim() } : {}) },
      { onSuccess: done, onError },
    );
  };

  let errorText: ReactNode = null;
  if (error?.kind === 'empty') errorText = t('nameRequired');
  else if (error?.kind === 'invalid') errorText = t('invalidName');
  else if (error?.kind === 'failed') errorText = t(space ? 'renameFailed' : 'failed');
  else if (error?.kind === 'taken') {
    const { slug: takenSlug, archivedId } = error;
    // An archived channel's page offers Unarchive when it knows the channel's id.
    const takenHref = uiRoutes().channel(projectId, takenSlug);
    errorText = t.rich('slugTaken', {
      slug: takenSlug,
      link: (chunks) => (
        <Link
          href={archivedId ? `${takenHref}?archived=${encodeURIComponent(archivedId)}` : takenHref}
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
          <ModalDescription>{t(space ? 'renameDescription' : 'description')}</ModalDescription>
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
                  // A network failure is not the name's fault.
                  aria-invalid={error && error.kind !== 'failed' ? true : undefined}
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
              <Field className="gap-1.5">
                <FieldLabel htmlFor={`${id}-description`}>{t('descriptionLabel')}</FieldLabel>
                <Input
                  id={`${id}-description`}
                  autoComplete="off"
                  value={description}
                  maxLength={DESCRIPTION_MAX}
                  placeholder={t('descriptionPlaceholder')}
                  onChange={(event) => setDescription(event.target.value)}
                />
              </Field>
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
