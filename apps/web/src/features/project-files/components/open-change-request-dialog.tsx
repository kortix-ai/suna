'use client';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { InfoBanner } from '@/components/ui/info-banner';
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
import { errorToast, successToast } from '@/components/ui/toast';
import type { ProjectBranch, ProjectSession } from '@/lib/projects-client';
import { GitBranch, GitPullRequest, Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useBranches } from '../hooks/use-branches';
import { useOpenChangeRequest, useVersionDiff } from '../hooks/use-change-requests';
import { DiffPreviewBanner } from './diff-preview-banner';

interface OpenChangeRequestDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The project the change request belongs to. */
  projectId: string;
  /** The branch a change request merges into by default (e.g. `main`). */
  defaultBranch: string;
  /**
   * When set, the dialog opens a change request straight from an agent
   * session: the head is the session's branch and the base is `defaultBranch`,
   * both fixed — so there's no version picker, just a read-only summary.
   * Leaving this unset shows the From / Into branch picker.
   */
  session?: ProjectSession | null;
  /** Picker mode only — preselect the head version (toolbar shortcut). */
  initialHeadRef?: string;
  /** Invoked with the new CR id so the caller can deep-link to it. */
  onCreated?: (crId: string) => void;
}

// Branch names from agent sessions are UUIDs (`a1b2c3d4-...`) — too long for a
// dropdown trigger. We collapse anything matching the UUID shape down to the
// first 8 chars (enough to disambiguate). Human-named branches keep their name.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function displayBranchName(name: string): string {
  return UUID_RE.test(name) ? name.slice(0, 8) : name;
}

/** A labelled row inside the From / Into block — one shape for both modes. */
function FieldRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 px-3 py-2.5">
      <Label className="text-muted-foreground w-12 shrink-0 text-xs font-medium tracking-wide uppercase">
        {label}
      </Label>
      {children}
    </div>
  );
}

/** Read-only branch value (session mode). */
function BranchValue({ name }: { name: string }) {
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <GitBranch className="text-muted-foreground h-3 w-3 shrink-0" />
      <span className="text-foreground truncate font-mono text-xs">{name}</span>
    </div>
  );
}

/** Branch option inside the picker dropdown (picker mode). */
function BranchRow({ branch }: { branch: ProjectBranch }) {
  return (
    <div className="flex flex-col gap-0.5 py-0.5">
      <div className="flex items-center gap-1.5">
        <GitBranch className="text-muted-foreground h-3 w-3 shrink-0" />
        <span className="text-foreground truncate font-mono text-xs">
          {displayBranchName(branch.name)}
        </span>
        {branch.is_default && (
          <Badge variant="secondary" size="sm" className="shrink-0">
            default
          </Badge>
        )}
      </div>
      {branch.subject && (
        <span className="text-muted-foreground/80 ml-[18px] truncate text-xs">
          {branch.subject}
        </span>
      )}
    </div>
  );
}

const PICKER_TRIGGER_CLASS =
  'h-10 flex-1 min-w-0 border-0 bg-transparent px-2 hover:bg-muted/40 focus:ring-0';

export function OpenChangeRequestDialog({
  open,
  onOpenChange,
  projectId,
  defaultBranch,
  session = null,
  initialHeadRef,
  onCreated,
}: OpenChangeRequestDialogProps) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  // Callers clear `session` at the same moment they close the dialog; keep the
  // last one so the read-only summary doesn't flip to the picker mid-close.
  const lastSessionRef = useRef<ProjectSession | null>(session);
  if (session) lastSessionRef.current = session;
  const activeSession = session ?? lastSessionRef.current;
  const sessionMode = activeSession !== null;

  // Branches are only needed for the picker — skip the fetch in session mode.
  const branchesQuery = useBranches({ enabled: open && !sessionMode, projectId });
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
  const [pickedHeadRef, setPickedHeadRef] = useState('');
  const [pickedBaseRef, setPickedBaseRef] = useState(defaultBranch);

  // In session mode head/base are fixed; in picker mode they come from state.
  const headRef = sessionMode ? activeSession!.branch_name : pickedHeadRef;
  const baseRef = sessionMode ? defaultBranch : pickedBaseRef;

  // Reset the form (and picker defaults) each time the dialog opens so drafts
  // don't leak between sessions / branches.
  useEffect(() => {
    if (!open) return;
    setTitle('');
    setDescription('');
    if (sessionMode) return;
    setPickedBaseRef(defaultBranch);
    if (initialHeadRef && initialHeadRef !== defaultBranch) {
      setPickedHeadRef(initialHeadRef);
    } else if (headOptions.length === 1) {
      setPickedHeadRef(headOptions[0].name);
    } else {
      setPickedHeadRef('');
    }
  }, [open, sessionMode, session?.session_id, initialHeadRef, defaultBranch, headOptions.length]);

  useEffect(() => {
    if (!open || sessionMode) return;
    if (pickedHeadRef || headOptions.length === 0) return;
    setPickedHeadRef(headOptions[0].name);
  }, [open, sessionMode, pickedHeadRef, headOptions]);

  const openMutation = useOpenChangeRequest({ projectId });

  // Live diff between the two refs — the user sees the file-count and +/- before
  // submitting, and we block submit when there's nothing to merge.
  const diffQuery = useVersionDiff(
    open && headRef && baseRef && headRef !== baseRef ? { from: headRef, into: baseRef } : null,
    { enabled: open, projectId },
  );
  const diffPreview = diffQuery.data;
  const hasChanges =
    Boolean(diffPreview) &&
    !diffPreview!.is_same_ref &&
    !diffPreview!.is_up_to_date &&
    diffPreview!.files_changed > 0;

  const canSubmit =
    Boolean(title.trim()) &&
    Boolean(headRef) &&
    headRef !== baseRef &&
    !diffQuery.isLoading &&
    hasChanges;

  const handleSubmit = () => {
    if (!canSubmit) return;
    openMutation.mutate(
      {
        title: title.trim(),
        description: description.trim() || undefined,
        head_ref: headRef,
        base_ref: baseRef,
        session_id: sessionMode ? activeSession!.session_id : undefined,
      },
      {
        onSuccess: (cr) => {
          successToast(`Opened change request #${cr.number}`);
          onOpenChange(false);
          onCreated?.(cr.cr_id);
        },
        onError: (err) => errorToast(err.message),
      },
    );
  };

  const hasOnlyDefaultBranch = !sessionMode && !branchesQuery.isLoading && headOptions.length === 0;
  const selectedHeadBranch = headRef ? branchMap.get(headRef) : undefined;
  const selectedBaseBranch = branchMap.get(baseRef);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-lg">
        <DialogHeader className="space-y-1 px-5 pt-5 pb-3">
          <DialogTitle className="flex items-center gap-2 text-base font-medium">
            <GitPullRequest className="text-muted-foreground h-4 w-4" />
            {tHardcodedUi.raw(
              'featuresProjectFilesComponentsOpenChangeRequestDialog.line226JsxTextOpenChangeRequest',
            )}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {sessionMode ? (
              <>
                {tHardcodedUi.raw(
                  'featuresProjectFilesComponentsOpenChangeRequestDialog.line231JsxTextProposeMergingThisSessionAposSWorkInto',
                )}{' '}
                <span className="text-foreground font-mono">{defaultBranch}</span>
                {tHardcodedUi.raw(
                  'featuresProjectFilesComponentsOpenChangeRequestDialog.line232JsxTextTheSessionNeedsToHaveCommittedAndPushed',
                )}
              </>
            ) : (
              <>
                {tHardcodedUi.raw(
                  'featuresProjectFilesComponentsOpenChangeRequestDialog.line237JsxTextProposeMergingOneVersionIntoAnotherTheMerge',
                )}
              </>
            )}
          </DialogDescription>
        </DialogHeader>

        {hasOnlyDefaultBranch ? (
          <div className="space-y-3 px-5 pb-5">
            <InfoBanner
              tone="warning"
              title={tHardcodedUi.raw(
                'featuresProjectFilesComponentsOpenChangeRequestDialog.line246JsxAttrTitleNoNonDefaultVersionsYet',
              )}
            >
              {tHardcodedUi.raw(
                'featuresProjectFilesComponentsOpenChangeRequestDialog.line247JsxTextStartASessionEachSessionLivesOnIts',
              )}
            </InfoBanner>
            <div className="flex justify-end">
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                Close
              </Button>
            </div>
          </div>
        ) : (
          <>
            <div className="space-y-4 px-5 pb-4">
              {/* Title */}
              <div className="space-y-1.5">
                <Label htmlFor="cr-title" className="text-foreground text-xs font-medium">
                  Title
                </Label>
                <Input
                  id="cr-title"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder={
                    sessionMode
                      ? activeSession?.name || 'What did this session change?'
                      : 'What does this change do?'
                  }
                  autoFocus
                  className="h-9"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleSubmit();
                  }}
                />
              </div>

              {/* From / Into — read-only summary in session mode, branch pickers
                  in picker mode. Same container shape either way. */}
              <div className="border-border/60 divide-border/40 divide-y rounded-2xl border">
                {sessionMode ? (
                  <>
                    <FieldRow label="From">
                      <BranchValue name={`${displayBranchName(headRef)} (session)`} />
                    </FieldRow>
                    <FieldRow label="Into">
                      <BranchValue name={baseRef} />
                    </FieldRow>
                  </>
                ) : (
                  <>
                    <FieldRow label="From">
                      <Select
                        value={headRef || undefined}
                        onValueChange={setPickedHeadRef}
                        disabled={branchesQuery.isLoading || headOptions.length === 0}
                      >
                        <SelectTrigger className={PICKER_TRIGGER_CLASS}>
                          {selectedHeadBranch ? (
                            <BranchRow branch={selectedHeadBranch} />
                          ) : (
                            <SelectValue
                              placeholder={tHardcodedUi.raw(
                                'featuresProjectFilesComponentsOpenChangeRequestDialog.line305JsxAttrPlaceholderPickAVersion',
                              )}
                            />
                          )}
                        </SelectTrigger>
                        <SelectContent className="max-h-[260px] w-[420px]">
                          {headOptions.map((b) => (
                            <SelectItem key={b.name} value={b.name} className="py-1.5">
                              <BranchRow branch={b} />
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </FieldRow>
                    <FieldRow label="Into">
                      <Select
                        value={baseRef}
                        onValueChange={setPickedBaseRef}
                        disabled={branchesQuery.isLoading}
                      >
                        <SelectTrigger className={PICKER_TRIGGER_CLASS}>
                          {selectedBaseBranch ? (
                            <BranchRow branch={selectedBaseBranch} />
                          ) : (
                            <SelectValue />
                          )}
                        </SelectTrigger>
                        <SelectContent className="max-h-[260px] w-[420px]">
                          {branches.map((b) => (
                            <SelectItem key={b.name} value={b.name} className="py-1.5">
                              <BranchRow branch={b} />
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </FieldRow>
                  </>
                )}
              </div>

              {/* Live diff preview — shows whether there's anything to merge
                  BEFORE submit. */}
              {headRef && baseRef && headRef !== baseRef && (
                <DiffPreviewBanner
                  loading={diffQuery.isLoading}
                  error={diffQuery.error as Error | null}
                  preview={diffPreview}
                />
              )}
              {!sessionMode && headRef && baseRef && headRef === baseRef && (
                <InfoBanner tone="warning">
                  {tHardcodedUi.raw(
                    'featuresProjectFilesComponentsOpenChangeRequestDialog.line354JsxTextPickTwoDifferentVersionsYouCanAposT',
                  )}
                </InfoBanner>
              )}

              {/* Description */}
              <div className="space-y-1.5">
                <Label htmlFor="cr-description" className="text-foreground text-xs font-medium">
                  Description <span className="text-muted-foreground font-normal">(optional)</span>
                </Label>
                <Textarea
                  id="cr-description"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder={tHardcodedUi.raw(
                    'featuresProjectFilesComponentsOpenChangeRequestDialog.line369JsxAttrPlaceholderContextForReviewersWhatChangedAndWhy',
                  )}
                  rows={3}
                  className="resize-none"
                />
              </div>
            </div>

            <DialogFooter>
              <Button
                variant="ghost"
                onClick={() => onOpenChange(false)}
                disabled={openMutation.isPending}
              >
                Cancel
              </Button>
              <Button disabled={!canSubmit || openMutation.isPending} onClick={handleSubmit}>
                {openMutation.isPending && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}
                {tHardcodedUi.raw(
                  'featuresProjectFilesComponentsOpenChangeRequestDialog.line386JsxTextOpenChangeRequest',
                )}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
