'use client';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { kortix } from '@/lib/kortix';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { GitBranch, KeyRound, Loader2, Trash2, UserCog } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

export function SecretsTab({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const key = ['project-secrets', projectId] as const;
  const refresh = () => qc.invalidateQueries({ queryKey: key });

  const secrets = useQuery({
    queryKey: key,
    queryFn: () => kortix.project(projectId).secrets.list(),
  });

  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [gitToken, setGitToken] = useState('');

  const upsert = useMutation({
    mutationFn: () => kortix.project(projectId).secrets.upsert({ name: name.trim(), value }),
    onSuccess: () => {
      setName('');
      setValue('');
      refresh();
      toast.success('Secret saved');
    },
    onError: () => toast.error('Could not save secret'),
  });

  const remove = useMutation({
    mutationFn: (n: string) => kortix.project(projectId).secrets.remove(n),
    onSuccess: () => {
      refresh();
      toast.success('Secret removed');
    },
    onError: () => toast.error('Could not remove secret'),
  });

  const setGitCredential = useMutation({
    mutationFn: () =>
      kortix.project(projectId).secrets.setGitCredential({ token: gitToken.trim() }),
    onSuccess: () => {
      setGitToken('');
      toast.success('Git credential saved');
    },
    onError: () => toast.error('Could not save git credential'),
  });

  const raw = secrets.data as any;
  const items: any[] = Array.isArray(raw) ? raw : (raw?.items ?? []);

  return (
    <div className="space-y-4">
      <Card className="p-5">
        <div className="flex items-center gap-2 text-sm font-medium">
          <KeyRound className="size-4 text-brand" /> Shared secrets
        </div>
        <p className="text-xs text-muted-foreground">
          Environment variables + API keys available to every member at runtime.
        </p>
        <form
          className="mt-3 flex flex-wrap gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim() && value) upsert.mutate();
          }}
        >
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="NAME"
            className="min-w-[10rem] flex-1 font-mono"
          />
          <Input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="value"
            type="password"
            className="min-w-[10rem] flex-1 font-mono"
          />
          <Button type="submit" disabled={!name.trim() || !value || upsert.isPending}>
            {upsert.isPending && <Loader2 className="size-4 animate-spin" />}
            Save
          </Button>
        </form>
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
            key={String(s.name ?? i)}
            projectId={projectId}
            secret={s}
            onChanged={refresh}
            onRemove={() => remove.mutate(String(s.name))}
            removing={remove.isPending}
          />
        ))}
      </Card>

      <Card className="p-5">
        <div className="flex items-center gap-2 text-sm font-medium">
          <GitBranch className="size-4 text-brand" /> Git credential
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
            {setGitCredential.isPending && <Loader2 className="size-4 animate-spin" />}
            Save credential
          </Button>
        </form>
      </Card>
    </div>
  );
}

function SecretRow({
  projectId,
  secret,
  onChanged,
  onRemove,
  removing,
}: {
  projectId: string;
  secret: any;
  onChanged: () => void;
  onRemove: () => void;
  removing: boolean;
}) {
  const name = String(secret?.name ?? '');
  const mine = secret?.mine as { active: boolean } | null;
  const effective = String(secret?.effective_source ?? 'none');
  const [personal, setPersonal] = useState('');

  const setPersonalMut = useMutation({
    mutationFn: (input: { value?: string; active?: boolean }) =>
      kortix.project(projectId).secrets.setPersonal(name, input),
    onSuccess: () => {
      setPersonal('');
      onChanged();
      toast.success('Personal override saved');
    },
    onError: () => toast.error('Could not save override'),
  });

  const removePersonalMut = useMutation({
    mutationFn: () => kortix.project(projectId).secrets.removePersonal(name),
    onSuccess: () => {
      onChanged();
      toast.success('Override removed');
    },
    onError: () => toast.error('Could not remove override'),
  });

  return (
    <div className="px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="font-mono text-sm">{name}</span>
          {secret?.configured && (
            <Badge variant="secondary" className="text-[10px]">
              shared
            </Badge>
          )}
          <Badge variant="outline" className="text-[10px]">
            uses: {effective}
          </Badge>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="size-8 text-muted-foreground hover:text-destructive"
          disabled={removing}
          onClick={onRemove}
          aria-label={`Remove ${name}`}
        >
          <Trash2 className="size-4" />
        </Button>
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
    </div>
  );
}
