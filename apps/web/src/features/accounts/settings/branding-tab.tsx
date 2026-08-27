'use client';

/**
 * Organization branding — the `?tab=branding` pane of `/accounts/[id]`.
 *
 * Enterprise `branding` entitlement. A product name, and three marks
 * (brandmark, symbol, favicon), each with a light image and an optional dark
 * variant. Every upload goes to
 * the API (`POST /accounts/:id/branding/assets/:kind`), which sniffs the bytes
 * and owns the URL — this pane never chooses where an image lives. After every
 * write the `['accounts']` query is invalidated, which is what
 * `BrandingProvider` renders from, so the header above this very pane
 * re-brands live.
 *
 * Mounted only when the caller holds `account.write` (the hub's rail gate) and
 * the account is entitled — the hub renders `EnterpriseUpsell` otherwise. The
 * pane still guards `canManage` on every control so a read-only viewer, if one
 * ever reaches it, sees the state and no buttons.
 */

import {
  getAccountBranding,
  removeAccountBrandingAsset,
  resetAccountBranding,
  updateAccountBranding,
  uploadAccountBrandingAsset,
  type AccountBranding,
  type AccountBrandingAssetKind,
  type AccountBrandingState,
} from '@kortix/sdk';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { TrashIcon, UploadSimpleIcon } from '@phosphor-icons/react';
import { type FormEvent, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import Hint from '@/components/ui/hint';
import { Input } from '@/components/ui/input';
import { KortixLogo } from '@/components/ui/kortix-logo';
import { Label } from '@/components/ui/label';
import Loading from '@/components/ui/loading';
import { Skeleton } from '@/components/ui/skeleton';
import { errorToast, successToast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';

const MAX_APP_NAME_LENGTH = 60;
const MAX_ASSET_BYTES = 1024 * 1024;
const ACCEPT = 'image/png,image/jpeg,image/webp,image/svg+xml,image/x-icon,.ico,.svg';

export const brandingQueryKey = (accountId: string) => ['account-branding', accountId] as const;

type Scheme = 'light' | 'dark';

interface MarkSlot {
  title: string;
  description: string;
  /** How the preview tile frames the mark. */
  frame: 'wide' | 'square';
  kinds: Record<Scheme, AccountBrandingAssetKind>;
  urlKeys: Record<Scheme, keyof AccountBranding>;
}

const SLOTS: MarkSlot[] = [
  {
    title: 'Logo',
    description: 'Wide brandmark — the header and loading screens. SVG or PNG, up to 1 MB.',
    frame: 'wide',
    kinds: { light: 'logo', dark: 'logo_dark' },
    urlKeys: { light: 'logo_url', dark: 'logo_dark_url' },
  },
  {
    title: 'Icon',
    description:
      'Square symbol — where the wide logo does not fit, and the touch icon. Stands in for the logo when none is set.',
    frame: 'square',
    kinds: { light: 'icon', dark: 'icon_dark' },
    urlKeys: { light: 'icon_url', dark: 'icon_dark_url' },
  },
  {
    title: 'Favicon',
    description: 'Browser tab — 32×32 PNG or ICO. Uses the icon when none is set.',
    frame: 'square',
    kinds: { light: 'favicon', dark: 'favicon_dark' },
    urlKeys: { light: 'favicon_url', dark: 'favicon_dark_url' },
  },
];

export function BrandingTab({ accountId, canManage }: { accountId: string; canManage: boolean }) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: brandingQueryKey(accountId),
    queryFn: () => getAccountBranding(accountId),
    staleTime: 20_000,
  });

  // Every write returns the full state — seed the cache from it and let the
  // rendering provider (`['accounts']`) refetch so the header re-brands.
  const settle = (state: AccountBrandingState) => {
    queryClient.setQueryData(brandingQueryKey(accountId), state);
    void queryClient.invalidateQueries({ queryKey: ['accounts'] });
    void queryClient.invalidateQueries({ queryKey: ['account', accountId] });
  };

  if (query.isLoading || !query.data) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-64 w-full rounded-md" />
        <Skeleton className="h-16 w-full rounded-md" />
      </div>
    );
  }

  const { branding } = query.data;
  const isDefault = Object.values(branding).every((v) => v === null);

  return (
    <div className="space-y-10">
      <section className="space-y-4">
        <div className="space-y-1">
          <Label>Product name</Label>
          <p className="text-muted-foreground text-xs">
            Replaces “Kortix” in the browser tab title.
          </p>
        </div>
        <AppNameCard
          // Keyed on the saved value: a save (or a reset) remounts the form
          // with fresh state instead of syncing it through an effect.
          key={branding.app_name ?? ''}
          accountId={accountId}
          value={branding.app_name}
          canManage={canManage}
          onSaved={settle}
        />
      </section>

      <section className="space-y-4">
        <div className="space-y-1">
          <Label>Marks</Label>
          <p className="text-muted-foreground text-xs">
            Uploaded images replace the Kortix marks for every member of this account. The dark
            variant is optional — without one, the light image is used in both themes.
          </p>
        </div>
        <div className="bg-popover rounded-md border">
          {SLOTS.map((slot, i) => (
            <MarkRow
              key={slot.title}
              accountId={accountId}
              slot={slot}
              branding={branding}
              canManage={canManage}
              onSettled={settle}
              className={cn(i > 0 && 'border-border border-t')}
            />
          ))}
        </div>
      </section>

      <section className="space-y-4">
        <Label>Reset</Label>
        <ResetRow accountId={accountId} disabled={!canManage || isDefault} onSettled={settle} />
      </section>
    </div>
  );
}

// ─── Product name ───────────────────────────────────────────────────────────

function AppNameCard({
  accountId,
  value,
  canManage,
  onSaved,
}: {
  accountId: string;
  value: string | null;
  canManage: boolean;
  onSaved: (state: AccountBrandingState) => void;
}) {
  const [name, setName] = useState(value ?? '');

  const mutation = useMutation({
    mutationFn: (next: string | null) => updateAccountBranding(accountId, { app_name: next }),
    onSuccess: (state) => {
      successToast(state.branding.app_name ? 'Product name saved' : 'Product name cleared');
      onSaved(state);
    },
    onError: (err: Error) => errorToast(err.message || 'Failed to save the product name'),
  });

  const trimmed = name.trim();
  const canSubmit =
    canManage && trimmed !== (value ?? '') && trimmed.length <= MAX_APP_NAME_LENGTH;

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit) return;
    mutation.mutate(trimmed.length > 0 ? trimmed : null);
  }

  return (
    <form onSubmit={handleSubmit} className="bg-popover rounded-md border">
      <div className="space-y-1.5 px-4 py-5">
        <Label htmlFor="branding-app-name">Name</Label>
        <Input
          id="branding-app-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Kortix"
          disabled={!canManage || mutation.isPending}
          maxLength={MAX_APP_NAME_LENGTH}
          className="max-w-md"
          autoComplete="off"
        />
        <p className="text-muted-foreground text-xs">
          Leave empty to keep “Kortix”. Up to {MAX_APP_NAME_LENGTH} characters.
        </p>
      </div>
      <div className="border-border flex items-center justify-end border-t px-4 py-3">
        <Button type="submit" size="sm" disabled={!canSubmit || mutation.isPending}>
          {mutation.isPending ? <Loading className="size-3.5 shrink-0" /> : null}
          Save
        </Button>
      </div>
    </form>
  );
}

// ─── One mark: light + dark cells ───────────────────────────────────────────

function MarkRow({
  accountId,
  slot,
  branding,
  canManage,
  onSettled,
  className,
}: {
  accountId: string;
  slot: MarkSlot;
  branding: AccountBranding;
  canManage: boolean;
  onSettled: (state: AccountBrandingState) => void;
  className?: string;
}) {
  return (
    <div className={cn('space-y-3 px-4 py-4', className)}>
      <div className="space-y-0.5">
        <p className="text-foreground text-sm font-medium">{slot.title}</p>
        <p className="text-muted-foreground text-xs text-pretty">{slot.description}</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {(['light', 'dark'] as const).map((scheme) => (
          <VariantCell
            key={scheme}
            accountId={accountId}
            slot={slot}
            scheme={scheme}
            url={branding[slot.urlKeys[scheme]]}
            fallbackUrl={scheme === 'dark' ? branding[slot.urlKeys.light] : null}
            canManage={canManage}
            onSettled={onSettled}
          />
        ))}
      </div>
    </div>
  );
}

function VariantCell({
  accountId,
  slot,
  scheme,
  url,
  fallbackUrl,
  canManage,
  onSettled,
}: {
  accountId: string;
  slot: MarkSlot;
  scheme: Scheme;
  url: string | null;
  /** The light image a dark cell inherits when it has no upload of its own. */
  fallbackUrl: string | null;
  canManage: boolean;
  onSettled: (state: AccountBrandingState) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const kind = slot.kinds[scheme];
  const label = `${slot.title.toLowerCase()} (${scheme})`;

  const upload = useMutation({
    mutationFn: (file: File) => uploadAccountBrandingAsset(accountId, kind, file, file.name),
    onSuccess: (state) => {
      successToast(`${slot.title} (${scheme}) updated`);
      onSettled(state);
    },
    onError: (err: Error) => errorToast(err.message || `Failed to upload the ${label}`),
  });
  const remove = useMutation({
    mutationFn: () => removeAccountBrandingAsset(accountId, kind),
    onSuccess: (state) => {
      successToast(`${slot.title} (${scheme}) removed`);
      onSettled(state);
    },
    onError: (err: Error) => errorToast(err.message || `Failed to remove the ${label}`),
  });
  const pending = upload.isPending || remove.isPending;

  function pick(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    // Reset so picking the same file again re-fires `change`.
    event.target.value = '';
    if (!file) return;
    if (file.size > MAX_ASSET_BYTES) {
      errorToast('Image is too large (max 1 MB)');
      return;
    }
    upload.mutate(file);
  }

  return (
    <div className="border-border flex items-center gap-3 rounded-md border px-3 py-2.5">
      <Preview slot={slot} scheme={scheme} url={url ?? fallbackUrl} inherited={!url && !!fallbackUrl} />
      <div className="min-w-0 flex-1">
        <p className="text-foreground text-xs font-medium capitalize">{scheme}</p>
        <p className="text-muted-foreground text-xs">
          {url ? 'Uploaded' : fallbackUrl ? 'Uses the light image' : 'Kortix default'}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPT}
          className="sr-only"
          onChange={pick}
          aria-label={`Upload ${label}`}
          disabled={!canManage || pending}
        />
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={!canManage || pending}
          onClick={() => inputRef.current?.click()}
        >
          {upload.isPending ? (
            <Loading className="size-3.5 shrink-0" />
          ) : (
            <UploadSimpleIcon className="size-3.5 shrink-0" />
          )}
          {url ? 'Replace' : 'Upload'}
        </Button>
        {url ? (
          <Hint label={`Remove ${label}`}>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              aria-label={`Remove ${label}`}
              disabled={!canManage || pending}
              onClick={() => remove.mutate()}
            >
              {remove.isPending ? (
                <Loading className="size-3.5 shrink-0" />
              ) : (
                <TrashIcon className="size-3.5 shrink-0" />
              )}
            </Button>
          </Hint>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Preview tile, painted in the scheme it previews (light cell on a light
 * ground, dark cell on a dark ground) so the mark is judged where it will
 * actually be seen. Shows the uploaded image, the inherited light image
 * (dimmed), or the Kortix default that slot falls back to.
 */
function Preview({
  slot,
  scheme,
  url,
  inherited,
}: {
  slot: MarkSlot;
  scheme: Scheme;
  url: string | null;
  inherited: boolean;
}) {
  const wide = slot.frame === 'wide';
  const dark = scheme === 'dark';
  return (
    <div
      className={cn(
        'flex shrink-0 items-center justify-center rounded-sm border',
        wide ? 'h-10 w-24' : 'size-10',
        dark ? 'border-zinc-700 bg-zinc-950 text-zinc-50' : 'border-zinc-200 bg-white text-zinc-950',
      )}
    >
      {url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={url}
          alt={`${slot.title} ${scheme}`}
          draggable={false}
          className={cn(
            'select-none object-contain',
            wide ? 'h-5 max-w-20' : 'size-6',
            inherited && 'opacity-50',
          )}
        />
      ) : (
        <KortixLogo variant={wide ? 'brandmark' : 'icon'} size={wide ? 14 : 20} />
      )}
    </div>
  );
}

// ─── Reset ──────────────────────────────────────────────────────────────────

function ResetRow({
  accountId,
  disabled,
  onSettled,
}: {
  accountId: string;
  disabled: boolean;
  onSettled: (state: AccountBrandingState) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const mutation = useMutation({
    mutationFn: () => resetAccountBranding(accountId),
    onSuccess: (state) => {
      successToast('Branding reset to Kortix defaults');
      setConfirming(false);
      onSettled(state);
    },
    onError: (err: Error) => errorToast(err.message || 'Failed to reset branding'),
  });

  return (
    <>
      <div className="bg-popover rounded-md border px-4 py-3">
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <p className="text-foreground text-sm font-medium">Reset to Kortix</p>
            <p className="text-muted-foreground text-xs">Removes every uploaded mark and the product name.</p>
          </div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={disabled || mutation.isPending}
            onClick={() => setConfirming(true)}
          >
            Reset
          </Button>
        </div>
      </div>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Reset branding?"
        description="Every member of this account will see the Kortix logo, icon, favicon, and name again. Uploaded images are deleted."
        confirmLabel="Reset"
        confirmVariant="destructive"
        isPending={mutation.isPending}
        onConfirm={() => mutation.mutate()}
      />
    </>
  );
}
