'use client';

/**
 * Milestone create / edit dialog.
 *
 * Same shape for both flows — `milestone` null = create, set = edit. Inline
 * rather than a separate page (Linear-style) so users stay in context.
 *
 * Fields:
 *   - Title (required)
 *   - Description (markdown, 1–3 lines of context)
 *   - Acceptance criteria (markdown, "Done when: …")
 *   - Due date (optional)
 *   - Color hue picker (optional)
 *
 * Color hue is stored as a 0–360 integer; we preview it as a small dot so
 * users aren't guessing what the number means.
 */

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  useCreateMilestone,
  useUpdateMilestone,
  type Milestone,
} from '@/hooks/kortix/use-milestones';
import { cn } from '@/lib/utils';

const HUE_OPTIONS = [0, 30, 50, 120, 170, 210, 260, 290, 330]; // curated swatches

export function MilestoneDialog({
  projectId,
  open,
  onOpenChange,
  milestone,
}: {
  projectId: string;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  milestone: Milestone | null;
}) {
  const isEdit = milestone !== null;

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [acceptance, setAcceptance] = useState('');
  const [dueAt, setDueAt] = useState('');
  const [hue, setHue] = useState<number | null>(null);

  const createM = useCreateMilestone();
  const updateM = useUpdateMilestone();

  // Reset local state when the target milestone or the open state changes.
  // Without this, reopening a dialog would show stale input from last session.
  useEffect(() => {
    if (!open) return;
    setTitle(milestone?.title ?? '');
    setDescription(milestone?.description_md ?? '');
    setAcceptance(milestone?.acceptance_md ?? '');
    setDueAt(milestone?.due_at ? milestone.due_at.slice(0, 10) : '');
    setHue(milestone?.color_hue ?? null);
  }, [open, milestone]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = title.trim();
    if (!trimmed) {
      toast.error('Title is required');
      return;
    }
    try {
      if (isEdit && milestone) {
        await updateM.mutateAsync({
          projectId,
          ref: milestone.id,
          patch: {
            title: trimmed,
            description_md: description,
            acceptance_md: acceptance,
            due_at: dueAt || null,
            color_hue: hue,
          },
        });
        toast.success(`Updated milestone "${trimmed}"`);
      } else {
        await createM.mutateAsync({
          projectId,
          title: trimmed,
          description_md: description || undefined,
          acceptance_md: acceptance || undefined,
          due_at: dueAt || null,
          color_hue: hue,
        });
        toast.success(`Created milestone "${trimmed}"`);
      }
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Save failed');
    }
  };

  const pending = createM.isPending || updateM.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[540px]">
        <DialogHeader>
          <DialogTitle>{isEdit ? `Edit milestone M${milestone?.number}` : 'New milestone'}</DialogTitle>
          <DialogDescription>
            An outcome-level goal that groups tickets. Keep the acceptance
            criteria concrete — PM will run it to verify "done".
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-1.5">
            <label className="text-[11px] uppercase tracking-[0.06em] font-semibold text-muted-foreground/70">Title</label>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Delivery path e2e"
              autoFocus
              maxLength={120}
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-[11px] uppercase tracking-[0.06em] font-semibold text-muted-foreground/70">Description</label>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="1–3 lines of context — what this outcome covers and why it matters."
              rows={2}
              className="resize-y"
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-[11px] uppercase tracking-[0.06em] font-semibold text-muted-foreground/70">Acceptance criteria</label>
            <Textarea
              value={acceptance}
              onChange={(e) => setAcceptance(e.target.value)}
              placeholder={'Done when: POST /events → subscriber receives signed hook within 3 attempts.'}
              rows={3}
              className="resize-y font-mono text-[12px]"
            />
            <p className="text-[10.5px] text-muted-foreground/50">
              A concrete check — a shell command, curl, test name, or manual verification step.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label className="text-[11px] uppercase tracking-[0.06em] font-semibold text-muted-foreground/70">Due date (optional)</label>
              <Input
                type="date"
                value={dueAt}
                onChange={(e) => setDueAt(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-[11px] uppercase tracking-[0.06em] font-semibold text-muted-foreground/70">Color</label>
              <div className="flex items-center gap-1.5 flex-wrap">
                <button
                  type="button"
                  onClick={() => setHue(null)}
                  className={cn(
                    'h-5 w-5 rounded-full border transition',
                    hue === null ? 'border-foreground ring-2 ring-foreground/20' : 'border-border/50 hover:border-border',
                  )}
                  aria-label="No color"
                  title="No color"
                >
                  <span className="block h-full w-full rounded-full bg-muted/40" />
                </button>
                {HUE_OPTIONS.map((h) => (
                  <button
                    key={h}
                    type="button"
                    onClick={() => setHue(h)}
                    className={cn(
                      'h-5 w-5 rounded-full border transition',
                      hue === h ? 'border-foreground ring-2 ring-foreground/30' : 'border-border/40 hover:border-foreground/40',
                    )}
                    style={{ backgroundColor: `hsl(${h} 70% 55%)` }}
                    aria-label={`hue ${h}`}
                    title={`hue ${h}`}
                  />
                ))}
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={pending}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending || !title.trim()}>
              {pending ? 'Saving…' : isEdit ? 'Save changes' : 'Create milestone'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
