'use client';

import { Check, Copy, KeyRound, MoreHorizontal, Trash2 } from 'lucide-react';
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
import {
  useCreateGatewayKey,
  useGatewayKeys,
  useRevokeGatewayKey,
} from '@/hooks/projects/use-project-gateway';
import type { CreatedGatewayKey } from '@/lib/projects-gateway-client';

function fmtDate(s: string | null): string {
  if (!s) return 'never';
  return new Date(s).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

export function GatewayKeys({
  projectId,
  canWrite = false,
}: {
  projectId: string;
  canWrite?: boolean;
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
      <div className="flex min-h-0 flex-1 items-center justify-center p-5">
        <p className="text-muted-foreground text-sm">
          You need the manage-keys permission to view gateway keys.
        </p>
      </div>
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
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="w-full space-y-4 p-5">
        <section className="space-y-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <Label>
                API keys
                <span className="text-muted-foreground font-normal"> ({keys.length})</span>
              </Label>
              <p className="text-muted-foreground mt-0.5 text-pretty text-xs">
                Project-scoped keys for calling the gateway from external apps — every request is
                logged and billed here.
              </p>
            </div>
            {canWrite && (
              <Button size="sm" className="shrink-0" onClick={() => setCreating(true)}>
                Create key
              </Button>
            )}
          </div>

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
                        <span className="text-foreground truncate text-sm font-medium">
                          {k.name}
                        </span>
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
                            variant="destructive"
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
        </section>
      </div>

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
  onClose,
}: {
  created: CreatedGatewayKey;
  /** Env-correct public gateway origin (dev vs prod); falls back to prod. */
  gatewayUrl: string | null;
  onClose: () => void;
}) {
  const base = gatewayUrl ?? 'https://gateway.kortix.com';
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard.writeText(created.secret_key);
    setCopied(true);
    successToast('Key copied');
  };
  return (
    <Modal open onOpenChange={(n) => (n ? undefined : onClose())}>
      <ModalContent className="sm:max-w-md">
        <ModalHeader>
          <ModalTitle>Copy your key</ModalTitle>
          <ModalDescription>{created.name}</ModalDescription>
        </ModalHeader>
        <ModalBody className="space-y-3">
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
          <div>
            <div className="text-muted-foreground mb-1.5 text-xs font-medium">Use it</div>
            <pre className="bg-muted/30 text-foreground overflow-x-auto rounded-md border p-3 font-mono text-xs leading-relaxed">
              {`curl ${base}/v1/chat/completions \\
  -H "Authorization: Bearer ${created.secret_key}" \\
  -d '{"model":"claude-sonnet-4.6","messages":[{"role":"user","content":"Hello"}]}'`}
            </pre>
          </div>
        </ModalBody>
        <ModalFooter>
          <Button onClick={onClose}>Done</Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
