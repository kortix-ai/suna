'use client';

import type { WorkspaceConnectorAuthorizationStrategy } from '@kortix/sdk';
import { useEffect, useState } from 'react';

import { Badge } from '@/components/ui/badge';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { CaretDownIcon, PlusIcon, User, UsersThree } from '@phosphor-icons/react';
import { VisuallyHidden } from '@radix-ui/react-visually-hidden';

import {
  connectorConnectionSlugAfterNameChange,
  type EasyConnectConnectionInput,
  isConnectorConnectionSlugAvailable,
  normalizeConnectorConnectionSlug,
} from './connector-connection-form';
import { ConnectorConnectionHeader } from './connector-connection-header';

export function AuthorizationStrategyField({
  idPrefix,
  value,
  onChange,
  disabled = false,
  pending = false,
  lockedReason,
  hideLabel = false,
}: {
  idPrefix: string;
  value: WorkspaceConnectorAuthorizationStrategy;
  onChange: (value: WorkspaceConnectorAuthorizationStrategy) => void;
  disabled?: boolean;
  pending?: boolean;
  /**
   * Set on a connector that already exists, where the choice is settled.
   *
   * Forces the control off AND replaces the description, because a disabled
   * select with unchanged help text reads as a bug: the user tries it, nothing
   * happens, and nothing says why. The reason belongs where the control is.
   */
  lockedReason?: string;
  /**
   * Skips this field's own "Authorization owner" label. For a caller that
   * already prints its own plain-language label for this exact control
   * directly above it (the connector Settings tab's "Connects as") —
   * so the two do not stack and repeat the same fact in two vocabularies.
   * Defaults to `false`; every other caller is unaffected.
   *
   * It never leaves the control unnamed. In the interactive branch the
   * suppressed `FieldLabel htmlFor` was the select's ONLY name source, so
   * `hideLabel` alone would have shipped a form control with no accessible
   * name (WCAG 4.1.2) — invisible to `tsc`, to eslint and to every test here.
   * That combination is one line away: `connector-settings.tsx` today passes both
   * `hideLabel` and a `lockedReason`, and its own comment says re-enabling
   * editing means deleting `lockedReason`. So the two props are coupled below
   * rather than documented apart — documenting it was tried, twice, and this
   * still surprised a reviewer.
   */
  hideLabel?: boolean;
}) {
  const id = `${idPrefix}-authorization-strategy`;
  /** The name the `<FieldLabel>` would have carried, moved onto the control
   *  itself whenever that label is suppressed. */
  const suppressedLabel = hideLabel ? 'Authorization owner' : undefined;

  // Settled connectors get a STATEMENT, not a dead input. A disabled select
  // still looks operable — it keeps the chevron, the focus ring and the hover —
  // so it invites a click that does nothing. Reading the value out plainly is
  // both calmer and more honest about the fact that there is no decision left.
  if (lockedReason) {
    const isWorkspace = value === 'workspace';
    return (
      <Field>
        {hideLabel ? null : <FieldLabel>Authorization owner</FieldLabel>}
        <div className="bg-popover flex items-start gap-3 rounded-md border px-4 py-3">
          <span
            className={cn(
              'flex size-9 shrink-0 items-center justify-center rounded-sm',
              isWorkspace ? 'bg-kortix-blue/15' : 'bg-kortix-purple/15',
            )}
          >
            {isWorkspace ? (
              <UsersThree className="text-kortix-blue size-5" weight="duotone" />
            ) : (
              <User className="text-kortix-purple size-5" weight="duotone" />
            )}
          </span>
          <div className="min-w-0 flex-1 space-y-0.5">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">{isWorkspace ? 'Workspace' : 'User'}</span>
              <Badge variant="outline" size="xs">
                Fixed
              </Badge>
            </div>
            <p className="text-muted-foreground text-xs text-pretty">
              {isWorkspace
                ? 'Everyone in this workspace shares one connection.'
                : 'Everyone connects their own account.'}
            </p>
          </div>
        </div>
        <FieldDescription className="text-pretty">{lockedReason}</FieldDescription>
      </Field>
    );
  }
  return (
    <Field>
      <div className="flex items-center justify-between gap-2">
        {hideLabel ? null : <FieldLabel htmlFor={id}>Authorization owner</FieldLabel>}
        {pending ? <Loading className="size-4 shrink-0" /> : null}
      </div>
      <Select
        value={value}
        disabled={disabled || pending}
        onValueChange={(next) => onChange(next as WorkspaceConnectorAuthorizationStrategy)}
      >
        <SelectTrigger id={id} aria-label={suppressedLabel}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="workspace">Workspace</SelectItem>
          <SelectItem value="user">User</SelectItem>
        </SelectContent>
      </Select>
      <FieldDescription className="text-pretty">
        {value === 'workspace'
          ? 'Everyone in this workspace shares one connection.'
          : 'Everyone connects their own account.'}
      </FieldDescription>
    </Field>
  );
}

/**
 * The "Add connector" dialog: connection header + one primary button.
 *
 * Defaults (app name, proposed slug, workspace authorization) are always valid,
 * so a non-technical user reads the header and presses "+ Add connector"
 * without meeting "slug" or "authorization owner". Those fields stay behind a
 * collapsed disclosure for the rare rename / ownership case. The disclosure
 * force-opens when the slug inside it becomes invalid, so a submit that
 * would silently refuse never hides its reason.
 */
export function ConnectorConnectionModal({
  open,
  idPrefix,
  title,
  initialName,
  initialSlug,
  existingSlugs,
  pending,
  authorizationStrategyDisabled = false,
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
  authorizationStrategyDisabled?: boolean;
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
  const [name, setName] = useState(initialName);
  const [slug, setSlug] = useState(initialSlug);
  const [slugEdited, setSlugEdited] = useState(false);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [authorizationStrategy, setAuthorizationStrategy] =
    useState<WorkspaceConnectorAuthorizationStrategy>('workspace');

  useEffect(() => {
    if (!open) return;
    setName(initialName);
    setSlug(initialSlug);
    setSlugEdited(false);
    setOptionsOpen(false);
    setAuthorizationStrategy('workspace');
  }, [initialName, initialSlug, open]);

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
            onSubmit({ name, slug, authorizationStrategy });
          }}
        >
          <ModalBody className="max-h-[60vh] space-y-4 overflow-y-auto">
            <p className="text-muted-foreground text-sm text-pretty">
              Adds {displayName} to this workspace. You connect an account right after.
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
                    Advanced options
                  </span>
                  <CaretDownIcon className="text-muted-foreground size-4 shrink-0 transition-transform group-data-[state=open]:rotate-180" />
                </Button>
              </DisclosureTrigger>
              <DisclosureContent variant="outline" contentClassName="border-border border-t">
                <div className="px-4 py-5">
                  <FieldGroup className="gap-4">
                    <Field>
                      <FieldLabel htmlFor={`${idPrefix}-name`}>Display name</FieldLabel>
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
                      <FieldLabel htmlFor={`${idPrefix}-slug`}>Slug</FieldLabel>
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
                          ? 'This slug already exists in this workspace.'
                          : 'Unique within this workspace. You can change the proposed value.'}
                      </FieldDescription>
                    </Field>
                    <AuthorizationStrategyField
                      idPrefix={idPrefix}
                      value={authorizationStrategy}
                      onChange={setAuthorizationStrategy}
                      disabled={authorizationStrategyDisabled}
                      pending={pending}
                    />
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
              Cancel
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
              {submitLabel ?? 'Add connector'}
            </Button>
          </ModalFooter>
        </form>
      </ModalContent>
    </Modal>
  );
}
