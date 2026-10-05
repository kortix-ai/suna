'use client';

import { useTranslations as useI18nTranslations } from '@/i18n/use-translations';
import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Disclosure, DisclosureContent, DisclosureTrigger } from '@/components/ui/disclosure';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import Loading from '@/components/ui/loading';
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  ModalTitle,
} from '@/components/ui/modal';
import { cn } from '@/lib/utils';
import { CaretDownIcon, PlusIcon } from '@phosphor-icons/react';
import { VisuallyHidden } from '@radix-ui/react-visually-hidden';

import {
  connectorConnectionSlugAfterNameChange,
  type EasyConnectConnectionInput,
  isConnectorConnectionSlugAvailable,
  normalizeConnectorConnectionSlug,
  proposeConnectorConnectionName,
} from './connector-connection-form';
import { ConnectorConnectionHeader } from './connector-connection-header';

/**
 * The "Add connector" dialog: connection header + one primary button.
 *
 * Defaults (app name, proposed slug) are always valid, so a non-technical user
 * reads the header and presses "+ Add connector" without meeting "slug". That
 * field stays behind a collapsed disclosure for the rare rename case. The
 * disclosure force-opens when the slug inside it becomes invalid, so a submit
 * that would silently refuse never hides its reason.
 *
 * There is no owner choice here any more. A connector is a capability with no
 * identity; WHO it runs as is a property of each account on its Accounts tab,
 * where both a shared and a private account can exist at the same time.
 */
export function ConnectorConnectionModal({
  open,
  idPrefix,
  title,
  initialName,
  initialSlug,
  existingSlugs,
  pending,
  icon,
  byline,
  summary,
  submitLabel,
  onOpenChange,
  onSubmit,
}: {
  open: boolean;
  idPrefix: string;
  title: string;
  description: string;
  initialName: string;
  initialSlug: string;
  existingSlugs: readonly string[];
  pending: boolean;
  /** The app tile — `ConnectorConnectionIcon` over the catalogue record. */
  icon?: React.ReactNode;
  /** e.g. "by Pipedream". */
  byline?: string | null;
  /** The catalogue description, when the source publishes one. */
  summary?: string | null;
  /** Defaults to `+ Add connector`. */
  submitLabel?: string;
  onOpenChange: (open: boolean) => void;
  onSubmit: (connection: EasyConnectConnectionInput) => void;
}) {
  const tI18nComplete = useI18nTranslations('hardcodedUi.i18nComplete');
  // The proposed name counts the project's existing connections to this app,
  // so the second Sentry is "Sentry 2" — see `proposeConnectorConnectionName`.
  const proposedName = proposeConnectorConnectionName(initialName, existingSlugs);
  const [name, setName] = useState(proposedName);
  const [slug, setSlug] = useState(initialSlug);
  const [slugEdited, setSlugEdited] = useState(false);
  const [optionsOpen, setOptionsOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(proposedName);
    setSlug(initialSlug);
    setSlugEdited(false);
    setOptionsOpen(false);
  }, [proposedName, initialSlug, open]);

  const slugAvailable = isConnectorConnectionSlugAvailable(slug, existingSlugs);
  const slugInvalid = slug.length > 0 && !slugAvailable;
  const slugDescriptionId = `${idPrefix}-slug-description`;
  const displayName = name.trim() || initialName;

  return (
    <Modal open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
      <ModalContent className="lg:max-w-lg" aria-describedby={undefined}>
        <VisuallyHidden asChild>
          <ModalTitle>{title}</ModalTitle>
        </VisuallyHidden>
        <ModalHeader>
          <ConnectorConnectionHeader
            icon={icon}
            name={displayName}
            byline={byline}
            description={summary}
          />
        </ModalHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!name.trim() || !slugAvailable || pending) return;
            onSubmit({ name, slug });
          }}
        >
          <ModalBody className="max-h-[60vh] space-y-4 overflow-y-auto">
            <p className="text-muted-foreground text-sm text-pretty">
              {tI18nComplete.raw('text17e9f72b9ba8')} {displayName}{' '}
              {tI18nComplete.raw('texte99baf469ca8')}
            </p>
            <Disclosure
              variant="outline"
              className="overflow-hidden"
              open={optionsOpen || slugInvalid}
              onOpenChange={setOptionsOpen}
            >
              <DisclosureTrigger variant="outline">
                <Button
                  type="button"
                  variant="popover"
                  className="flex w-full items-center justify-between rounded-none"
                >
                  <span className="text-muted-foreground truncate text-sm font-medium">
                    {tI18nComplete.raw('text9443ff69463e')}
                  </span>
                  <CaretDownIcon className="text-muted-foreground size-4 shrink-0 transition-transform group-data-[state=open]:rotate-180" />
                </Button>
              </DisclosureTrigger>
              <DisclosureContent variant="outline" contentClassName="border-border border-t">
                <div className="px-4 py-5">
                  <FieldGroup className="gap-4">
                    <Field>
                      <FieldLabel htmlFor={`${idPrefix}-name`}>
                        {tI18nComplete.raw('text2b7f6a84de91')}
                      </FieldLabel>
                      <Input
                        id={`${idPrefix}-name`}
                        value={name}
                        onChange={(event) => {
                          const nextName = event.target.value;
                          setName(nextName);
                          setSlug((currentSlug) =>
                            connectorConnectionSlugAfterNameChange({
                              displayName: nextName,
                              currentSlug,
                              existingSlugs,
                              slugEdited,
                            }),
                          );
                        }}
                        placeholder={initialName}
                        variant="popover"
                        maxLength={255}
                        disabled={pending}
                        required
                      />
                    </Field>
                    <Field>
                      <FieldLabel htmlFor={`${idPrefix}-slug`}>
                        {tI18nComplete.raw('textd15387ecc6c5')}
                      </FieldLabel>
                      <Input
                        id={`${idPrefix}-slug`}
                        value={slug}
                        onChange={(event) => {
                          setSlugEdited(true);
                          setSlug(normalizeConnectorConnectionSlug(event.target.value));
                        }}
                        placeholder={initialSlug}
                        variant="popover"
                        className="font-mono text-xs"
                        maxLength={128}
                        aria-invalid={slug.length > 0 && !slugAvailable}
                        aria-describedby={slugDescriptionId}
                        disabled={pending}
                        required
                      />
                      <FieldDescription
                        id={slugDescriptionId}
                        role={slug.length > 0 && !slugAvailable ? 'alert' : undefined}
                        className={cn(slug.length > 0 && !slugAvailable && 'text-destructive')}
                      >
                        {slug.length > 0 && !slugAvailable
                          ? tI18nComplete.raw('text1b07037029d3')
                          : tI18nComplete.raw('text48026cbaf423')}
                      </FieldDescription>
                    </Field>
                  </FieldGroup>
                </div>
              </DisclosureContent>
            </Disclosure>
          </ModalBody>
          <ModalFooter className="sm:justify-between">
            <Button
              type="button"
              variant="outline-ghost"
              onClick={() => onOpenChange(false)}
              disabled={pending}
            >
              {tI18nComplete.raw('text19766ed6ccb2')}
            </Button>
            <Button
              type="submit"
              className="gap-1.5 active:scale-[0.96]"
              disabled={pending || !name.trim() || !slugAvailable}
            >
              {pending ? (
                <Loading className="size-4 shrink-0" />
              ) : (
                <PlusIcon className="size-4 shrink-0" weight="bold" />
              )}
              {submitLabel ?? tI18nComplete.raw('texta6ef2483d6fb')}
            </Button>
          </ModalFooter>
        </form>
      </ModalContent>
    </Modal>
  );
}
