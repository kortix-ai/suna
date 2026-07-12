'use client';

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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { kortix } from '@/lib/kortix';
import type { ProjectTrigger } from '@kortix/sdk';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, Play, Trash2, Zap } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

type TriggerType = 'cron' | 'webhook';

export function TriggersTab({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const key = ['project-triggers', projectId] as const;
  const refresh = () => qc.invalidateQueries({ queryKey: key });

  const triggers = useQuery({
    queryKey: key,
    queryFn: () => kortix.project(projectId).triggers.list(),
  });

  const [name, setName] = useState('');
  const [type, setType] = useState<TriggerType>('cron');
  const [cron, setCron] = useState('0 0 * * * *');
  const [prompt, setPrompt] = useState('');

  const items: ProjectTrigger[] = triggers.data?.triggers ?? [];
  const paused: boolean = Boolean(triggers.data?.triggers_paused);

  const setActivation = useMutation({
    mutationFn: (next: boolean) => kortix.project(projectId).triggers.setActivation(next),
    onSuccess: (_res, next) => {
      refresh();
      toast.success(next ? 'All triggers paused' : 'All triggers resumed');
    },
    onError: () => toast.error('Could not change activation'),
  });

  const create = useMutation({
    mutationFn: () =>
      kortix.project(projectId).triggers.create({
        name: name.trim(),
        type,
        prompt_template: prompt.trim() || name.trim(),
        ...(type === 'cron' ? { cron: cron.trim() } : {}),
      }),
    onSuccess: () => {
      setName('');
      setPrompt('');
      refresh();
      toast.success('Trigger created');
    },
    onError: () => toast.error('Could not create trigger'),
  });

  const fire = useMutation({
    mutationFn: (slug: string) => kortix.project(projectId).triggers.fire(slug),
    onSuccess: (res) => {
      toast.success(`Trigger ${res.status}`);
    },
    onError: () => toast.error('Could not fire trigger'),
  });

  const remove = useMutation({
    mutationFn: (slug: string) => kortix.project(projectId).triggers.remove(slug),
    onSuccess: () => {
      refresh();
      toast.success('Trigger deleted');
    },
    onError: () => toast.error('Could not delete trigger'),
  });

  return (
    <div className="space-y-4">
      <Card className="p-5">
        <div className="flex items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 text-sm font-medium">
              <Zap className="size-4 text-muted-foreground" /> Automations
            </div>
            <p className="text-xs text-muted-foreground">
              {paused
                ? 'All triggers are paused — nothing auto-runs.'
                : 'Triggers run automatically on schedule or webhook.'}
            </p>
          </div>
          <Button
            variant={paused ? 'default' : 'outline'}
            size="sm"
            disabled={setActivation.isPending}
            onClick={() => setActivation.mutate(!paused)}
          >
            {setActivation.isPending && <Loader2 className="size-4 animate-spin" />}
            {paused ? 'Resume all' : 'Pause all'}
          </Button>
        </div>
      </Card>

      <Card className="p-5">
        <div className="text-sm font-medium">Add a trigger</div>
        <form
          className="mt-3 space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) create.mutate();
          }}
        >
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="t-name">Name</Label>
              <Input
                id="t-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Nightly digest"
              />
            </div>
            <div className="space-y-1.5">
              <Label>Type</Label>
              <Select value={type} onValueChange={(v) => setType(v as TriggerType)}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="cron">cron</SelectItem>
                  <SelectItem value="webhook">webhook</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          {type === 'cron' && (
            <div className="space-y-1.5">
              <Label htmlFor="t-cron">Cron (6-field)</Label>
              <Input
                id="t-cron"
                value={cron}
                onChange={(e) => setCron(e.target.value)}
                placeholder="0 0 * * * *"
                className="font-mono"
              />
            </div>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="t-prompt">Prompt</Label>
            <Textarea
              id="t-prompt"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="What should the agent do when this fires?"
              rows={3}
            />
          </div>
          <div className="flex justify-end">
            <Button type="submit" disabled={!name.trim() || create.isPending}>
              {create.isPending && <Loader2 className="size-4 animate-spin" />}
              Add trigger
            </Button>
          </div>
        </form>
      </Card>

      <Card className="divide-y divide-border p-0">
        {triggers.isLoading && (
          <div className="p-4">
            <Skeleton className="h-5 w-44" />
          </div>
        )}
        {triggers.isSuccess && items.length === 0 && (
          <div className="p-6 text-center text-sm text-muted-foreground">No triggers yet.</div>
        )}
        {items.map((t, i) => {
          const slug = String(t.slug ?? t.name ?? i);
          const enabled = t.enabled !== false;
          return (
            <div key={slug} className="flex items-center justify-between gap-3 px-4 py-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium">{t.name ?? slug}</span>
                  <Badge variant="outline">{t.type ?? 'cron'}</Badge>
                  <Badge variant={enabled && !paused ? 'default' : 'secondary'}>
                    {paused ? 'paused' : enabled ? 'active' : 'off'}
                  </Badge>
                </div>
                <div className="mt-0.5 text-xs text-muted-foreground">
                  <span className="font-mono">{t.cron ?? t.webhook_url ?? slug}</span>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-8 text-muted-foreground hover:text-muted-foreground"
                  disabled={fire.isPending}
                  onClick={() => fire.mutate(slug)}
                  aria-label={`Run ${slug}`}
                >
                  <Play className="size-4" />
                </Button>
                <EditTriggerDialog
                  projectId={projectId}
                  slug={slug}
                  trigger={t}
                  onSaved={refresh}
                />
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-8 text-muted-foreground hover:text-destructive"
                  disabled={remove.isPending}
                  onClick={() => remove.mutate(slug)}
                  aria-label={`Delete ${slug}`}
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>
            </div>
          );
        })}
      </Card>
    </div>
  );
}

function EditTriggerDialog({
  projectId,
  slug,
  trigger,
  onSaved,
}: {
  projectId: string;
  slug: string;
  trigger: ProjectTrigger;
  onSaved: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(trigger.name);
  const [prompt, setPrompt] = useState(trigger.prompt_template);
  const [enabled, setEnabled] = useState<'on' | 'off'>(trigger.enabled === false ? 'off' : 'on');

  const update = useMutation({
    mutationFn: () =>
      kortix.project(projectId).triggers.update(slug, {
        name: name.trim() || undefined,
        prompt_template: prompt.trim() || undefined,
        enabled: enabled === 'on',
      }),
    onSuccess: () => {
      onSaved();
      setOpen(false);
      toast.success('Trigger updated');
    },
    onError: () => toast.error('Could not update trigger'),
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="text-muted-foreground"
          aria-label={`Edit ${slug}`}
        >
          Edit
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="font-mono text-base">{slug}</DialogTitle>
          <DialogDescription>Update this trigger.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor={`e-name-${slug}`}>Name</Label>
            <Input id={`e-name-${slug}`} value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`e-prompt-${slug}`}>Prompt</Label>
            <Textarea
              id={`e-prompt-${slug}`}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={3}
            />
          </div>
          <div className="space-y-1.5">
            <Label>Enabled</Label>
            <Select value={enabled} onValueChange={(v) => setEnabled(v as 'on' | 'off')}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="on">Enabled</SelectItem>
                <SelectItem value="off">Disabled</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button disabled={update.isPending} onClick={() => update.mutate()}>
            {update.isPending && <Loader2 className="size-4 animate-spin" />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
