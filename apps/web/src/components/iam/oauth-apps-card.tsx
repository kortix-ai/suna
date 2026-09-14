'use client';

import { useTranslations } from '@/i18n/use-translations';
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
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const queryClient = useQueryClient();
  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: OAUTH_CLIENTS_KEY(accountId) });
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
      successToast(tI18nComplete.raw('text30648767dd84'));
      invalidate();
      setPending(null);
    },
    onError: (err: Error) => errorToast(errorMessage(err, tI18nComplete.raw('text1c2fb82a41c4'))),
  });

  const rotateMutation = useMutation({
    mutationFn: (client: OAuthClient) => rotateOAuthClientSecret(accountId, client.client_id),
    onSuccess: (result) => {
      invalidate();
      setPending(null);
      setRotated(result);
    },
    onError: (err: Error) => errorToast(errorMessage(err, tI18nComplete.raw('text59611ccab0af'))),
  });

  const clients = clientsQuery.data?.oauth_clients ?? [];
  const scopesSupported = clientsQuery.data?.scopes_supported ?? Object.keys(SCOPE_HELP);
  const busy = deleteMutation.isPending || rotateMutation.isPending;

  return (
    <section className="space-y-4">
      <SettingsSubsectionHeader
        title={tI18nComplete.raw('textafff11a43d8f')}
        description={
          <>
            {tI18nComplete.raw('text04d35c3117b5')}{' '}
            <code className="text-foreground font-mono">createKortixAuth</code>{' '}
            {tI18nComplete.raw('text75857a458999')}{' '}
            <code className="text-foreground font-mono">@kortix/sdk/server</code>.{' '}
            <Link href="/docs/sdk/sign-in" className="text-foreground underline underline-offset-2">
              {tI18nComplete.raw('text83b3b277abbf')}
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
              {tI18nComplete.raw('text02290f388fa8')}
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
          title={tI18nComplete.raw('text084b1840b3f4')}
          description={clientsQuery.error instanceof Error ? clientsQuery.error.message : undefined}
          action={
            <Button variant="outline" size="sm" onClick={() => clientsQuery.refetch()}>
              {tI18nComplete.raw('text942087cc2d41')}
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
                label: tI18nComplete.raw('text0d683ef7eb96'),
                icon: <CopyIcon className="size-3.5 shrink-0" />,
                onSelect: () =>
                  void copyValue(
                    client.client_id,
                    tI18nComplete.raw('text07247959e9ef'),
                    tI18nComplete.raw('text19efd469fc32'),
                  ),
              },
              ...(canManage
                ? ([
                    {
                      label: tI18nComplete.raw('textf8301e6fd45e'),
                      icon: <PencilSimpleIcon className="size-3.5 shrink-0" />,
                      onSelect: () => setEditing(client),
                    },
                    ...(client.client_type === 'confidential'
                      ? [
                          {
                            label: tI18nComplete.raw('text4405518d273b'),
                            icon: <ArrowsClockwiseIcon className="size-3.5 shrink-0" />,
                            separated: true,
                            onSelect: () => setPending({ client, action: 'rotate' }),
                          },
                        ]
                      : []),
                    {
                      label: tI18nComplete.raw('text70ddc8217e8b'),
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
                          ? tI18nComplete.raw('text41cb2b40561f')
                          : tI18nComplete.raw('text4e7a78e97ff7')
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
                    {client.scopes.length > 0
                      ? client.scopes.join(' ')
                      : tI18nComplete.raw('textae5b8724e862')}
                  </code>,
                  `Created ${relativeTime(client.created_at)}`,
                ]}
                kebab={kebab}
                kebabLabel={tI18nComplete('text33da220b1a34', { value0: client.name })}
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
        title={
          pending?.action === 'delete'
            ? tI18nComplete.raw('texta4f6c318a669')
            : tI18nComplete.raw('text81bd2a33309d')
        }
        description={
          pending
            ? pending.action === 'delete'
              ? tI18nComplete('text31e4f2bb4dba', { value0: pending.client.name })
              : tI18nComplete('text548f4cfc6745', { value0: pending.client.name })
            : ''
        }
        confirmLabel={
          pending?.action === 'delete' ? 'Delete' : tI18nComplete.raw('text4405518d273b')
        }
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
                <ModalTitle>{tI18nComplete.raw('text745cdf07045d')}</ModalTitle>
                <ModalDescription>
                  {tI18nComplete.raw('textd21d10509292')} <strong>{rotated.name}</strong>
                  {tI18nComplete.raw('text9e37afbe968f')}
                </ModalDescription>
              </ModalHeader>
              <ModalBody>
                <SecretReveal client={rotated} />
              </ModalBody>
              <ModalFooter>
                <Button type="button" size="sm" onClick={() => setRotated(null)}>
                  {tI18nComplete.raw('text11a6767d5674')}
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
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  return (
    <div className="space-y-4">
      {client.client_secret ? (
        <InfoBanner tone="warning" icon={WarningIcon} title={tI18nComplete.raw('text8989e0a7f3cb')}>
          {tI18nComplete.raw('text949aff7c5b57')}
        </InfoBanner>
      ) : (
        <InfoBanner tone="neutral">{tI18nComplete.raw('text26b154c97fd8')}</InfoBanner>
      )}
      <CopyRow
        label={tI18nComplete.raw('text844a263ddf5a')}
        value={client.client_id}
        successMessage={tI18nComplete.raw('text07247959e9ef')}
      />
      {client.client_secret ? (
        <CopyRow
          label={tI18nComplete.raw('text4aded5faf156')}
          value={client.client_secret}
          successMessage={tI18nComplete.raw('textb3cbcf46a05e')}
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
function OAuthAppDialog({
  accountId,
  open,
  onOpenChange,
  scopesSupported,
  client,
}: OAuthAppDialogProps) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
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
      if (isEdit)
        return updateOAuthClient(accountId, client.client_id, input as UpdateOAuthClientInput);
      return createOAuthClient(accountId, input as CreateOAuthClientInput);
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: OAUTH_CLIENTS_KEY(accountId) });
      if (isEdit) {
        successToast(tI18nComplete.raw('text99db90df9291'));
        close();
        return;
      }
      setCreated(result as CreatedOAuthClient);
    },
    onError: (err: Error) =>
      setFormError(
        errorMessage(err, isEdit ? 'Could not update that app' : 'Could not register that app'),
      ),
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
              <ModalTitle>{tI18nComplete.raw('text72320149c3c2')}</ModalTitle>
              <ModalDescription>
                <strong>{created.name}</strong> {tI18nComplete.raw('text8e15f0dbfa86')}
                {created.client_secret ? tI18nComplete.raw('text3f5966e76ae1') : ''}{' '}
                {tI18nComplete.raw('texte2762471c9d7')}{' '}
                <code className="font-mono">createKortixAuth</code>{' '}
                {tI18nComplete.raw('texta45f266b33b5')}
              </ModalDescription>
            </ModalHeader>
            <ModalBody>
              <SecretReveal client={created} />
            </ModalBody>
            <ModalFooter>
              <Button type="button" size="sm" onClick={close}>
                {tI18nComplete.raw('text11a6767d5674')}
              </Button>
            </ModalFooter>
          </>
        ) : (
          <>
            <ModalHeader>
              <ModalTitle>
                {isEdit ? `Edit ${client.name}` : tI18nComplete.raw('text26c880f0d774')}
              </ModalTitle>
              <ModalDescription>
                {isEdit
                  ? tI18nComplete.raw('texte59a1d133be1')
                  : tI18nComplete.raw('texte5c8b30df3c9')}
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
                  <Label htmlFor={fieldId('name')}>{tI18nComplete.raw('textdcd1d5223f73')}</Label>
                  <Input
                    id={fieldId('name')}
                    value={form.name}
                    onChange={(event) => patch({ name: event.target.value })}
                    placeholder={tI18nComplete.raw('texta53bcafb67d9')}
                    disabled={mutation.isPending}
                    maxLength={255}
                    autoFocus
                    variant="popover"
                  />
                  <p className="text-muted-foreground text-xs">
                    {tI18nComplete.raw('text13e8da46c7b1')}
                  </p>
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor={fieldId('description')}>
                    {tI18nComplete.raw('text526e0087cc3f')}{' '}
                    <span className="text-muted-foreground text-xs font-normal">
                      {tI18nComplete.raw('text0059798b7f70')}
                    </span>
                  </Label>
                  <Input
                    id={fieldId('description')}
                    value={form.description}
                    onChange={(event) => patch({ description: event.target.value })}
                    placeholder={tI18nComplete.raw('text0ca058a2bd7f')}
                    disabled={mutation.isPending}
                    maxLength={1024}
                    variant="popover"
                  />
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor={fieldId('type')}>{tI18nComplete.raw('textbaaddf70fb5d')}</Label>
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
                        description={tI18nComplete.raw('textceb733acfa16')}
                      >
                        {tI18nComplete.raw('texta3e83aee8605')}
                      </SelectItem>
                      <SelectItem
                        size="sm"
                        value="public"
                        description={tI18nComplete.raw('textdbbfc6cf8952')}
                      >
                        {tI18nComplete.raw('text591935b15b1c')}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                  {isEdit ? (
                    <p className="text-muted-foreground text-xs">
                      {tI18nComplete.raw('text854e6dd9d777')}
                    </p>
                  ) : null}
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor={fieldId('redirect-uris')}>
                    {tI18nComplete.raw('text721353f1b4eb')}
                  </Label>
                  <Textarea
                    id={fieldId('redirect-uris')}
                    value={form.redirectUris}
                    onChange={(event) => patch({ redirectUris: event.target.value })}
                    placeholder={
                      'https://app.example.com/api/kortix/auth/callback\nhttp://localhost:3000/api/kortix/auth/callback'
                    }
                    disabled={mutation.isPending}
                    minHeight={72}
                    maxHeight={240}
                    className="font-mono text-xs"
                    spellCheck={false}
                  />
                  <p className="text-muted-foreground text-xs">
                    {tI18nComplete.raw('text8d49ce8a5936')}
                  </p>
                </div>

                <div className="space-y-1.5">
                  <Label>{tI18nComplete.raw('text0d5644ff52ce')}</Label>
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
                    {tI18nComplete.raw('text9428545e3f14')}
                  </p>
                </div>

                {isEdit ? (
                  <div className="flex items-center justify-between gap-4 rounded-md border px-4 py-3">
                    <div className="min-w-0 space-y-0.5">
                      <Label htmlFor={fieldId('active')}>
                        {tI18nComplete.raw('text92340695899b')}
                      </Label>
                      <p className="text-muted-foreground text-xs">
                        {tI18nComplete.raw('text99f4941ae829')}
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
                  {tI18nComplete.raw('text19766ed6ccb2')}
                </Button>
                <Button
                  type="submit"
                  size="sm"
                  disabled={!form.name.trim() || mutation.isPending}
                  className="gap-1.5"
                >
                  {mutation.isPending ? <Loading className="size-3.5 shrink-0" /> : null}
                  {isEdit
                    ? tI18nComplete.raw('textdd0ae7a5cbcf')
                    : tI18nComplete.raw('text02290f388fa8')}
                </Button>
              </ModalFooter>
            </form>
          </>
        )}
      </ModalContent>
    </Modal>
  );
}
