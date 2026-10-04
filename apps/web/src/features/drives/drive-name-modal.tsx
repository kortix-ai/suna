'use client';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import Loading from '@/components/ui/loading';
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalDescription,
  ModalFooter,
  ModalHeader,
  ModalTitle,
} from '@/components/ui/modal';
import { Switch } from '@/components/ui/switch';
import { useTranslations } from '@/i18n/use-translations';
import { type FormEvent, type ReactNode, useId, useState } from 'react';

import { isValidEntryName } from './drive-model';

export interface DriveNameModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  label: string;
  submitLabel: string;
  initialValue?: string;
  /** Entry names are one path segment; drive names are free text. */
  validateAsEntry?: boolean;
  /** Optional on/off choice shown under the name, e.g. "Use in this project". */
  toggle?: { label: string; description?: string; defaultChecked: boolean };
  isPending?: boolean;
  onSubmit: (value: string, toggled: boolean) => void;
}

/**
 * One text field, one submit. Backs every naming flow on the Drive page:
 * new drive, rename drive, new folder, rename file.
 */
export function DriveNameModal(props: DriveNameModalProps) {
  const { open, onOpenChange, title, description, isPending = false } = props;
  return (
    <Modal open={open} onOpenChange={(next) => (isPending ? undefined : onOpenChange(next))}>
      <ModalContent className="lg:max-w-md">
        <ModalHeader>
          <ModalTitle>{title}</ModalTitle>
          {description ? <ModalDescription>{description}</ModalDescription> : null}
        </ModalHeader>
        {/* Mounted per open, so every open starts from the props' values. */}
        {open ? <DriveNameForm {...props} /> : null}
      </ModalContent>
    </Modal>
  );
}

function DriveNameForm({
  onOpenChange,
  label,
  submitLabel,
  initialValue = '',
  validateAsEntry = false,
  toggle,
  isPending = false,
  onSubmit,
}: DriveNameModalProps) {
  const t = useTranslations('drives');
  const inputId = useId();
  const [value, setValue] = useState(initialValue);
  const [toggled, setToggled] = useState(toggle?.defaultChecked ?? false);
  const [touched, setTouched] = useState(false);

  const trimmed = value.trim();
  const valid = validateAsEntry ? isValidEntryName(trimmed) : trimmed.length > 0;
  const unchanged = initialValue !== '' && trimmed === initialValue.trim();

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (!valid || unchanged || isPending) return;
    onSubmit(trimmed, toggled);
  };

  return (
    <form onSubmit={handleSubmit} autoComplete="off">
      <ModalBody className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor={inputId}>{label}</Label>
          <Input
            id={inputId}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            onBlur={() => setTouched(true)}
            autoFocus
            disabled={isPending}
            maxLength={120}
            aria-invalid={touched && !valid}
            data-1p-ignore="true"
            data-lpignore="true"
          />
          {touched && !valid ? (
            <p role="alert" className="text-destructive text-xs">
              {t('invalidName')}
            </p>
          ) : null}
        </div>
        {toggle ? (
          <div className="bg-popover flex items-center justify-between gap-3 rounded-md border px-4 py-3">
            <div className="min-w-0">
              <p className="text-sm font-medium">{toggle.label}</p>
              {toggle.description ? (
                <p className="text-muted-foreground text-xs">{toggle.description}</p>
              ) : null}
            </div>
            <Switch
              checked={toggled}
              onCheckedChange={setToggled}
              disabled={isPending}
              aria-label={toggle.label}
            />
          </div>
        ) : null}
      </ModalBody>
      <ModalFooter className="sm:justify-between">
        <Button
          type="button"
          variant="outline-ghost"
          size="sm"
          className="w-full sm:w-auto"
          onClick={() => onOpenChange(false)}
          disabled={isPending}
        >
          {t('cancel')}
        </Button>
        <Button
          type="submit"
          size="sm"
          className="w-full sm:w-auto"
          disabled={isPending || !valid || unchanged}
        >
          {isPending ? <Loading className="size-4 shrink-0" /> : null}
          {submitLabel}
        </Button>
      </ModalFooter>
    </form>
  );
}
