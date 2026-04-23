'use client';

/**
 * Credentials tab — project-scoped encrypted secret store.
 *
 * Layout echoes Team / Milestones tabs: max-w-3xl, uppercase section
 * labels, rounded-xl card on bg-card with divided rows.
 *
 * List rows show NAME + description + "last read" relative timestamp.
 * Value is hidden behind a Reveal button that fires an explicit
 * GET /:name — each reveal creates a `read` event in the audit log
 * so "who peeked at STRIPE_KEY last Tuesday" is answerable.
 *
 * Edit dialog handles both create and update (upsert semantics on the
 * backend — same POST for both).
 */

import { useMemo, useState } from 'react';
import { KeyRound, Plus, Eye, EyeOff, Copy, Trash2, Loader2, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  useCredentials,
  useDeleteCredential,
  useRevealCredential,
  useUpsertCredential,
  type CredentialItem,
} from '@/hooks/kortix/use-credentials';
import { relativeTime } from '@/lib/kortix/task-meta';

// Env-var-style name validation — mirrors the server rule so we reject
// before the round-trip rather than surfacing a 400.
const NAME_RE = /^[A-Z_][A-Z0-9_]*$/i;

export function CredentialsTab({ projectId }: { projectId: string }) {
  const { data, isLoading } = useCredentials(projectId);
  const [dialog, setDialog] = useState<{ mode: 'create' } | { mode: 'edit'; item: CredentialItem } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<CredentialItem | null>(null);
  const delCred = useDeleteCredential();

  const items = useMemo(() => data ?? [], [data]);

  return (
    <div className="flex-1 overflow-y-auto bg-background">
      <div className="container mx-auto max-w-3xl px-3 sm:px-4 py-5 space-y-5">

        <header className="flex items-end justify-between gap-3">
          <div>
            <h2 className="text-[15px] font-semibold tracking-tight">Credentials</h2>
            <p className="text-[11.5px] text-muted-foreground/60 mt-1 flex items-center gap-1.5">
              <ShieldCheck className="h-3 w-3" /> AES-256-GCM encrypted, scoped to this project only. Agents read via <code className="text-[11px] px-1 py-0.5 rounded bg-muted/50">credential_get()</code>.
            </p>
          </div>
          <Button size="sm" onClick={() => setDialog({ mode: 'create' })} className="gap-1.5">
            <Plus className="h-3.5 w-3.5" /> New credential
          </Button>
        </header>

        {isLoading && (
          <div className="text-[12px] text-muted-foreground/50 py-6 text-center">Loading credentials…</div>
        )}

        {!isLoading && items.length === 0 && (
          <EmptyState onCreate={() => setDialog({ mode: 'create' })} />
        )}

        {!isLoading && items.length > 0 && (
          <ul className="rounded-xl border border-border/40 bg-card divide-y divide-border/30 overflow-hidden">
            {items.map((item) => (
              <CredentialRow
                key={item.id}
                projectId={projectId}
                item={item}
                onEdit={() => setDialog({ mode: 'edit', item })}
                onDelete={() => setConfirmDelete(item)}
              />
            ))}
          </ul>
        )}
      </div>

      <CredentialDialog
        projectId={projectId}
        open={dialog !== null}
        onOpenChange={(o) => { if (!o) setDialog(null); }}
        initial={dialog?.mode === 'edit' ? dialog.item : null}
      />

      <ConfirmDialog
        open={confirmDelete !== null}
        onOpenChange={(o) => { if (!o) setConfirmDelete(null); }}
        title="Delete credential?"
        description={confirmDelete ? `"${confirmDelete.name}" will be removed from this project's vault. Audit log entries are preserved.` : ''}
        confirmLabel="Delete"
        isPending={delCred.isPending}
        onConfirm={async () => {
          if (!confirmDelete) return;
          try {
            await delCred.mutateAsync({ projectId, name: confirmDelete.name });
            toast.success(`Deleted ${confirmDelete.name}`);
          } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Delete failed');
          } finally {
            setConfirmDelete(null);
          }
        }}
      />
    </div>
  );
}

// ── Row ─────────────────────────────────────────────────────────────────────

function CredentialRow({
  projectId,
  item,
  onEdit,
  onDelete,
}: {
  projectId: string;
  item: CredentialItem;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const reveal = useRevealCredential();
  const [value, setValue] = useState<string | null>(null);

  const onReveal = async () => {
    if (value !== null) { setValue(null); return; }
    try {
      const res = await reveal.mutateAsync({ projectId, name: item.name });
      setValue(res.value);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Reveal failed');
    }
  };

  const onCopy = async () => {
    try {
      const res = value !== null
        ? { value }
        : await reveal.mutateAsync({ projectId, name: item.name });
      await navigator.clipboard.writeText(res.value);
      toast.success(`Copied ${item.name}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Copy failed');
    }
  };

  return (
    <li className="group px-4 py-3 hover:bg-muted/20 transition-colors">
      <div className="flex items-start gap-3">
        <KeyRound className="h-4 w-4 text-muted-foreground/50 shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 min-w-0">
            <button
              onClick={onEdit}
              className="text-[13px] font-semibold font-mono truncate hover:text-foreground/80 cursor-pointer text-left"
              title="Click to edit"
            >
              {item.name}
            </button>
          </div>
          {item.description && (
            <p className="mt-0.5 text-[11.5px] text-muted-foreground/60 truncate">{item.description}</p>
          )}
          <div className="mt-1 flex items-center gap-3 text-[10.5px] tabular-nums text-muted-foreground/50">
            <span>set {relativeTime(item.updated_at)}</span>
            {item.last_read_at
              ? <span>· last read {relativeTime(item.last_read_at)}</span>
              : <span>· never read</span>}
          </div>
          {value !== null && (
            <div className="mt-2 rounded-md bg-muted/40 border border-border/40 px-2.5 py-1.5 font-mono text-[12px] break-all">
              {value}
            </div>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <Button
            variant="ghost" size="sm"
            onClick={onReveal}
            disabled={reveal.isPending}
            className="h-7 px-2 text-muted-foreground/60 hover:text-foreground"
            title={value !== null ? 'Hide value' : 'Reveal value (audit-logged)'}
          >
            {reveal.isPending
              ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
              : value !== null
                ? <EyeOff className="h-3.5 w-3.5" />
                : <Eye className="h-3.5 w-3.5" />}
          </Button>
          <Button
            variant="ghost" size="sm"
            onClick={onCopy}
            className="h-7 px-2 text-muted-foreground/60 hover:text-foreground"
            title="Copy value to clipboard"
          >
            <Copy className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost" size="sm"
            onClick={onDelete}
            className="h-7 px-2 text-muted-foreground/50 hover:text-destructive"
            title="Delete"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
    </li>
  );
}

// ── Dialog ──────────────────────────────────────────────────────────────────

function CredentialDialog({
  projectId,
  open,
  onOpenChange,
  initial,
}: {
  projectId: string;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  initial: CredentialItem | null;
}) {
  const isEdit = initial !== null;
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [description, setDescription] = useState('');
  const upsert = useUpsertCredential();

  // Reset when opening
  useMemo(() => {
    if (open) {
      setName(initial?.name ?? '');
      setDescription(initial?.description ?? '');
      setValue('');
    }
    return null;
  }, [open, initial]);

  const nameValid = NAME_RE.test(name.trim());
  const canSubmit = name.trim() && (isEdit || value) && (isEdit || nameValid);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    try {
      await upsert.mutateAsync({
        projectId,
        name: name.trim(),
        value,
        description: description.trim() || null,
      });
      toast.success(`${isEdit ? 'Updated' : 'Created'} credential ${name.trim()}`);
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Save failed');
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>{isEdit ? `Update ${initial?.name}` : 'New credential'}</DialogTitle>
          <DialogDescription className="flex items-center gap-1.5">
            <ShieldCheck className="h-3 w-3" />
            Encrypted with AES-256-GCM, scoped to this project only.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={onSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <label className="text-[11px] uppercase tracking-[0.06em] font-semibold text-muted-foreground/70">Name</label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={isEdit}
              placeholder="STRIPE_API_KEY"
              className="font-mono text-[13px]"
              autoFocus={!isEdit}
              maxLength={120}
            />
            {!isEdit && name && !nameValid && (
              <p className="text-[10.5px] text-destructive/80">
                Letters, digits, underscore — no leading digit, no dashes.
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <label className="text-[11px] uppercase tracking-[0.06em] font-semibold text-muted-foreground/70">
              Value{isEdit && <span className="font-normal normal-case text-muted-foreground/50"> — enter a new value to rotate; leave blank to keep existing and update description only</span>}
            </label>
            <Textarea
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={isEdit ? 'Leave blank to keep existing value' : 'sk_live_...'}
              rows={3}
              className="resize-y font-mono text-[12px]"
              autoFocus={isEdit}
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-[11px] uppercase tracking-[0.06em] font-semibold text-muted-foreground/70">Description (optional)</label>
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Stripe live-mode API key — for the billing worker"
              maxLength={240}
            />
          </div>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={upsert.isPending}>
              Cancel
            </Button>
            <Button type="submit" disabled={!canSubmit || upsert.isPending}>
              {upsert.isPending ? 'Saving…' : isEdit ? 'Save changes' : 'Create credential'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ── Empty ───────────────────────────────────────────────────────────────────

function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="rounded-xl border border-dashed border-border/50 bg-muted/10 p-8 text-center">
      <KeyRound className="h-6 w-6 text-muted-foreground/40 mx-auto mb-3" />
      <h3 className="text-[13px] font-semibold text-foreground/90">No credentials yet</h3>
      <p className="text-[11.5px] text-muted-foreground/60 mt-1 max-w-md mx-auto">
        Store project-specific secrets (API keys, tokens, connection strings).
        Agents read them with <code className="text-[11px] px-1 py-0.5 rounded bg-muted/50">credential_get(&quot;NAME&quot;)</code> instead of scraping <code className="text-[11px] px-1 py-0.5 rounded bg-muted/50">.env</code> files.
        Values never enter <code className="text-[11px] px-1 py-0.5 rounded bg-muted/50">process.env</code>.
      </p>
      <Button size="sm" onClick={onCreate} className="mt-3 gap-1.5">
        <Plus className="h-3.5 w-3.5" /> Store first credential
      </Button>
    </div>
  );
}
