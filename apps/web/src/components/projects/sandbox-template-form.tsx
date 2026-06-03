'use client';

/**
 * Create / edit dialog for a project's sandbox template.
 *
 * Mirrors the Daytona "Create Snapshot" form (image + resources + entrypoint)
 * but adapted for Kortix: a template can be defined either by a `dockerfile`
 * path in the project repo OR a public `image` reference. The Kortix runtime
 * layer is added automatically — the user only defines their workspace base.
 */

import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Loader2, Container, FileCode, Package } from 'lucide-react';

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
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';
import {
  createSandboxTemplate,
  updateSandboxTemplate,
  type SandboxTemplate,
} from '@/lib/projects-client';

type Mode = 'image' | 'dockerfile';

interface SandboxTemplateFormProps {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Pre-fill from an existing template to edit; null/undefined = create. */
  template?: SandboxTemplate | null;
}

const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function isValidSlug(s: string): boolean {
  return SLUG_RE.test(s);
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

export function SandboxTemplateForm({
  projectId,
  open,
  onOpenChange,
  template,
}: SandboxTemplateFormProps) {
  const isEdit = !!template;
  const queryClient = useQueryClient();

  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugManuallyEdited, setSlugManuallyEdited] = useState(false);
  const [mode, setMode] = useState<Mode>('image');
  const [image, setImage] = useState('');
  const [dockerfilePath, setDockerfilePath] = useState('');
  const [entrypoint, setEntrypoint] = useState('');
  const [cpu, setCpu] = useState<string>('2');
  const [memoryGb, setMemoryGb] = useState<string>('4');
  const [diskGb, setDiskGb] = useState<string>('20');

  // Reset / hydrate when opening
  useEffect(() => {
    if (!open) return;
    if (template) {
      setName(template.name);
      setSlug(template.slug);
      setSlugManuallyEdited(true);
      if (template.image) {
        setMode('image');
        setImage(template.image);
        setDockerfilePath('');
      } else {
        setMode('dockerfile');
        setImage('');
        setDockerfilePath(template.dockerfile_path ?? '');
      }
      setEntrypoint(template.entrypoint ?? '');
      setCpu(String(template.cpu));
      setMemoryGb(String(template.memory_gb));
      setDiskGb(String(template.disk_gb));
    } else {
      setName('');
      setSlug('');
      setSlugManuallyEdited(false);
      setMode('image');
      setImage('');
      setDockerfilePath('');
      setEntrypoint('');
      setCpu('2');
      setMemoryGb('4');
      setDiskGb('20');
    }
  }, [open, template]);

  // Auto-slug from name when the user hasn't typed a slug manually yet.
  useEffect(() => {
    if (!slugManuallyEdited) setSlug(slugify(name));
  }, [name, slugManuallyEdited]);

  const slugError = useMemo(() => {
    if (!slug) return null;
    if (slug === 'default') return 'Slug "default" is reserved for the platform template.';
    if (!isValidSlug(slug)) return 'Use lowercase letters, digits, dashes, or underscores (1-64 chars).';
    return null;
  }, [slug]);

  const sourceError = useMemo(() => {
    if (mode === 'image' && !image.trim()) return 'Image reference required.';
    if (mode === 'dockerfile' && !dockerfilePath.trim()) return 'Dockerfile path required.';
    if (mode === 'image' && image.trim().endsWith(':latest')) {
      return 'Pin a specific tag instead of "latest".';
    }
    return null;
  }, [mode, image, dockerfilePath]);

  const canSubmit = !!slug && !slugError && !sourceError && !!name.trim();

  const createMut = useMutation({
    mutationFn: () =>
      createSandboxTemplate(projectId, {
        slug,
        name: name.trim(),
        ...(mode === 'image' ? { image: image.trim() } : { dockerfile_path: dockerfilePath.trim() }),
        entrypoint: entrypoint.trim() || undefined,
        cpu: parsePosInt(cpu),
        memory_gb: parsePosInt(memoryGb),
        disk_gb: parsePosInt(diskGb),
      }),
    onSuccess: () => {
      toast.success('Template created — build started');
      queryClient.invalidateQueries({ queryKey: ['project-snapshots', projectId] });
      queryClient.invalidateQueries({ queryKey: ['project-sandboxes', projectId] });
      onOpenChange(false);
    },
    onError: (err: Error) => toast.error(err.message || 'Failed to create template'),
  });

  const editMut = useMutation({
    mutationFn: () =>
      updateSandboxTemplate(projectId, template!.template_id!, {
        name: name.trim(),
        image: mode === 'image' ? image.trim() : null,
        dockerfile_path: mode === 'dockerfile' ? dockerfilePath.trim() : null,
        entrypoint: entrypoint.trim() || null,
        cpu: parsePosInt(cpu) ?? null,
        memory_gb: parsePosInt(memoryGb) ?? null,
        disk_gb: parsePosInt(diskGb) ?? null,
      }),
    onSuccess: () => {
      toast.success('Template updated');
      queryClient.invalidateQueries({ queryKey: ['project-snapshots', projectId] });
      queryClient.invalidateQueries({ queryKey: ['project-sandboxes', projectId] });
      onOpenChange(false);
    },
    onError: (err: Error) => toast.error(err.message || 'Failed to update template'),
  });

  const submitting = createMut.isPending || editMut.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Container className="size-4" />
            {isEdit ? `Edit "${template?.name}"` : 'New sandbox template'}
          </DialogTitle>
          <DialogDescription>
            Define a sandbox image sessions can boot from. Pick either a public Docker image or a Dockerfile in
            your repo. The Kortix runtime layer (agent daemon, opencode, bun) is added automatically.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="tpl-name">Name</Label>
              <Input
                id="tpl-name"
                placeholder="ML Development"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="tpl-slug">Slug</Label>
              <Input
                id="tpl-slug"
                placeholder="ml"
                value={slug}
                onChange={(e) => {
                  setSlugManuallyEdited(true);
                  setSlug(e.target.value.toLowerCase());
                }}
                disabled={isEdit}
                aria-invalid={!!slugError}
              />
              {slugError && (
                <p className="mt-1 text-xs text-destructive">{slugError}</p>
              )}
            </div>
          </div>

          <div>
            <Label>Image source</Label>
            <div className="mt-2 grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setMode('image')}
                className={cn(
                  'flex flex-col items-start gap-1 rounded-2xl border border-border/60 p-3 text-left text-sm transition-colors',
                  mode === 'image' && 'border-foreground/30 bg-muted/40',
                )}
              >
                <div className="flex items-center gap-2">
                  <Package className="size-4" />
                  <span className="font-medium">Public image</span>
                </div>
                <span className="text-xs text-muted-foreground">
                  e.g. <code className="font-mono">python:3.12-slim</code>
                </span>
              </button>
              <button
                type="button"
                onClick={() => setMode('dockerfile')}
                className={cn(
                  'flex flex-col items-start gap-1 rounded-2xl border border-border/60 p-3 text-left text-sm transition-colors',
                  mode === 'dockerfile' && 'border-foreground/30 bg-muted/40',
                )}
              >
                <div className="flex items-center gap-2">
                  <FileCode className="size-4" />
                  <span className="font-medium">Dockerfile</span>
                </div>
                <span className="text-xs text-muted-foreground">
                  Path inside this repo
                </span>
              </button>
            </div>
            <div className="mt-3">
              {mode === 'image' ? (
                <>
                  <Label htmlFor="tpl-image">Image</Label>
                  <Input
                    id="tpl-image"
                    placeholder="python:3.12-slim"
                    value={image}
                    onChange={(e) => setImage(e.target.value)}
                  />
                  <p className="mt-1 text-xs text-muted-foreground">
                    Must include a specific tag (no <code className="font-mono">latest</code>).
                  </p>
                </>
              ) : (
                <>
                  <Label htmlFor="tpl-df">Dockerfile path</Label>
                  <Input
                    id="tpl-df"
                    placeholder=".kortix/Dockerfile.ml"
                    value={dockerfilePath}
                    onChange={(e) => setDockerfilePath(e.target.value)}
                  />
                  <p className="mt-1 text-xs text-muted-foreground">
                    Relative to the repository root.
                  </p>
                </>
              )}
              {sourceError && (
                <p className="mt-1 text-xs text-destructive">{sourceError}</p>
              )}
            </div>
          </div>

          <div>
            <Label>Resources</Label>
            <div className="mt-2 grid grid-cols-3 gap-3">
              <NumericField id="cpu" label="vCPU" value={cpu} onChange={setCpu} min={1} max={32} />
              <NumericField id="mem" label="Memory (GiB)" value={memoryGb} onChange={setMemoryGb} min={1} max={128} />
              <NumericField id="disk" label="Disk (GiB)" value={diskGb} onChange={setDiskGb} min={1} max={500} />
            </div>
          </div>

          <div>
            <Label htmlFor="tpl-entry">Entrypoint <span className="text-muted-foreground">(optional)</span></Label>
            <Textarea
              id="tpl-entry"
              placeholder="Leave blank to use the Kortix default (recommended)."
              value={entrypoint}
              onChange={(e) => setEntrypoint(e.target.value)}
              className="font-mono text-xs"
              rows={2}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button
            onClick={() => (isEdit ? editMut.mutate() : createMut.mutate())}
            disabled={!canSubmit || submitting}
          >
            {submitting && <Loader2 className="mr-2 size-4 animate-spin" />}
            {isEdit ? 'Save changes' : 'Create template'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function NumericField({
  id,
  label,
  value,
  onChange,
  min,
  max,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  min: number;
  max: number;
}) {
  return (
    <div>
      <Label htmlFor={id} className="text-xs">{label}</Label>
      <Input
        id={id}
        type="number"
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

function parsePosInt(s: string): number | undefined {
  const n = Number.parseInt(s, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}
