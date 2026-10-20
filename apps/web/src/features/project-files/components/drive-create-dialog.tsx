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
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { useTranslations } from '@/i18n/use-translations';
import { cn } from '@/lib/utils';
import { CaretRightIcon } from '@phosphor-icons/react';
import { Fragment, type ReactNode, useId, useState } from 'react';

export type DriveCreateKind = 'folder' | 'file';

/** Who can open a new team folder: the three choices of the access dialog. */
export type FolderAudienceMode = 'everyone' | 'restricted' | 'specific';

/** Where the new entry lands: the drive's glyph, then drive › folder › folder. */
export interface DriveLocation {
  icon?: ReactNode;
  crumbs: string[];
}

/**
 * "New folder" / "New file" in a modal. The name is checked as it is typed
 * (a slash, a name already in this folder), so a submit can only succeed: the
 * dialog closes at once and the row appears in the listing before the server
 * answers. A top-level Drive folder (a team folder) also asks who can open
 * it, so it is never admins-only by accident.
 */
export function DriveCreateDialog({
  kind,
  location,
  isTaken,
  askAudience = false,
  onCreate,
  onClose,
}: {
  /** `null` closes the dialog. */
  kind: DriveCreateKind | null;
  location: DriveLocation;
  isTaken: (name: string) => boolean;
  /** Ask who can open the new folder (a Drive team folder). */
  askAudience?: boolean;
  onCreate: (kind: DriveCreateKind, name: string, audience?: FolderAudienceMode) => void;
  onClose: () => void;
}) {
  const t = useTranslations('drives');
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const id = useId();
  const [name, setName] = useState('');
  const [audience, setAudience] = useState<FolderAudienceMode>('everyone');
  // The last kind keeps the title through the exit animation.
  const [shownKind, setShownKind] = useState<DriveCreateKind>('folder');
  if (kind && kind !== shownKind) setShownKind(kind);
  const close = () => {
    setName('');
    setAudience('everyone');
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
      <ModalContent className={askAudience ? 'lg:max-w-md' : 'lg:max-w-sm'}>
        <ModalHeader>
          <ModalTitle>
            {shownKind === 'file'
              ? t('newFile')
              : askAudience
                ? t('newTeamFolder')
                : t('newFolder')}
          </ModalTitle>
          <ModalDescription className="flex min-w-0 flex-wrap items-center gap-1 [&_svg]:size-3.5 [&_svg]:shrink-0">
            {location.icon}
            {/* Every folder, so the path reads in full; a long one wraps. */}
            {location.crumbs.map((crumb, i, all) => (
              <Fragment key={`${i}-${crumb}`}>
                {i > 0 ? <CaretRightIcon className="text-muted-foreground" /> : null}
                <span
                  className={cn('break-all', i === all.length - 1 && 'text-foreground font-medium')}
                >
                  {crumb}
                </span>
              </Fragment>
            ))}
          </ModalDescription>
        </ModalHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!canSubmit || !kind) return;
            onCreate(kind, trimmed, askAudience && kind === 'folder' ? audience : undefined);
            close();
          }}
        >
          <ModalBody>
            <Field>
              {/* The title already says what the field is; the label stays for screen readers. */}
              <FieldLabel htmlFor={`${id}-name`} className="sr-only">
                {shownKind === 'folder' ? t('folderNameLabel') : t('fileNameLabel')}
              </FieldLabel>
              <Input
                id={`${id}-name`}
                autoComplete="off"
                spellCheck={false}
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder={shownKind === 'folder' ? t('untitledFolder') : t('untitledFile')}
                aria-invalid={error ? true : undefined}
                autoFocus
              />
              {error ? (
                <FieldDescription className="text-destructive" role="alert">
                  {error}
                </FieldDescription>
              ) : null}
            </Field>
            {askAudience && shownKind === 'folder' ? (
              <Field className="mt-4 gap-1.5">
                <FieldLabel>{t('audienceQuestion')}</FieldLabel>
                <RadioGroup
                  value={audience}
                  onValueChange={(mode) => setAudience(mode as FolderAudienceMode)}
                  className="space-y-2"
                >
                  <RadioGroupItem
                    value="everyone"
                    id={`${id}-everyone`}
                    label={t('everyoneInProject')}
                    description={t('audienceEveryoneDescription')}
                    size="lg"
                    variant="outline"
                  />
                  <RadioGroupItem
                    value="restricted"
                    id={`${id}-restricted`}
                    label={t('audienceAdmins')}
                    description={t('audienceAdminsDescription')}
                    size="lg"
                    variant="outline"
                  />
                  <RadioGroupItem
                    value="specific"
                    id={`${id}-specific`}
                    label={t('audienceSpecific')}
                    description={t('audienceSpecificDescription')}
                    size="lg"
                    variant="outline"
                  />
                </RadioGroup>
              </Field>
            ) : null}
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
