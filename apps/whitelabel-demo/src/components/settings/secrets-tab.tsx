'use client';

import Loading from '@/components/ui/loading';

import { CallSnippet } from '@/components/dev/call-snippet';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Marker, MarkerContent, MarkerIcon } from '@/components/ui/marker';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { kortix } from '@/lib/kortix';
import { qk } from '@/lib/query-keys';
import {
  collidingIdentifiers,
  normalizeSecretKey,
  pendingKeyCollision,
} from '@/lib/secret-collisions';
import { scopeExplanation, secretScope } from '@/lib/secret-scope';
import {
  type SecretWriteIntent,
  buildSecretRotateInput,
  buildSecretUpsertInput,
  defaultIdentifier,
  secretWriteIntent,
} from '@/lib/secret-upsert';
import type { ProjectSecret } from '@kortix/sdk';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, GitBranch, KeyRound, Plug, RotateCw, Trash2, UserCog } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { toast } from 'sonner';

/**
 * The whole secret lifecycle in one tab: create (with an identifier that need
 * not be the env KEY), rotate, delete — plus the two things about a secret that
 * are invisible in the row itself and cost a session create to discover: which
 * rows share an env KEY, and which rows are not runtime-scoped at all.
 */

/** Said wherever someone would otherwise expect this tab to affect a live run. */
const ALLOWLIST_IS_CREATE_ONLY =
  'A session’s secret allowlist is fixed when the session is created — there is no update path for it. Adding, rotating or removing a secret here never widens or narrows what a session that is already running may read; that takes a new session.';

/**
 * True of rotation because a live process cannot have its environment rewritten:
 * the platform does push the new value out to active sandboxes, but the agent
 * there is already running with the old one. Only a session started after the
 * rotation is reliably using the new value.
 */
const ROTATION_REACHES_RUNNING_SESSIONS_LATE =
  'Sessions already running keep the old value until they restart — their agent was started with the old environment and it cannot be replaced in place.';

export function SecretsTab({ workspaceId }: { workspaceId: string }) {
  const qc = useQueryClient();
  const key = qk.secrets(workspaceId);
  const refresh = () => qc.invalidateQueries({ queryKey: key });

  const secrets = useQuery({
    queryKey: key,
    queryFn: () => kortix.project(workspaceId).secrets.list(),
  });

  const [name, setName] = useState('');
  // The identifier follows the KEY until someone edits it. Tracking that
  // separately is what lets the field be BOTH a sensible default and editable —
  // clearing the flag on an empty edit puts it back in step.
  const [identifier, setIdentifier] = useState('');
  const [identifierEdited, setIdentifierEdited] = useState(false);
  const [value, setValue] = useState('');
  const [gitToken, setGitToken] = useState('');

  const items: ProjectSecret[] = secrets.data?.items ?? [];
  const draftIdentifier = identifierEdited ? identifier : defaultIdentifier(name);
  const draft = { identifier: draftIdentifier, name, value };
  // A half-typed row has no intent yet — reading one from an empty KEY would
  // accuse every existing identifier of retargeting itself mid-keystroke.
  const intent: SecretWriteIntent = name.trim()
    ? secretWriteIntent(items, draft)
    : { kind: 'create' };
  const collidesWith = pendingKeyCollision(items, draft);

  const upsert = useMutation({
    mutationFn: () => kortix.project(workspaceId).secrets.upsert(buildSecretUpsertInput(draft)),
    onSuccess: () => {
      setName('');
      setIdentifier('');
      setIdentifierEdited(false);
      setValue('');
      refresh();
      toast.success(intent.kind === 'rotate' ? 'Secret rotated' : 'Secret saved');
    },
    onError: () => toast.error('Could not save secret'),
  });

  const remove = useMutation({
    // By IDENTIFIER, not by env KEY — several identifiers can share one KEY, and
    // the delete route addresses the unique handle.
    mutationFn: (id: string) => kortix.project(workspaceId).secrets.remove(id),
    onSuccess: () => {
      refresh();
      toast.success('Secret removed');
    },
    onError: () => toast.error('Could not remove secret'),
  });

  const setGitCredential = useMutation({
    mutationFn: () =>
      kortix.project(workspaceId).secrets.setGitCredential({ token: gitToken.trim() }),
    onSuccess: () => {
      setGitToken('');
      toast.success('Git credential saved');
    },
    onError: () => toast.error('Could not save git credential'),
  });

  const blocked = intent.kind === 'retarget';
  const canSubmit = Boolean(name.trim()) && Boolean(value) && !blocked && !upsert.isPending;

  return (
    <div className="space-y-4">
      <Card className="p-5">
        <div className="flex items-center gap-2 text-sm font-medium">
          <KeyRound className="size-4 text-muted-foreground" /> Shared secrets
        </div>
        <p className="text-xs text-muted-foreground">
          Environment variables + API keys available to every member at runtime. A secret has a
          unique <span className="font-mono">identifier</span> and an env{' '}
          <span className="font-mono">KEY</span>: agents and session allowlists reference the
          identifier, the sandbox receives the KEY. They are the same thing until you make them
          different.
        </p>
        <form
          className="mt-3 space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (canSubmit) upsert.mutate();
          }}
        >
          <div className="flex flex-wrap gap-2">
            <div className="min-w-[10rem] flex-1 space-y-1">
              <Label htmlFor="secret-identifier" className="text-xs text-muted-foreground">
                Identifier
              </Label>
              <Input
                id="secret-identifier"
                value={draftIdentifier}
                onChange={(e) => {
                  setIdentifier(e.target.value);
                  setIdentifierEdited(e.target.value.length > 0);
                }}
                placeholder="STRIPE_KEY"
                className="font-mono"
              />
            </div>
            <div className="min-w-[10rem] flex-1 space-y-1">
              <Label htmlFor="secret-name" className="text-xs text-muted-foreground">
                Env KEY
              </Label>
              <Input
                id="secret-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="STRIPE_KEY"
                className="font-mono"
              />
            </div>
            <div className="min-w-[10rem] flex-1 space-y-1">
              <Label htmlFor="secret-value" className="text-xs text-muted-foreground">
                Value
              </Label>
              <Input
                id="secret-value"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder="value"
                type="password"
                className="font-mono"
              />
            </div>
          </div>

          {intent.kind === 'retarget' && (
            <Notice tone="destructive">
              <span className="font-mono">{draftIdentifier}</span> already stores{' '}
              <span className="font-mono">{intent.existingKey}</span>. An identifier is a stable
              handle — pointing it at another KEY would re-aim every agent grant that names it, so
              the server refuses it. Delete that secret first, or choose another identifier.
            </Notice>
          )}
          {intent.kind === 'rotate' && (
            <Notice>
              <span className="font-mono">{draftIdentifier}</span> already exists — saving replaces
              its value. {ROTATION_REACHES_RUNNING_SESSIONS_LATE}
            </Notice>
          )}
          {collidesWith.length > 0 && (
            <Notice tone="destructive">
              <span className="font-mono">{name.trim().toUpperCase()}</span> is already stored by{' '}
              <span className="font-mono">{collidesWith.join(', ')}</span>. Both may exist, but one
              session cannot allowlist both identifiers — that create is refused with 409
              SECRET_IDENTIFIER_KEY_COLLISION.
            </Notice>
          )}

          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-muted-foreground">{ALLOWLIST_IS_CREATE_ONLY}</p>
            <Button type="submit" disabled={!canSubmit}>
              {upsert.isPending && <Loading className="size-4" />}
              {intent.kind === 'rotate' ? 'Rotate' : 'Save'}
            </Button>
          </div>
        </form>

        {/* Create and rotate are one call, and the snippet takes the identifier
            and the KEY only — the typed value is never rendered anywhere. */}
        <div className="mt-3">
          <CallSnippet
            id="secret.upsert"
            context={{
              workspaceId,
              // normalizeSecretKey, not raw trim — the upsert uppercases the KEY
              // before sending, and KEY collisions are adjudicated on the
              // uppercased value. A snippet whose whole job is teaching the
              // identifier-vs-KEY distinction must not print the wrong KEY.
              secret: {
                identifier: draftIdentifier || undefined,
                name: name.trim() ? normalizeSecretKey(name) : undefined,
              },
            }}
          />
        </div>
      </Card>

      <Card className="divide-y divide-border p-0">
        {secrets.isLoading && (
          <div className="p-4">
            <Skeleton className="h-5 w-44" />
          </div>
        )}
        {secrets.isSuccess && items.length === 0 && (
          <div className="p-6 text-center text-sm text-muted-foreground">No secrets yet.</div>
        )}
        {items.map((s, i) => (
          <SecretRow
            key={String(s.identifier ?? i)}
            workspaceId={workspaceId}
            secret={s}
            collidesWith={collidingIdentifiers(items, s.identifier)}
            onChanged={refresh}
            onRemove={() => remove.mutate(s.identifier)}
            removing={remove.isPending}
          />
        ))}
      </Card>

      <Card className="p-5">
        <div className="flex items-center gap-2 text-sm font-medium">
          <GitBranch className="size-4 text-muted-foreground" /> Git credential
        </div>
        <p className="text-xs text-muted-foreground">
          A token the agent uses to clone and push to the project repository.
        </p>
        <form
          className="mt-3 flex flex-wrap gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (gitToken.trim()) setGitCredential.mutate();
          }}
        >
          <Input
            value={gitToken}
            onChange={(e) => setGitToken(e.target.value)}
            placeholder="ghp_…"
            type="password"
            className="min-w-[12rem] flex-1 font-mono"
          />
          <Button type="submit" disabled={!gitToken.trim() || setGitCredential.isPending}>
            {setGitCredential.isPending && <Loading className="size-4" />}
            Save credential
          </Button>
        </form>
      </Card>
    </div>
  );
}

function Notice({
  tone = 'muted',
  children,
}: {
  tone?: 'muted' | 'destructive';
  children: ReactNode;
}) {
  return (
    <Marker className={tone === 'destructive' ? 'items-start text-destructive' : 'items-start'}>
      <MarkerIcon className="mt-0.5">
        <AlertTriangle />
      </MarkerIcon>
      <MarkerContent className="whitespace-normal">{children}</MarkerContent>
    </Marker>
  );
}

function SecretRow({
  workspaceId,
  secret,
  collidesWith,
  onChanged,
  onRemove,
  removing,
}: {
  workspaceId: string;
  secret: ProjectSecret;
  collidesWith: string[];
  onChanged: () => void;
  onRemove: () => void;
  removing: boolean;
}) {
  const name = secret.name;
  const mine = secret.mine;
  const effective = secret.effective_source;
  const scope = secretScope(secret);
  const scopeNote = scopeExplanation(scope);
  const [personal, setPersonal] = useState('');
  const [rotated, setRotated] = useState('');

  const rotate = useMutation({
    mutationFn: () =>
      kortix.project(workspaceId).secrets.upsert(buildSecretRotateInput(secret, rotated)),
    onSuccess: () => {
      setRotated('');
      onChanged();
      toast.success(`${secret.identifier} rotated`);
    },
    onError: () => toast.error('Could not rotate secret'),
  });

  const setPersonalMut = useMutation({
    mutationFn: (input: { value?: string; active?: boolean }) =>
      // The personal-override route addresses the env KEY, not the identifier.
      kortix.project(workspaceId).secrets.setPersonal(name, input),
    onSuccess: () => {
      setPersonal('');
      onChanged();
      toast.success('Personal override saved');
    },
    onError: () => toast.error('Could not save override'),
  });

  const removePersonalMut = useMutation({
    mutationFn: () => kortix.project(workspaceId).secrets.removePersonal(name),
    onSuccess: () => {
      onChanged();
      toast.success('Override removed');
    },
    onError: () => toast.error('Could not remove override'),
  });

  return (
    <div className="px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-sm">{secret.identifier}</span>
            {secret.configured && (
              <Badge variant="secondary" className="text-[10px]">
                shared
              </Badge>
            )}
            <Badge variant="outline" className="text-[10px]">
              uses: {effective}
            </Badge>
            {scope !== 'runtime' && (
              <Badge variant="outline" className="text-[10px]">
                <Plug className="size-3" /> not runtime
              </Badge>
            )}
            {collidesWith.length > 0 && (
              <Badge variant="destructive" className="text-[10px]">
                <AlertTriangle className="size-3" /> KEY shared
              </Badge>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            env <span className="font-mono">{name}</span>
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <DeleteSecretDialog
            workspaceId={workspaceId}
            identifier={secret.identifier}
            name={name}
            scope={scope}
            pending={removing}
            onConfirm={onRemove}
          />
        </div>
      </div>

      {collidesWith.length > 0 && (
        <div className="mt-2">
          <Notice tone="destructive">
            <span className="font-mono">{name}</span> is also stored by{' '}
            <span className="font-mono">{collidesWith.join(', ')}</span>. A session may allowlist
            either identifier, never both — naming both is refused with 409
            SECRET_IDENTIFIER_KEY_COLLISION.
          </Notice>
        </div>
      )}
      {scopeNote && (
        <div className="mt-2">
          <Notice>{scopeNote}</Notice>
        </div>
      )}

      {scope === 'runtime' && (
        <>
          <Separator className="my-2" />

          <div className="space-y-2">
            <Label className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <RotateCw className="size-3.5" /> Rotate
            </Label>
            <div className="flex flex-wrap items-center gap-2">
              <Input
                value={rotated}
                onChange={(e) => setRotated(e.target.value)}
                placeholder="new value"
                type="password"
                aria-label={`New value for ${secret.identifier}`}
                className="h-8 min-w-[10rem] flex-1 font-mono"
              />
              <Button
                variant="outline"
                size="sm"
                disabled={!rotated || rotate.isPending}
                onClick={() => rotate.mutate()}
              >
                {rotate.isPending && <Loading className="size-4" />}
                Rotate
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              {ROTATION_REACHES_RUNNING_SESSIONS_LATE} The identifier and its env KEY stay the same,
              so every agent grant and every session allowlist that names it keeps working.
            </p>
          </div>

          <Separator className="my-2" />

          <div className="space-y-2">
            <Label className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <UserCog className="size-3.5" /> Personal override
            </Label>
            <div className="flex flex-wrap items-center gap-2">
              <Input
                value={personal}
                onChange={(e) => setPersonal(e.target.value)}
                placeholder="your own value"
                type="password"
                aria-label={`Personal value for ${name}`}
                className="h-8 min-w-[10rem] flex-1 font-mono"
              />
              <Button
                variant="outline"
                size="sm"
                disabled={!personal || setPersonalMut.isPending}
                onClick={() => setPersonalMut.mutate({ value: personal, active: true })}
              >
                Use mine
              </Button>
              {mine && (
                <>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={setPersonalMut.isPending}
                    onClick={() => setPersonalMut.mutate({ active: !mine.active })}
                  >
                    {mine.active ? 'Disable' : 'Enable'}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-muted-foreground hover:text-destructive"
                    disabled={removePersonalMut.isPending}
                    onClick={() => removePersonalMut.mutate()}
                  >
                    Remove mine
                  </Button>
                </>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function DeleteSecretDialog({
  workspaceId,
  identifier,
  name,
  scope,
  pending,
  onConfirm,
}: {
  workspaceId: string;
  identifier: string;
  name: string;
  scope: ReturnType<typeof secretScope>;
  pending: boolean;
  onConfirm: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="size-8 text-muted-foreground hover:text-destructive"
          disabled={pending}
          aria-label={`Remove ${identifier}`}
        >
          <Trash2 className="size-4" />
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete {identifier}?</DialogTitle>
          <DialogDescription>
            The shared value for <span className="font-mono">{name}</span> is removed and cannot be
            recovered. Agents granted <span className="font-mono">{identifier}</span> lose it on
            their next run.
            {scope === 'channel_install'
              ? ' This row belongs to an installed channel — deleting it breaks that install until it is reconnected.'
              : ''}
          </DialogDescription>
        </DialogHeader>
        <p className="text-xs text-muted-foreground">{ALLOWLIST_IS_CREATE_ONLY}</p>
        {/* The delete addresses the identifier, and the identifier is exactly
            what the confirmation is about — so the call belongs on the confirm
            step, where it can be read before anything is irreversible. */}
        <CallSnippet id="secret.delete" context={{ workspaceId, secret: { identifier, name } }} />
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={pending}
            onClick={() => {
              onConfirm();
              setOpen(false);
            }}
          >
            {pending && <Loading className="size-4" />}
            Delete secret
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
