'use client';

/**
 * OAuth apps: the account's "Sign in with Kortix" client registry.
 *
 * A row here is a third-party app (Essentia's dashboards, a partner portal,
 * an internal tool on its own origin) that sends people to `/v1/oauth/authorize`
 * and gets back a `kortix_oat_` token for them. The app pairs the client id and
 * secret with `createKortixAuth` from `@kortix/sdk/server`; everything else —
 * PKCE, consent, refresh, revoke — the SDK and `/v1/oauth` do between them.
 * Spec: `docs/specs/2026-08-26-sign-in-with-kortix.md`.
 *
 * **Why it sits in Tokens.** A client secret is a credential the account
 * issues to a machine, exactly like a service account token, and it answers to
 * the same permissions (`token.create` / `token.revoke`). So it lives beside
 * the service account list, in the same row, with the same create → show-once
 * modal — a person who has minted a token here already knows how this works.
 *
 * **The secret is shown once.** Create and rotate return `client_secret`
 * exactly once; list and get never do. Both halves (form → reveal) live in one
 * `Modal` on purpose, the way `CreateApiKeyDialog` does: a dialog that closes
 * and reopens somewhere else is how a one-time secret gets lost.
 *
 * **Layout.** `AccessList` / `AccessRow` from `features/workspace/shared/access`
 * — the single row every access surface in this account uses.
 */

import { type FormEvent, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { EntityAvatar } from '@/components/ui/entity-avatar';
import { InfoBanner } from '@/components/ui/info-banner';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { SettingsSubsectionHeader } from '@/components/ui/settings-subsection-header';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { errorToast, successToast } from '@/components/ui/toast';
import { ErrorState } from '@/features/layout/section/error-state';
import {
  AccessList,
  AccessRow,
  CopyRow,
  type KebabItem,
  copyValue,
} from '@/features/workspace/shared/access';
import {
  type CreateOAuthClientInput,
  type CreatedOAuthClient,
  type OAuthClient,
  type OAuthClientType,
  type UpdateOAuthClientInput,
  createOAuthClient,
  deleteOAuthClient,
  listOAuthClients,
  rotateOAuthClientSecret,
  updateOAuthClient,
} from '@/lib/iam-client';
import { relativeTime } from '@/lib/relative-time';
import {
  AppWindowIcon,
  ArrowsClockwiseIcon,
  CopyIcon,
  PencilSimpleIcon,
  PlusIcon,
  TrashIcon,
  WarningIcon,
} from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';

const OAUTH_CLIENTS_KEY = (accountId: string) => ['oauth-clients', accountId];

/**
 * One line per scope, in the words a person registering an app needs: what
 * the app learns or may do, not the OAuth term. `scopes_supported` from the
 * API decides which of these are offered; an unknown scope falls back to its
 * raw name so a new server-side scope still shows up here before this map
 * learns about it.
 */
export const SCOPE_HELP: Record<string, string> = {
  profile: 'Who the user is (id, email, accounts)',
  email: 'Email address',
  kortix: 'Act as the user on the Kortix API (projects, sessions, files)',
};

const CLIENT_TYPE_LABEL: Record<OAuthClientType, string> = {
  confidential: 'Confidential',
  public: 'Public',
};

/** Mirrors `normalizeRedirectUris` in `apps/api/src/repositories/oauth-clients.ts`. */
const MAX_REDIRECT_URIS = 20;

function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '[::1]' ||
    hostname.endsWith('.localhost')
  );
}

export type ParsedRedirectUris = { ok: true; value: string[] } | { ok: false; error: string };

/**
 * Turn the textarea (one URI per line) into the list the endpoint accepts, or
 * into one sentence saying why it can't. The rules are the server's, checked
 * here first so a typo is caught before the round-trip and the message names
 * the offending line: absolute URL, `https` everywhere except loopback hosts,
 * no `#fragment`, at least one, at most 20. Duplicates collapse silently —
 * pasting the same callback twice is not a mistake worth a red line.
 */
export function parseRedirectUris(text: string): ParsedRedirectUris {
  const out: string[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const value = rawLine.trim();
    if (!value) continue;
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return { ok: false, error: `Not an absolute URL: ${value}` };
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return { ok: false, error: `Redirect URIs must be http(s): ${value}` };
    }
    if (url.protocol === 'http:' && !isLoopbackHost(url.hostname)) {
      return { ok: false, error: `Use https (http is allowed on localhost only): ${value}` };
    }
    if (url.hash || value.endsWith('#')) {
      return { ok: false, error: `Redirect URIs can't carry a #fragment: ${value}` };
    }
    if (!out.includes(value)) out.push(value);
  }
  if (out.length === 0) return { ok: false, error: 'Add at least one redirect URI.' };
  if (out.length > MAX_REDIRECT_URIS) {
    return { ok: false, error: `At most ${MAX_REDIRECT_URIS} redirect URIs.` };
  }
  return { ok: true, value: out };
}

/**
 * Meta-line summary of a client's redirect URIs: the first one in full, then
 * how many more. A row that lists five callbacks in a row is unreadable; the
 * full set is one Edit away and in the `title` tooltip.
 */
export function summarizeRedirectUris(uris: string[]): string {
  if (uris.length === 0) return 'No redirect URI';
  if (uris.length === 1) return uris[0];
  return `${uris[0]} +${uris.length - 1} more`;
}

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

type PendingAction = { client: OAuthClient; action: 'delete' | 'rotate' };

export interface OAuthAppsCardProps {
  accountId: string;
  /** `token.create` / `token.revoke` — hides the register action and every row action when false. */
  canManage: boolean;
}

export function OAuthAppsCard({ accountId, canManage }: OAuthAppsCardProps) {
  const queryClient = useQueryClient();
  const invalidate = () => queryClient.invalidateQueries({ queryKey: OAUTH_CLIENTS_KEY(accountId) });
  const [registerOpen, setRegisterOpen] = useState(false);
  const [editing, setEditing] = useState<OAuthClient | null>(null);
  const [pending, setPending] = useState<PendingAction | null>(null);
  /** A rotated secret, shown once in its own modal after the confirm. */
  const [rotated, setRotated] = useState<CreatedOAuthClient | null>(null);

  const clientsQuery = useQuery({
    queryKey: OAUTH_CLIENTS_KEY(accountId),
    queryFn: () => listOAuthClients(accountId),
    staleTime: 30_000,
  });

  const deleteMutation = useMutation({
    mutationFn: (client: OAuthClient) => deleteOAuthClient(accountId, client.client_id),
    onSuccess: () => {
      successToast('App deleted');
      invalidate();
      setPending(null);
    },
    onError: (err: Error) => errorToast(errorMessage(err, 'Could not delete that app')),
  });

  const rotateMutation = useMutation({
    mutationFn: (client: OAuthClient) => rotateOAuthClientSecret(accountId, client.client_id),
    onSuccess: (result) => {
      invalidate();
      setPending(null);
      setRotated(result);
    },
    onError: (err: Error) => errorToast(errorMessage(err, 'Could not rotate that secret')),
  });

  const clients = clientsQuery.data?.oauth_clients ?? [];
  const scopesSupported = clientsQuery.data?.scopes_supported ?? Object.keys(SCOPE_HELP);
  const busy = deleteMutation.isPending || rotateMutation.isPending;

  return (
    <section className="space-y-4">
      <SettingsSubsectionHeader
        title="OAuth apps"
        description={
          <>
            Apps that sign users in with Kortix. Pair the client id and secret with{' '}
            <code className="text-foreground font-mono">createKortixAuth</code> from{' '}
            <code className="text-foreground font-mono">@kortix/sdk/server</code>.{' '}
            <Link href="/docs/sdk/sign-in" className="text-foreground underline underline-offset-2">
              Read the guide
            </Link>
            .
          </>
        }
        action={
          canManage ? (
            <Button
              size="sm"
              variant="secondary"
              className="gap-1.5"
              onClick={() => setRegisterOpen(true)}
            >
              <PlusIcon className="size-4 shrink-0" />
              Register app
            </Button>
          ) : undefined
        }
      />

      {clientsQuery.isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 2 }).map((_, index) => (
            <Skeleton key={index} className="h-14 rounded-md" />
          ))}
        </div>
      ) : clientsQuery.error ? (
        <ErrorState
          size="sm"
          title="Couldn't load these apps"
          description={
            clientsQuery.error instanceof Error ? clientsQuery.error.message : undefined
          }
          action={
            <Button variant="outline" size="sm" onClick={() => clientsQuery.refetch()}>
              Retry
            </Button>
          }
        />
      ) : clients.length === 0 ? null : (
        // No apps, no chrome — same rule as the service account list above it:
        // the register action lives in the header where the eye already lands.
        <AccessList>
          {clients.map((client) => {
            const kebab: KebabItem[] = [
              {
                label: 'Copy client id',
                icon: <CopyIcon className="size-3.5 shrink-0" />,
                onSelect: () => void copyValue(client.client_id, 'Client id copied'),
              },
              ...(canManage
                ? ([
                    {
                      label: 'Edit app',
                      icon: <PencilSimpleIcon className="size-3.5 shrink-0" />,
                      onSelect: () => setEditing(client),
                    },
                    ...(client.client_type === 'confidential'
                      ? [
                          {
                            label: 'Rotate secret',
                            icon: <ArrowsClockwiseIcon className="size-3.5 shrink-0" />,
                            separated: true,
                            onSelect: () => setPending({ client, action: 'rotate' }),
                          },
                        ]
                      : []),
                    {
                      label: 'Delete app',
                      icon: <TrashIcon className="size-3.5 shrink-0" />,
                      variant: 'destructive',
                      separated: true,
                      onSelect: () => setPending({ client, action: 'delete' }),
                    },
                  ] satisfies KebabItem[])
                : []),
            ];
            return (
              <AccessRow
                key={client.client_id}
                leading={<EntityAvatar icon={AppWindowIcon} label={client.name} size="sm" />}
                title={client.name}
                badges={
                  <>
                    <Badge variant={client.active ? 'success' : 'muted'} size="sm">
                      {client.active ? 'Active' : 'Inactive'}
                    </Badge>
                    <Badge
                      variant="outline"
                      size="sm"
                      title={
                        client.client_type === 'confidential'
                          ? 'Server-side app — signs in with its client secret'
                          : 'Browser or native app — no secret, PKCE only'
                      }
                    >
                      {CLIENT_TYPE_LABEL[client.client_type]}
                    </Badge>
                  </>
                }
                metaParts={[
                  <code key="id" className="font-mono">
                    {client.client_id}
                  </code>,
                  <span key="uris" title={client.redirect_uris.join('\n')}>
                    {summarizeRedirectUris(client.redirect_uris)}
                  </span>,
                  <code key="scopes" className="font-mono">
                    {client.scopes.length > 0 ? client.scopes.join(' ') : 'no scopes'}
                  </code>,
                  `Created ${relativeTime(client.created_at)}`,
                ]}
                kebab={kebab}
                kebabLabel={`Actions for ${client.name}`}
                pending={busy && pending?.client.client_id === client.client_id}
              />
            );
          })}
        </AccessList>
      )}

      <OAuthAppDialog
        accountId={accountId}
        open={registerOpen}
        onOpenChange={setRegisterOpen}
        scopesSupported={scopesSupported}
      />
      <OAuthAppDialog
        accountId={accountId}
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
        scopesSupported={scopesSupported}
        client={editing ?? undefined}
      />

      <ConfirmDialog
        open={!!pending}
        onOpenChange={(open) => {
          if (!open) setPending(null);
        }}
        title={pending?.action === 'delete' ? 'Delete this app?' : 'Rotate this secret?'}
        description={
          pending
            ? pending.action === 'delete'
              ? `"${pending.client.name}" can no longer sign anyone in, and every token it holds stops working. This can't be undone.`
              : `"${pending.client.name}" gets a new client secret and the old one stops working right away. Update the app's configuration before its next sign-in.`
            : ''
        }
        confirmLabel={pending?.action === 'delete' ? 'Delete' : 'Rotate secret'}
        confirmVariant={pending?.action === 'delete' ? 'destructive' : 'default'}
        isPending={busy}
        onConfirm={() => {
          if (!pending) return;
          if (pending.action === 'delete') deleteMutation.mutate(pending.client);
          else rotateMutation.mutate(pending.client);
        }}
      />

      <Modal
        open={rotated !== null}
        onOpenChange={(open) => {
          if (!open) setRotated(null);
        }}
      >
        <ModalContent className="lg:max-w-lg">
          {rotated ? (
            <>
              <ModalHeader>
                <ModalTitle>Copy the new secret now</ModalTitle>
                <ModalDescription>
                  This is the only time <strong>{rotated.name}</strong>&apos;s new secret is shown.
                  The old one has already stopped working.
                </ModalDescription>
              </ModalHeader>
              <ModalBody>
                <SecretReveal client={rotated} />
              </ModalBody>
              <ModalFooter>
                <Button type="button" size="sm" onClick={() => setRotated(null)}>
                  Done
                </Button>
              </ModalFooter>
            </>
          ) : null}
        </ModalContent>
      </Modal>
    </section>
  );
}

/**
 * The show-once block: client id, secret (confidential only), and the warning
 * that the secret is not shown again. Shared by "just registered" and "just
 * rotated" so both read the same.
 */
function SecretReveal({ client }: { client: CreatedOAuthClient }) {
  return (
    <div className="space-y-4">
      {client.client_secret ? (
        <InfoBanner tone="warning" icon={WarningIcon} title="Save the secret now">
          It is not shown again. A lost secret has to be rotated.
        </InfoBanner>
      ) : (
        <InfoBanner tone="neutral">
          A public client has no secret — it signs in with PKCE only.
        </InfoBanner>
      )}
      <CopyRow label="Client id" value={client.client_id} successMessage="Client id copied" />
      {client.client_secret ? (
        <CopyRow
          label="Client secret"
          value={client.client_secret}
          successMessage="Client secret copied"
        />
      ) : null}
    </div>
  );
}

interface OAuthAppDialogProps {
  accountId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  scopesSupported: string[];
  /** Present → edit that client. Absent → register a new one. */
  client?: OAuthClient;
}

interface FormState {
  name: string;
  description: string;
  clientType: OAuthClientType;
  redirectUris: string;
  scopes: string[];
  active: boolean;
}

function initialForm(client: OAuthClient | undefined, scopesSupported: string[]): FormState {
  return {
    name: client?.name ?? '',
    description: client?.description ?? '',
    clientType: client?.client_type ?? 'confidential',
    redirectUris: client?.redirect_uris.join('\n') ?? '',
    scopes: client ? client.scopes : scopesSupported,
    active: client?.active ?? true,
  };
}

/**
 * Register or edit, then (on register) show the credentials once.
 *
 * The same form serves both modes because the fields are the same minus two:
 * the type is fixed at registration (the endpoint has no `client_type` on
 * PATCH — a public client that grew a secret would break every deployed copy
 * of the app), and `active` only exists once there is something to switch
 * off. Every API rejection (`{ error }`) lands in the banner at the top of the
 * form, not in a toast, so it stays on screen beside the field it names.
 */
function OAuthAppDialog({ accountId, open, onOpenChange, scopesSupported, client }: OAuthAppDialogProps) {
  const queryClient = useQueryClient();
  const isEdit = client !== undefined;
  // Keyed on the client so switching from one Edit to another re-seeds.
  const [seededFor, setSeededFor] = useState<string | undefined>(client?.client_id);
  const [form, setForm] = useState<FormState>(() => initialForm(client, scopesSupported));
  const [formError, setFormError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedOAuthClient | null>(null);

  if (seededFor !== client?.client_id) {
    setSeededFor(client?.client_id);
    setForm(initialForm(client, scopesSupported));
    setFormError(null);
  }

  const patch = (next: Partial<FormState>) => setForm((prev) => ({ ...prev, ...next }));

  const mutation = useMutation({
    mutationFn: async (input: CreateOAuthClientInput | UpdateOAuthClientInput) => {
      if (isEdit) return updateOAuthClient(accountId, client.client_id, input as UpdateOAuthClientInput);
      return createOAuthClient(accountId, input as CreateOAuthClientInput);
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: OAUTH_CLIENTS_KEY(accountId) });
      if (isEdit) {
        successToast('App updated');
        close();
        return;
      }
      setCreated(result as CreatedOAuthClient);
    },
    onError: (err: Error) =>
      setFormError(errorMessage(err, isEdit ? 'Could not update that app' : 'Could not register that app')),
  });

  function close() {
    onOpenChange(false);
    // Reset after the close animation so the form does not visibly blank out
    // underneath the fading overlay.
    setTimeout(() => {
      setForm(initialForm(undefined, scopesSupported));
      setFormError(null);
      setCreated(null);
    }, 200);
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (mutation.isPending || created) return;
    const name = form.name.trim();
    if (!name) {
      setFormError('Give the app a name.');
      return;
    }
    const uris = parseRedirectUris(form.redirectUris);
    if (!uris.ok) {
      setFormError(uris.error);
      return;
    }
    if (form.scopes.length === 0) {
      setFormError('Pick at least one scope.');
      return;
    }
    setFormError(null);
    const description = form.description.trim();
    if (isEdit) {
      mutation.mutate({
        name,
        description: description || null,
        redirect_uris: uris.value,
        scopes: form.scopes,
        active: form.active,
      } satisfies UpdateOAuthClientInput);
    } else {
      mutation.mutate({
        name,
        ...(description ? { description } : {}),
        client_type: form.clientType,
        redirect_uris: uris.value,
        scopes: form.scopes,
      } satisfies CreateOAuthClientInput);
    }
  }

  const toggleScope = (scope: string, checked: boolean) =>
    patch({
      scopes: checked
        ? scopesSupported.filter((s) => s === scope || form.scopes.includes(s))
        : form.scopes.filter((s) => s !== scope),
    });

  const fieldId = (suffix: string) => `oauth-app-${client?.client_id ?? 'new'}-${suffix}`;

  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        if (mutation.isPending) return;
        if (!next) close();
        else onOpenChange(true);
      }}
    >
      <ModalContent className="lg:max-w-lg">
        {created ? (
          <>
            <ModalHeader>
              <ModalTitle>Copy these credentials now</ModalTitle>
              <ModalDescription>
                <strong>{created.name}</strong> is registered. Put the client id
                {created.client_secret ? ' and secret' : ''} into the app&apos;s{' '}
                <code className="font-mono">createKortixAuth</code> config.
              </ModalDescription>
            </ModalHeader>
            <ModalBody>
              <SecretReveal client={created} />
            </ModalBody>
            <ModalFooter>
              <Button type="button" size="sm" onClick={close}>
                Done
              </Button>
            </ModalFooter>
          </>
        ) : (
          <>
            <ModalHeader>
              <ModalTitle>{isEdit ? `Edit ${client.name}` : 'Register an app'}</ModalTitle>
              <ModalDescription>
                {isEdit
                  ? 'Changes apply to the next sign-in. Tokens already issued keep working until they expire.'
                  : 'An app that signs Kortix users in on its own origin. You get a client id and, for a confidential app, a secret shown once.'}
              </ModalDescription>
            </ModalHeader>
            <form onSubmit={submit}>
              <ModalBody className="max-h-[60vh] space-y-4 overflow-y-auto">
                {formError ? (
                  <InfoBanner tone="destructive" icon={WarningIcon}>
                    {formError}
                  </InfoBanner>
                ) : null}

                <div className="space-y-1.5">
                  <Label htmlFor={fieldId('name')}>Name</Label>
                  <Input
                    id={fieldId('name')}
                    value={form.name}
                    onChange={(event) => patch({ name: event.target.value })}
                    placeholder="Dashboards"
                    disabled={mutation.isPending}
                    maxLength={255}
                    autoFocus
                    variant="popover"
                  />
                  <p className="text-muted-foreground text-xs">
                    Shown on the consent screen — name it the way its users know it.
                  </p>
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor={fieldId('description')}>
                    Description{' '}
                    <span className="text-muted-foreground text-xs font-normal">(optional)</span>
                  </Label>
                  <Input
                    id={fieldId('description')}
                    value={form.description}
                    onChange={(event) => patch({ description: event.target.value })}
                    placeholder="Internal dashboards for the ops team"
                    disabled={mutation.isPending}
                    maxLength={1024}
                    variant="popover"
                  />
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor={fieldId('type')}>Type</Label>
                  <Select
                    value={form.clientType}
                    onValueChange={(value) => patch({ clientType: value as OAuthClientType })}
                    disabled={mutation.isPending || isEdit}
                  >
                    <SelectTrigger id={fieldId('type')} className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem
                        size="sm"
                        value="confidential"
                        description="Server-side app. Gets a client secret."
                      >
                        Confidential
                      </SelectItem>
                      <SelectItem
                        size="sm"
                        value="public"
                        description="Browser or native app. No secret — PKCE only."
                      >
                        Public
                      </SelectItem>
                    </SelectContent>
                  </Select>
                  {isEdit ? (
                    <p className="text-muted-foreground text-xs">
                      The type is fixed at registration. Register a new app to change it.
                    </p>
                  ) : null}
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor={fieldId('redirect-uris')}>Redirect URIs</Label>
                  <Textarea
                    id={fieldId('redirect-uris')}
                    value={form.redirectUris}
                    onChange={(event) => patch({ redirectUris: event.target.value })}
                    placeholder={'https://app.example.com/api/kortix/auth/callback\nhttp://localhost:3000/api/kortix/auth/callback'}
                    disabled={mutation.isPending}
                    minHeight={72}
                    maxHeight={240}
                    className="font-mono text-xs"
                    spellCheck={false}
                  />
                  <p className="text-muted-foreground text-xs">
                    One per line. Matched byte-for-byte at sign-in; https everywhere except
                    localhost.
                  </p>
                </div>

                <div className="space-y-1.5">
                  <Label>Scopes</Label>
                  <div className="rounded-md border p-1">
                    {scopesSupported.map((scope) => (
                      <Checkbox
                        key={scope}
                        checked={form.scopes.includes(scope)}
                        onCheckedChange={(checked) => toggleScope(scope, checked === true)}
                        disabled={mutation.isPending}
                        label={
                          <span className="flex min-w-0 flex-col gap-0.5 sm:flex-row sm:items-baseline sm:gap-2">
                            <code className="font-mono">{scope}</code>
                            <span className="text-muted-foreground text-xs font-normal">
                              {SCOPE_HELP[scope] ?? scope}
                            </span>
                          </span>
                        }
                      />
                    ))}
                  </div>
                  <p className="text-muted-foreground text-xs">
                    The most the app may ask for. Each sign-in can request a subset.
                  </p>
                </div>

                {isEdit ? (
                  <div className="flex items-center justify-between gap-4 rounded-md border px-4 py-3">
                    <div className="min-w-0 space-y-0.5">
                      <Label htmlFor={fieldId('active')}>Active</Label>
                      <p className="text-muted-foreground text-xs">
                        Switch off to stop new sign-ins without deleting the app.
                      </p>
                    </div>
                    <Switch
                      id={fieldId('active')}
                      checked={form.active}
                      onCheckedChange={(checked) => patch({ active: checked })}
                      disabled={mutation.isPending}
                    />
                  </div>
                ) : null}
              </ModalBody>
              <ModalFooter className="sm:justify-between">
                <Button
                  type="button"
                  variant="outline-ghost"
                  size="sm"
                  onClick={close}
                  disabled={mutation.isPending}
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  size="sm"
                  disabled={!form.name.trim() || mutation.isPending}
                  className="gap-1.5"
                >
                  {mutation.isPending ? <Loading className="size-3.5 shrink-0" /> : null}
                  {isEdit ? 'Save changes' : 'Register app'}
                </Button>
              </ModalFooter>
            </form>
          </>
        )}
      </ModalContent>
    </Modal>
  );
}
