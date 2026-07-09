'use client';

import { useTranslations } from 'next-intl';
// SAML SSO config on the Settings tab. The Supabase auth.sso_providers
// row is created out-of-band (Studio or auth admin API) — admins paste
// the resulting UUID + primary email domain here, plus the JWT claim
// holding group memberships. Once configured, every SAML-issued JWT
// triggers JIT membership + group sync in the auth middleware.

import { toast } from '@/lib/toast';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Check, Loader2, Plus, ShieldCheck, Trash2, X } from 'lucide-react';
import { useMemo, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
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

interface SsoCardProps {
  accountId: string;
  canManage: boolean;
}

export function SsoCard({ accountId, canManage }: SsoCardProps) {
  const tHardcodedUi = useTranslations('hardcodedUi');
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
      toast.success('SSO provider removed');
      queryClient.invalidateQueries({ queryKey: ['iam-sso-provider', accountId] });
      queryClient.invalidateQueries({ queryKey: ['iam-sso-mappings', accountId] });
      setDeleteOpen(false);
    },
    onError: (err: Error) => toast.error(err.message || 'Failed to remove provider'),
  });

  const deleteMappingMutation = useMutation({
    mutationFn: (mappingId: string) => deleteSsoGroupMapping(accountId, mappingId),
    onSuccess: () => {
      toast.success('Mapping removed');
      queryClient.invalidateQueries({ queryKey: ['iam-sso-mappings', accountId] });
      setMapDeleteTarget(null);
    },
    onError: (err: Error) => toast.error(err.message || 'Failed to remove mapping'),
  });

  const provider = providerQuery.data;
  const mappings = mappingsQuery.data ?? [];

  return (
    <section className="border-border/70 bg-card rounded-xl border">
      <header className={provider ? 'border-border/60 border-b px-6 py-4' : 'px-6 py-4'}>
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-foreground flex items-center gap-2 text-base font-semibold">
              <ShieldCheck className="text-muted-foreground h-4 w-4" />
              {tHardcodedUi.raw('componentsIamSsoCard.line103JsxTextSAMLSSO')}
              {provider && (
                <Badge
                  variant="outline"
                  size="sm"
                  className="border-emerald-500/40 bg-emerald-500/10 text-[10px] font-normal text-emerald-700 dark:text-emerald-300"
                >
                  connected
                </Badge>
              )}
            </h2>
            <p className="text-muted-foreground mt-0.5 text-xs">
              {provider
                ? tHardcodedUi.raw(
                    'componentsIamSsoCard.line106JsxTextConnectYourIdPUsersSigningInViaSAML',
                  )
                : 'Auto-provision members from your IdP. Group claims sync to IAM groups.'}
            </p>
          </div>
          {canManage && (
            <Button
              variant={provider ? 'outline' : 'default'}
              onClick={() => setEditOpen(true)}
              size="sm"
              className="shrink-0"
            >
              {provider ? 'Edit' : 'Configure'}
            </Button>
          )}
        </div>
      </header>

      {provider && (
        <div className="px-6 py-4">
          {providerQuery.isLoading ? (
            <Skeleton className="h-16 w-full" />
          ) : (
            <dl className="text-sm">
              <div className="border-border/40 flex items-center justify-between gap-4 border-b py-2">
                <dt className="text-muted-foreground shrink-0">Provider</dt>
                <dd className="text-foreground min-w-0 truncate text-right font-medium">
                  {provider.name}
                </dd>
              </div>
              <div className="border-border/40 flex items-center justify-between gap-4 border-b py-2">
                <dt className="text-muted-foreground shrink-0">
                  {tHardcodedUi.raw('componentsIamSsoCard.line135JsxTextPrimaryDomain')}
                </dt>
                <dd className="text-foreground min-w-0 truncate text-right font-mono text-xs">
                  {provider.primary_domain}
                </dd>
              </div>
              <div className="border-border/40 flex items-center justify-between gap-4 border-b py-2">
                <dt className="text-muted-foreground shrink-0">
                  {tHardcodedUi.raw('componentsIamSsoCard.line137JsxTextGroupClaim')}
                </dt>
                <dd className="min-w-0 truncate text-right">
                  <code className="bg-muted/60 text-foreground rounded px-1.5 py-0.5 font-mono text-[11px]">
                    {provider.group_claim_name}
                  </code>
                </dd>
              </div>
              <div className="border-border/40 flex items-center justify-between gap-4 border-b py-2">
                <dt className="text-muted-foreground shrink-0">
                  {tHardcodedUi.raw('componentsIamSsoCard.line139JsxTextAutoCreateMembers')}
                </dt>
                <dd className="text-right">
                  {provider.auto_create_members ? (
                    <span className="inline-flex items-center gap-1 font-medium text-emerald-600 dark:text-emerald-400">
                      <Check className="h-3.5 w-3.5" />
                      Yes
                    </span>
                  ) : (
                    <span className="text-muted-foreground">No</span>
                  )}
                </dd>
              </div>
              <div className="flex items-center justify-between gap-4 py-2">
                <dt className="text-muted-foreground shrink-0">Auto-provision groups</dt>
                <dd className="text-right">
                  {provider.auto_provision_groups ? (
                    <span className="inline-flex items-center gap-1 font-medium text-emerald-600 dark:text-emerald-400">
                      <Check className="h-3.5 w-3.5" />
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
        <>
          <header className="border-border/60 flex items-center justify-between border-t px-6 py-3">
            <h3 className="text-foreground text-sm font-medium">
              {tHardcodedUi.raw('componentsIamSsoCard.line154JsxTextGroupMappings')}
            </h3>
            {canManage && (
              <Button
                size="sm"
                variant="outline"
                className="gap-1.5"
                onClick={() => setMapOpen(true)}
              >
                <Plus className="h-3.5 w-3.5" />
                {tHardcodedUi.raw('componentsIamSsoCard.line163JsxTextAddMapping')}
              </Button>
            )}
          </header>
          <div className="px-6 pb-5">
            {mappingsQuery.isLoading ? (
              <Skeleton className="h-12 w-full" />
            ) : mappings.length === 0 ? (
              <p className="text-muted-foreground text-xs">
                {tHardcodedUi.raw(
                  'componentsIamSsoCard.line172JsxTextNoMappingsYetMapIdPGroupRoleValues',
                )}{' '}
                <span className="font-mono">{provider.group_claim_name}</span>{' '}
                {tHardcodedUi.raw(
                  'componentsIamSsoCard.line173JsxTextClaimToIAMGroupsSoUsersLandIn',
                )}
              </p>
            ) : (
              <ul className="space-y-1.5">
                {mappings.map((m) => (
                  <li
                    key={m.mapping_id}
                    className="border-border/60 bg-muted/20 flex items-center gap-2.5 rounded-lg border px-3 py-2"
                  >
                    <code
                      title={m.claim_value}
                      className="text-foreground max-w-[42%] truncate font-mono text-xs"
                    >
                      {m.claim_value}
                    </code>
                    <ArrowRight className="text-muted-foreground/50 h-3.5 w-3.5 shrink-0" />
                    <Badge variant="outline" size="sm" className="min-w-0 max-w-[42%] truncate">
                      {m.group_name}
                    </Badge>
                    <span className="flex-1" />
                    {canManage && (
                      <Button
                        size="icon"
                        variant="ghost"
                        className="text-muted-foreground hover:text-destructive h-7 w-7 shrink-0"
                        onClick={() => setMapDeleteTarget(m)}
                        aria-label={tHardcodedUi.raw(
                          'componentsIamSsoCard.line201JsxAttrAriaLabelRemoveMapping',
                        )}
                      >
                        <X className="h-3.5 w-3.5" />
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}

      {provider && canManage && (
        <footer className="border-border/60 flex justify-end border-t px-6 py-3">
          <Button
            size="sm"
            variant="ghost"
            className="text-destructive hover:text-destructive"
            onClick={() => setDeleteOpen(true)}
          >
            <Trash2 className="mr-1.5 h-3.5 w-3.5" />
            {tHardcodedUi.raw('componentsIamSsoCard.line225JsxTextRemoveSSOProvider')}
          </Button>
        </footer>
      )}

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
        title={tHardcodedUi.raw('componentsIamSsoCard.line253JsxAttrTitleRemoveSSOProvider')}
        description={tHardcodedUi.raw(
          'componentsIamSsoCard.line254JsxAttrDescriptionExistingMembersKeepTheirAccessNewSignIns',
        )}
        confirmLabel={tHardcodedUi.raw(
          'componentsIamSsoCard.line255JsxAttrConfirmLabelRemoveProvider',
        )}
        confirmVariant="destructive"
        isPending={deleteMutation.isPending}
        onConfirm={() => deleteMutation.mutate()}
      />

      <ConfirmDialog
        open={!!mapDeleteTarget}
        onOpenChange={(o) => {
          if (!o) setMapDeleteTarget(null);
        }}
        title={tHardcodedUi.raw('componentsIamSsoCard.line266JsxAttrTitleRemoveMapping')}
        description={
          mapDeleteTarget
            ? `Users with the "${mapDeleteTarget.claim_value}" claim will no longer auto-join "${mapDeleteTarget.group_name}".`
            : ''
        }
        confirmLabel={tHardcodedUi.raw(
          'componentsIamSsoCard.line272JsxAttrConfirmLabelRemoveMapping',
        )}
        confirmVariant="destructive"
        isPending={deleteMappingMutation.isPending}
        onConfirm={() => {
          if (mapDeleteTarget) deleteMappingMutation.mutate(mapDeleteTarget.mapping_id);
        }}
      />
    </section>
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
  const tHardcodedUi = useTranslations('hardcodedUi');
  const [name, setName] = useState(existing?.name ?? '');
  const [domain, setDomain] = useState(existing?.primary_domain ?? '');
  const [claim, setClaim] = useState(existing?.group_claim_name ?? 'groups');
  const [autoCreate, setAutoCreate] = useState(existing?.auto_create_members ?? true);
  const [autoProvision, setAutoProvision] = useState(existing?.auto_provision_groups ?? false);
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
      setAutoProvision(existing?.auto_provision_groups ?? false);
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
      toast.success(existing ? 'SSO provider updated' : 'SSO provider configured');
      onSaved();
      onOpenChange(false);
    },
    onError: (err: Error) => toast.error(err.message || 'Failed to save provider'),
  });

  const metadataReady =
    metaKind === 'xml' ? metaXml.trim().length > 40 : /^https?:\/\/.+/i.test(metaUrl.trim());
  const ready =
    name.trim().length > 0 &&
    /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain.trim()) &&
    (importing ? metadataReady : true);

  return (
    <Dialog open={open} onOpenChange={(o) => !mutation.isPending && onOpenChange(o)}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{existing ? 'Edit SAML provider' : 'Configure SAML SSO'}</DialogTitle>
          <DialogDescription>
            {existing
              ? 'Update the display name, sign-in domain, and group-claim settings for your identity provider.'
              : 'Paste your IdP’s SAML metadata (Entra → “App Federation Metadata XML”) and we register it for you.'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>{tHardcodedUi.raw('componentsIamSsoCard.line350JsxTextDisplayName')}</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Azure AD"
              disabled={mutation.isPending}
            />
          </div>

          {importing && (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label>IdP SAML metadata</Label>
                <div className="border-border/70 inline-flex overflow-hidden rounded-md border">
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
                          ? 'bg-secondary text-foreground px-2.5 py-1 text-[11px] font-medium'
                          : 'text-muted-foreground hover:bg-muted/50 px-2.5 py-1 text-[11px]'
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
                  className="border-border bg-background focus-visible:ring-ring w-full resize-y rounded-md border px-3 py-2 font-mono text-[11px] outline-none focus-visible:ring-1"
                />
              ) : (
                <Input
                  value={metaUrl}
                  onChange={(e) => setMetaUrl(e.target.value)}
                  placeholder="https://login.microsoftonline.com/<tenant>/federationmetadata/…"
                  className="text-xs"
                  disabled={mutation.isPending}
                />
              )}
              <p className="text-muted-foreground text-[11px]">
                From Entra: Enterprise App → Single sign-on → SAML → “App Federation Metadata XML”.
              </p>
            </div>
          )}

          <div className="space-y-1.5">
            <Label>
              {tHardcodedUi.raw('componentsIamSsoCard.line371JsxTextPrimaryEmailDomain')}
            </Label>
            <Input
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              placeholder="acme.com"
              disabled={mutation.isPending}
            />
            <p className="text-muted-foreground text-[11px]">
              {tHardcodedUi.raw('componentsIamSsoCard.line379JsxTextUsedToRouteSignInFlowsForThis')}
            </p>
          </div>

          <div className="space-y-1.5">
            <Label>{tHardcodedUi.raw('componentsIamSsoCard.line384JsxTextGroupClaimName')}</Label>
            <Input
              value={claim}
              onChange={(e) => setClaim(e.target.value)}
              placeholder="groups"
              className="font-mono text-xs"
              disabled={mutation.isPending}
            />
            <p className="text-muted-foreground text-[11px]">
              {tHardcodedUi.raw('componentsIamSsoCard.line393JsxTextCommonValues')}
              <span className="font-mono">groups</span>{' '}
              {tHardcodedUi.raw('componentsIamSsoCard.line393JsxTextOkta')}{' '}
              <span className="font-mono">memberOf</span>{' '}
              {tHardcodedUi.raw('componentsIamSsoCard.line394JsxTextAzureAD')}
            </p>
            <p className="text-muted-foreground text-[11px] leading-relaxed">
              <span className="text-kortix-yellow">Entra tip:</span> set your SAML{' '}
              <span className="font-mono">emailaddress</span> claim source to{' '}
              <span className="font-mono">userPrincipalName</span> — onmicrosoft.com
              users have no <span className="font-mono">mail</span>, and an empty email
              breaks sign-in. Entra also emits group <span className="font-mono">Object IDs</span>{' '}
              by default: map those, or emit names via “Groups assigned to the
              application” (needs Entra ID P1/P2).
            </p>
          </div>

          <label className="text-foreground flex cursor-pointer items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={autoCreate}
              onChange={(e) => setAutoCreate(e.target.checked)}
              className="border-border accent-primary mt-0.5 h-3.5 w-3.5 rounded"
              disabled={mutation.isPending}
            />
            <span>
              <span className="font-medium">
                {tHardcodedUi.raw('componentsIamSsoCard.line407JsxTextAutoCreateMembers')}
              </span>
              <span className="text-muted-foreground block text-[11px]">
                {tHardcodedUi.raw(
                  'componentsIamSsoCard.line409JsxTextWhenOffOnlyUsersAnAdminHasAlready',
                )}
              </span>
            </span>
          </label>

          <label className="text-foreground flex cursor-pointer items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={autoProvision}
              onChange={(e) => setAutoProvision(e.target.checked)}
              className="border-border accent-primary mt-0.5 h-3.5 w-3.5 rounded"
              disabled={mutation.isPending}
            />
            <span>
              <span className="font-medium">Auto-provision groups</span>
              <span className="text-muted-foreground block text-[11px]">
                Create an IAM group for every group the IdP sends and add users to it — no per-group
                mapping. You just attach project roles to the auto-created groups.
              </span>
            </span>
          </label>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={mutation.isPending}
          >
            Cancel
          </Button>
          <Button
            onClick={() => mutation.mutate()}
            disabled={!ready || mutation.isPending}
            className="gap-1.5"
          >
            {mutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            {existing ? 'Save changes' : 'Import & configure'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
  const tHardcodedUi = useTranslations('hardcodedUi');
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
      toast.success('Mapping added');
      onCreated();
      onOpenChange(false);
    },
    onError: (err: Error) => toast.error(err.message || 'Failed to add mapping'),
  });

  const groups = groupsQuery.data ?? [];
  const ready = claimValue.trim().length > 0 && groupId.length > 0;

  return (
    <Dialog open={open} onOpenChange={(o) => !mutation.isPending && onOpenChange(o)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {tHardcodedUi.raw('componentsIamSsoCard.line490JsxTextAddGroupMapping')}
          </DialogTitle>
          <DialogDescription>
            {tHardcodedUi.raw(
              'componentsIamSsoCard.line492JsxTextUsersWithThisClaimValueInTheirSAML',
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>{tHardcodedUi.raw('componentsIamSsoCard.line499JsxTextClaimValue')}</Label>
            <Input
              value={claimValue}
              onChange={(e) => setClaimValue(e.target.value)}
              placeholder="Engineers"
              className="font-mono text-xs"
              disabled={mutation.isPending}
            />
            <p className="text-muted-foreground text-[11px]">
              {tHardcodedUi.raw(
                'componentsIamSsoCard.line508JsxTextExactCaseSensitiveMatchAgainstAnEntryIn',
              )}
            </p>
          </div>

          <div className="space-y-1.5">
            <Label>{tHardcodedUi.raw('componentsIamSsoCard.line514JsxTextIAMGroup')}</Label>
            <Select
              value={groupId || undefined}
              onValueChange={setGroupId}
              disabled={mutation.isPending || groupsQuery.isLoading}
            >
              <SelectTrigger>
                <SelectValue
                  placeholder={tHardcodedUi.raw(
                    'componentsIamSsoCard.line521JsxAttrPlaceholderPickAGroup',
                  )}
                />
              </SelectTrigger>
              <SelectContent>
                {groups.length === 0 ? (
                  <div className="text-muted-foreground px-2 py-1.5 text-xs">
                    {tHardcodedUi.raw(
                      'componentsIamSsoCard.line526JsxTextNoGroupsInThisAccountYetCreateOne',
                    )}
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
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={mutation.isPending}
          >
            Cancel
          </Button>
          <Button
            onClick={() => mutation.mutate()}
            disabled={!ready || mutation.isPending}
            className="gap-1.5"
          >
            {mutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            {tHardcodedUi.raw('componentsIamSsoCard.line554JsxTextAddMapping')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
