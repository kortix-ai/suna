'use client';

import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalDescription,
  ModalFooter,
  ModalHeader,
  ModalTitle,
} from '@/components/ui/modal';
import { useTranslations } from '@/i18n/use-translations';
import { useId, useState } from 'react';

export type DriveCreateKind = 'folder' | 'file';

/**
 * "New folder" / "New file" in a modal. The name is checked as it is typed
 * (a slash, a name already in this folder), so a submit can only succeed: the
 * dialog closes at once and the row appears in the listing before the server
 * answers.
 */
export function DriveCreateDialog({
  kind,
  folderLabel,
  isTaken,
  onCreate,
  onClose,
}: {
  /** `null` closes the dialog. */
  kind: DriveCreateKind | null;
  /** Where the new entry lands, for the description line. */
  folderLabel: string;
  isTaken: (name: string) => boolean;
  onCreate: (kind: DriveCreateKind, name: string) => void;
  onClose: () => void;
}) {
  const t = useTranslations('drives');
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const id = useId();
  const [name, setName] = useState('');
  // The last kind keeps the title through the exit animation.
  const [shownKind, setShownKind] = useState<DriveCreateKind>('folder');
  if (kind && kind !== shownKind) setShownKind(kind);
  const close = () => {
    setName('');
    onClose();
  };

  const trimmed = name.trim();
  const error = trimmed.includes('/')
    ? t('invalidName')
    : trimmed && isTaken(trimmed)
      ? t('nameTaken', { name: trimmed })
      : null;
  const canSubmit = !!trimmed && !error;

  return (
    <Modal open={kind !== null} onOpenChange={(open) => !open && close()}>
      <ModalContent className="lg:max-w-sm">
        <ModalHeader>
          <ModalTitle>{shownKind === 'folder' ? t('newFolder') : t('newFile')}</ModalTitle>
          <ModalDescription>{t('createIn', { folder: folderLabel })}</ModalDescription>
        </ModalHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!canSubmit || !kind) return;
            onCreate(kind, trimmed);
            close();
          }}
        >
          <ModalBody>
            <Field>
              <FieldLabel htmlFor={`${id}-name`}>
                {shownKind === 'folder' ? t('folderNameLabel') : t('fileNameLabel')}
              </FieldLabel>
              <Input
                id={`${id}-name`}
                autoComplete="off"
                spellCheck={false}
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder={
                  shownKind === 'folder' ? t('untitledFolder') : t('untitledFile')
                }
                aria-invalid={error ? true : undefined}
                autoFocus
              />
              {error ? (
                <FieldDescription className="text-destructive" role="alert">
                  {error}
                </FieldDescription>
              ) : null}
            </Field>
          </ModalBody>
          <ModalFooter>
            <Button type="button" variant="outline-ghost" onClick={close}>
              {tI18nComplete.raw('text19766ed6ccb2')}
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              {t('create')}
            </Button>
          </ModalFooter>
        </form>
      </ModalContent>
    </Modal>
  );
}
