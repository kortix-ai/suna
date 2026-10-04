'use client';

/** The "Add a trigger" card: owns its fields and the create mutation. */

import Loading from '@/components/ui/loading';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
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
import { useMutation, useQueryClient } from '@tanstack/react-query';
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
            {create.isPending && <Loading className="size-4" />}
            Add trigger
          </Button>
        </div>
      </form>
    </Card>
  );
}
