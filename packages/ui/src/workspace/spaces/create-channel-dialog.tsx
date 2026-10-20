'use client';

import { ApiError } from '@kortix/sdk';
import { useCreateProjectSpace } from '@kortix/sdk/react';
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
import { successToast } from '../../primitives/toast';
import { UiLink as Link, useUiRouter } from '../../providers/ui-provider';

/** The API accepts up to 80; the slug keeps the first 40 slug characters. */
const NAME_MAX = 80;
const DESCRIPTION_MAX = 160;

/** Which inline error the name field shows. `taken` carries the slug the server refused. */
type NameError = { kind: 'empty' } | { kind: 'invalid' } | { kind: 'taken'; slug: string } | { kind: 'failed' };

/**
 * "Create a channel": a name with a live `#slug` preview and an optional
 * description. Every error stays in the dialog (the SDK call does not toast).
 * On success the dialog closes and the new channel opens.
 */
export function CreateChannelDialog({
  projectId,
  open,
  onOpenChange,
}: {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations('spaces.create');
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const id = useId();
  const router = useUiRouter();
  const create = useCreateProjectSpace(projectId);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState<NameError | null>(null);

  const slug = spaceSlug(name);

  const close = () => {
    if (create.isPending) return;
    setName('');
    setDescription('');
    setError(null);
    onOpenChange(false);
  };

  const submit = () => {
    if (create.isPending) return;
    if (!name.trim()) return setError({ kind: 'empty' });
    if (!slug) return setError({ kind: 'invalid' });
    create.mutate(
      { name: name.trim(), ...(description.trim() ? { description: description.trim() } : {}) },
      {
        onSuccess: (space) => {
          setName('');
          setDescription('');
          setError(null);
          onOpenChange(false);
          successToast(t('created'));
          router.push(uiRoutes().channel(projectId, space.slug ?? slug));
        },
        onError: (err) => {
          if (err instanceof ApiError && err.status === 409 && err.code === 'slug_taken') {
            setError({ kind: 'taken', slug });
          } else if (err instanceof ApiError && err.status === 400 && err.code === 'invalid_name') {
            setError({ kind: 'invalid' });
          } else {
            setError({ kind: 'failed' });
          }
        },
      },
    );
  };

  let errorText: ReactNode = null;
  if (error?.kind === 'empty') errorText = t('nameRequired');
  else if (error?.kind === 'invalid') errorText = t('invalidName');
  else if (error?.kind === 'failed') errorText = t('failed');
  else if (error?.kind === 'taken') {
    const takenSlug = error.slug;
    errorText = t.rich('slugTaken', {
      slug: takenSlug,
      link: (chunks) => (
        <Link
          href={uiRoutes().channel(projectId, takenSlug)}
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
          <ModalTitle>{t('title')}</ModalTitle>
          <ModalDescription>{t('description')}</ModalDescription>
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
                  aria-invalid={error ? true : undefined}
                  aria-describedby={`${id}-name-hint`}
                  onChange={(event) => {
                    setName(event.target.value);
                    if (error) setError(null);
                  }}
                />
                <FieldDescription
                  id={`${id}-name-hint`}
                  className={error ? 'text-destructive' : 'font-mono'}
                  role={error ? 'alert' : undefined}
                >
                  {errorText ?? `#${slug || t('slugPlaceholder')}`}
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
              disabled={create.isPending}
            >
              {tI18nComplete.raw('text19766ed6ccb2')}
            </Button>
            <Button type="submit" disabled={create.isPending} aria-busy={create.isPending || undefined}>
              {create.isPending ? <Loading className="size-4 shrink-0" /> : null}
              {t('submit')}
            </Button>
          </ModalFooter>
        </form>
      </ModalContent>
    </Modal>
  );
}
