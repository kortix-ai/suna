'use client';

import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import Loading from '@/components/ui/loading';
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalDescription,
  ModalFooter,
  ModalHeader,
  ModalTitle,
} from '@/components/ui/modal';
import { errorToast, successToast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';
import { importProjectSkill } from '@kortix/sdk';
import { FileZipIcon, UploadSimpleIcon } from '@phosphor-icons/react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type DragEvent, useRef, useState } from 'react';

import { formatSkillImportFileSize, skillImportFileError } from './skill-import-file';

async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  const chunkSize = 32_768;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'Skill could not be imported';
}

function repoLabel(repoUrl: string | undefined): string {
  if (!repoUrl) return 'the project repo';
  try {
    const url = new URL(repoUrl);
    const path = url.pathname.replace(/^\/+/, '').replace(/\.git$/, '');
    return path || repoUrl;
  } catch {
    return repoUrl;
  }
}

export function SkillImportModal({
  projectId,
  open,
  onOpenChange,
}: {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const queryClient = useQueryClient();
  const [dragging, setDragging] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);

  const resetSelection = () => {
    setSelectedFile(null);
    setDragging(false);
    if (inputRef.current) inputRef.current.value = '';
  };

  const closeModal = () => {
    resetSelection();
    onOpenChange(false);
  };

  const mutation = useMutation({
    mutationFn: async (file: File) =>
      importProjectSkill(projectId, {
        fileName: file.name,
        dataBase64: await fileToBase64(file),
      }),
    onSuccess: async (result) => {
      successToast(`Change request #${result.change_request.number} opened`, {
        description: `Skill files were added to ${repoLabel(result.target?.repo_url)} on ${result.branch}.`,
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['project-detail', projectId] }),
        queryClient.invalidateQueries({ queryKey: ['project-config', projectId] }),
        queryClient.invalidateQueries({
          queryKey: ['project-files', 'change-requests', projectId],
        }),
      ]);
      closeModal();
    },
    onError: (error) => errorToast(errorMessage(error)),
  });

  const selectFile = (file: File | undefined) => {
    if (!file) return;
    const validationError = skillImportFileError(file);
    if (validationError) {
      errorToast(validationError);
      if (inputRef.current) inputRef.current.value = '';
      return;
    }
    setSelectedFile(file);
    if (inputRef.current) inputRef.current.value = '';
  };

  const onDrop = (event: DragEvent<HTMLButtonElement>) => {
    event.preventDefault();
    setDragging(false);
    selectFile(event.dataTransfer.files?.[0]);
  };

  const uploadSelectedFile = () => {
    if (selectedFile) mutation.mutate(selectedFile);
  };

  return (
    <Modal
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) resetSelection();
        onOpenChange(nextOpen);
      }}
    >
      <ModalContent className="lg:max-w-md">
        <ModalHeader>
          <ModalTitle>Upload skill</ModalTitle>
          <ModalDescription>
            Add a project skill to this Kortix project repo through a reviewable change request.
          </ModalDescription>
        </ModalHeader>
        <ModalBody className="pt-5">
          <Field>
            <FieldLabel>Skill file</FieldLabel>
            <button
              type="button"
              className={cn(
                'border-border hover:bg-muted/40 focus-visible:ring-ring flex min-h-32 w-full flex-col items-center justify-center gap-3 rounded-md border border-dashed px-5 text-center transition-[color,background-color] outline-none focus-visible:ring-2',
                dragging && 'bg-muted/40',
              )}
              disabled={mutation.isPending}
              onClick={() => inputRef.current?.click()}
              onDragOver={(event) => {
                event.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={onDrop}
            >
              {mutation.isPending ? (
                <Loading className="size-5" />
              ) : (
                <FileZipIcon className="text-muted-foreground size-5" />
              )}
              {selectedFile ? (
                <span className="min-w-0 space-y-1">
                  <span className="text-foreground block max-w-full truncate text-sm font-medium">
                    {selectedFile.name}
                  </span>
                  <span className="text-muted-foreground block text-xs tabular-nums">
                    {formatSkillImportFileSize(selectedFile.size)} · Click or drop to replace
                  </span>
                </span>
              ) : (
                <>
                  <span className="text-sm font-medium">Choose or drop a skill file</span>
                  <span className="text-muted-foreground text-xs">
                    SKILL.md, .md, .skill, or ZIP. Maximum 10 MB.
                  </span>
                </>
              )}
            </button>
            <input
              ref={inputRef}
              type="file"
              className="sr-only"
              aria-label="Skill file"
              accept=".md,.skill,.zip,application/zip,text/markdown,text/plain"
              onChange={(event) => selectFile(event.target.files?.[0])}
            />
            <FieldDescription>
              The upload writes files under .kortix/opencode/skills. It does not install a local
              Codex or Conductor skill.
            </FieldDescription>
          </Field>
        </ModalBody>
        <ModalFooter>
          <Button
            variant="outline-ghost"
            size="sm"
            onClick={closeModal}
            disabled={mutation.isPending}
          >
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={uploadSelectedFile}
            disabled={!selectedFile || mutation.isPending}
          >
            {mutation.isPending ? (
              <Loading className="size-3.5 shrink-0" />
            ) : (
              <UploadSimpleIcon className="size-3.5 shrink-0" />
            )}
            Upload
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
