'use client';

import type { ConnectorAuthorizationStrategy } from '@kortix/sdk';
import { useEffect, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { User, UsersThree } from '@phosphor-icons/react';

import {
  connectorProfileSlugAfterNameChange,
  type EasyConnectProfileInput,
  isConnectorProfileSlugAvailable,
  normalizeConnectorProfileSlug,
} from './connector-profile-form';

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
  value: ConnectorAuthorizationStrategy;
  onChange: (value: ConnectorAuthorizationStrategy) => void;
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
   * directly above it (the connector Settings rung's "Who it connects as") —
   * so the two do not stack and repeat the same fact in two vocabularies.
   * Defaults to `false`; every other caller is unaffected.
   */
  hideLabel?: boolean;
}) {
  const id = `${idPrefix}-authorization-strategy`;

  // Settled connectors get a STATEMENT, not a dead input. A disabled select
  // still looks operable — it keeps the chevron, the focus ring and the hover —
  // so it invites a click that does nothing. Reading the value out plainly is
  // both calmer and more honest about the fact that there is no decision left.
  if (lockedReason) {
    const isProject = value === 'project';
    return (
      <Field>
        {hideLabel ? null : <FieldLabel>Authorization owner</FieldLabel>}
        <div className="bg-popover flex items-start gap-3 rounded-md border px-3 py-2.5">
          <span
            className={cn(
              'flex size-9 shrink-0 items-center justify-center rounded-sm',
              isProject ? 'bg-kortix-blue/15' : 'bg-kortix-purple/15',
            )}
          >
            {isProject ? (
              <UsersThree className="text-kortix-blue size-4" weight="duotone" />
            ) : (
              <User className="text-kortix-purple size-4" weight="duotone" />
            )}
          </span>
          <div className="min-w-0 flex-1 space-y-0.5">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">{isProject ? 'Project' : 'User'}</span>
              <Badge variant="outline" size="xs">
                Fixed
              </Badge>
            </div>
            <p className="text-muted-foreground text-xs text-pretty">
              {isProject
                ? 'One project-managed account, shared with allowed sessions.'
                : 'Each member authorizes their own account, private to their sessions.'}
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
        onValueChange={(next) => onChange(next as ConnectorAuthorizationStrategy)}
      >
        <SelectTrigger id={id}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="project">Project</SelectItem>
          <SelectItem value="user">User</SelectItem>
        </SelectContent>
      </Select>
      <FieldDescription className="text-pretty">
        {value === 'project'
          ? 'One project-managed account is available to allowed sessions.'
          : 'Each user authorizes their own account for private sessions.'}
      </FieldDescription>
    </Field>
  );
}

export function ConnectorProfileModal({
  open,
  idPrefix,
  title,
  description,
  initialName,
  initialSlug,
  existingSlugs,
  pending,
  authorizationStrategyDisabled = false,
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
  onOpenChange: (open: boolean) => void;
  onSubmit: (profile: EasyConnectProfileInput) => void;
}) {
  const [name, setName] = useState(initialName);
  const [slug, setSlug] = useState(initialSlug);
  const [slugEdited, setSlugEdited] = useState(false);
  const [authorizationStrategy, setAuthorizationStrategy] =
    useState<ConnectorAuthorizationStrategy>('project');

  useEffect(() => {
    if (!open) return;
    setName(initialName);
    setSlug(initialSlug);
    setSlugEdited(false);
    setAuthorizationStrategy('project');
  }, [initialName, initialSlug, open]);

  const slugAvailable = isConnectorProfileSlugAvailable(slug, existingSlugs);
  const slugDescriptionId = `${idPrefix}-slug-description`;

  return (
    <Modal open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
      <ModalContent className="lg:max-w-md">
        <ModalHeader>
          <ModalTitle>{title}</ModalTitle>
          <ModalDescription>{description}</ModalDescription>
        </ModalHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!name.trim() || !slugAvailable || pending) return;
            onSubmit({ name, slug, authorizationStrategy });
          }}
        >
          <ModalBody className="max-h-[60vh] overflow-y-auto">
            <FieldGroup className="gap-4">
              <Field>
                <FieldLabel htmlFor={`${idPrefix}-name`}>Display name</FieldLabel>
                <Input
                  id={`${idPrefix}-name`}
                  value={name}
                  onChange={(event) => {
                    const displayName = event.target.value;
                    setName(displayName);
                    setSlug((currentSlug) =>
                      connectorProfileSlugAfterNameChange({
                        displayName,
                        currentSlug,
                        existingSlugs,
                        slugEdited,
                      }),
                    );
                  }}
                  placeholder={initialName}
                  variant="popover"
                  autoFocus
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
                    setSlug(normalizeConnectorProfileSlug(event.target.value));
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
                    ? 'This slug already exists in this project.'
                    : 'Unique within this project. You can change the proposed value.'}
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
            <Button type="submit" disabled={pending || !name.trim() || !slugAvailable}>
              {pending ? <Loading className="size-4 shrink-0" /> : null}
              Add profile
            </Button>
          </ModalFooter>
        </form>
      </ModalContent>
    </Modal>
  );
}
