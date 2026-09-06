'use client';

import { useTranslations } from '@/i18n/use-translations';
// SAML SSO config on the Settings tab. The Supabase auth.sso_providers
// row is created out-of-band (Studio or auth admin API) — admins paste
// the resulting UUID + primary email domain here, plus the JWT claim
// holding group memberships. Once configured, every SAML-issued JWT
// triggers JIT membership + group sync in the auth middleware.

import { errorToast, successToast } from '@/components/ui/toast';
import { getEnv } from '@/lib/env-config';
import {
  ArrowRightIcon as ArrowRight,
  CheckIcon as Check,
  CaretDownIcon as ChevronDown,
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
import { ErrorState } from '@/features/layout/section/error-state';
import { useAuth } from '@/features/providers/auth-provider';
import {
  CopyRow,
  EMPTY_PRINCIPAL_SELECTION,
  PrincipalPicker,
  type PrincipalSelection,
  singlePrincipal,
} from '@/features/workspace/shared/access';
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
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  return (
    <div className={className}>
      {heading && (
        <>
          <h3 className="text-foreground text-sm font-medium">
            {tI18nComplete.raw('text4b6617d27a7f')}
          </h3>
          <p className="text-muted-foreground mt-0.5 text-xs">
            {tI18nComplete.raw('text6261ccf529dc')}
          </p>
        </>
      )}
      <div className={heading ? 'mt-3 space-y-3' : 'space-y-3'}>
        <CopyRow
          label={tI18nComplete.raw('text8e5381229b65')}
          value={urls.entityId}
          successMessage={tI18nComplete.raw('textcae19266dc91')}
        />
        <CopyRow
          label={tI18nComplete.raw('text2085a74cbb9b')}
          value={urls.acsUrl}
          successMessage={tI18nComplete.raw('textcbd6aeca8616')}
        />
      </div>
    </div>
  );
}

interface SsoCardProps {
  accountId: string;
  canManage: boolean;
}

export function SsoCard({ accountId, canManage }: SsoCardProps) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
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
      successToast(tI18nComplete.raw('textb7ce84ad7e7d'));
      queryClient.invalidateQueries({ queryKey: ['iam-sso-provider', accountId] });
      queryClient.invalidateQueries({ queryKey: ['iam-sso-mappings', accountId] });
      setDeleteOpen(false);
    },
    onError: (err: Error) => errorToast(err.message || tI18nComplete.raw('textccbfd6f25c02')),
  });

  const deleteMappingMutation = useMutation({
    mutationFn: (mappingId: string) => deleteSsoGroupMapping(accountId, mappingId),
    onSuccess: () => {
      successToast(tI18nComplete.raw('textdc613b61cff5'));
      queryClient.invalidateQueries({ queryKey: ['iam-sso-mappings', accountId] });
      setMapDeleteTarget(null);
    },
    onError: (err: Error) => errorToast(err.message || tI18nComplete.raw('text0d8104fca93b')),
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
        updated.enforce_sso
          ? tI18nComplete.raw('textfb93c43856a8')
          : tI18nComplete.raw('textb97d0d8acd14'),
      );
      queryClient.invalidateQueries({ queryKey: ['iam-sso-provider', accountId] });
    },
    onError: (err: Error) => errorToast(err.message || tI18nComplete.raw('text6d0137714cf5')),
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0 space-y-0.5">
          <p className="text-foreground flex items-center gap-2 text-sm font-medium">
            {tI18nComplete.raw('text405e739d53d2')}
            {provider && (
              <Badge variant="success" size="sm">
                {tI18nComplete.raw('text12a7bd86e0a4')}
              </Badge>
            )}
          </p>
          <p className="text-muted-foreground text-xs">
            {provider
              ? tI18nComplete.raw('textfa497ac79066')
              : tI18nComplete.raw('textb769a269132c')}
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
              {tI18nComplete.raw('text464c4ffd019e')}
            </Button>
          ) : (
            // New providers go through the guided setup wizard (per-IdP
            // steps + inline import) instead of the bare dialog.
            <Button asChild size="sm" variant="secondary" className="shrink-0">
              <Link href={`/accounts/${accountId}/sso-setup`}>
                {tI18nComplete.raw('text6defafa2caa6')}
              </Link>
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
              title={tI18nComplete.raw('textb91015bed915')}
              description={
                providerQuery.error instanceof Error ? providerQuery.error.message : undefined
              }
              action={
                <Button variant="outline" size="sm" onClick={() => providerQuery.refetch()}>
                  {tI18nComplete.raw('text942087cc2d41')}
                </Button>
              }
            />
          </div>
        )}
        {!provider && !providerQuery.isLoading && !providerQuery.isError && (
          <div className="px-4 py-5">
            <p className="text-foreground text-sm font-medium">
              {tI18nComplete.raw('text898569356612')}
            </p>
            <p className="text-muted-foreground mt-1 text-xs leading-relaxed">
              {tI18nComplete.raw('textec89d54062ea')}
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
                <dt className="text-muted-foreground text-xs">
                  {tI18nComplete.raw('text472590ae974d')}
                </dt>
                <dd className="text-foreground mt-0.5 truncate font-medium">{provider.name}</dd>
              </div>
              <div className="min-w-0">
                <dt className="text-muted-foreground text-xs">
                  {tI18nComplete.raw('textb58723266197')}
                </dt>
                <dd className="text-foreground mt-1 truncate font-mono text-xs">
                  {provider.primary_domain}
                </dd>
              </div>
              <div className="min-w-0">
                <dt className="text-muted-foreground text-xs">
                  {tI18nComplete.raw('textae030e046fcf')}
                </dt>
                <dd className="mt-1">
                  <code className="bg-muted/60 text-foreground rounded px-1.5 py-0.5 font-mono text-xs">
                    {provider.group_claim_name}
                  </code>
                </dd>
              </div>
              <div className="min-w-0">
                <dt className="text-muted-foreground text-xs">
                  {tI18nComplete.raw('textc2b1b8e2e039')}
                </dt>
                <dd className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
                  <span
                    className={
                      provider.auto_create_members
                        ? 'text-kortix-green inline-flex items-center gap-1 font-medium'
                        : 'text-muted-foreground inline-flex items-center gap-1'
                    }
                  >
                    {provider.auto_create_members ? <Check className="size-3.5 shrink-0" /> : null}
                    {tI18nComplete.raw('text33e17e895ebc')}
                    {provider.auto_create_members ? '' : tI18nComplete.raw('text6e81eb627df1')}
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
                    {tI18nComplete.raw('text459ff8f45278')}
                    {provider.auto_provision_groups ? '' : tI18nComplete.raw('text6e81eb627df1')}
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
                <p className="text-foreground text-sm font-medium">
                  {tI18nComplete.raw('text05b1748edb1e')}
                </p>
                <p className="text-muted-foreground text-xs">
                  {tI18nComplete.raw('text3e29ac703c2f')}
                </p>
              </div>
              {canManage && (
                <Switch
                  checked={!!provider.enforce_sso}
                  onCheckedChange={(checked) => enforceSsoMutation.mutate(checked)}
                  disabled={enforceSsoMutation.isPending || providerQuery.isLoading}
                  aria-label={tI18nComplete.raw('text05b1748edb1e')}
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
                      {tI18nComplete.raw('text1ca52f90af41')}
                      {mappings.length > 0 && (
                        <Badge variant="muted" size="sm">
                          {mappings.length}
                        </Badge>
                      )}
                    </p>
                    <p className="text-muted-foreground mt-0.5 text-xs">
                      {tI18nComplete.raw('textd39e457aea5f')}{' '}
                      <span className="font-mono">{provider.group_claim_name}</span>{' '}
                      {tI18nComplete.raw('texte6158ee80566')}
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
                      {tI18nComplete.raw('text160cc87a108c')}
                    </Button>
                  </div>
                )}
                {mappingsQuery.isLoading ? (
                  <div className="px-4 py-3">
                    <Skeleton className="h-8 w-full rounded-md" />
                  </div>
                ) : mappings.length === 0 ? (
                  <p className="text-muted-foreground px-4 py-4 text-xs">
                    {tI18nComplete.raw('text7c6d27aed192')}
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
                        <Badge variant="outline" size="sm" className="max-w-[42%] min-w-0 truncate">
                          {m.group_name}
                        </Badge>
                        <span className="flex-1" />
                        {canManage && (
                          <Button
                            size="icon"
                            variant="ghost"
                            className="text-muted-foreground hover:text-destructive shrink-0"
                            onClick={() => setMapDeleteTarget(m)}
                            aria-label={tI18nComplete.raw('textde5a4015009a')}
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
                    <p className="text-foreground text-sm font-medium">
                      {tI18nComplete.raw('textc4be9515eb1a')}
                    </p>
                    <p className="text-muted-foreground mt-0.5 text-xs">
                      {tI18nComplete.raw('texta48a3f3dfb45')}
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
              {tI18nComplete.raw('text95819284355b')}
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
        title={tI18nComplete.raw('textdd1415c23913')}
        description={tI18nComplete.raw('text1f923dc84e2f')}
        confirmLabel={tI18nComplete.raw('text5234fbffc3e9')}
        confirmVariant="destructive"
        isPending={deleteMutation.isPending}
        onConfirm={() => deleteMutation.mutate()}
      />

      <ConfirmDialog
        open={!!mapDeleteTarget}
        onOpenChange={(o) => {
          if (!o) setMapDeleteTarget(null);
        }}
        title={tI18nComplete.raw('text45afe4152eb7')}
        description={
          mapDeleteTarget
            ? tI18nComplete('text5a4c567b2373', {
                value0: mapDeleteTarget.claim_value,
                value1: mapDeleteTarget.group_name,
              })
            : ''
        }
        confirmLabel={tI18nComplete.raw('textde5a4015009a')}
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
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
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
      successToast(tI18nComplete.raw('text72db205c0097'));
      onSaved();
      onOpenChange(false);
    },
    onError: (err: Error) => errorToast(err.message || tI18nComplete.raw('texte21fa38b5758')),
  });

  const ready = name.trim().length > 0 && /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain.trim());

  const spUrls = useSpUrls();

  return (
    <Modal open={open} onOpenChange={(o) => !mutation.isPending && onOpenChange(o)}>
      <ModalContent className="lg:max-w-lg">
        <ModalHeader>
          <ModalTitle>{tI18nComplete.raw('text32581286f916')}</ModalTitle>
          <ModalDescription>{tI18nComplete.raw('text41bb63a2e247')}</ModalDescription>
        </ModalHeader>

        <ModalBody className="max-h-[60vh] space-y-4 overflow-y-auto">
          {spUrls && (
            <SpDetails urls={spUrls} className="bg-muted/20 rounded-md border px-3 py-3" />
          )}

          <div className="space-y-1.5">
            <Label>{tI18nComplete.raw('text2b7f6a84de91')}</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={tI18nComplete.raw('text8c061bef8878')}
              disabled={mutation.isPending}
              variant="popover"
            />
          </div>

          <div className="space-y-1.5">
            <Label>{tI18nComplete.raw('text196f5a9a744a')}</Label>
            <Input
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              placeholder={tI18nComplete.raw('text1194228da8fd')}
              disabled={mutation.isPending}
              variant="popover"
            />
            <p className="text-muted-foreground text-xs">{tI18nComplete.raw('texte6c1f062119d')}</p>
            {adminEmailDomain && domain.trim().toLowerCase() === adminEmailDomain && (
              <p className="text-kortix-yellow text-xs">{tI18nComplete.raw('textcd93ff59e7c2')}</p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label>{tI18nComplete.raw('texte75adb62c8c7')}</Label>
            <Input
              value={claim}
              onChange={(e) => setClaim(e.target.value)}
              placeholder={tI18nComplete.raw('text4ed379d418bb')}
              className="font-mono text-xs"
              disabled={mutation.isPending}
              variant="popover"
            />
            <p className="text-muted-foreground text-xs">
              {tI18nComplete.raw('textdca21555d836')}{' '}
              <span className="font-mono">{tI18nComplete.raw('text4ed379d418bb')}</span>{' '}
              {tI18nComplete.raw('text0f92526d5f8f')}{' '}
              <span className="font-mono">{tI18nComplete.raw('text310478914595')}</span>{' '}
              {tI18nComplete.raw('text9715b82f0966')}
            </p>
            <p className="text-muted-foreground text-xs leading-relaxed">
              <span className="text-kortix-yellow">{tI18nComplete.raw('textd46958e8ca77')}</span>{' '}
              {tI18nComplete.raw('textab09dcc1883e')}{' '}
              <span className="font-mono">{tI18nComplete.raw('text2a9a3df163eb')}</span>{' '}
              {tI18nComplete.raw('texte6b55c9a01c3')}{' '}
              <span className="font-mono">{tI18nComplete.raw('texte378907770e5')}</span>{' '}
              {tI18nComplete.raw('texta5949a4c27d3')}{' '}
              <span className="font-mono">{tI18nComplete.raw('text00d8d3f11739')}</span>
              {tI18nComplete.raw('text352007bbaa9e')}
              <span className="font-mono">{tI18nComplete.raw('textdea47e4b79d6')}</span>{' '}
              {tI18nComplete.raw('texte4ce46bf8c90')}
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
              <span className="font-medium">{tI18nComplete.raw('text33e17e895ebc')}</span>
              <span className="text-muted-foreground block text-xs">
                {tI18nComplete.raw('text4568e87aaf86')}
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
              <span className="font-medium">{tI18nComplete.raw('text459ff8f45278')}</span>
              <span className="text-muted-foreground block text-xs">
                {tI18nComplete.raw('text8a562f22155c')}
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
            {tI18nComplete.raw('text19766ed6ccb2')}
          </Button>
          <Button
            size="sm"
            onClick={() => mutation.mutate()}
            disabled={!ready || mutation.isPending}
            className="gap-1.5"
          >
            {mutation.isPending && <Loading className="size-3.5 shrink-0" />}
            {tI18nComplete.raw('textdd0ae7a5cbcf')}
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
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
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
      successToast(tI18nComplete.raw('text2d782022e664'));
      onCreated();
      onOpenChange(false);
    },
    onError: (err: Error) => errorToast(err.message || tI18nComplete.raw('textc7a1b38bba89')),
  });

  const ready = claimValue.trim().length > 0 && groupId.length > 0;

  return (
    <Modal open={open} onOpenChange={(o) => !mutation.isPending && onOpenChange(o)}>
      <ModalContent className="lg:max-w-lg">
        <ModalHeader>
          <ModalTitle>{tI18nComplete.raw('text67467eb27011')}</ModalTitle>
          <ModalDescription>{tI18nComplete.raw('text62d62774a85e')}</ModalDescription>
        </ModalHeader>

        <ModalBody className="space-y-4">
          <div className="space-y-1.5">
            <Label>{tI18nComplete.raw('textd06d32440b8d')}</Label>
            <Input
              value={claimValue}
              onChange={(e) => setClaimValue(e.target.value)}
              placeholder={tI18nComplete.raw('text373a7598b12d')}
              className="font-mono text-xs"
              disabled={mutation.isPending}
              variant="popover"
            />
            <p className="text-muted-foreground text-xs">{tI18nComplete.raw('text45b895cb8502')}</p>
          </div>

          <div className="space-y-1.5">
            <Label>{tI18nComplete.raw('texta4d51f7a060a')}</Label>
            <PrincipalPicker
              scope={{ kind: 'account', accountId }}
              selection="single"
              kinds={['group']}
              value={principal}
              onChange={setPrincipal}
              disabled={mutation.isPending}
              autoFocus={false}
              emptyLabel={tI18nComplete.raw('text011275ae7075')}
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
            {tI18nComplete.raw('text19766ed6ccb2')}
          </Button>
          <Button
            size="sm"
            onClick={() => mutation.mutate()}
            disabled={!ready || mutation.isPending}
            className="gap-1.5"
          >
            {mutation.isPending && <Loading className="size-3.5 shrink-0" />}
            {tI18nComplete.raw('text160cc87a108c')}
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
