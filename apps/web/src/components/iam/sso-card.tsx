'use client';

// SAML SSO config on the Settings tab. The Supabase auth.sso_providers
// row is created out-of-band (Studio or auth admin API) — admins paste
// the resulting UUID + primary email domain here, plus the JWT claim
// holding group memberships. Once configured, every SAML-issued JWT
// triggers JIT membership + group sync in the auth middleware.

import { getEnv } from '@/lib/env-config';
import { errorToast, successToast } from '@/components/ui/toast';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Check, Copy, Plus, Trash2, X } from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import Loading from '@/components/ui/loading';
import { Switch } from '@/components/ui/switch';
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
import { Skeleton } from '@/components/ui/skeleton';
import { useAuth } from '@/features/providers/auth-provider';
import {
  type SsoGroupMapping,
  type SsoProvider,
  createSsoGroupMapping,
  deleteSsoGroupMapping,
  deleteSsoProvider,
  getSsoProvider,
  importSsoProviderFromMetadata,
  listGroups,
  listSsoGroupMappings,
  upsertSsoProvider,
} from '@/lib/iam-client';

import { type SamlSpUrls, buildSamlSpUrls } from '@/lib/saml-sp';

async function copyToClipboard(value: string, successMsg = 'Copied to clipboard') {
  try {
    await navigator.clipboard.writeText(value);
    successToast(successMsg);
  } catch {
    errorToast('Copy failed — select and copy manually');
  }
}

/**
 * "Service provider details" block — the Entity ID + Reply URL (ACS) admins
 * paste into their IdP's SAML configuration. Shown both before a provider is
 * configured (admins need these values first) and inside the configure/edit
 * dialog. Deliberately does not mention the delegated identity provider by
 * name — see sso-card.test.ts.
 */
function SpDetails({ urls, className }: { urls: SamlSpUrls; className?: string }) {
  return (
    <div className={className}>
      <h3 className="text-foreground text-sm font-medium">Service provider details</h3>
      <p className="text-muted-foreground mt-0.5 text-xs">
        Paste these into your identity provider's SAML configuration.
      </p>
      <div className="mt-3 space-y-3">
        <div className="space-y-1.5">
          <Label className="text-xs">Identifier (Entity ID)</Label>
          <div className="flex items-center gap-2">
            <code className="bg-muted/30 min-w-0 flex-1 truncate rounded-md border px-3 py-2 font-mono text-xs">
              {urls.entityId}
            </code>
            <Button
              variant="outline"
              size="icon"
              aria-label="Copy Identifier (Entity ID)"
              onClick={() => copyToClipboard(urls.entityId, 'Entity ID copied')}
            >
              <Copy className="size-3.5 shrink-0" />
            </Button>
          </div>
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">Reply URL (ACS)</Label>
          <div className="flex items-center gap-2">
            <code className="bg-muted/30 min-w-0 flex-1 truncate rounded-md border px-3 py-2 font-mono text-xs">
              {urls.acsUrl}
            </code>
            <Button
              variant="outline"
              size="icon"
              aria-label="Copy Reply URL (ACS)"
              onClick={() => copyToClipboard(urls.acsUrl, 'Reply URL copied')}
            >
              <Copy className="size-3.5 shrink-0" />
            </Button>
          </div>
        </div>
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
  const spUrls = useMemo(() => buildSamlSpUrls(getEnv().SUPABASE_URL), []);

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
        {!provider && spUrls && (
          <div className="px-4 py-5">
            <SpDetails urls={spUrls} />
          </div>
        )}

        {provider && (
          <div className="px-4 py-5">
            {providerQuery.isLoading ? (
              <Skeleton className="h-16 w-full rounded-md" />
            ) : (
              <dl className="divide-border divide-y text-sm">
                <div className="flex items-center justify-between gap-4 py-2 first:pt-0 last:pb-0">
                  <dt className="text-muted-foreground shrink-0">Provider</dt>
                  <dd className="text-foreground min-w-0 truncate text-right font-medium">
                    {provider.name}
                  </dd>
                </div>
                <div className="flex items-center justify-between gap-4 py-2 first:pt-0 last:pb-0">
                  <dt className="text-muted-foreground shrink-0">Primary domain</dt>
                  <dd className="text-foreground min-w-0 truncate text-right font-mono text-xs">
                    {provider.primary_domain}
                  </dd>
                </div>
                <div className="flex items-center justify-between gap-4 py-2 first:pt-0 last:pb-0">
                  <dt className="text-muted-foreground shrink-0">Group claim</dt>
                  <dd className="min-w-0 truncate text-right">
                    <code className="bg-muted/60 text-foreground rounded px-1.5 py-0.5 font-mono text-xs">
                      {provider.group_claim_name}
                    </code>
                  </dd>
                </div>
                <div className="flex items-center justify-between gap-4 py-2 first:pt-0 last:pb-0">
                  <dt className="text-muted-foreground shrink-0">Auto-create members</dt>
                  <dd className="text-right">
                    {provider.auto_create_members ? (
                      <span className="text-kortix-green inline-flex items-center gap-1 font-medium">
                        <Check className="size-3.5 shrink-0" />
                        Yes
                      </span>
                    ) : (
                      <span className="text-muted-foreground">No</span>
                    )}
                  </dd>
                </div>
                <div className="flex items-center justify-between gap-4 py-2 first:pt-0 last:pb-0">
                  <dt className="text-muted-foreground shrink-0">Auto-provision groups</dt>
                  <dd className="text-right">
                    {provider.auto_provision_groups ? (
                      <span className="text-kortix-green inline-flex items-center gap-1 font-medium">
                        <Check className="size-3.5 shrink-0" />
                        Yes
                      </span>
                    ) : (
                      <span className="text-muted-foreground">No</span>
                    )}
                  </dd>
                </div>
              </dl>
            )}
          </div>
        )}

        {provider && (
          <div className="border-border border-t px-4 py-4">
            <div className="flex items-center justify-between gap-4">
              <div className="min-w-0 space-y-0.5">
                <p className="text-foreground text-sm font-medium">
                  Enforce SSO for this domain
                </p>
                <p className="text-muted-foreground text-xs">
                  Members must sign in with your identity provider — the password option
                  disappears.
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
            <p className="text-muted-foreground mt-2 text-xs">
              Anyone on this domain who currently signs in with a password loses that option the
              moment you turn this on — only your identity provider works after that.
            </p>
          </div>
        )}

        {provider && (
          <div className="border-border border-t">
            <div className="flex items-center justify-between gap-3 px-4 py-3">
              <p className="text-foreground text-sm font-medium">Group mappings</p>
              {canManage && (
                <Button
                  size="sm"
                  variant="outline"
                  className="gap-1.5"
                  onClick={() => setMapOpen(true)}
                >
                  <Plus className="size-3.5 shrink-0" />
                  Add mapping
                </Button>
              )}
            </div>
            <div className="border-border border-t">
              {mappingsQuery.isLoading ? (
                <div className="px-4 py-3">
                  <Skeleton className="h-8 w-full rounded-md" />
                </div>
              ) : mappings.length === 0 ? (
                <p className="text-muted-foreground px-4 py-4 text-xs">
                  No mappings yet. Map IdP group/role values (from the{' '}
                  <span className="font-mono">{provider.group_claim_name}</span> claim) to IAM
                  groups so users land in the right group on sign-in.
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
            </div>
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

      <EditProviderDialog
        accountId={accountId}
        open={editOpen}
        onOpenChange={setEditOpen}
        existing={provider ?? null}
        onSaved={() => {
          queryClient.invalidateQueries({ queryKey: ['iam-sso-provider', accountId] });
          queryClient.invalidateQueries({ queryKey: ['iam-sso-mappings', accountId] });
        }}
      />

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

// ─── Edit / create provider dialog ────────────────────────────────────────

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
  existing: SsoProvider | null;
  onSaved: () => void;
}) {
  const { user } = useAuth();
  // The current admin's own email domain — if this account routes it to the
  // IdP and the admin isn't ALSO the identity that comes back from that IdP,
  // they can lock themselves out or silently land signed in as someone else
  // via IdP session reuse. Warn before that surprises anyone.
  const adminEmailDomain = user?.email?.split('@')[1]?.trim().toLowerCase() || null;
  const [name, setName] = useState(existing?.name ?? '');
  const [domain, setDomain] = useState(existing?.primary_domain ?? '');
  const [claim, setClaim] = useState(existing?.group_claim_name ?? 'groups');
  const [autoCreate, setAutoCreate] = useState(existing?.auto_create_members ?? true);
  // New connections default auto-provision ON (groups appear without
  // hand-mapping); an existing provider keeps whatever the admin chose.
  const [autoProvision, setAutoProvision] = useState(existing ? existing.auto_provision_groups : true);
  // New providers register by importing the IdP metadata (XML or URL) — the
  // backend handles the identity-provider registration; no internals surface in
  // the UI. Edits reuse the stored provider id under the hood.
  const [metaKind, setMetaKind] = useState<'xml' | 'url'>('xml');
  const [metaXml, setMetaXml] = useState('');
  const [metaUrl, setMetaUrl] = useState('');

  // Hydrate when opening for edit; reset when closing.
  useMemo(() => {
    if (open) {
      setName(existing?.name ?? '');
      setDomain(existing?.primary_domain ?? '');
      setClaim(existing?.group_claim_name ?? 'groups');
      setAutoCreate(existing?.auto_create_members ?? true);
      setAutoProvision(existing ? existing.auto_provision_groups : true);
      setMetaKind('xml');
      setMetaXml('');
      setMetaUrl('');
    }
  }, [open, existing]);

  const importing = !existing;
  const mutation = useMutation({
    mutationFn: () =>
      importing
        ? importSsoProviderFromMetadata(accountId, {
            name: name.trim(),
            primary_domain: domain.trim().toLowerCase(),
            group_claim_name: claim.trim() || 'groups',
            auto_create_members: autoCreate,
            auto_provision_groups: autoProvision,
            ...(metaKind === 'xml'
              ? { metadata_xml: metaXml.trim() }
              : { metadata_url: metaUrl.trim() }),
          })
        : upsertSsoProvider(accountId, {
            // Threaded from the loaded provider — an internal id, never shown
            // or editable in the UI.
            supabase_sso_provider_id: existing!.supabase_sso_provider_id,
            name: name.trim(),
            primary_domain: domain.trim().toLowerCase(),
            group_claim_name: claim.trim() || 'groups',
            auto_create_members: autoCreate,
            auto_provision_groups: autoProvision,
          }),
    onSuccess: () => {
      successToast(existing ? 'SSO provider updated' : 'SSO provider configured');
      onSaved();
      onOpenChange(false);
    },
    onError: (err: Error) => errorToast(err.message || 'Failed to save provider'),
  });

  const metadataReady =
    metaKind === 'xml' ? metaXml.trim().length > 40 : /^https?:\/\/.+/i.test(metaUrl.trim());
  const ready =
    name.trim().length > 0 &&
    /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain.trim()) &&
    (importing ? metadataReady : true);

  const spUrls = useMemo(() => buildSamlSpUrls(getEnv().SUPABASE_URL), []);

  return (
    <Modal open={open} onOpenChange={(o) => !mutation.isPending && onOpenChange(o)}>
      <ModalContent className="lg:max-w-lg">
        <ModalHeader>
          <ModalTitle>{existing ? 'Edit SAML provider' : 'Configure SAML SSO'}</ModalTitle>
          <ModalDescription>
            {existing
              ? 'Update the display name, sign-in domain, and group-claim settings for your identity provider.'
              : 'Paste your IdP’s SAML metadata (Entra → “App Federation Metadata XML”) and we register it for you.'}
          </ModalDescription>
        </ModalHeader>

        <ModalBody className="max-h-[60vh] space-y-4 overflow-y-auto">
          {spUrls && <SpDetails urls={spUrls} className="bg-muted/20 rounded-md border px-3 py-3" />}

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

          {importing && (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label>IdP SAML metadata</Label>
                <div className="border-border inline-flex overflow-hidden rounded-md border">
                  {(
                    [
                      ['xml', 'Paste XML'],
                      ['url', 'From URL'],
                    ] as const
                  ).map(([k, label]) => (
                    <button
                      key={k}
                      type="button"
                      onClick={() => setMetaKind(k)}
                      disabled={mutation.isPending}
                      className={
                        metaKind === k
                          ? 'bg-secondary text-foreground px-2.5 py-1 text-xs font-medium'
                          : 'text-muted-foreground hover:bg-muted/50 px-2.5 py-1 text-xs'
                      }
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
              {metaKind === 'xml' ? (
                <textarea
                  value={metaXml}
                  onChange={(e) => setMetaXml(e.target.value)}
                  placeholder="<EntityDescriptor …>…</EntityDescriptor>"
                  disabled={mutation.isPending}
                  rows={5}
                  className="border-border bg-popover focus-visible:ring-ring w-full resize-y rounded-md border px-3 py-2 font-mono text-xs outline-none focus-visible:ring-1"
                />
              ) : (
                <Input
                  value={metaUrl}
                  onChange={(e) => setMetaUrl(e.target.value)}
                  placeholder="https://login.microsoftonline.com/<tenant>/federationmetadata/…"
                  className="text-xs"
                  disabled={mutation.isPending}
                  variant="popover"
                />
              )}
              <p className="text-muted-foreground text-xs">
                From Entra: Enterprise App → Single sign-on → SAML → “App Federation Metadata XML”.
              </p>
            </div>
          )}

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
              Every sign-in from this domain is routed to this identity provider instead of
              password login — only add a domain your IdP actually controls. Users on other
              domains are unaffected.
            </p>
            {adminEmailDomain && domain.trim().toLowerCase() === adminEmailDomain && (
              <p className="text-kortix-yellow text-xs">
                This is your own email domain — saving this will route YOUR next sign-in to the
                IdP too. Make sure your account exists there before you continue.
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
              <span className="font-mono">userPrincipalName</span> — onmicrosoft.com users have
              no <span className="font-mono">mail</span>, and an empty email breaks sign-in. Entra
              also emits group <span className="font-mono">Object IDs</span> by default: map
              those, or emit names via “Groups assigned to the application” (needs Entra ID
              P1/P2).
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
                When off, only users an admin has already invited can sign in via SAML. Group
                sync still runs for those members.
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
                Create an IAM group for every group the IdP sends and add users to it — no
                per-group mapping. You just attach project roles to the auto-created groups.
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
            {existing ? 'Save changes' : 'Import & configure'}
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
  const [groupId, setGroupId] = useState('');

  const groupsQuery = useQuery({
    queryKey: ['account-groups', accountId],
    queryFn: () => listGroups(accountId),
    enabled: open,
    staleTime: 30_000,
  });

  // Reset on open so re-opening doesn't leak the previous selection.
  useMemo(() => {
    if (open) {
      setClaimValue('');
      setGroupId('');
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

  const groups = groupsQuery.data ?? [];
  const ready = claimValue.trim().length > 0 && groupId.length > 0;

  return (
    <Modal open={open} onOpenChange={(o) => !mutation.isPending && onOpenChange(o)}>
      <ModalContent className="lg:max-w-lg">
        <ModalHeader>
          <ModalTitle>Add group mapping</ModalTitle>
          <ModalDescription>
            Users with this claim value in their SAML token will be added to the chosen IAM group
            on sign-in.
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
            <Select
              value={groupId || undefined}
              onValueChange={setGroupId}
              disabled={mutation.isPending || groupsQuery.isLoading}
            >
              <SelectTrigger variant="popover">
                <SelectValue placeholder="Pick a group..." />
              </SelectTrigger>
              <SelectContent>
                {groups.length === 0 ? (
                  <div className="text-muted-foreground px-2 py-1.5 text-xs">
                    No groups in this account yet. Create one first.
                  </div>
                ) : (
                  groups.map((g) => (
                    <SelectItem key={g.group_id} value={g.group_id}>
                      {g.name}
                    </SelectItem>
                  ))
                )}
              </SelectContent>
            </Select>
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
