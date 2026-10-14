'use client';

import { useLocale, useTranslations } from '@/i18n/use-translations';
import {
  CheckIcon as Check,
  KeyIcon as KeyRound,
  PlusIcon as Plus,
  ProhibitIcon as Prohibit,
} from '@phosphor-icons/react';
import { useState } from 'react';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
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
import { errorToast, successToast } from '@/components/ui/toast';
import { Copy } from '@/features/icon/icons/copy';
import { useCopy } from '@/hooks/use-copy';
import { EmptyState } from '@/features/layout/section/empty-state';
import { GatewayFirstRequest } from '@/features/workspace/customize/sections/view/gateway/gateway-api-reference';
import {
  formatShortDate,
  localizedRelativeTime,
} from '@/features/workspace/settings/tabs/tokens-tab';
import type { KebabItem } from '@/features/workspace/shared/access';
import { RowKebab } from '@/features/workspace/shared/access/access-row';
import {
  useCreateGatewayKey,
  useGatewayKeys,
  useRevokeGatewayKey,
} from '@/hooks/projects/use-project-gateway';
import type { CreatedGatewayKey } from '@/lib/projects-gateway-client';

/**
 * Gateway keys — `kortix_gw_…` credentials for calling THIS project's gateway
 * from outside Kortix.
 *
 * A SECTION, not a tab. It used to be its own tab labelled "API keys",
 * sitting four tabs away from another tab also labelled "API keys" (the
 * provider BYOK list) and one tab away from "API" (the reference for calling
 * the gateway with one of these). Three tabs, one job. All three are now
 * sections of `llm-api-keys-tab.tsx`, which owns the scroll container, the
 * padding and the section headings — this renders bare so it can sit inside
 * one.
 */
export function GatewayKeys({
  projectId,
  canWrite = false,
  onViewModels,
  createOpen,
  onCreateOpenChange,
  listOnly = false,
}: {
  projectId: string;
  canWrite?: boolean;
  /** Jump to the Models tab from the reveal dialog's reference panel. */
  onViewModels?: () => void;
  /** Controlled create dialog — the Gateway tab's hero owns the Create button. */
  createOpen?: boolean;
  onCreateOpenChange?: (open: boolean) => void;
  /** Only the key rows (and the dialogs): no count line, no empty state.
   *  The hero above already says what a key is and carries Create. */
  listOnly?: boolean;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const tTokens = useTranslations('settings.tokens');
  const locale = useLocale();
  const [renderedAt] = useState(() => Date.now());
  const { data, isError } = useGatewayKeys(projectId);
  const createKey = useCreateGatewayKey(projectId);
  const revokeKey = useRevokeGatewayKey(projectId);
  const [localCreating, setLocalCreating] = useState(false);
  const creating = createOpen ?? localCreating;
  const setCreating = (open: boolean) => {
    if (createOpen === undefined) setLocalCreating(open);
    onCreateOpenChange?.(open);
  };
  const [name, setName] = useState('');
  const [created, setCreated] = useState<CreatedGatewayKey | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<{ key_id: string; name: string } | null>(null);

  const keys = data?.keys ?? [];

  if (isError) {
    return (
      <p className="text-muted-foreground py-6 text-center text-sm">
        {tI18nComplete.raw('text9173e2705c5b')}
      </p>
    );
  }

  const submit = () => {
    const n = name.trim();
    if (!n) return;
    createKey.mutate(n, {
      onSuccess: (key) => {
        setCreated(key);
        setCreating(false);
        setName('');
      },
      onError: (e) =>
        errorToast(e instanceof Error ? e.message : tI18nComplete.raw('text5a517d8378f5')),
    });
  };

  return (
    <div className="space-y-3">
      {keys.length === 0 ? (
        listOnly ? null : (
          <EmptyState
            icon={KeyRound}
            size="sm"
            title={tI18nComplete.raw('text3e5039d12acd')}
            description={tI18nComplete.raw('text16da5dfc6a3b')}
            action={
              canWrite ? (
                <Button variant="outline" size="sm" onClick={() => setCreating(true)}>
                  {tI18nComplete.raw('textb6cde9030cef')}
                </Button>
              ) : undefined
            }
          />
        )
      ) : (
        // The same card as Settings → Personal access keys (`tokens-tab.tsx`):
        // a header row with the count and New key, then flat rows split by
        // hairlines — key tile, name (+ status when not active), one meta
        // line, and a ⋯ that keeps Revoke one click away.
        <div className="bg-surface overflow-hidden rounded-lg border" data-gateway-key-list="">
          <div className="flex h-12 items-center justify-between gap-3 border-b pr-2 pl-4">
            <span className="text-foreground text-sm font-medium">
              {tTokens('keyCount', { count: keys.length })}
            </span>
            {canWrite ? (
              <Button size="sm" variant="ghost" className="gap-1.5" onClick={() => setCreating(true)}>
                <Plus className="size-3.5 shrink-0" />
                {tTokens('newKey')}
              </Button>
            ) : null}
          </div>
          <ul className="divide-y">
            {keys.map((k) => {
              const active = k.status === 'active';
              const revoking = revokeKey.isPending && revokeKey.variables === k.key_id;
              const meta = [
                tTokens('createdOn', { date: formatShortDate(k.created_at, locale) }),
                k.last_used_at
                  ? tTokens('lastUsed', { time: localizedRelativeTime(k.last_used_at, locale, renderedAt) })
                  : tTokens('neverUsed'),
              ];
              const kebab: KebabItem[] =
                active && canWrite
                  ? [
                      {
                        label: tTokens('revokeKey'),
                        icon: <Prohibit className="size-3.5 shrink-0" />,
                        variant: 'destructive',
                        onSelect: () => setRevokeTarget({ key_id: k.key_id, name: k.name }),
                      },
                    ]
                  : [];
              return (
                <li key={k.key_id} className="flex items-center gap-3 px-4 py-3">
                  <span className="bg-muted text-muted-foreground flex size-8 shrink-0 items-center justify-center rounded-md">
                    <KeyRound className="size-4" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="text-foreground truncate text-sm font-medium">{k.name}</span>
                      {!active ? (
                        <Badge variant="secondary" size="sm">
                          {tTokens(`status.${k.status}`)}
                        </Badge>
                      ) : null}
                    </span>
                    <span className="text-muted-foreground block truncate text-xs">{meta.join(' · ')}</span>
                  </span>
                  {revoking ? (
                    <Loading className="size-3.5 shrink-0" />
                  ) : kebab.length > 0 ? (
                    <span className="shrink-0">
                      <RowKebab items={kebab} label={tTokens('actionsFor', { name: k.name })} />
                    </span>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <Modal open={creating} onOpenChange={(n) => (n ? undefined : setCreating(false))}>
        <ModalContent className="sm:max-w-md">
          <ModalHeader>
            <ModalTitle>{tI18nComplete.raw('textd7d351ef148e')}</ModalTitle>
            <ModalDescription>{tI18nComplete.raw('text8a01d0208ec9')}</ModalDescription>
          </ModalHeader>
          <ModalBody>
            <div className="space-y-1.5">
              <Label htmlFor="gateway-key-name">{tI18nComplete.raw('textdcd1d5223f73')}</Label>
              <Input
                id="gateway-key-name"
                autoFocus
                placeholder={tI18nComplete.raw('text0cab103fc553')}
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && submit()}
                variant="popover"
              />
            </div>
          </ModalBody>
          <ModalFooter className="sm:justify-between">
            <Button type="button" variant="outline-ghost" onClick={() => setCreating(false)}>
              {tI18nComplete.raw('text19766ed6ccb2')}
            </Button>
            <Button disabled={!name.trim() || createKey.isPending} onClick={submit}>
              {createKey.isPending ? <Loading className="size-4 shrink-0" /> : null}
              {tI18nComplete.raw('textb6cde9030cef')}
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>

      {created && (
        <RevealKeyDialog
          created={created}
          gatewayUrl={data?.gateway_url ?? null}
          onViewModels={
            onViewModels
              ? () => {
                  setCreated(null);
                  onViewModels();
                }
              : undefined
          }
          onClose={() => setCreated(null)}
        />
      )}

      <ConfirmDialog
        open={revokeTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRevokeTarget(null);
        }}
        title={tI18nComplete.raw('texte29abcb7ef37')}
        description={
          revokeTarget ? tI18nComplete('text539de6570111', { value0: revokeTarget.name }) : ''
        }
        confirmLabel={tI18nComplete.raw('text87e6d00bbf53')}
        confirmVariant="destructive"
        onConfirm={() => {
          if (!revokeTarget) return;
          revokeKey.mutate(revokeTarget.key_id, {
            onSuccess: () => {
              setRevokeTarget(null);
              successToast(tI18nComplete.raw('text113455086576'));
            },
            onError: (e) =>
              errorToast(e instanceof Error ? e.message : tI18nComplete.raw('text44dfa6d7ebf7')),
          });
        }}
        isPending={revokeKey.isPending}
      />
    </div>
  );
}

/**
 * The show-once reveal (Paper KM01, OpenAI-style): the full key with a dark
 * Copy, one quiet line saying it is shown once, then one first-request card
 * (curl / Python / Node) that reads the key from `KORTIX_GATEWAY_KEY`.
 *
 * Closing is gated on "I've stored this key": Done, ×, Escape and an outside
 * click all do nothing until it is checked. The key cannot be shown again, so
 * a stray click must not lose it.
 */
function RevealKeyDialog({
  created,
  gatewayUrl,
  onViewModels,
  onClose,
}: {
  created: CreatedGatewayKey;
  /** Env-correct public gateway origin (dev vs prod); falls back to prod. */
  gatewayUrl: string | null;
  onViewModels?: () => void;
  onClose: () => void;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const t = useTranslations('gatewayAccess');
  const [stored, setStored] = useState(false);
  const { copied, copy } = useCopy({
    successMessage: tI18nComplete.raw('textd5abc7bad676'),
    errorMessage: tI18nComplete.raw('text94f69e8f103e'),
  });
  return (
    <Modal open onOpenChange={(open) => (!open && stored ? onClose() : undefined)}>
      <ModalContent variant="base" className="space-y-0 lg:max-w-[40rem]" data-gateway-reveal="">
        <ModalHeader className="px-6 pt-5 pr-12 pb-4">
          <ModalTitle>{t('revealTitle')}</ModalTitle>
        </ModalHeader>

        <div className="space-y-3 px-6 pb-5">
          {/* The key's own name labels the field: one line, no "created just now". */}
          <span className="text-muted-foreground block truncate text-xs">{created.name}</span>
          <div className="bg-background -mt-1.5 flex items-center gap-2 rounded-md border py-1.5 pr-1.5 pl-3">
            <code className="text-foreground min-w-0 flex-1 truncate font-mono text-xs">
              {created.secret_key}
            </code>
            <Button
              type="button"
              size="xs"
              className="shrink-0 gap-1.5"
              aria-label={copied ? tI18nComplete.raw('text8d525e5f158b') : tI18nComplete.raw('texte47c8bae740d')}
              onClick={() => void copy(created.secret_key)}
            >
              {copied ? (
                <Check className="size-3.5 shrink-0" />
              ) : (
                <>
                  <Copy className="size-3.5 shrink-0" />
                  {tI18nComplete.raw('texte21f935f11d7')}
                </>
              )}
              <span className="sr-only" aria-live="polite">
                {copied ? tI18nComplete.raw('text8d525e5f158b') : ''}
              </span>
            </Button>
          </div>
          <Alert>
            <AlertDescription className="text-xs">{t('shownOnceNote')}</AlertDescription>
          </Alert>
        </div>

        <div className="border-t px-6 pt-4 pb-5">
          <GatewayFirstRequest gatewayUrl={gatewayUrl} onViewModels={onViewModels} />
        </div>

        <div className="bg-background flex items-center justify-between gap-3 border-t px-6 py-3">
          <div className="flex items-center gap-2">
            <Checkbox
              id="gateway-key-stored"
              checked={stored}
              onCheckedChange={(v) => setStored(v === true)}
              className="data-[state=checked]:border-foreground data-[state=checked]:bg-foreground"
            />
            <label htmlFor="gateway-key-stored" className="text-foreground cursor-pointer text-xs">
              {t('storedConfirm')}
            </label>
          </div>
          <Button size="sm" disabled={!stored} onClick={onClose}>
            {tI18nComplete.raw('text11a6767d5674')}
          </Button>
        </div>
      </ModalContent>
    </Modal>
  );
}
