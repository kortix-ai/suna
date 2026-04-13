'use client';

/**
 * Project About — single-column, centered, Context is the main thing.
 *
 *   Context (.kortix/CONTEXT.md) — HERO, main attraction
 *   ────
 *   Details card: path, created at
 */

import { useState, useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { cn } from '@/lib/utils';
import { UnifiedMarkdown } from '@/components/markdown';
import { useFileContent, useInvalidateFileContent } from '@/features/files/hooks/use-file-content';
import { uploadFile } from '@/features/files/api/opencode-files';
import { Button } from '@/components/ui/button';
import {
  FileText,
  FolderGit2,
  Loader2,
  AlertCircle,
  Pencil,
  Check,
  Copy,
  Calendar,
} from 'lucide-react';
import { relativeTime, fullDate } from '@/lib/kortix/task-meta';

interface ProjectAboutProps {
  project: any;
}

export function ProjectAbout({ project }: ProjectAboutProps) {
  // ── CONTEXT.md file path ─────────────────────────────────
  const contextPath = project?.path && project.path !== '/'
    ? `${project.path.replace(/\/+$/, '')}/.kortix/CONTEXT.md`
    : null;

  const {
    data: contextFile,
    isLoading: contextLoading,
    error: contextError,
  } = useFileContent(contextPath, { staleTime: 30_000 });

  const invalidateContent = useInvalidateFileContent();
  const contextContent = contextFile?.type === 'text' ? contextFile.content : null;

  // ── CONTEXT.md edit state ────────────────────────────────
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const startEditing = useCallback(() => {
    setDraft(contextContent || '');
    setEditing(true);
  }, [contextContent]);

  useLayoutEffect(() => {
    if (!editing) return;
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [editing, draft]);

  useEffect(() => {
    if (editing) {
      setTimeout(() => textareaRef.current?.focus(), 0);
    }
  }, [editing]);

  const saveContext = useCallback(async () => {
    if (!contextPath || draft === (contextContent || '')) {
      setEditing(false);
      return;
    }
    setSaving(true);
    try {
      const parts = contextPath.split('/');
      const fileName = parts.pop() || 'CONTEXT.md';
      const dirPath = parts.join('/');
      const file = new File([draft], fileName, { type: 'text/markdown' });
      await uploadFile(file, dirPath);
      invalidateContent(contextPath);
    } catch {
      // silently fail — user can retry
    } finally {
      setSaving(false);
      setEditing(false);
    }
  }, [contextPath, draft, contextContent, invalidateContent]);

  const cancelEditing = useCallback(() => {
    setEditing(false);
    setDraft('');
  }, []);

  // ── Path copy ────────────────────────────────────────────
  const [pathCopied, setPathCopied] = useState(false);
  const copyPath = useCallback(() => {
    if (!project?.path) return;
    navigator.clipboard.writeText(project.path).catch(() => {});
    setPathCopied(true);
    setTimeout(() => setPathCopied(false), 1200);
  }, [project?.path]);

  return (
    <div className="h-full overflow-y-auto animate-in fade-in-0 duration-300 fill-mode-both">
      <div className="container mx-auto max-w-3xl px-4 sm:px-6 lg:px-10 py-8 sm:py-10 space-y-10">

        {/* ─── Context (.kortix/CONTEXT.md) — HERO ───────── */}
        <section>
          <div className="flex items-center gap-2 mb-3">
            <FileText className="h-3.5 w-3.5 text-muted-foreground/45" />
            <span className="text-[10px] uppercase tracking-[0.08em] text-muted-foreground/55 font-semibold">
              Context
            </span>
            <span className="text-[11px] text-muted-foreground/30 font-mono hidden sm:inline">
              .kortix/CONTEXT.md
            </span>
            <div className="ml-auto flex items-center gap-1">
              {editing ? (
                <>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 px-2 text-[11px] text-muted-foreground hover:text-foreground cursor-pointer"
                    onClick={cancelEditing}
                    disabled={saving}
                  >
                    Cancel
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 px-2 text-[11px] text-emerald-500 hover:text-emerald-400 gap-1 cursor-pointer"
                    onClick={saveContext}
                    disabled={saving}
                  >
                    {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
                    Save
                  </Button>
                </>
              ) : contextContent ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-2 text-[11px] text-muted-foreground/50 hover:text-foreground gap-1 cursor-pointer"
                  onClick={startEditing}
                >
                  <Pencil className="h-3 w-3" />
                  Edit
                </Button>
              ) : null}
            </div>
          </div>

          {contextLoading ? (
            <div className="rounded-xl border border-border/40 bg-card flex items-center gap-2 justify-center py-12 text-muted-foreground/40">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span className="text-[13px]">Loading CONTEXT.md…</span>
            </div>
          ) : editing ? (
            <textarea
              ref={textareaRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.preventDefault();
                  cancelEditing();
                }
                if (e.key === 's' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  saveContext();
                }
              }}
              spellCheck
              className={cn(
                'w-full min-h-[240px] resize-none overflow-hidden',
                'bg-card border border-border/40 rounded-xl outline-none',
                'text-[13px] text-foreground/85 leading-[1.7] font-mono',
                'placeholder:text-muted-foreground/30',
                'focus:border-primary/30 focus:ring-1 focus:ring-primary/20',
                'p-5 transition-colors',
              )}
              placeholder="# Project Context&#10;&#10;Mission, architecture, key decisions, open questions — the durable project memory every agent reads first."
            />
          ) : contextError || !contextContent ? (
            <button
              onClick={startEditing}
              className="w-full rounded-xl border border-dashed border-border/60 p-10 text-center hover:border-primary/40 hover:bg-primary/[0.02] transition-colors cursor-pointer group"
            >
              <AlertCircle className="h-5 w-5 text-muted-foreground/25 mx-auto mb-3 group-hover:text-primary/50 transition-colors" />
              <p className="text-[13px] text-foreground/70 mb-1 font-medium">
                No CONTEXT.md yet
              </p>
              <p className="text-[12px] text-muted-foreground/40 max-w-[380px] mx-auto leading-relaxed">
                Click to create{' '}
                <code className="font-mono text-[11px] bg-muted/40 px-1.5 py-0.5 rounded">
                  .kortix/CONTEXT.md
                </code>
                {' '}— the durable project memory every agent reads first.
              </p>
            </button>
          ) : (
            <div className="rounded-xl border border-border/40 bg-card px-5 sm:px-6 py-5">
              <article className="prose prose-sm dark:prose-invert max-w-none">
                <UnifiedMarkdown content={contextContent} />
              </article>
            </div>
          )}
        </section>

        {/* ─── Details card (compact, reference info) ─────── */}
        <section>
          <SectionLabel label="Details" />
          <div className="rounded-xl border border-border/40 divide-y divide-border/30 overflow-hidden bg-card">
            <MetaRow
              icon={<FolderGit2 className="h-3.5 w-3.5 text-muted-foreground/45" />}
              label="Path"
              value={
                <button
                  onClick={copyPath}
                  className="text-[12px] font-mono text-foreground/75 hover:text-foreground inline-flex items-center gap-1.5 transition-colors cursor-pointer max-w-full min-w-0"
                  title="Copy path"
                >
                  <span className="truncate">{project?.path || '—'}</span>
                  {pathCopied ? (
                    <Check className="h-3 w-3 text-emerald-500 shrink-0" />
                  ) : (
                    <Copy className="h-3 w-3 text-muted-foreground/30 shrink-0" />
                  )}
                </button>
              }
            />
            <MetaRow
              icon={<Calendar className="h-3.5 w-3.5 text-muted-foreground/45" />}
              label="Created"
              value={
                <span
                  className="text-[12px] text-foreground/70 tabular-nums"
                  title={fullDate(project?.created_at)}
                >
                  {relativeTime(project?.created_at)}
                </span>
              }
            />
          </div>
        </section>
      </div>
    </div>
  );
}

// ── Section Label ────────────────────────────────────────────────────────

function SectionLabel({ label }: { label: string }) {
  return (
    <div className="mb-2">
      <span className="text-[10px] uppercase tracking-[0.08em] text-muted-foreground/55 font-semibold">
        {label}
      </span>
    </div>
  );
}

// ── Meta Row ─────────────────────────────────────────────────────────────

function MetaRow({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-3 px-4 py-3 min-w-0">
      <span className="shrink-0">{icon}</span>
      <span className="text-[11px] uppercase tracking-[0.06em] text-muted-foreground/45 font-medium w-[72px] shrink-0">
        {label}
      </span>
      <div className="flex-1 min-w-0 flex items-center justify-end text-right">
        {value}
      </div>
    </div>
  );
}
