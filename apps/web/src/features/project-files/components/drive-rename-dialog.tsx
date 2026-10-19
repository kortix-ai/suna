'use client';

import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  ModalTitle,
} from '@/components/ui/modal';
import type { FileNode } from '@/features/file-browser/types';
import { useTranslations } from '@/i18n/use-translations';
import { createContext, useContext, useId, useRef, useState } from 'react';

/**
 * Asks the explorer to rename `node` in its modal. Every card and row starts
 * a rename through `useDriveRowInteractions().startRenaming`, which calls this
 * when it is provided; without it the card renames inline as before.
 */
export const DriveRenameContext = createContext<((node: FileNode) => void) | null>(null);

export function useRequestRename() {
  return useContext(DriveRenameContext);
}

/**
 * Rename in a modal: the current name, with the part before the extension
 * selected, checked as it is typed (empty, a slash, a name already here).
 */
export function DriveRenameDialog({
  node,
  isTaken,
  onRename,
  onClose,
}: {
  /** `null` closes the dialog. */
  node: FileNode | null;
  isTaken: (name: string) => boolean;
  onRename: (node: FileNode, newName: string) => void;
  onClose: () => void;
}) {
  const t = useTranslations('drives');
  const id = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState('');
  // The node the dialog was opened for keeps its text through the exit animation.
  const [shown, setShown] = useState<FileNode | null>(null);
  if (node && node !== shown) {
    setShown(node);
    setName(node.name);
  }

  const trimmed = name.trim();
  const unchanged = !!shown && trimmed === shown.name;
  const error = trimmed.includes('/')
    ? t('invalidName')
    : trimmed && !unchanged && trimmed.toLowerCase() !== shown?.name.toLowerCase() && isTaken(trimmed)
      ? t('nameTaken', { name: trimmed })
      : null;
  const canSubmit = !!trimmed && !unchanged && !error;

  return (
    <Modal open={node !== null} onOpenChange={(open) => !open && onClose()}>
      <ModalContent
        className="lg:max-w-sm"
        onOpenAutoFocus={(e) => {
          // Select the name without its extension, like a desktop file manager.
          e.preventDefault();
          const el = inputRef.current;
          if (!el) return;
          el.focus();
          const dot = node?.type === 'file' ? el.value.lastIndexOf('.') : -1;
          el.setSelectionRange(0, dot > 0 ? dot : el.value.length);
        }}
      >
        <ModalHeader>
          <ModalTitle>{t('rename')}</ModalTitle>
        </ModalHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!canSubmit || !node) return;
            onRename(node, trimmed);
            onClose();
          }}
        >
          <ModalBody>
            <Field>
              <FieldLabel htmlFor={`${id}-name`}>{t('newNameLabel')}</FieldLabel>
              <Input
                ref={inputRef}
                id={`${id}-name`}
                autoComplete="off"
                spellCheck={false}
                value={name}
                onChange={(event) => setName(event.target.value)}
                aria-invalid={error ? true : undefined}
              />
              {error ? (
                <FieldDescription className="text-destructive" role="alert">
                  {error}
                </FieldDescription>
              ) : null}
            </Field>
          </ModalBody>
          <ModalFooter>
            <Button type="button" variant="outline-ghost" onClick={onClose}>
              {t('cancel')}
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              {t('save')}
            </Button>
          </ModalFooter>
        </form>
      </ModalContent>
    </Modal>
  );
}
