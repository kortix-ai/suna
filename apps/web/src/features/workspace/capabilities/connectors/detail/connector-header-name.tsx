'use client';

import { setConnectorName } from '@kortix/sdk';
import { CheckIcon, PencilSimpleIcon, XIcon } from '@phosphor-icons/react';
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import Loading from '@/components/ui/loading';
import { errorToast, successToast } from '@/components/ui/toast';

export function ConnectorHeaderName({
  projectId,
  slug,
  displayName,
  canWrite,
  disabled,
  onChanged,
}: {
  projectId: string;
  slug: string;
  displayName: string;
  canWrite: boolean;
  disabled: boolean;
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(displayName);
  const [sourceName, setSourceName] = useState(displayName);
  if (sourceName !== displayName) {
    setSourceName(displayName);
    setDraft(displayName);
    setEditing(false);
  }

  const rename = useMutation({
    mutationFn: () => setConnectorName(projectId, slug, draft.trim()),
    onSuccess: () => {
      successToast('Renamed');
      setEditing(false);
      onChanged();
    },
    onError: (error: Error) => errorToast(error.message || 'Failed to rename'),
  });

  if (editing && canWrite) {
    return (
      <form
        className="flex min-w-0 items-center gap-1.5"
        onSubmit={(event) => {
          event.preventDefault();
          if (draft.trim() && draft.trim() !== displayName) rename.mutate();
          else setEditing(false);
        }}
      >
        <Input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          variant="transparent"
          className="h-8 max-w-sm min-w-0 p-0 text-2xl font-semibold tracking-tight max-sm:text-xl"
          autoFocus
          disabled={disabled || rename.isPending}
          aria-label="Connector name"
        />
        <Button
          type="submit"
          size="icon-xs"
          variant="ghost"
          disabled={disabled || rename.isPending || !draft.trim()}
          aria-label="Save name"
        >
          {rename.isPending ? (
            <Loading className="size-4 shrink-0" />
          ) : (
            <CheckIcon className="size-4 shrink-0" />
          )}
        </Button>
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          disabled={rename.isPending}
          onClick={() => {
            setDraft(displayName);
            setEditing(false);
          }}
          aria-label="Cancel rename"
        >
          <XIcon className="size-4 shrink-0" />
        </Button>
      </form>
    );
  }

  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <span className="truncate">{displayName}</span>
      {canWrite ? (
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          disabled={disabled}
          onClick={() => setEditing(true)}
          aria-label="Rename connector"
          className="shrink-0"
        >
          <PencilSimpleIcon className="size-3.5 shrink-0" />
        </Button>
      ) : null}
    </span>
  );
}
