'use client';

import {
  CheckIcon as Check,
  CopyIcon as Copy,
  KeyIcon as KeyRound,
  DotsThreeIcon as MoreHorizontal,
  TrashIcon as Trash2,
} from '@phosphor-icons/react';
import { useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { EntityAvatar } from '@/components/ui/entity-avatar';
import Hint from '@/components/ui/hint';
import { InfoBanner } from '@/components/ui/info-banner';
import { InlineMeta } from '@/components/ui/inline-meta';
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
import { EmptyState } from '@/features/layout/section/empty-state';
import { GatewayApiReference } from '@/features/workspace/customize/sections/view/gateway/gateway-api-reference';
import {
  useCreateGatewayKey,
  useGatewayKeys,
  useRevokeGatewayKey,
} from '@/hooks/projects/use-project-gateway';
import type { CreatedGatewayKey } from '@/lib/projects-gateway-client';

// Hoisted so render does not rebuild the formatter per call — same default
// locale and options as the previous inline `toLocaleDateString` call.
const KEY_DATE_FORMAT = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
});

function fmtDate(s: string | null): string {
  if (!s) return 'never';
  return KEY_DATE_FORMAT.format(new Date(s));
}

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
}: {
  projectId: string;
  canWrite?: boolean;
  /** Jump to the Models tab from the reveal dialog's reference panel. */
  onViewModels?: () => void;
}) {
  const { data, isError } = useGatewayKeys(projectId);
  const createKey = useCreateGatewayKey(projectId);
  const revokeKey = useRevokeGatewayKey(projectId);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [created, setCreated] = useState<CreatedGatewayKey | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<{ key_id: string; name: string } | null>(null);

  const keys = data?.keys ?? [];

  if (isError) {
    return (
      <p className="text-muted-foreground py-6 text-center text-sm">
        You need the manage-keys permission to view gateway keys.
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
      onError: (e) => errorToast(e instanceof Error ? e.message : 'Could not create key'),
    });
  };

  return (
    <div className="space-y-3">
      {/* The count line and the header button only exist once there is a list
          to describe. With no keys the empty state already says what a key is
          for AND carries the one Create button — printing "0 keys" above a
          second Create button is the same offer made twice. */}
      {keys.length > 0 && (
        <div className="flex items-start justify-between gap-3">
          <p className="text-muted-foreground text-xs text-pretty">
            {keys.length === 1 ? '1 key' : `${keys.length} keys`}. Every request made with one is
            logged and billed to this project.
          </p>
          {canWrite && (
            <Button size="sm" className="shrink-0" onClick={() => setCreating(true)}>
              Create key
            </Button>
          )}
        </div>
      )}

      {keys.length === 0 ? (
        <EmptyState
          icon={KeyRound}
          size="sm"
          title="No keys yet"
          description="Create a project-scoped key to call the gateway from outside a Kortix session."
          action={
            canWrite ? (
              <Button variant="outline" size="sm" onClick={() => setCreating(true)}>
                Create key
              </Button>
            ) : undefined
          }
        />
      ) : (
        <ul className="space-y-2">
          {keys.map((k) => {
            const active = k.status === 'active';
            const revoking = revokeKey.isPending && revokeKey.variables === k.key_id;
            return (
              <li
                key={k.key_id}
                className="bg-popover group flex items-center gap-3 rounded-md border px-4 py-2.5 transition-colors"
              >
                <EntityAvatar icon={KeyRound} size="sm" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="text-foreground truncate text-sm font-medium">{k.name}</span>
                    <Badge
                      size="sm"
                      variant={active ? 'success' : 'secondary'}
                      className="capitalize"
                    >
                      {k.status}
                    </Badge>
                  </div>
                  <InlineMeta className="mt-0.5">
                    <code className="font-mono">{k.key_prefix}…</code>
                    <span>last used {fmtDate(k.last_used_at)}</span>
                  </InlineMeta>
                </div>
                {active && canWrite && (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        className="shrink-0"
                        aria-label="Key actions"
                        disabled={revoking}
                      >
                        {revoking ? (
                          <Loading className="size-3.5 shrink-0" />
                        ) : (
                          <MoreHorizontal className="size-3.5 shrink-0" />
                        )}
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-44">
                      <DropdownMenuItem
                        onClick={() => setRevokeTarget({ key_id: k.key_id, name: k.name })}
                      >
                        <Trash2 className="size-3.5 shrink-0" />
                        Revoke key
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <Modal open={creating} onOpenChange={(n) => (n ? undefined : setCreating(false))}>
        <ModalContent className="sm:max-w-md">
          <ModalHeader>
            <ModalTitle>Create gateway key</ModalTitle>
            <ModalDescription>Name it so you can tell your keys apart later.</ModalDescription>
          </ModalHeader>
          <ModalBody>
            <div className="space-y-1.5">
              <Label htmlFor="gateway-key-name">Name</Label>
              <Input
                id="gateway-key-name"
                autoFocus
                placeholder="e.g. Production backend"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && submit()}
                variant="popover"
              />
            </div>
          </ModalBody>
          <ModalFooter className="sm:justify-between">
            <Button type="button" variant="outline-ghost" onClick={() => setCreating(false)}>
              Cancel
            </Button>
            <Button disabled={!name.trim() || createKey.isPending} onClick={submit}>
              {createKey.isPending ? <Loading className="size-4 shrink-0" /> : null}
              Create key
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
        title="Revoke key"
        description={
          revokeTarget
            ? `Revoke ${revokeTarget.name}? Apps calling the gateway with it stop working immediately.`
            : ''
        }
        confirmLabel="Revoke"
        confirmVariant="destructive"
        onConfirm={() => {
          if (!revokeTarget) return;
          revokeKey.mutate(revokeTarget.key_id, {
            onSuccess: () => {
              setRevokeTarget(null);
              successToast('Key revoked');
            },
            onError: (e) => errorToast(e instanceof Error ? e.message : 'Could not revoke'),
          });
        }}
        isPending={revokeKey.isPending}
      />
    </div>
  );
}

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
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard.writeText(created.secret_key);
    setCopied(true);
    successToast('Key copied');
  };
  return (
    <Modal open onOpenChange={(n) => (n ? undefined : onClose())}>
      <ModalContent className="sm:max-w-xl">
        <ModalHeader>
          <ModalTitle>Copy your key</ModalTitle>
          <ModalDescription>{created.name}</ModalDescription>
        </ModalHeader>
        <ModalBody className="max-h-[70vh] space-y-3 overflow-y-auto">
          <InfoBanner tone="warning" title="Shown once">
            This is the only time the full key is displayed. Store it somewhere safe.
          </InfoBanner>
          <div className="bg-popover flex items-center gap-2 rounded-md border px-3 py-2.5">
            <code className="text-foreground min-w-0 flex-1 truncate font-mono text-xs">
              {created.secret_key}
            </code>
            <Hint label={copied ? 'Copied' : 'Copy key'}>
              <Button
                type="button"
                onClick={copy}
                variant="ghost"
                size="icon-sm"
                className="shrink-0"
                aria-label="Copy key"
              >
                {copied ? (
                  <Check className="text-kortix-green size-4 shrink-0" />
                ) : (
                  <Copy className="size-4 shrink-0" />
                )}
              </Button>
            </Hint>
          </div>
          <GatewayApiReference
            apiKey={created.secret_key}
            gatewayUrl={gatewayUrl}
            onViewModels={onViewModels}
          />
        </ModalBody>
        <ModalFooter>
          <Button onClick={onClose}>Done</Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
