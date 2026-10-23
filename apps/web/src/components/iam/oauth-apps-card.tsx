'use client';

import { useTranslations } from '@/i18n/use-translations';
/**
 * OAuth apps: the account's "Sign in with Kortix" client registry.
 *
 * A row here is a third-party app (SampleCo's dashboards, a partner portal,
 * an internal tool on its own origin) that sends people to `/v1/oauth/authorize`
 * and gets back a `kortix_oat_` token for them. The app pairs the client id and
 * secret with `createKortixAuth` from `@kortix/sdk/server`; everything else —
 * PKCE, consent, refresh, revoke — the SDK and `/v1/oauth` do between them.
 *
 * **Why it sits in Tokens.** A client secret is a credential the account
 * issues to a machine, exactly like a service account token, and it answers to
 * the same permissions (`token.create` / `token.revoke`). So it lives beside
 * the service account list, with the same create → show-once flow in the
 * account hub's split sheet — a person who has minted a token here already
 * knows how this works.
 *
 * **The secret is shown once.** Create and rotate return `client_secret`
 * exactly once; list and get never do. Register reopens the sheet with the
 * credentials from the mutation's own `onSuccess`, so closing the sheet
 * mid-request never loses them. Rotate shows its secret in a modal after the
 * confirm.
 *
 * **Layout.** A flat, Linear-style table (`iam-table.tsx`) — App, Type,
 * Redirect URIs, Scopes, Created — Jay's pick from the Paper "API · auth apps"
 * variants (03, 2026-10-13). The row kebab is `AccessRow`'s own (`RowKebab`).
 */

import { type FormEvent, useState } from 'react';

import { Button } from '@kortix/ui/button';
import { Checkbox } from '@kortix/ui/checkbox';
import { ConfirmDialog } from '@kortix/ui/confirm-dialog';
import { EntityAvatar } from '@kortix/ui/entity-avatar';
import { InfoBanner } from '@kortix/ui/info-banner';
import { Input } from '@kortix/ui/input';
import { Label } from '@kortix/ui/label';
import Loading from '@kortix/ui/loading';
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalDescription,
  ModalFooter,
  ModalHeader,
  ModalTitle,
} from '@kortix/ui/modal';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@kortix/ui/select';
import { SettingsSubsectionHeader } from '@kortix/ui/settings-subsection-header';
import { Skeleton } from '@kortix/ui/skeleton';
import { Switch } from '@kortix/ui/switch';
import { Textarea } from '@kortix/ui/textarea';
import { errorToast, successToast } from '@kortix/ui/toast';
import { useAccountHubSheet } from '@kortix/ui/internal/account-hub/hub-sheet';
import { ErrorState } from '@kortix/ui/error-state';
import { CopyRow, RowKebab, type KebabItem, copyValue } from '@kortix/ui/access/access/index';
import { cn } from '@kortix/ui';
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
import { relativeTime } from '@kortix/ui/internal/lib/relative-time';
import {
  AppWindowIcon,
  ArrowsClockwiseIcon,
  CopyIcon,
  PencilSimpleIcon,
  PlusIcon,
  TrashIcon,
  WarningIcon,
} from '@phosphor-icons/react';
import { useIsMutating, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from '@/components/site-link';

import { IamTable, IamTableCell, IamTableHead, IamTableRow } from './iam-table';

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

/** Lets the sheet's pinned footer read the register/edit request's state: it renders outside the form. */
const OAUTH_APP_MUTATION_KEY = (accountId: string) => ['oauth-app-save', accountId];
const oauthAppFormId = (client?: OAuthClient) => `oauth-app-form-${client?.client_id ?? 'new'}`;

/** Cancel and Register / Save, pinned at the sheet's bottom and tied to the form by id. */
function OAuthAppSheetFooter({ accountId, client }: { accountId: string; client?: OAuthClient }) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const sheet = useAccountHubSheet();
  const pending = useIsMutating({ mutationKey: OAUTH_APP_MUTATION_KEY(accountId) }) > 0;
  return (
    // Cancel on the left edge, the commit action on the right.
    <div className="flex w-full items-center justify-between gap-2">
      <Button type="button" variant="outline-ghost" size="sm" onClick={sheet.close} disabled={pending}>
        {tI18nComplete.raw('text19766ed6ccb2')}
      </Button>
      <Button type="submit" form={oauthAppFormId(client)} size="sm" disabled={pending} className="gap-1.5">
        {pending ? <Loading className="size-3.5 shrink-0" /> : null}
        {client ? tI18nComplete.raw('textdd0ae7a5cbcf') : tI18nComplete.raw('text02290f388fa8')}
      </Button>
    </div>
  );
}

/** The table's "Redirect URIs" cell: the first URI's host, plus how many more. */
export function redirectHostSummary(uris: string[]): string {
  if (uris.length === 0) return '—';
  let host = uris[0];
  try {
    host = new URL(uris[0]).host;
  } catch {
    // Not a URL the browser parses: show it whole rather than nothing.
  }
  return uris.length > 1 ? `${host} +${uris.length - 1}` : host;
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
  const sheet = useAccountHubSheet();
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

  // Register and Edit open in the account hub's split sheet, beside the list.
  // Keyed on the client so a switch from one app to another mounts a fresh form.
  const openRegister = () =>
    sheet.open({
      title: tI18nComplete.raw('text26c880f0d774'),
      description: tI18nComplete.raw('texte5c8b30df3c9'),
      body: <OAuthAppSheetForm key="new" accountId={accountId} scopesSupported={scopesSupported} />,
      footer: <OAuthAppSheetFooter accountId={accountId} />,
    });
  const openEdit = (client: OAuthClient) =>
    sheet.open({
      title: tI18nComplete('text2313fe21ea84', { name: client.name }),
      description: tI18nComplete.raw('texte59a1d133be1'),
      body: (
        <OAuthAppSheetForm
          key={client.client_id}
          accountId={accountId}
          scopesSupported={scopesSupported}
          client={client}
        />
      ),
      footer: <OAuthAppSheetFooter key={client.client_id} accountId={accountId} client={client} />,
    });

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
            <Link href="/docs/sdk/auth#sign-in-with-kortix" className="text-foreground underline underline-offset-2">
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
              onClick={() => openRegister()}
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
        <IamTable label={tI18nComplete.raw('textafff11a43d8f')}>
          <IamTableHead>
            <IamTableCell header>{tI18nComplete.raw('text0d04bfeb7d64')}</IamTableCell>
            <IamTableCell header width="w-24">{tI18nComplete.raw('textbaaddf70fb5d')}</IamTableCell>
            <IamTableCell header width="w-40">{tI18nComplete.raw('text721353f1b4eb')}</IamTableCell>
            <IamTableCell header width="w-14" align="end">{tI18nComplete.raw('text0d5644ff52ce')}</IamTableCell>
            <IamTableCell header width="w-20" align="end">{tI18nComplete.raw('textd70b9e24bca2')}</IamTableCell>
            <IamTableCell width="w-7" />
          </IamTableHead>
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
                      onSelect: () => openEdit(client),
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
            const rowBusy = busy && pending?.client.client_id === client.client_id;
            return (
              <IamTableRow key={client.client_id} muted={!client.active}>
                <IamTableCell>
                  <EntityAvatar icon={AppWindowIcon} label={client.name} size="xs" />
                  <span className={cn('truncate', client.active && 'font-medium')}>
                    {client.name}
                  </span>
                  {client.active ? null : (
                    <span className="text-muted-foreground shrink-0 text-xs">
                      {tI18nComplete.raw('textca7981b46ecf')}
                    </span>
                  )}
                </IamTableCell>
                <IamTableCell
                  width="w-24"
                  className="text-muted-foreground"
                >
                  <span
                    title={
                      client.client_type === 'confidential'
                        ? tI18nComplete.raw('text41cb2b40561f')
                        : tI18nComplete.raw('text4e7a78e97ff7')
                    }
                  >
                    {CLIENT_TYPE_LABEL[client.client_type]}
                  </span>
                </IamTableCell>
                <IamTableCell width="w-40" className="text-muted-foreground">
                  <span className="truncate" title={client.redirect_uris.join('\n')}>
                    {redirectHostSummary(client.redirect_uris)}
                  </span>
                </IamTableCell>
                <IamTableCell
                  width="w-14"
                  align="end"
                  className="text-muted-foreground tabular-nums"
                >
                  <span title={client.scopes.join(' ')}>{client.scopes.length}</span>
                </IamTableCell>
                <IamTableCell width="w-20" align="end" className="text-muted-foreground">
                  {relativeTime(client.created_at)}
                </IamTableCell>
                <IamTableCell width="w-7" align="end">
                  {rowBusy ? (
                    <Loading className="size-3.5" />
                  ) : (
                    <RowKebab
                      items={kebab}
                      label={tI18nComplete('text33da220b1a34', { value0: client.name })}
                    />
                  )}
                </IamTableCell>
              </IamTableRow>
            );
          })}
        </IamTable>
      )}


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

interface OAuthAppSheetFormProps {
  accountId: string;
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
function OAuthAppSheetForm({ accountId, scopesSupported, client }: OAuthAppSheetFormProps) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const queryClient = useQueryClient();
  const isEdit = client !== undefined;
  const sheet = useAccountHubSheet();
  // The owner keys this form on the client, so each app gets a fresh form.
  const [form, setForm] = useState<FormState>(() => initialForm(client, scopesSupported));
  const [formError, setFormError] = useState<string | null>(null);

  const patch = (next: Partial<FormState>) => setForm((prev) => ({ ...prev, ...next }));

  const mutation = useMutation({
    mutationKey: OAUTH_APP_MUTATION_KEY(accountId),
    mutationFn: async (input: CreateOAuthClientInput | UpdateOAuthClientInput) => {
      if (isEdit)
        return updateOAuthClient(accountId, client.client_id, input as UpdateOAuthClientInput);
      return createOAuthClient(accountId, input as CreateOAuthClientInput);
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: OAUTH_CLIENTS_KEY(accountId) });
      if (isEdit) {
        successToast(tI18nComplete.raw('text99db90df9291'));
        sheet.close();
        return;
      }
      // From the mutation's own options, not a `mutate` callback: this still
      // runs if the sheet was closed mid-request, and reopens it with the
      // one-time secret instead of losing it.
      const created = result as CreatedOAuthClient;
      sheet.open({
        title: tI18nComplete.raw('text72320149c3c2'),
        description: (
          <>
            <strong>{created.name}</strong> {tI18nComplete.raw('text8e15f0dbfa86')}
            {created.client_secret ? tI18nComplete.raw('text3f5966e76ae1') : ''}{' '}
            {tI18nComplete.raw('texte2762471c9d7')}{' '}
            <code className="font-mono">createKortixAuth</code>{' '}
            {tI18nComplete.raw('texta45f266b33b5')}
          </>
        ),
        body: <SecretReveal client={created} />,
        footer: (
          <Button type="button" size="sm" onClick={sheet.close}>
            {tI18nComplete.raw('text11a6767d5674')}
          </Button>
        ),
      });
    },
    onError: (err: Error) =>
      setFormError(
        errorMessage(err, isEdit ? 'Could not update that app' : 'Could not register that app'),
      ),
  });


  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (mutation.isPending) return;
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
    <form id={oauthAppFormId(client)} onSubmit={submit} className="space-y-4">
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
            required
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
          {/* The sidebar's Connect MCP / Connect your computer block: one
              filled row per scope, a 1px seam between them, outer corners
              rounded-md and inner corners rounded-sm. No border, no padding. */}
          <div className="flex flex-col gap-px">
            {scopesSupported.map((scope) => (
              // The Checkbox's own label IS the row: one fill, one padding.
              // Title over description; `items-start` + `mt-px` sits the 18px
              // box on the title's 20px line.
              // Its hover/checked tints are overridden so the row stays flat.
              <Checkbox
                key={scope}
                checked={form.scopes.includes(scope)}
                onCheckedChange={(checked) => toggleScope(scope, checked === true)}
                disabled={mutation.isPending}
                className="bg-hover hover:bg-hover has-data-[state=checked]:bg-hover has-data-[state=checked]:hover:bg-hover items-start rounded-sm px-2.5 py-2 first:rounded-t-md last:rounded-b-md [&>button]:mt-px"
                label={
                  <span className="flex min-w-0 flex-col">
                    <span className="font-medium">{scope}</span>
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
    </form>
  );
}
