'use client';

// SAML SSO config on the Settings tab. The Supabase auth.sso_providers
// row is created out-of-band (Studio or auth admin API) — admins paste
// the resulting UUID + primary email domain here, plus the JWT claim
// holding group memberships. Once configured, every SAML-issued JWT
// triggers JIT membership + group sync in the auth middleware.

import { errorToast, successToast } from '@/components/ui/toast';
import { getEnv } from '@/lib/env-config';
import {
  ArrowRightIcon as ArrowRight,
  CaretDownIcon as ChevronDown,
  CheckIcon as Check,
  PlusIcon as Plus,
  TrashIcon as Trash2,
  XIcon as X,
} from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useMemo, useState, useSyncExternalStore } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Disclosure, DisclosureContent, DisclosureTrigger } from '@/components/ui/disclosure';
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
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import {
  CopyRow,
  EMPTY_PRINCIPAL_SELECTION,
  PrincipalPicker,
  type PrincipalSelection,
  singlePrincipal,
} from '@/features/workspace/shared/access';
import { ErrorState } from '@/features/layout/section/error-state';
import { useAuth } from '@/features/providers/auth-provider';
import {
  type SsoGroupMapping,
  type SsoProvider,
  createSsoGroupMapping,
  deleteSsoGroupMapping,
  deleteSsoProvider,
  getSsoProvider,
  listSsoGroupMappings,
  upsertSsoProvider,
} from '@/lib/iam-client';

import { type SamlSpUrls, buildSamlSpUrls } from '@/lib/saml-sp';

/**
 * SP URLs come from the BROWSER's runtime env (`window.__KORTIX_RUNTIME_CONFIG`),
 * which can differ from the server's absolute `SUPABASE_URL` — so the server
 * snapshot is `null` and the client snapshot is computed once and cached.
 * `useSyncExternalStore` renders the client value in the hydration pass itself,
 * so the block appears in the first paint instead of popping in after an effect.
 */
const subscribeToNothing = () => () => {};
let clientSpUrlsSnapshot: SamlSpUrls | null | undefined;
function getClientSpUrlsSnapshot(): SamlSpUrls | null {
  if (clientSpUrlsSnapshot === undefined) {
    clientSpUrlsSnapshot = buildSamlSpUrls(getEnv().SUPABASE_URL);
  }
  return clientSpUrlsSnapshot;
}
function useSpUrls(): SamlSpUrls | null {
  return useSyncExternalStore(subscribeToNothing, getClientSpUrlsSnapshot, () => null);
}

/**
 * "Service provider details" block — the Entity ID + Reply URL (ACS) admins
 * paste into their IdP's SAML configuration. Shown both before a provider is
 * configured (admins need these values first) and inside the configure/edit
 * dialog. Deliberately does not mention the delegated identity provider by
 * name — see sso-card.test.ts.
 */
function SpDetails({
  urls,
  className,
  // The card's collapsed "Service provider values" section already titles this
  // block — heading off there; the edit dialog still wants it.
  heading = true,
}: {
  urls: SamlSpUrls;
  className?: string;
  heading?: boolean;
}) {
  return (
    <div className={className}>
      {heading && (
        <>
          <h3 className="text-foreground text-sm font-medium">Service provider details</h3>
          <p className="text-muted-foreground mt-0.5 text-xs">
            Paste these into your identity provider's SAML configuration.
          </p>
        </>
      )}
      <div className={heading ? 'mt-3 space-y-3' : 'space-y-3'}>
        <CopyRow
          label="Identifier (Entity ID)"
          value={urls.entityId}
          successMessage="Entity ID copied"
        />
        <CopyRow label="Reply URL (ACS)" value={urls.acsUrl} successMessage="Reply URL copied" />
      </div>
    </div>
  );
}

interface SsoCardProps {
  accountId: string;
  canManage: boolean;
}

export function SsoCard({ accountId, canManage }: SsoCardProps) {
  const queryClient = useQueryClient();
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [mapOpen, setMapOpen] = useState(false);
  const [mapDeleteTarget, setMapDeleteTarget] = useState<SsoGroupMapping | null>(null);

  const providerQuery = useQuery({
    queryKey: ['iam-sso-provider', accountId],
    queryFn: () => getSsoProvider(accountId),
    staleTime: 30_000,
  });

  const mappingsQuery = useQuery({
    queryKey: ['iam-sso-mappings', accountId],
    queryFn: () => listSsoGroupMappings(accountId),
    enabled: !!providerQuery.data,
    staleTime: 30_000,
  });

  const deleteMutation = useMutation({
    mutationFn: () => deleteSsoProvider(accountId),
    onSuccess: () => {
      successToast('SSO provider removed');
      queryClient.invalidateQueries({ queryKey: ['iam-sso-provider', accountId] });
      queryClient.invalidateQueries({ queryKey: ['iam-sso-mappings', accountId] });
      setDeleteOpen(false);
    },
    onError: (err: Error) => errorToast(err.message || 'Failed to remove provider'),
  });

  const deleteMappingMutation = useMutation({
    mutationFn: (mappingId: string) => deleteSsoGroupMapping(accountId, mappingId),
    onSuccess: () => {
      successToast('Mapping removed');
      queryClient.invalidateQueries({ queryKey: ['iam-sso-mappings', accountId] });
      setMapDeleteTarget(null);
    },
    onError: (err: Error) => errorToast(err.message || 'Failed to remove mapping'),
  });

  const provider = providerQuery.data;
  const mappings = mappingsQuery.data ?? [];
  const spUrls = useSpUrls();

  // Off by default — orgs opt in once their SAML connection is proven. Re-sends
  // every other stored field unchanged (the PUT route is a full upsert), only
  // flipping enforce_sso, so this toggle never touches the rest of the config.
  const enforceSsoMutation = useMutation({
    mutationFn: (enforce: boolean) => {
      if (!provider) throw new Error('No SSO provider configured');
      return upsertSsoProvider(accountId, {
        supabase_sso_provider_id: provider.supabase_sso_provider_id,
        name: provider.name,
        primary_domain: provider.primary_domain,
        group_claim_name: provider.group_claim_name,
        auto_create_members: provider.auto_create_members,
        auto_provision_groups: provider.auto_provision_groups,
        enforce_sso: enforce,
      });
    },
    onSuccess: (updated) => {
      successToast(
        updated.enforce_sso ? 'SSO is now enforced for this domain' : 'SSO enforcement turned off',
      );
      queryClient.invalidateQueries({ queryKey: ['iam-sso-provider', accountId] });
    },
    onError: (err: Error) => errorToast(err.message || 'Failed to update SSO enforcement'),
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0 space-y-0.5">
          <p className="text-foreground flex items-center gap-2 text-sm font-medium">
            SAML SSO
            {provider && (
              <Badge variant="success" size="sm">
                connected
              </Badge>
            )}
          </p>
          <p className="text-muted-foreground text-xs">
            {provider
              ? 'Connect your IdP. Users signing in via SAML are auto-provisioned and their IAM groups are kept in sync from a JWT claim.'
              : 'Auto-provision members from your IdP. Group claims sync to IAM groups.'}
          </p>
        </div>
        {canManage &&
          (provider ? (
            <Button
              variant="outline"
              onClick={() => setEditOpen(true)}
              size="sm"
              className="shrink-0"
            >
              Edit
            </Button>
          ) : (
            // New providers go through the guided setup wizard (per-IdP
            // steps + inline import) instead of the bare dialog.
            <Button asChild size="sm" variant="secondary" className="shrink-0">
              <Link href={`/accounts/${accountId}/sso-setup`}>Configure</Link>
            </Button>
          ))}
      </div>

      <div className="bg-popover rounded-md border">
        {/* Not connected → a calm call-to-action, not a wall of URLs. The
            guided wizard hands over the SP values at the step that needs
            them; the collapsed section below is the re-copy escape hatch. */}
        {!provider && providerQuery.isLoading && (
          <div className="px-4 py-5">
            <Skeleton className="h-12 w-full rounded-md" />
          </div>
        )}
        {!provider && !providerQuery.isLoading && providerQuery.isError && (
          <div className="px-4 py-5">
            <ErrorState
              size="sm"
              title="Couldn't load SSO status"
              description={
                providerQuery.error instanceof Error ? providerQuery.error.message : undefined
              }
              action={
                <Button variant="outline" size="sm" onClick={() => providerQuery.refetch()}>
                  Retry
                </Button>
              }
            />
          </div>
        )}
        {!provider && !providerQuery.isLoading && !providerQuery.isError && (
          <div className="px-4 py-5">
            <p className="text-foreground text-sm font-medium">Not connected yet</p>
            <p className="text-muted-foreground mt-1 text-xs leading-relaxed">
              Route your domain's sign-ins through your identity provider — Configure walks Entra,
              Okta, Google and more step by step, including everything your IdP asks for.
            </p>
          </div>
        )}

        {provider && (
          <div className="px-4 py-5">
            {/* No loading ternary here — `provider` truthy means the query
                already resolved; the pre-connect skeleton lives above. */}
            {/* Compact facts grid (Vercel-style) — two columns instead of five
                stacked full-width rows, so the connected summary reads at a
                glance instead of eating half the card. */}
            <dl className="grid gap-x-8 gap-y-4 text-sm sm:grid-cols-2">
              <div className="min-w-0">
                <dt className="text-muted-foreground text-xs">Provider</dt>
                <dd className="text-foreground mt-0.5 truncate font-medium">{provider.name}</dd>
              </div>
              <div className="min-w-0">
                <dt className="text-muted-foreground text-xs">Primary domain</dt>
                <dd className="text-foreground mt-1 truncate font-mono text-xs">
                  {provider.primary_domain}
                </dd>
              </div>
              <div className="min-w-0">
                <dt className="text-muted-foreground text-xs">Group claim</dt>
                <dd className="mt-1">
                  <code className="bg-muted/60 text-foreground rounded px-1.5 py-0.5 font-mono text-xs">
                    {provider.group_claim_name}
                  </code>
                </dd>
              </div>
              <div className="min-w-0">
                <dt className="text-muted-foreground text-xs">Provisioning</dt>
                <dd className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
                  <span
                    className={
                      provider.auto_create_members
                        ? 'text-kortix-green inline-flex items-center gap-1 font-medium'
                        : 'text-muted-foreground inline-flex items-center gap-1'
                    }
                  >
                    {provider.auto_create_members ? <Check className="size-3.5 shrink-0" /> : null}
                    Auto-create members{provider.auto_create_members ? '' : ': off'}
                  </span>
                  <span
                    className={
                      provider.auto_provision_groups
                        ? 'text-kortix-green inline-flex items-center gap-1 font-medium'
                        : 'text-muted-foreground inline-flex items-center gap-1'
                    }
                  >
                    {provider.auto_provision_groups ? (
                      <Check className="size-3.5 shrink-0" />
                    ) : null}
                    Auto-provision groups{provider.auto_provision_groups ? '' : ': off'}
                  </span>
                </dd>
              </div>
            </dl>
          </div>
        )}

        {provider && (
          <div className="border-border border-t px-4 py-4">
            <div className="flex items-center justify-between gap-4">
              <div className="min-w-0 space-y-0.5">
                <p className="text-foreground text-sm font-medium">Enforce SSO for this domain</p>
                <p className="text-muted-foreground text-xs">
                  Members must sign in with your identity provider — the password option disappears
                  the moment this is on, and only your identity provider works after that.
                </p>
              </div>
              {canManage && (
                <Switch
                  checked={!!provider.enforce_sso}
                  onCheckedChange={(checked) => enforceSsoMutation.mutate(checked)}
                  disabled={enforceSsoMutation.isPending || providerQuery.isLoading}
                  aria-label="Enforce SSO for this domain"
                />
              )}
            </div>
          </div>
        )}

        {provider && (
          <div className="border-border border-t">
            <Disclosure className="group">
              <DisclosureTrigger>
                <div className="flex w-full cursor-pointer items-center justify-between gap-3 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-foreground flex items-center gap-2 text-sm font-medium">
                      Group mappings
                      {mappings.length > 0 && (
                        <Badge variant="muted" size="sm">
                          {mappings.length}
                        </Badge>
                      )}
                    </p>
                    <p className="text-muted-foreground mt-0.5 text-xs">
                      Route IdP group values (from the{' '}
                      <span className="font-mono">{provider.group_claim_name}</span> claim) to
                      specific IAM groups.
                    </p>
                  </div>
                  <ChevronDown className="text-muted-foreground size-4 shrink-0 transition-transform group-data-[state=open]:rotate-180" />
                </div>
              </DisclosureTrigger>
              <DisclosureContent contentClassName="border-border border-t">
                {canManage && (
                  <div className="flex justify-end px-4 pt-3">
                    <Button
                      size="sm"
                      variant="outline"
                      className="gap-1.5"
                      onClick={() => setMapOpen(true)}
                    >
                      <Plus className="size-3.5 shrink-0" />
                      Add mapping
                    </Button>
                  </div>
                )}
                {mappingsQuery.isLoading ? (
                  <div className="px-4 py-3">
                    <Skeleton className="h-8 w-full rounded-md" />
                  </div>
                ) : mappings.length === 0 ? (
                  <p className="text-muted-foreground px-4 py-4 text-xs">
                    No mappings yet — with auto-provision on, your IdP&apos;s groups appear by
                    themselves; add a mapping only to route a claim value into a specific existing
                    group.
                  </p>
                ) : (
                  <div className="divide-border divide-y">
                    {mappings.map((m) => (
                      <div key={m.mapping_id} className="flex items-center gap-2.5 px-4 py-3">
                        <code
                          title={m.claim_value}
                          className="text-foreground max-w-[42%] truncate font-mono text-xs"
                        >
                          {m.claim_value}
                        </code>
                        <ArrowRight className="text-muted-foreground/50 size-3.5 shrink-0" />
                        <Badge variant="outline" size="sm" className="min-w-0 max-w-[42%] truncate">
                          {m.group_name}
                        </Badge>
                        <span className="flex-1" />
                        {canManage && (
                          <Button
                            size="icon"
                            variant="ghost"
                            className="text-muted-foreground hover:text-destructive shrink-0"
                            onClick={() => setMapDeleteTarget(m)}
                            aria-label="Remove mapping"
                          >
                            <X className="size-3.5 shrink-0" />
                          </Button>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </DisclosureContent>
            </Disclosure>
          </div>
        )}

        {/* Reference values, collapsed in BOTH states — needed only while
            configuring the IdP side, so they stay out of the way otherwise. */}
        {spUrls && (
          <div className="border-border border-t">
            <Disclosure className="group">
              <DisclosureTrigger>
                <div className="flex w-full cursor-pointer items-center justify-between gap-3 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-foreground text-sm font-medium">Service provider values</p>
                    <p className="text-muted-foreground mt-0.5 text-xs">
                      The Entity ID and ACS URL your IdP's SAML config asks for.
                    </p>
                  </div>
                  <ChevronDown className="text-muted-foreground size-4 shrink-0 transition-transform group-data-[state=open]:rotate-180" />
                </div>
              </DisclosureTrigger>
              <DisclosureContent contentClassName="border-border border-t">
                <div className="px-4 py-4">
                  <SpDetails urls={spUrls} heading={false} />
                </div>
              </DisclosureContent>
            </Disclosure>
          </div>
        )}

        {provider && canManage && (
          <div className="border-border flex justify-end border-t px-4 py-3">
            <Button
              size="sm"
              variant="ghost"
              className="text-destructive hover:text-destructive gap-1.5"
              onClick={() => setDeleteOpen(true)}
            >
              <Trash2 className="size-3.5 shrink-0" />
              Remove SSO provider
            </Button>
          </div>
        )}
      </div>

      {/* Edit only. A provider is CREATED in the guided wizard
          (features/sso-setup) — the dialog has no create branch to reach. */}
      {provider && (
        <EditProviderDialog
          accountId={accountId}
          open={editOpen}
          onOpenChange={setEditOpen}
          existing={provider}
          onSaved={() => {
            queryClient.invalidateQueries({ queryKey: ['iam-sso-provider', accountId] });
            queryClient.invalidateQueries({ queryKey: ['iam-sso-mappings', accountId] });
          }}
        />
      )}

      <AddMappingDialog
        accountId={accountId}
        open={mapOpen}
        onOpenChange={setMapOpen}
        onCreated={() =>
          queryClient.invalidateQueries({ queryKey: ['iam-sso-mappings', accountId] })
        }
      />

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title="Remove SSO provider?"
        description="Existing members keep their access; new sign-ins via SAML stop being provisioned and group sync no longer runs."
        confirmLabel="Remove provider"
        confirmVariant="destructive"
        isPending={deleteMutation.isPending}
        onConfirm={() => deleteMutation.mutate()}
      />

      <ConfirmDialog
        open={!!mapDeleteTarget}
        onOpenChange={(o) => {
          if (!o) setMapDeleteTarget(null);
        }}
        title="Remove mapping?"
        description={
          mapDeleteTarget
            ? `Users with the "${mapDeleteTarget.claim_value}" claim will no longer auto-join "${mapDeleteTarget.group_name}".`
            : ''
        }
        confirmLabel="Remove mapping"
        confirmVariant="destructive"
        isPending={deleteMappingMutation.isPending}
        onConfirm={() => {
          if (mapDeleteTarget) deleteMappingMutation.mutate(mapDeleteTarget.mapping_id);
        }}
      />
    </div>
  );
}

// ─── Edit provider dialog ─────────────────────────────────────────────────
//
// EDIT ONLY. Registering a NEW provider means importing IdP metadata, and
// that lives in the guided wizard (`features/sso-setup/setup-wizard.tsx`
// → `ImportForm`), which is the only entry point the card offers when no
// provider exists. The dialog's old create branch was unreachable from the
// UI and duplicated the wizard's form verbatim — it is gone.

function EditProviderDialog({
  accountId,
  open,
  onOpenChange,
  existing,
  onSaved,
}: {
  accountId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  existing: SsoProvider;
  onSaved: () => void;
}) {
  const { user } = useAuth();
  // The current admin's own email domain — if this account routes it to the
  // IdP and the admin isn't ALSO the identity that comes back from that IdP,
  // they can lock themselves out or silently land signed in as someone else
  // via IdP session reuse. Warn before that surprises anyone.
  const adminEmailDomain = user?.email?.split('@')[1]?.trim().toLowerCase() || null;
  const [name, setName] = useState(existing.name);
  const [domain, setDomain] = useState(existing.primary_domain);
  const [claim, setClaim] = useState(existing.group_claim_name);
  const [autoCreate, setAutoCreate] = useState(existing.auto_create_members);
  const [autoProvision, setAutoProvision] = useState(existing.auto_provision_groups);

  // Hydrate when opening for edit; reset when closing.
  useMemo(() => {
    if (open) {
      setName(existing.name);
      setDomain(existing.primary_domain);
      setClaim(existing.group_claim_name);
      setAutoCreate(existing.auto_create_members);
      setAutoProvision(existing.auto_provision_groups);
    }
  }, [open, existing]);

  const mutation = useMutation({
    mutationFn: () =>
      upsertSsoProvider(accountId, {
        // Threaded from the loaded provider — an internal id, never shown
        // or editable in the UI.
        supabase_sso_provider_id: existing.supabase_sso_provider_id,
        name: name.trim(),
        primary_domain: domain.trim().toLowerCase(),
        group_claim_name: claim.trim() || 'groups',
        auto_create_members: autoCreate,
        auto_provision_groups: autoProvision,
      }),
    onSuccess: () => {
      successToast('SSO provider updated');
      onSaved();
      onOpenChange(false);
    },
    onError: (err: Error) => errorToast(err.message || 'Failed to save provider'),
  });

  const ready = name.trim().length > 0 && /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain.trim());

  const spUrls = useSpUrls();

  return (
    <Modal open={open} onOpenChange={(o) => !mutation.isPending && onOpenChange(o)}>
      <ModalContent className="lg:max-w-lg">
        <ModalHeader>
          <ModalTitle>Edit SAML provider</ModalTitle>
          <ModalDescription>
            Update the display name, sign-in domain, and group-claim settings for your identity
            provider.
          </ModalDescription>
        </ModalHeader>

        <ModalBody className="max-h-[60vh] space-y-4 overflow-y-auto">
          {spUrls && (
            <SpDetails urls={spUrls} className="bg-muted/20 rounded-md border px-3 py-3" />
          )}

          <div className="space-y-1.5">
            <Label>Display name</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Azure AD"
              disabled={mutation.isPending}
              variant="popover"
            />
          </div>

          <div className="space-y-1.5">
            <Label>Primary email domain</Label>
            <Input
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              placeholder="acme.com"
              disabled={mutation.isPending}
              variant="popover"
            />
            <p className="text-muted-foreground text-xs">
              Every sign-in from this domain is routed to this identity provider instead of password
              login — only add a domain your IdP actually controls. Users on other domains are
              unaffected.
            </p>
            {adminEmailDomain && domain.trim().toLowerCase() === adminEmailDomain && (
              <p className="text-kortix-yellow text-xs">
                This is your own email domain — saving this will route YOUR next sign-in to the IdP
                too. Make sure your account exists there before you continue.
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label>Group claim name</Label>
            <Input
              value={claim}
              onChange={(e) => setClaim(e.target.value)}
              placeholder="groups"
              className="font-mono text-xs"
              disabled={mutation.isPending}
              variant="popover"
            />
            <p className="text-muted-foreground text-xs">
              Common values: <span className="font-mono">groups</span> (Okta),{' '}
              <span className="font-mono">memberOf</span> (Azure AD).
            </p>
            <p className="text-muted-foreground text-xs leading-relaxed">
              <span className="text-kortix-yellow">Entra tip:</span> set your SAML{' '}
              <span className="font-mono">emailaddress</span> claim source to{' '}
              <span className="font-mono">userPrincipalName</span> — onmicrosoft.com users have no{' '}
              <span className="font-mono">mail</span>, and an empty email breaks sign-in. Entra also
              emits group <span className="font-mono">Object IDs</span> by default: map those, or
              emit names via “Groups assigned to the application” (needs Entra ID P1/P2).
            </p>
          </div>

          <label className="text-foreground flex cursor-pointer items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={autoCreate}
              onChange={(e) => setAutoCreate(e.target.checked)}
              className="border-border accent-primary mt-0.5 size-3.5 rounded"
              disabled={mutation.isPending}
            />
            <span>
              <span className="font-medium">Auto-create members</span>
              <span className="text-muted-foreground block text-xs">
                When off, only users an admin has already invited can sign in via SAML. Group sync
                still runs for those members.
              </span>
            </span>
          </label>

          <label className="text-foreground flex cursor-pointer items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={autoProvision}
              onChange={(e) => setAutoProvision(e.target.checked)}
              className="border-border accent-primary mt-0.5 size-3.5 rounded"
              disabled={mutation.isPending}
            />
            <span>
              <span className="font-medium">Auto-provision groups</span>
              <span className="text-muted-foreground block text-xs">
                Create an IAM group for every group the IdP sends and add users to it — no per-group
                mapping. You just attach project roles to the auto-created groups.
              </span>
            </span>
          </label>
        </ModalBody>

        <ModalFooter className="sm:justify-between">
          <Button
            type="button"
            variant="outline-ghost"
            size="sm"
            onClick={() => onOpenChange(false)}
            disabled={mutation.isPending}
          >
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={() => mutation.mutate()}
            disabled={!ready || mutation.isPending}
            className="gap-1.5"
          >
            {mutation.isPending && <Loading className="size-3.5 shrink-0" />}
            Save changes
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}

// ─── Add mapping dialog ───────────────────────────────────────────────────

function AddMappingDialog({
  accountId,
  open,
  onOpenChange,
  onCreated,
}: {
  accountId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
}) {
  const [claimValue, setClaimValue] = useState('');
  // The ONE principal picker. Group-only, single-select — the same control
  // every other "who is this for?" field in the access surface uses.
  const [principal, setPrincipal] = useState<PrincipalSelection>(EMPTY_PRINCIPAL_SELECTION);
  const selected = singlePrincipal(principal);
  const groupId = selected?.kind === 'group' ? selected.id : '';

  // Reset on open so re-opening doesn't leak the previous selection.
  useMemo(() => {
    if (open) {
      setClaimValue('');
      setPrincipal(EMPTY_PRINCIPAL_SELECTION);
    }
  }, [open]);

  const mutation = useMutation({
    mutationFn: () =>
      createSsoGroupMapping(accountId, {
        claim_value: claimValue.trim(),
        group_id: groupId,
      }),
    onSuccess: () => {
      successToast('Mapping added');
      onCreated();
      onOpenChange(false);
    },
    onError: (err: Error) => errorToast(err.message || 'Failed to add mapping'),
  });

  const ready = claimValue.trim().length > 0 && groupId.length > 0;

  return (
    <Modal open={open} onOpenChange={(o) => !mutation.isPending && onOpenChange(o)}>
      <ModalContent className="lg:max-w-lg">
        <ModalHeader>
          <ModalTitle>Add group mapping</ModalTitle>
          <ModalDescription>
            Users with this claim value in their SAML token will be added to the chosen IAM group on
            sign-in.
          </ModalDescription>
        </ModalHeader>

        <ModalBody className="space-y-4">
          <div className="space-y-1.5">
            <Label>Claim value</Label>
            <Input
              value={claimValue}
              onChange={(e) => setClaimValue(e.target.value)}
              placeholder="Engineers"
              className="font-mono text-xs"
              disabled={mutation.isPending}
              variant="popover"
            />
            <p className="text-muted-foreground text-xs">
              Exact, case-sensitive match against an entry in the group claim your IdP sends.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label>IAM group</Label>
            <PrincipalPicker
              scope={{ kind: 'account', accountId }}
              selection="single"
              kinds={['group']}
              value={principal}
              onChange={setPrincipal}
              disabled={mutation.isPending}
              autoFocus={false}
              emptyLabel="No groups in this account yet. Create one first."
            />
          </div>
        </ModalBody>

        <ModalFooter className="sm:justify-between">
          <Button
            type="button"
            variant="outline-ghost"
            size="sm"
            onClick={() => onOpenChange(false)}
            disabled={mutation.isPending}
          >
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={() => mutation.mutate()}
            disabled={!ready || mutation.isPending}
            className="gap-1.5"
          >
            {mutation.isPending && <Loading className="size-3.5 shrink-0" />}
            Add mapping
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
