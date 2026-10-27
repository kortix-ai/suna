'use client';

/**
 * The whole secret lifecycle in one tab: create (with an identifier that need
 * not be the env KEY), rotate, delete — plus the two things about a secret that
 * are invisible in the row itself and cost a session create to discover: which
 * rows share an env KEY, and which rows are not runtime-scoped at all.
 *
 * The upsert form and the git credential card own their own mutations; the row
 * stays here with the shared delete mutation.
 */

import Loading from '@kortix/ui/loading';

import { CallSnippet } from '@/components/dev/call-snippet';
import { Badge } from '@kortix/ui/badge';
import { Button } from '@kortix/ui/button';
import { Card } from '@kortix/ui/card';
import { ConfirmDialog } from '@kortix/ui/confirm-dialog';
import { Input } from '@kortix/ui/input';
import { Label } from '@kortix/ui/label';
import { Separator } from '@kortix/ui/separator';
import { Skeleton } from '@kortix/ui/skeleton';
import { kortix } from '@/lib/kortix';
import { qk } from '@/lib/query-keys';
import { collidingIdentifiers } from '@/lib/secret-collisions';
import { scopeExplanation, secretScope } from '@/lib/secret-scope';
import { buildSecretRotateInput } from '@/lib/secret-upsert';
import type { ProjectSecret } from '@kortix/sdk';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { GitCredentialCard } from './secrets/git-credential-card';
import { SecretUpsertForm } from './secrets/secret-upsert-form';
import {
  ALLOWLIST_IS_CREATE_ONLY,
  Notice,
  ROTATION_REACHES_RUNNING_SESSIONS_LATE,
} from './secrets/shared';
import { errorToast, successToast } from '@kortix/ui/toast';
import { ArrowClockwiseIcon, PlugIcon, TrashIcon, UserGearIcon, WarningIcon } from '@phosphor-icons/react';

export function SecretsTab({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const key = qk.secrets(projectId);
  const refresh = () => qc.invalidateQueries({ queryKey: key });

  const secrets = useQuery({
    queryKey: key,
    queryFn: () => kortix.project(projectId).secrets.list(),
  });

  const items: ProjectSecret[] = secrets.data?.items ?? [];

  const remove = useMutation({
    // By IDENTIFIER, not by env KEY — several identifiers can share one KEY, and
    // the delete route addresses the unique handle.
    mutationFn: (id: string) => kortix.project(projectId).secrets.remove(id),
    onSuccess: () => {
      refresh();
      successToast('Secret removed');
    },
    onError: () => errorToast('Could not remove secret'),
  });

  return (
    <div className="space-y-4">
      <SecretUpsertForm projectId={projectId} items={items} onSaved={refresh} />

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
            projectId={projectId}
            secret={s}
            collidesWith={collidingIdentifiers(items, s.identifier)}
            onChanged={refresh}
            onRemove={() => remove.mutate(s.identifier)}
            removing={remove.isPending}
          />
        ))}
      </Card>

      <GitCredentialCard projectId={projectId} />
    </div>
  );
}

function SecretRow({
  projectId,
  secret,
  collidesWith,
  onChanged,
  onRemove,
  removing,
}: {
  projectId: string;
  secret: ProjectSecret;
  collidesWith: string[];
  onChanged: () => void;
  onRemove: () => void;
  removing: boolean;
}) {
  const name = secret.name;
  const effective = secret.effective_source;
  const scope = secretScope(secret);
  const scopeNote = scopeExplanation(scope);

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
                <PlugIcon className="size-3" /> not runtime
              </Badge>
            )}
            {collidesWith.length > 0 && (
              <Badge variant="destructive" className="text-[10px]">
                <WarningIcon className="size-3" /> KEY shared
              </Badge>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            env <span className="font-mono">{name}</span>
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <DeleteSecretDialog
            projectId={projectId}
            identifier={secret.identifier}
            name={name}
            scope={scope}
            pending={removing}
            onConfirm={onRemove}
          />
        </div>
      </div>

      <SecretRowNotices name={name} collidesWith={collidesWith} scopeNote={scopeNote} />

      {scope === 'runtime' && (
        <>
          <Separator className="my-2" />

          <SecretRotateBlock projectId={projectId} secret={secret} onChanged={onChanged} />

          <Separator className="my-2" />

          <SecretPersonalOverride projectId={projectId} secret={secret} onChanged={onChanged} />
        </>
      )}
    </div>
  );
}

function SecretRowNotices({
  name,
  collidesWith,
  scopeNote,
}: {
  name: string;
  collidesWith: string[];
  scopeNote: string | null;
}) {
  return (
    <>
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
    </>
  );
}

function SecretRotateBlock({
  projectId,
  secret,
  onChanged,
}: {
  projectId: string;
  secret: ProjectSecret;
  onChanged: () => void;
}) {
  const [rotated, setRotated] = useState('');

  const rotate = useMutation({
    mutationFn: () =>
      kortix.project(projectId).secrets.upsert(buildSecretRotateInput(secret, rotated)),
    onSuccess: () => {
      setRotated('');
      onChanged();
      successToast(`${secret.identifier} rotated`);
    },
    onError: () => errorToast('Could not rotate secret'),
  });

  return (
    <div className="space-y-2">
      <Label className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <ArrowClockwiseIcon className="size-3.5" /> Rotate
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
        {ROTATION_REACHES_RUNNING_SESSIONS_LATE} The identifier and its env KEY stay the same, so
        every agent grant and every session allowlist that names it keeps working.
      </p>
    </div>
  );
}

function SecretPersonalOverride({
  projectId,
  secret,
  onChanged,
}: {
  projectId: string;
  secret: ProjectSecret;
  onChanged: () => void;
}) {
  const name = secret.name;
  const mine = secret.mine;
  const [personal, setPersonal] = useState('');

  const setPersonalMut = useMutation({
    mutationFn: (input: { value?: string; active?: boolean }) =>
      // The personal-override route addresses the env KEY, not the identifier.
      kortix
        .project(projectId)
        .secrets.setPersonal(name, input),
    onSuccess: () => {
      setPersonal('');
      onChanged();
      successToast('Personal override saved');
    },
    onError: () => errorToast('Could not save override'),
  });

  const removePersonalMut = useMutation({
    mutationFn: () => kortix.project(projectId).secrets.removePersonal(name),
    onSuccess: () => {
      onChanged();
      successToast('Override removed');
    },
    onError: () => errorToast('Could not remove override'),
  });

  return (
    <div className="space-y-2">
      <Label className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <UserGearIcon className="size-3.5" /> Personal override
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
          <PersonalMineActions
            mine={mine}
            setPersonalMut={setPersonalMut}
            removePersonalMut={removePersonalMut}
          />
        )}
      </div>
    </div>
  );
}

function PersonalMineActions({
  mine,
  setPersonalMut,
  removePersonalMut,
}: {
  mine: { active: boolean; updated_at: string };
  setPersonalMut: {
    isPending: boolean;
    mutate: (input: { value?: string; active?: boolean }) => void;
  };
  removePersonalMut: { isPending: boolean; mutate: () => void };
}) {
  return (
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
  );
}

function DeleteSecretDialog({
  projectId,
  identifier,
  name,
  scope,
  pending,
  onConfirm,
}: {
  projectId: string;
  identifier: string;
  name: string;
  scope: ReturnType<typeof secretScope>;
  pending: boolean;
  onConfirm: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        className="size-8 text-muted-foreground hover:text-destructive"
        disabled={pending}
        aria-label={`Remove ${identifier}`}
        onClick={() => setOpen(true)}
      >
        <TrashIcon className="size-4" />
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={`Delete ${identifier}?`}
        description={
          <div className="space-y-3">
            <p>
              The shared value for <span className="font-mono">{name}</span> is removed and cannot
              be recovered. Agents granted <span className="font-mono">{identifier}</span> lose it
              on their next run.
              {scope === 'channel_install'
                ? ' This row belongs to an installed channel — deleting it breaks that install until it is reconnected.'
                : ''}
            </p>
            <p className="text-xs">{ALLOWLIST_IS_CREATE_ONLY}</p>
            {/* The delete addresses the identifier, and the identifier is exactly
                what the confirmation is about — so the call belongs on the confirm
                step, where it can be read before anything is irreversible. */}
            <CallSnippet id="secret.delete" context={{ projectId, secret: { identifier, name } }} />
          </div>
        }
        confirmLabel="Delete secret"
        confirmVariant="destructive"
        isPending={pending}
        onConfirm={() => {
          onConfirm();
          setOpen(false);
        }}
      />
    </>
  );
}
