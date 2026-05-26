'use client';

import { useTranslations } from 'next-intl';
// SAML SSO config on the Settings tab. The Supabase auth.sso_providers
// row is created out-of-band (Studio or auth admin API) — admins paste
// the resulting UUID + primary email domain here, plus the JWT claim
// holding group memberships. Once configured, every SAML-issued JWT
// triggers JIT membership + group sync in the auth middleware.

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, Plus, ShieldCheck, Trash2, X } from 'lucide-react';
import { toast } from 'sonner';

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
    <section className="rounded-xl border border-border/70 bg-card">
      <header className={provider ? 'border-b border-border/60 px-6 py-4' : 'px-6 py-4'}>
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h2 className="flex items-center gap-2 text-base font-semibold text-foreground">
              <ShieldCheck className="h-4 w-4 text-muted-foreground" />
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
            <p className="mt-0.5 text-xs text-muted-foreground">
              {provider
                ? tHardcodedUi.raw('componentsIamSsoCard.line106JsxTextConnectYourIdPUsersSigningInViaSAML')
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
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
            <dt className="text-muted-foreground">Provider</dt>
            <dd className="font-medium text-foreground">{provider.name}</dd>
            <dt className="text-muted-foreground">{tHardcodedUi.raw('componentsIamSsoCard.line135JsxTextPrimaryDomain')}</dt>
            <dd className="font-mono text-xs text-foreground">{provider.primary_domain}</dd>
            <dt className="text-muted-foreground">{tHardcodedUi.raw('componentsIamSsoCard.line137JsxTextGroupClaim')}</dt>
            <dd className="font-mono text-xs text-foreground">{provider.group_claim_name}</dd>
            <dt className="text-muted-foreground">{tHardcodedUi.raw('componentsIamSsoCard.line139JsxTextAutoCreateMembers')}</dt>
            <dd className="text-foreground">
              {provider.auto_create_members ? 'Yes' : 'No'}
            </dd>
            <dt className="text-muted-foreground">{tHardcodedUi.raw('componentsIamSsoCard.line143JsxTextSupabaseProviderId')}</dt>
            <dd className="truncate font-mono text-[11px] text-muted-foreground">
              {provider.supabase_sso_provider_id}
            </dd>
          </dl>
        )}
      </div>
      )}

      {provider && (
        <>
          <header className="flex items-center justify-between border-t border-border/60 px-6 py-3">
            <h3 className="text-sm font-medium text-foreground">{tHardcodedUi.raw('componentsIamSsoCard.line154JsxTextGroupMappings')}</h3>
            {canManage && (
              <Button
                size="sm"
                variant="outline"
                className="gap-1.5"
                onClick={() => setMapOpen(true)}
              >
                <Plus className="h-3.5 w-3.5" />
                {tHardcodedUi.raw('componentsIamSsoCard.line163JsxTextAddMapping')}</Button>
            )}
          </header>
          <div className="px-6 pb-5">
            {mappingsQuery.isLoading ? (
              <Skeleton className="h-12 w-full" />
            ) : mappings.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                {tHardcodedUi.raw('componentsIamSsoCard.line172JsxTextNoMappingsYetMapIdPGroupRoleValues')}{' '}
                <span className="font-mono">{provider.group_claim_name}</span> {tHardcodedUi.raw('componentsIamSsoCard.line173JsxTextClaimToIAMGroupsSoUsersLandIn')}</p>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border/60 text-left text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                    <th className="py-2 font-medium">{tHardcodedUi.raw('componentsIamSsoCard.line180JsxTextClaimValue')}</th>
                    <th className="py-2 font-medium">{tHardcodedUi.raw('componentsIamSsoCard.line181JsxTextIAMGroup')}</th>
                    <th className="w-10 py-2" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/60">
                  {mappings.map((m) => (
                    <tr key={m.mapping_id} className="hover:bg-muted/20">
                      <td className="py-2 font-mono text-xs text-foreground">
                        {m.claim_value}
                      </td>
                      <td className="py-2">
                        <Badge variant="outline" size="sm">{m.group_name}</Badge>
                      </td>
                      <td className="py-2 text-right">
                        {canManage && (
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-7 w-7 text-muted-foreground hover:text-destructive"
                            onClick={() => setMapDeleteTarget(m)}
                            aria-label={tHardcodedUi.raw('componentsIamSsoCard.line201JsxAttrAriaLabelRemoveMapping')}
                          >
                            <X className="h-3.5 w-3.5" />
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}

      {provider && canManage && (
        <footer className="flex justify-end border-t border-border/60 px-6 py-3">
          <Button
            size="sm"
            variant="ghost"
            className="text-destructive hover:text-destructive"
            onClick={() => setDeleteOpen(true)}
          >
            <Trash2 className="mr-1.5 h-3.5 w-3.5" />
            {tHardcodedUi.raw('componentsIamSsoCard.line225JsxTextRemoveSSOProvider')}</Button>
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
        description={tHardcodedUi.raw('componentsIamSsoCard.line254JsxAttrDescriptionExistingMembersKeepTheirAccessNewSignIns')}
        confirmLabel={tHardcodedUi.raw('componentsIamSsoCard.line255JsxAttrConfirmLabelRemoveProvider')}
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
        confirmLabel={tHardcodedUi.raw('componentsIamSsoCard.line272JsxAttrConfirmLabelRemoveMapping')}
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
  const [supabaseId, setSupabaseId] = useState(existing?.supabase_sso_provider_id ?? '');
  const [domain, setDomain] = useState(existing?.primary_domain ?? '');
  const [claim, setClaim] = useState(existing?.group_claim_name ?? 'groups');
  const [autoCreate, setAutoCreate] = useState(existing?.auto_create_members ?? true);

  // Hydrate when opening for edit; reset when closing.
  useMemo(() => {
    if (open) {
      setName(existing?.name ?? '');
      setSupabaseId(existing?.supabase_sso_provider_id ?? '');
      setDomain(existing?.primary_domain ?? '');
      setClaim(existing?.group_claim_name ?? 'groups');
      setAutoCreate(existing?.auto_create_members ?? true);
    }
  }, [open, existing]);

  const mutation = useMutation({
    mutationFn: () =>
      upsertSsoProvider(accountId, {
        supabase_sso_provider_id: supabaseId.trim(),
        name: name.trim(),
        primary_domain: domain.trim().toLowerCase(),
        group_claim_name: claim.trim() || 'groups',
        auto_create_members: autoCreate,
      }),
    onSuccess: () => {
      toast.success(existing ? 'SSO provider updated' : 'SSO provider configured');
      onSaved();
      onOpenChange(false);
    },
    onError: (err: Error) => toast.error(err.message || 'Failed to save provider'),
  });

  const ready =
    name.trim().length > 0 &&
    /^[0-9a-f-]{36}$/i.test(supabaseId.trim()) &&
    /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain.trim());

  return (
    <Dialog open={open} onOpenChange={(o) => !mutation.isPending && onOpenChange(o)}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{existing ? 'Edit SAML provider' : 'Configure SAML SSO'}</DialogTitle>
          <DialogDescription>
            {tHardcodedUi.raw('componentsIamSsoCard.line343JsxTextCreateTheProviderInSupabaseStudioAuthenticationSSO')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>{tHardcodedUi.raw('componentsIamSsoCard.line350JsxTextDisplayName')}</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Okta"
              disabled={mutation.isPending}
            />
          </div>

          <div className="space-y-1.5">
            <Label>{tHardcodedUi.raw('componentsIamSsoCard.line360JsxTextSupabaseProviderUUID')}</Label>
            <Input
              value={supabaseId}
              onChange={(e) => setSupabaseId(e.target.value)}
              placeholder="00000000-0000-0000-0000-000000000000"
              className="font-mono text-xs"
              disabled={mutation.isPending}
            />
          </div>

          <div className="space-y-1.5">
            <Label>{tHardcodedUi.raw('componentsIamSsoCard.line371JsxTextPrimaryEmailDomain')}</Label>
            <Input
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              placeholder="acme.com"
              disabled={mutation.isPending}
            />
            <p className="text-[11px] text-muted-foreground">
              {tHardcodedUi.raw('componentsIamSsoCard.line379JsxTextUsedToRouteSignInFlowsForThis')}</p>
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
            <p className="text-[11px] text-muted-foreground">
              {tHardcodedUi.raw('componentsIamSsoCard.line393JsxTextCommonValues')}<span className="font-mono">groups</span> {tHardcodedUi.raw('componentsIamSsoCard.line393JsxTextOkta')}{' '}
              <span className="font-mono">memberOf</span> {tHardcodedUi.raw('componentsIamSsoCard.line394JsxTextAzureAD')}</p>
          </div>

          <label className="flex cursor-pointer items-start gap-2 text-sm text-foreground">
            <input
              type="checkbox"
              checked={autoCreate}
              onChange={(e) => setAutoCreate(e.target.checked)}
              className="mt-0.5 h-3.5 w-3.5 rounded border-border accent-primary"
              disabled={mutation.isPending}
            />
            <span>
              <span className="font-medium">{tHardcodedUi.raw('componentsIamSsoCard.line407JsxTextAutoCreateMembers')}</span>
              <span className="block text-[11px] text-muted-foreground">
                {tHardcodedUi.raw('componentsIamSsoCard.line409JsxTextWhenOffOnlyUsersAnAdminHasAlready')}</span>
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
            {existing ? 'Save changes' : 'Configure SSO'}
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
          <DialogTitle>{tHardcodedUi.raw('componentsIamSsoCard.line490JsxTextAddGroupMapping')}</DialogTitle>
          <DialogDescription>
            {tHardcodedUi.raw('componentsIamSsoCard.line492JsxTextUsersWithThisClaimValueInTheirSAML')}</DialogDescription>
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
            <p className="text-[11px] text-muted-foreground">
              {tHardcodedUi.raw('componentsIamSsoCard.line508JsxTextExactCaseSensitiveMatchAgainstAnEntryIn')}</p>
          </div>

          <div className="space-y-1.5">
            <Label>{tHardcodedUi.raw('componentsIamSsoCard.line514JsxTextIAMGroup')}</Label>
            <Select
              value={groupId || undefined}
              onValueChange={setGroupId}
              disabled={mutation.isPending || groupsQuery.isLoading}
            >
              <SelectTrigger>
                <SelectValue placeholder={tHardcodedUi.raw('componentsIamSsoCard.line521JsxAttrPlaceholderPickAGroup')} />
              </SelectTrigger>
              <SelectContent>
                {groups.length === 0 ? (
                  <div className="px-2 py-1.5 text-xs text-muted-foreground">
                    {tHardcodedUi.raw('componentsIamSsoCard.line526JsxTextNoGroupsInThisAccountYetCreateOne')}</div>
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
            {tHardcodedUi.raw('componentsIamSsoCard.line554JsxTextAddMapping')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
