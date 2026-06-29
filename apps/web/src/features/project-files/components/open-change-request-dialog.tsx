'use client';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { InfoBanner } from '@/components/ui/info-banner';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalDescription,
  ModalFooter,
  ModalHeader,
  ModalTitle,
} from '@/components/ui/modal';
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
import { GitBranch, Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useBranches } from '../hooks/use-branches';
import { useOpenChangeRequest, useVersionDiff } from '../hooks/use-change-requests';
import { DiffPreviewBanner } from './diff-preview-banner';

interface OpenChangeRequestDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  defaultBranch: string;
  session?: ProjectSession | null;
  initialHeadRef?: string;
  onCreated?: (crId: string) => void;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function displayBranchName(name: string): string {
  return UUID_RE.test(name) ? name.slice(0, 8) : name;
}

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

function BranchValue({ name }: { name: string }) {
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <GitBranch className="text-muted-foreground size-3 shrink-0" />
      <span className="text-foreground truncate font-mono text-xs">{name}</span>
    </div>
  );
}

function BranchRow({ branch }: { branch: ProjectBranch }) {
  return (
    <div className="flex items-center justify-start gap-2 py-0.5">
      <GitBranch className="text-muted-foreground size-4 shrink-0" />

      <div className="flex flex-col items-start gap-0">
        {branch.subject && (
          <span className="text-muted-foreground/80 truncate text-xs">{branch.subject}</span>
        )}
        <div className="flex items-center gap-1.5">
          <span className="text-foreground truncate font-mono text-xs">
            {displayBranchName(branch.name)}
          </span>
          {branch.is_default && (
            <Badge variant="kortix" size="xs" className="shrink-0 text-[11px]">
              default
            </Badge>
          )}
        </div>
      </div>
    </div>
  );
}

const PICKER_TRIGGER_CLASS =
  'py-2 flex-1 min-w-0 rounded-sm border-0 bg-transparent px-2 hover:bg-muted/40 focus:ring-0';

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
  const lastSessionRef = useRef<ProjectSession | null>(session);
  if (session) lastSessionRef.current = session;
  const activeSession = session ?? lastSessionRef.current;
  const sessionMode = activeSession !== null;

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

  const headRef = sessionMode ? activeSession!.branch_name : pickedHeadRef;
  const baseRef = sessionMode ? defaultBranch : pickedBaseRef;

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
    <Modal open={open} onOpenChange={onOpenChange}>
      <ModalContent className="gap-0 overflow-hidden p-0 lg:max-w-lg">
        <ModalHeader>
          <ModalTitle>
            {tHardcodedUi.raw(
              'featuresProjectFilesComponentsOpenChangeRequestDialog.line226JsxTextOpenChangeRequest',
            )}
          </ModalTitle>
          <ModalDescription className="text-balance">
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
              tHardcodedUi.raw(
                'featuresProjectFilesComponentsOpenChangeRequestDialog.line237JsxTextProposeMergingOneVersionIntoAnotherTheMerge',
              )
            )}
          </ModalDescription>
        </ModalHeader>

        {hasOnlyDefaultBranch ? (
          <>
            <ModalBody className="space-y-3 pt-0">
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
            </ModalBody>
            <ModalFooter className="sm:justify-end">
              <Button variant="outline-ghost" size="sm" onClick={() => onOpenChange(false)}>
                Close
              </Button>
            </ModalFooter>
          </>
        ) : (
          <>
            <ModalBody className="space-y-4 pt-0">
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

              <div className="border-border divide-border bg-popover divide-y rounded-md border">
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
            </ModalBody>

            <ModalFooter className="sm:justify-between">
              <Button
                variant="outline-ghost"
                size="sm"
                className="w-full sm:w-auto"
                onClick={() => onOpenChange(false)}
                disabled={openMutation.isPending}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                className="w-full sm:w-auto"
                disabled={!canSubmit || openMutation.isPending}
                onClick={handleSubmit}
              >
                {openMutation.isPending && <Loader2 className="mr-2 size-3.5 animate-spin" />}
                {tHardcodedUi.raw(
                  'featuresProjectFilesComponentsOpenChangeRequestDialog.line386JsxTextOpenChangeRequest',
                )}
              </Button>
            </ModalFooter>
          </>
        )}
      </ModalContent>
    </Modal>
  );
}
