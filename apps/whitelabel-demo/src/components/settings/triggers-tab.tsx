'use client';

/**
 * The Automations tab: pause/resume, the add form, and the trigger list.
 */

import Loading from '@/components/ui/loading';

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
import { qk } from '@/lib/query-keys';
import type { ProjectTrigger } from '@kortix/sdk';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Play, Trash2, Zap } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

type TriggerType = 'cron' | 'webhook';

export function AddTriggerForm({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: qk.triggers(projectId) });

  const [name, setName] = useState('');
  const [type, setType] = useState<TriggerType>('cron');
  const [cron, setCron] = useState('0 0 * * * *');
  const [prompt, setPrompt] = useState('');

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

  return (
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
          <TriggerTypeSelect value={type} onValueChange={setType} />
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
            {create.isPending && <Loading className="size-4" />}
            Add trigger
          </Button>
        </div>
      </form>
    </Card>
  );
}

function TriggerTypeSelect({
  value,
  onValueChange,
}: {
  value: TriggerType;
  onValueChange: (value: TriggerType) => void;
}) {
  return (
    <div className="space-y-1.5">
      <Label>Type</Label>
      <Select value={value} onValueChange={(v) => onValueChange(v as TriggerType)}>
        <SelectTrigger className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="cron">cron</SelectItem>
          <SelectItem value="webhook">webhook</SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}

export function TriggerRow({
  projectId,
  trigger,
  index,
  paused,
  firing,
  removing,
  onFire,
  onRemove,
}: {
  projectId: string;
  trigger: ProjectTrigger;
  index: number;
  paused: boolean;
  firing: boolean;
  removing: boolean;
  onFire: () => void;
  onRemove: () => void;
}) {
  const qc = useQueryClient();
  const slug = String(trigger.slug ?? trigger.name ?? index);
  const enabled = trigger.enabled !== false;
  const refresh = () => qc.invalidateQueries({ queryKey: qk.triggers(projectId) });

  return (
    <div className="flex items-center justify-between gap-3 px-4 py-3">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{trigger.name ?? slug}</span>
          <Badge variant="outline">{trigger.type ?? 'cron'}</Badge>
          <Badge variant={enabled && !paused ? 'default' : 'secondary'}>
            {paused ? 'paused' : enabled ? 'active' : 'off'}
          </Badge>
        </div>
        <div className="mt-0.5 text-xs text-muted-foreground">
          <span className="font-mono">{trigger.cron ?? trigger.webhook_url ?? slug}</span>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Button
          variant="ghost"
          size="icon"
          className="size-8 text-muted-foreground hover:text-muted-foreground"
          disabled={firing}
          onClick={onFire}
          aria-label={`Run ${slug}`}
        >
          <Play className="size-4" />
        </Button>
        <EditTriggerDialog
          projectId={projectId}
          slug={slug}
          trigger={trigger}
          onSaved={refresh}
        />
        <Button
          variant="ghost"
          size="icon"
          className="size-8 text-muted-foreground hover:text-destructive"
          disabled={removing}
          onClick={onRemove}
          aria-label={`Delete ${slug}`}
        >
          <Trash2 className="size-4" />
        </Button>
      </div>
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
  const qc = useQueryClient();
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
          <TriggerEnabledSelect value={enabled} onValueChange={setEnabled} />
        </div>
        <DialogFooter>
          <Button disabled={update.isPending} onClick={() => update.mutate()}>
            {update.isPending && <Loading className="size-4" />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function TriggerEnabledSelect({
  value,
  onValueChange,
}: {
  value: 'on' | 'off';
  onValueChange: (value: 'on' | 'off') => void;
}) {
  return (
    <div className="space-y-1.5">
      <Label>Enabled</Label>
      <Select value={value} onValueChange={(v) => onValueChange(v as 'on' | 'off')}>
        <SelectTrigger className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="on">Enabled</SelectItem>
          <SelectItem value="off">Disabled</SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}

export function TriggersTab({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: qk.triggers(projectId) });

  const triggers = useQuery({
    queryKey: qk.triggers(projectId),
    queryFn: () => kortix.project(projectId).triggers.list(),
  });

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
      <TriggersPauseCard paused={paused} setActivation={setActivation} />

      <AddTriggerForm projectId={projectId} />

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
          return (
            <TriggerRow
              key={slug}
              projectId={projectId}
              trigger={t}
              index={i}
              paused={paused}
              firing={fire.isPending}
              removing={remove.isPending}
              onFire={() => fire.mutate(slug)}
              onRemove={() => remove.mutate(slug)}
            />
          );
        })}
      </Card>
    </div>
  );
}

function TriggersPauseCard({
  paused,
  setActivation,
}: {
  paused: boolean;
  setActivation: { isPending: boolean; mutate: (next: boolean) => void };
}) {
  return (
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
          {setActivation.isPending && <Loading className="size-4" />}
          {paused ? 'Resume all' : 'Pause all'}
        </Button>
      </div>
    </Card>
  );
}
