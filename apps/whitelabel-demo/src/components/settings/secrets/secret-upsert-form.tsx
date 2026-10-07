'use client';

/** The "Shared secrets" card: the create/rotate form, its pre-flight notices,
 *  and the call snippet that shows the body it sends. */

import Loading from '@/components/ui/loading';

import { CallSnippet } from '@/components/dev/call-snippet';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { kortix } from '@/lib/kortix';
import { normalizeSecretKey } from '@/lib/secret-collisions';
import { pendingKeyCollision } from '@/lib/secret-collisions';
import {
  type SecretWriteIntent,
  defaultIdentifier,
  normalizeSecretDraft,
  secretWriteIntent,
} from '@/lib/secret-upsert';
import type { ProjectSecret } from '@kortix/sdk';
import { useMutation } from '@tanstack/react-query';
import { KeyRound } from 'lucide-react';
import { type Dispatch, type SetStateAction, useState } from 'react';
import { toast } from 'sonner';
import { ALLOWLIST_IS_CREATE_ONLY, Notice, ROTATION_REACHES_RUNNING_SESSIONS_LATE } from './shared';

export function SecretUpsertForm({
  projectId,
  items,
  onSaved,
}: {
  projectId: string;
  items: ProjectSecret[];
  onSaved: () => void;
}) {
  const [name, setName] = useState('');
  // The identifier follows the KEY until someone edits it. Tracking that
  // separately is what lets the field be BOTH a sensible default and editable —
  // clearing the flag on an empty edit puts it back in step.
  const [identifier, setIdentifier] = useState('');
  const [identifierEdited, setIdentifierEdited] = useState(false);
  const [value, setValue] = useState('');

  const draftIdentifier = identifierEdited ? identifier : defaultIdentifier(name);
  const draft = { identifier: draftIdentifier, name, value };
  // A half-typed row has no intent yet — reading one from an empty KEY would
  // accuse every existing identifier of retargeting itself mid-keystroke.
  const intent: SecretWriteIntent = name.trim()
    ? secretWriteIntent(items, draft)
    : { kind: 'create' };
  const collidesWith = pendingKeyCollision(items, draft);

  const upsert = useMutation({
    mutationFn: () => kortix.project(projectId).secrets.upsert(normalizeSecretDraft(draft)),
    onSuccess: () => {
      setName('');
      setIdentifier('');
      setIdentifierEdited(false);
      setValue('');
      onSaved();
      toast.success(intent.kind === 'rotate' ? 'Secret rotated' : 'Secret saved');
    },
    onError: () => toast.error('Could not save secret'),
  });

  const blocked = intent.kind === 'retarget';
  const canSubmit = Boolean(name.trim()) && Boolean(value) && !blocked && !upsert.isPending;

  return (
    <Card className="p-5">
      <div className="flex items-center gap-2 text-sm font-medium">
        <KeyRound className="size-4 text-muted-foreground" /> Shared secrets
      </div>
      <SecretFormIntro />
      <form
        className="mt-3 space-y-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (canSubmit) upsert.mutate();
        }}
      >
        <SecretDraftFields
          draftIdentifier={draftIdentifier}
          name={name}
          value={value}
          setIdentifier={setIdentifier}
          setIdentifierEdited={setIdentifierEdited}
          setName={setName}
          setValue={setValue}
        />

        <SecretDraftNotices
          intent={intent}
          draftIdentifier={draftIdentifier}
          name={name}
          collidesWith={collidesWith}
        />

        <SecretDraftSubmit intent={intent} canSubmit={canSubmit} upsert={upsert} />
      </form>

      <SecretUpsertSnippet projectId={projectId} draftIdentifier={draftIdentifier} name={name} />
    </Card>
  );
}

function SecretFormIntro() {
  return (
    <p className="text-xs text-muted-foreground">
      Environment variables + API keys available to every member at runtime. A secret has a unique{' '}
      <span className="font-mono">identifier</span> and an env{' '}
      <span className="font-mono">KEY</span>: agents and session allowlists reference the
      identifier, the sandbox receives the KEY. They are the same thing until you make them
      different.
    </p>
  );
}

function SecretDraftFields({
  draftIdentifier,
  name,
  value,
  setIdentifier,
  setIdentifierEdited,
  setName,
  setValue,
}: {
  draftIdentifier: string;
  name: string;
  value: string;
  setIdentifier: Dispatch<SetStateAction<string>>;
  setIdentifierEdited: Dispatch<SetStateAction<boolean>>;
  setName: Dispatch<SetStateAction<string>>;
  setValue: Dispatch<SetStateAction<string>>;
}) {
  return (
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
  );
}

function SecretDraftNotices({
  intent,
  draftIdentifier,
  name,
  collidesWith,
}: {
  intent: SecretWriteIntent;
  draftIdentifier: string;
  name: string;
  collidesWith: string[];
}) {
  return (
    <>
      {intent.kind === 'retarget' && (
        <Notice tone="destructive">
          <span className="font-mono">{draftIdentifier}</span> already stores{' '}
          <span className="font-mono">{intent.existingKey}</span>. An identifier is a stable handle
          — pointing it at another KEY would re-aim every agent grant that names it, so the server
          refuses it. Delete that secret first, or choose another identifier.
        </Notice>
      )}
      {intent.kind === 'rotate' && (
        <Notice>
          <span className="font-mono">{draftIdentifier}</span> already exists — saving replaces its
          value. {ROTATION_REACHES_RUNNING_SESSIONS_LATE}
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
    </>
  );
}

function SecretDraftSubmit({
  intent,
  canSubmit,
  upsert,
}: {
  intent: SecretWriteIntent;
  canSubmit: boolean;
  upsert: { isPending: boolean };
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <p className="text-xs text-muted-foreground">{ALLOWLIST_IS_CREATE_ONLY}</p>
      <Button type="submit" disabled={!canSubmit}>
        {upsert.isPending && <Loading className="size-4" />}
        {intent.kind === 'rotate' ? 'Rotate' : 'Save'}
      </Button>
    </div>
  );
}

function SecretUpsertSnippet({
  projectId,
  draftIdentifier,
  name,
}: {
  projectId: string;
  draftIdentifier: string;
  name: string;
}) {
  return (
    <>
      {/* Create and rotate are one call, and the snippet takes the identifier
          and the KEY only — the typed value is never rendered anywhere. */}
      <div className="mt-3">
        <CallSnippet
          id="secret.upsert"
          context={{
            projectId,
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
    </>
  );
}
