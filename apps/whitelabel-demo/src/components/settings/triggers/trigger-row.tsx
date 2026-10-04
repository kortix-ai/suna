'use client';

/** One trigger row: its badges and its fire/remove/edit actions. The row is
 *  presentation only — the shared fire/remove mutations live in TriggersTab so
 *  their pending state stays cross-row, as before. */

import Loading from '@/components/ui/loading';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
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
import { Textarea } from '@/components/ui/textarea';
import { kortix } from '@/lib/kortix';
import { qk } from '@/lib/query-keys';
import type { ProjectTrigger } from '@kortix/sdk';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Play, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

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
            {update.isPending && <Loading className="size-4" />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
