'use client';

import { useEffect, useMemo, useState } from 'react';
import { GitBranch, GitPullRequest, Loader2 } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
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
import { cn } from '@/lib/utils';

import { useBranches } from '../hooks/use-branches';
import { useProjectContext } from '../context';
import { useOpenChangeRequest, useVersionDiff } from '../hooks/use-change-requests';
import { DiffPreviewBanner } from './diff-preview-banner';
import type { ProjectBranch } from '@/lib/projects-client';

interface OpenChangeRequestDialogProps {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /** Optional preselected head branch (used by the toolbar shortcut). */
  initialHeadRef?: string;
  /** Optional callback invoked with the new CR id so the caller can open the detail dialog. */
  onCreated?: (crId: string) => void;
}

// Branch names from agent sessions are UUIDs (`a1b2c3d4-...`) — too long for a
// dropdown trigger. We collapse anything matching the UUID shape down to the
// first 8 chars (which is enough to disambiguate). Human-named branches
// (`feature/...`, `fix/...`) keep their full name.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function displayBranchName(name: string): string {
  return UUID_RE.test(name) ? name.slice(0, 8) : name;
}

function BranchRow({ branch }: { branch: ProjectBranch }) {
  return (
    <div className="flex flex-col gap-0.5 py-0.5">
      <div className="flex items-center gap-1.5">
        <GitBranch className="h-3 w-3 text-muted-foreground shrink-0" />
        <span className="font-mono text-xs text-foreground truncate">
          {displayBranchName(branch.name)}
        </span>
        {branch.is_default && (
          <span className="rounded bg-muted px-1 py-0 text-[9px] text-muted-foreground shrink-0">
            default
          </span>
        )}
      </div>
      {branch.subject && (
        <span className="ml-[18px] text-[10.5px] text-muted-foreground/80 truncate">
          {branch.subject}
        </span>
      )}
    </div>
  );
}

export function OpenChangeRequestDialog({
  open,
  onOpenChange,
  initialHeadRef,
  onCreated,
}: OpenChangeRequestDialogProps) {
  const ctx = useProjectContext();
  const defaultBranch = ctx?.defaultBranch ?? 'main';

  const branchesQuery = useBranches({ enabled: open });
  const branches = branchesQuery.data?.branches ?? [];
  const branchMap = useMemo(() => {
    const m = new Map<string, ProjectBranch>();
    for (const b of branches) m.set(b.name, b);
    return m;
  }, [branches]);

  const headOptions = useMemo(
    () => branches.filter((b) => b.name !== defaultBranch),
    [branches, defaultBranch],
  );

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [headRef, setHeadRef] = useState<string>('');
  const [baseRef, setBaseRef] = useState<string>(defaultBranch);

  useEffect(() => {
    if (!open) return;
    setTitle('');
    setDescription('');
    setBaseRef(defaultBranch);
    if (initialHeadRef && initialHeadRef !== defaultBranch) {
      setHeadRef(initialHeadRef);
    } else if (headOptions.length === 1) {
      setHeadRef(headOptions[0].name);
    } else {
      setHeadRef('');
    }
  }, [open, initialHeadRef, defaultBranch, headOptions.length]);

  useEffect(() => {
    if (!open) return;
    if (headRef || headOptions.length === 0) return;
    setHeadRef(headOptions[0].name);
  }, [open, headRef, headOptions]);

  const openMutation = useOpenChangeRequest();

  // Live diff between the two selected versions. The user sees the file-count
  // and +/- before submitting, and we block submit when there's nothing to
  // merge (avoids creating empty CRs).
  const diffPreviewQuery = useVersionDiff(
    headRef && baseRef && headRef !== baseRef ? { from: headRef, into: baseRef } : null,
    { enabled: open },
  );
  const diffPreview = diffPreviewQuery.data;
  const hasChanges =
    Boolean(diffPreview) && !diffPreview!.is_same_ref && !diffPreview!.is_up_to_date && diffPreview!.files_changed > 0;

  const canSubmit =
    Boolean(title.trim()) &&
    Boolean(headRef) &&
    headRef !== baseRef &&
    !diffPreviewQuery.isLoading &&
    hasChanges;

  const handleSubmit = () => {
    if (!canSubmit) return;
    openMutation.mutate(
      {
        title: title.trim(),
        description: description.trim() || undefined,
        head_ref: headRef,
        base_ref: baseRef,
      },
      {
        onSuccess: (cr) => {
          toast.success(`Opened change request #${cr.number}`);
          onOpenChange(false);
          onCreated?.(cr.cr_id);
        },
        onError: (err) => toast.error(err.message),
      },
    );
  };

  const hasOnlyDefaultBranch = !branchesQuery.isLoading && headOptions.length === 0;
  const selectedHeadBranch = headRef ? branchMap.get(headRef) : undefined;
  const selectedBaseBranch = branchMap.get(baseRef);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg p-0 gap-0 overflow-hidden">
        <DialogHeader className="px-5 pt-5 pb-3 space-y-1">
          <DialogTitle className="text-base font-medium flex items-center gap-2">
            <GitPullRequest className="h-4 w-4 text-muted-foreground" />
            Open change request
          </DialogTitle>
          <DialogDescription className="text-[12px]">
            Propose merging one version into another. The merge runs through
            Kortix against your project's git host.
          </DialogDescription>
        </DialogHeader>

        {hasOnlyDefaultBranch ? (
          <div className="px-5 pb-5 space-y-3">
            <div className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
              <p className="font-medium">No non-default versions yet.</p>
              <p className="mt-1">
                Start a session — each session lives on its own branch — and
                you'll be able to open a change request from it.
              </p>
            </div>
            <div className="flex justify-end">
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                Close
              </Button>
            </div>
          </div>
        ) : (
          <>
            <div className="px-5 pb-4 space-y-4">
              {/* Title */}
              <div className="space-y-1.5">
                <Label htmlFor="cr-title" className="text-xs font-medium text-foreground">
                  Title
                </Label>
                <Input
                  id="cr-title"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="What does this change do?"
                  autoFocus
                  className="h-9"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleSubmit();
                  }}
                />
              </div>

              {/* Branch picker — From / Into laid out as two clearly-separated
                  rows of (label, dropdown). The trigger renders the branch
                  name in a mono font and (when available) the head commit
                  subject in a secondary line. */}
              <div className="rounded-md border border-border/60 divide-y divide-border/40">
                <div className="px-3 py-2.5 flex items-center gap-3">
                  <Label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide w-12 shrink-0">
                    From
                  </Label>
                  <Select
                    value={headRef || undefined}
                    onValueChange={setHeadRef}
                    disabled={branchesQuery.isLoading || headOptions.length === 0}
                  >
                    <SelectTrigger
                      className={cn(
                        'h-10 flex-1 min-w-0 border-0 bg-transparent px-2 hover:bg-muted/40 focus:ring-0',
                      )}
                    >
                      {selectedHeadBranch ? (
                        <BranchRow branch={selectedHeadBranch} />
                      ) : (
                        <SelectValue placeholder="Pick a version" />
                      )}
                    </SelectTrigger>
                    <SelectContent className="w-[420px] max-h-[260px]">
                      {headOptions.map((b) => (
                        <SelectItem key={b.name} value={b.name} className="py-1.5">
                          <BranchRow branch={b} />
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="px-3 py-2.5 flex items-center gap-3">
                  <Label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide w-12 shrink-0">
                    Into
                  </Label>
                  <Select
                    value={baseRef}
                    onValueChange={setBaseRef}
                    disabled={branchesQuery.isLoading}
                  >
                    <SelectTrigger
                      className={cn(
                        'h-10 flex-1 min-w-0 border-0 bg-transparent px-2 hover:bg-muted/40 focus:ring-0',
                      )}
                    >
                      {selectedBaseBranch ? (
                        <BranchRow branch={selectedBaseBranch} />
                      ) : (
                        <SelectValue />
                      )}
                    </SelectTrigger>
                    <SelectContent className="w-[420px] max-h-[260px]">
                      {branches.map((b) => (
                        <SelectItem key={b.name} value={b.name} className="py-1.5">
                          <BranchRow branch={b} />
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {/* Live diff preview — shows the user whether there's anything
                  to merge BEFORE they click submit. */}
              {headRef && baseRef && headRef !== baseRef && (
                <DiffPreviewBanner
                  loading={diffPreviewQuery.isLoading}
                  error={diffPreviewQuery.error as Error | null}
                  preview={diffPreview}
                />
              )}
              {headRef && baseRef && headRef === baseRef && (
                <div className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
                  Pick two different versions — you can't merge a version into
                  itself.
                </div>
              )}

              {/* Description */}
              <div className="space-y-1.5">
                <Label
                  htmlFor="cr-description"
                  className="text-xs font-medium text-foreground"
                >
                  Description{' '}
                  <span className="font-normal text-muted-foreground">(optional)</span>
                </Label>
                <Textarea
                  id="cr-description"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Context for reviewers — what changed and why."
                  rows={3}
                  className="text-sm resize-none"
                />
              </div>
            </div>

            <DialogFooter className="px-5 py-3 bg-muted/30 border-t border-border/40">
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button
                disabled={!canSubmit || openMutation.isPending}
                onClick={handleSubmit}
              >
                {openMutation.isPending && (
                  <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                )}
                Open change request
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
