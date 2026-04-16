'use client';

import Image from 'next/image';
import { useState, useEffect, useRef, useMemo } from 'react';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import {
  Loader2,
  X,
  Play,
  Paperclip,
} from 'lucide-react';
import { useCreateKortixTask, useStartKortixTask } from '@/hooks/kortix/use-kortix-tasks';
import type { KortixTaskStatus } from '@/hooks/kortix/use-kortix-tasks';
import { uploadFile } from '@/features/files/api/opencode-files';
import { getFileIcon } from '@/features/files/components/file-icon';
import { toast } from '@/lib/toast';

function isImageFile(file: File): boolean {
  if (file.type.startsWith('image/')) return true;
  const ext = file.name.split('.').pop()?.toLowerCase() || '';
  return ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp'].includes(ext);
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${(bytes / 1048576).toFixed(1)}MB`;
}

export function NewTaskDialog({
  open,
  onOpenChange,
  projectId,
  projectName,
  projectPath,
  defaultStatus,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  projectName?: string;
  projectPath?: string;
  defaultStatus?: KortixTaskStatus;
}) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [verification, setVerification] = useState('');
  const [showVerification, setShowVerification] = useState(false);
  const [autoRun, setAutoRun] = useState(true);
  const [createMore, setCreateMore] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [uploading, setUploading] = useState(false);

  const titleRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const create = useCreateKortixTask();
  const start = useStartKortixTask();

  // Preview URLs for images
  const previews = useMemo(() => {
    return files.map((f) => isImageFile(f) ? URL.createObjectURL(f) : null);
  }, [files]);

  // Cleanup preview URLs
  useEffect(() => {
    return () => { previews.forEach((url) => url && URL.revokeObjectURL(url)); };
  }, [previews]);

  useEffect(() => {
    if (open) {
      setTitle('');
      setDescription('');
      setVerification('');
      setShowVerification(false);
      setFiles([]);
      setTimeout(() => titleRef.current?.focus(), 50);
    }
  }, [open]);

  const removeFile = (index: number) => {
    setFiles((prev) => prev.filter((_, i) => i !== index));
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = Array.from(e.target.files || []);
    if (selected.length > 0) setFiles((prev) => [...prev, ...selected]);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const dropped = Array.from(e.dataTransfer.files);
    if (dropped.length > 0) setFiles((prev) => [...prev, ...dropped]);
  };

  const submit = async () => {
    const t = title.trim();
    if (!t) return;

    let attachmentPaths: string[] = [];
    if (files.length > 0) {
      setUploading(true);
      try {
        const uploadDir = `/workspace/uploads`;
        const results = await Promise.all(
          files.map((file) => uploadFile(file, uploadDir)),
        );
        attachmentPaths = results.flat().map((r) => r.path);
      } catch {
        toast('Failed to upload attachments');
        setUploading(false);
        return;
      }
      setUploading(false);
    }

    let fullDescription = description.trim();
    if (attachmentPaths.length > 0) {
      const refs = attachmentPaths.map((p) => `- ${p}`).join('\n');
      fullDescription = fullDescription
        ? `${fullDescription}\n\nAttachments:\n${refs}`
        : `Attachments:\n${refs}`;
    }

    create.mutate(
      {
        project_id: projectId,
        title: t,
        description: fullDescription,
        verification_condition: verification.trim(),
        status: 'todo',
      },
      {
        onSuccess: (task) => {
          const taskId = (task as any)?.id;
          if (autoRun && taskId) {
            start.mutate({ id: taskId }, {
              onSuccess: () => toast('Task started', { description: t }),
              onError: () => toast('Task created but failed to start', { description: t }),
            });
          } else {
            toast(`Task created${createMore ? ' — ready for next' : ''}`, { description: t });
          }
          if (createMore) {
            setTitle('');
            setDescription('');
            setVerification('');
            setShowVerification(false);
            setFiles([]);
            setTimeout(() => titleRef.current?.focus(), 0);
          } else {
            onOpenChange(false);
          }
        },
        onError: () => {
          toast('Failed to create task', { description: 'Something went wrong.' });
        },
      },
    );
  };

  const isPending = create.isPending || start.isPending || uploading;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        hideCloseButton
        className="sm:max-w-[680px] max-h-[85vh] p-0 gap-0 rounded-2xl border-border shadow-2xl overflow-hidden flex flex-col"
        onDragOver={(e) => e.preventDefault()}
        onDrop={handleDrop}
      >
        <DialogTitle className="sr-only">New task</DialogTitle>
        <DialogDescription className="sr-only">
          Create a new task {projectName ? `in ${projectName}` : ''}
        </DialogDescription>

        {/* ── Header ─────────────────────────────────────────── */}
        <div className="flex items-center gap-2 px-5 pt-4 pb-2">
          <div className="flex items-center gap-2 text-sm">
            <span className="font-semibold text-foreground tracking-tight">
              {projectName || 'KORTIX'}
            </span>
            <span className="text-muted-foreground/40">›</span>
            <span className="text-muted-foreground">New task</span>
          </div>
          <div className="ml-auto">
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-muted-foreground/60 hover:text-foreground"
              onClick={() => onOpenChange(false)}
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>

        {/* ── Scrollable body ─────────────────────────────────── */}
        <div className="flex-1 overflow-y-auto min-h-0">
        {/* ── Content ────────────────────────────────────────── */}
        <div className="px-5 pt-2 pb-4 space-y-3">
          <input
            ref={titleRef}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); }
            }}
            placeholder="Task title"
            className="w-full text-[22px] font-semibold bg-transparent border-0 outline-none placeholder:text-muted-foreground/35 text-foreground tracking-tight leading-tight"
          />
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); }
            }}
            placeholder="Add description…"
            rows={5}
            className="w-full text-sm bg-transparent border-0 outline-none resize-none placeholder:text-muted-foreground/35 text-foreground/90 leading-relaxed min-h-[100px]"
          />

          {/* Verification */}
          {showVerification ? (
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-[11px] uppercase tracking-[0.08em] text-muted-foreground/50 font-semibold">
                  Verification condition
                </span>
                <button
                  onClick={() => { setShowVerification(false); setVerification(''); }}
                  className="text-[11px] text-muted-foreground/40 hover:text-foreground cursor-pointer"
                >
                  Remove
                </button>
              </div>
              <textarea
                value={verification}
                onChange={(e) => setVerification(e.target.value)}
                placeholder="How will we know this task is actually done?"
                rows={2}
                className="w-full text-sm bg-transparent border-0 outline-none resize-none placeholder:text-muted-foreground/35 text-foreground/90 leading-relaxed"
              />
            </div>
          ) : (
            <button
              onClick={() => setShowVerification(true)}
              className="text-[11px] text-muted-foreground/40 hover:text-foreground font-medium transition-colors cursor-pointer"
            >
              + Add verification condition
            </button>
          )}

          {/* Attachment preview strip */}
          {files.length > 0 && (
            <div className="flex flex-wrap gap-2 pt-1">
              {files.map((file, i) => {
                const ext = file.name.split('.').pop()?.toLowerCase() || '';
                const preview = previews[i];
                return (
                  <div key={i} className="relative group">
                    <div className="flex flex-col rounded-lg border border-border/50 overflow-hidden w-[120px] bg-card hover:bg-muted/30 hover:border-border transition-colors">
                      {/* Thumbnail */}
                      <div className="h-[72px] relative flex items-center justify-center overflow-hidden bg-muted/20">
                        {preview ? (
                          <Image src={preview} alt={file.name} fill className="object-cover" unoptimized />
                        ) : (
                          <div className="flex flex-col items-center gap-1">
                            {getFileIcon(file.name, { className: 'h-6 w-6', variant: 'monochrome' })}
                            {ext && (
                              <span className="text-[9px] font-medium text-muted-foreground/40 uppercase">
                                {ext}
                              </span>
                            )}
                          </div>
                        )}
                      </div>
                      {/* Name + size */}
                      <div className="px-2 py-1.5 border-t border-border/30">
                        <div className="flex items-center gap-1 min-w-0">
                          {getFileIcon(file.name, { className: 'h-3 w-3 shrink-0', variant: 'monochrome' })}
                          <span className="text-[10px] truncate text-foreground/80">{file.name}</span>
                        </div>
                        <span className="text-[9px] text-muted-foreground/30">{formatSize(file.size)}</span>
                      </div>
                    </div>
                    {/* Remove */}
                    <button
                      onClick={() => removeFile(i)}
                      className="absolute -top-1.5 -right-1.5 h-5 w-5 rounded-full bg-foreground text-background flex items-center justify-center z-10 cursor-pointer opacity-0 group-hover:opacity-100 transition-opacity"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        </div>{/* end scrollable body */}

        {/* Hidden file input */}
        <input ref={fileInputRef} type="file" multiple className="hidden" onChange={handleFileSelect} />

        {/* ── Footer ─────────────────────────────────────────── */}
        <div className="border-t border-border px-5 py-3 flex items-center justify-between bg-muted/15 rounded-b-2xl">
          <div className="flex items-center gap-3">
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-muted-foreground/50 hover:text-foreground"
              title="Attach files"
              onClick={() => fileInputRef.current?.click()}
            >
              <Paperclip className="h-4 w-4" />
            </Button>
            <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer select-none">
              <Switch checked={autoRun} onCheckedChange={setAutoRun} />
              Auto-run
            </label>
            <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer select-none">
              <Switch checked={createMore} onCheckedChange={setCreateMore} />
              Create more
            </label>
          </div>

          <Button
            size="sm"
            onClick={submit}
            disabled={!title.trim() || isPending}
            className="h-8 px-4 gap-1.5"
          >
            {isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {!isPending && autoRun && <Play className="h-3 w-3" />}
            {uploading ? 'Uploading…' : autoRun ? 'Create & Run' : 'Create task'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
