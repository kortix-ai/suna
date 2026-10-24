'use client';

import { useId, useState } from 'react';

import { Badge } from '../../../primitives/badge';
import { Button } from '../../../primitives/button';
import { Field, FieldDescription, FieldLabel } from '../../../primitives/field';
import { Input } from '../../../primitives/input';
import Loading from '../../../primitives/loading';
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalDescription,
  ModalFooter,
  ModalHeader,
  ModalTitle,
} from '../../../primitives/modal';
import { useTranslations } from '../../../i18n';

import { wayKindLabel, type WayKind } from './way-kind';

/** One way to connect, as the Install dialog describes it. */
export interface InstallWay {
  kind: WayKind;
  oneClick: boolean;
}

/**
 * Install → this dialog → the connector profile. The user names the profile
 * here: it is the project's entry in `kortix.yaml`, and its accounts, who may
 * use them and its tool rules all live on it. The text says which way it
 * connects, so a Composio app or an API key never comes as a surprise.
 */
export function InstallDialog({
  appName,
  way,
  open,
  pending,
  onOpenChange,
  onConfirm,
}: {
  appName: string;
  way: InstallWay;
  open: boolean;
  pending: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (name: string) => void;
}) {
  const t = useTranslations('connectorPages');
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const id = useId();
  const [name, setName] = useState(appName);
  const valid = /[a-z0-9]/i.test(name);

  return (
    <Modal open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
      <ModalContent className="lg:max-w-md">
        <ModalHeader>
          <ModalTitle className="flex items-center gap-2">
            {t('installTitle', { name: appName })}
            <Badge variant="muted" size="xs">
              {wayKindLabel(way.kind)}
            </Badge>
          </ModalTitle>
          <ModalDescription>{wayDescription(t, way, appName)}</ModalDescription>
        </ModalHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (valid && !pending) onConfirm(name.trim());
          }}
        >
          <ModalBody className="space-y-4">
            <Field>
              <FieldLabel htmlFor={`${id}-name`}>{t('installNameLabel')}</FieldLabel>
              <Input
                id={`${id}-name`}
                value={name}
                onChange={(event) => setName(event.target.value)}
                autoComplete="off"
                disabled={pending}
                autoFocus
              />
              <FieldDescription>{t('installProfileHint')}</FieldDescription>
            </Field>
          </ModalBody>
          <ModalFooter className="sm:justify-between">
            <Button type="button" variant="outline-ghost" onClick={() => onOpenChange(false)} disabled={pending}>
              {tI18nComplete.raw('text19766ed6ccb2')}
            </Button>
            <Button type="submit" disabled={!valid || pending}>
              {pending ? <Loading className="size-4 shrink-0" /> : null}
              {t('install')}
            </Button>
          </ModalFooter>
        </form>
      </ModalContent>
    </Modal>
  );
}

/** What connecting this way means for the user, in one or two sentences. */
export function wayDescription(
  t: ReturnType<typeof useTranslations>,
  way: InstallWay,
  appName: string,
): string {
  if (way.kind === 'composio') return t('wayComposio', { name: appName });
  if (way.kind === 'channel') return t('wayChannel', { name: appName });
  if (way.kind === 'mcp') return way.oneClick ? t('wayMcpOneClick', { name: appName }) : t('wayMcpSetup', { name: appName });
  return t('wayApi', { name: appName, kind: wayKindLabel(way.kind) });
}
