'use client';

import { useMatter } from '@/components/access';
import { type DocFocus, DocumentPanel, Marked } from '@/components/vault/document-panel';
import { errorText, relativeTime } from '@/lib/utils';
import { api } from '@convex/_generated/api';
import { cn } from '@kortix/ui';
import { Badge } from '@kortix/ui/badge';
import { Button } from '@kortix/ui/button';
import { ConfirmDialog } from '@kortix/ui/confirm-dialog';
import type { Id } from '@convex/_generated/dataModel';
import { Input } from '@kortix/ui/input';
import Loading from '@kortix/ui/loading';
import { Skeleton } from '@kortix/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@kortix/ui/table';
import { errorToast, successToast } from '@kortix/ui/toast';
import { CaretDownIcon, ChatCircleTextIcon, CheckIcon, DotsThreeIcon, EyeIcon, FileDocIcon, FilePdfIcon, FileTextIcon, MagnifyingGlassIcon, StackIcon, TableIcon, TrashIcon, UploadSimpleIcon } from '@phosphor-icons/react';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@kortix/ui/dropdown-menu';
import { useAction, useMutation, useQuery } from 'convex/react';
import { useRouter } from 'next/navigation';
import { useDeferredValue, useEffect, useRef, useState } from 'react';

const ACCEPT = '.pdf,.docx,.txt';
const MAX_BYTES = 15 * 1024 * 1024;
const MAX_FILES = 50;

const iconFor = (name: string) => (name.endsWith('.pdf') ? FilePdfIcon : name.endsWith('.docx') ? FileDocIcon : FileTextIcon);
const kb = (n: number) => (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/** A file the browser refuses before upload: wrong type or too large. */
function refuseReason(file: { name: string; size: number }): string | null {
  if (!/\.(pdf|docx|txt)$/i.test(file.name)) return 'PDF, DOCX or TXT only';
  if (file.size > MAX_BYTES) return 'Files are limited to 15 MB';
  return null;
}

export default function VaultPage() {
  const { matter } = useMatter();
  const router = useRouter();
  // null = no access; the matter gate already shows that, so it reads as empty here.
  const listed = useQuery(api.documents.list, { matterId: matter._id });
  const docs = listed === null ? [] : listed;
  const uploadDoc = useAction(api.documents.upload);
  const [uploading, setUploading] = useState<Record<string, number>>({});
  // 0 = sending to Lumen, 1 = stored, extracting.
  const [dragging, setDragging] = useState(false);
  const [starting, setStarting] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const removeDoc = useMutation(api.documents.remove);
  const [open, setOpen] = useState<{ id: string; focus?: DocFocus } | null>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(null);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);
  const [q, setQ] = useState('');
  const term = useDeferredValue(q.trim());
  const hits = useQuery(api.documents.search, term.length >= 2 ? { matterId: matter._id, q: term } : 'skip');
  const ready = docs?.filter((d) => d.status === 'ready' && (d.paras ?? 0) > 0 && !d.superseded) ?? [];
  // One row per document: its newest version that did not fail; every version in its menu.
  const families = new Map<string, NonNullable<typeof docs>>();
  for (const d of docs ?? []) families.set(d.family, [...(families.get(d.family) ?? []), d]);
  const rows = [...families.values()]
    .map((versions) => {
      const sorted = [...versions].sort((a, b) => b.version - a.version);
      return { doc: sorted.find((d) => d.status !== 'failed') ?? sorted[0], versions: sorted };
    })
    .sort((a, b) => b.doc._creationTime - a.doc._creationTime);
  const versionInput = useRef<HTMLInputElement>(null);
  const [versionOf, setVersionOf] = useState<{ id: Id<'documents'>; filename: string } | null>(null);

  async function upload(files: File[], parent?: { id: Id<'documents'>; filename: string }) {
    if (files.length > MAX_FILES) return errorToast(`Drop up to ${MAX_FILES} files at a time`);
    for (const file of files) {
      const refused = refuseReason(file);
      if (refused) {
        errorToast(`${file.name}: ${refused}`);
        continue;
      }
      setUploading((u) => ({ ...u, [file.name]: 0 }));
      try {
        await uploadDoc({
          matterId: matter._id,
          filename: file.name,
          bytes: await file.arrayBuffer(),
          contentType: file.type,
          ...(parent ? { versionOf: parent.id } : {}),
        });
        if (parent) successToast(`New version of ${parent.filename} uploaded`, { description: 'It replaces the old one in new work once it is read. The old version stays citable.' });
      } catch (err) {
        const why = errorText(err);
        if (why.startsWith('Already in this vault')) errorToast(`${file.name} is already in this vault`, { description: why });
        else errorToast(`${file.name}: could not upload`, { description: why });
      } finally {
        setUploading(({ [file.name]: _, ...rest }) => rest);
      }
    }
  }

  function review() {
    setStarting(true);
    router.push(`/app/matters/${matter._id}/reviews/new`);
  }

  const [toDelete, setToDelete] = useState<{ id: Id<'documents'>; filename: string } | null>(null);
  async function remove() {
    if (!toDelete) return;
    const { id, filename } = toDelete;
    setToDelete(null);
    try {
      await removeDoc({ documentId: id });
      if (open?.id === id) setOpen(null);
      successToast(`${filename} deleted`);
    } catch (err) {
      errorToast('Could not delete the document', { description: errorText(err) });
    }
  }

  return (
    <div className="flex min-h-0 flex-1">
      <div className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-6xl space-y-4 px-4 py-6 sm:px-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-medium">Documents</h2>
              <p className="text-xs text-muted-foreground">
                {docs === undefined ? ' ' : `${rows.length} document${rows.length === 1 ? '' : 's'}, ${ready.length} ready${docs.length > rows.length ? `, ${docs.length - rows.length} earlier version${docs.length - rows.length === 1 ? '' : 's'}` : ''}`}
              </p>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => input.current?.click()}>
                <UploadSimpleIcon className="size-4" /> Upload
              </Button>
              <Button variant="outline" size="sm" disabled={ready.length === 0} onClick={() => router.push(`/app/matters/${matter._id}/assistant`)}>
                <ChatCircleTextIcon className="size-4" /> Ask
              </Button>
              <Button size="sm" disabled={ready.length === 0 || starting} onClick={review}>
                {starting ? <Loading className="size-4" /> : <TableIcon className="size-4" />} Review all
              </Button>
            </div>
          </div>

          <div className="relative">
            <MagnifyingGlassIcon className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search every page in this vault…"
              aria-label="Search the vault"
              className="pl-9"
            />
          </div>

          {term.length >= 2 && (
            <section aria-label="Search results" className="rounded-xl border border-border bg-card">
              {hits === undefined ? (
                <div className="space-y-2 p-3">
                  {Array.from({ length: 3 }, (_, i) => (
                    <Skeleton key={i} className="h-10 w-full" />
                  ))}
                </div>
              ) : !hits || hits.length === 0 ? (
                <p className="px-4 py-5 text-sm text-muted-foreground">
                  No passage mentions “{term}”. <span className="text-muted-foreground/70">Try a shorter term.</span>
                </p>
              ) : (
                <ul className="divide-y divide-border">
                  {hits.map((h) => (
                    <li key={`${h.documentId}-${h.page}`}>
                      <Button
                        variant="ghost"
                        data-testid="search-hit"
                        onClick={() =>
                          setOpen({
                            id: h.documentId,
                            focus: { page: h.page, mark: term },
                          })
                        }
                        className="block h-auto w-full whitespace-normal rounded-none px-4 py-2.5 text-left font-normal hover:bg-muted/60"
                      >
                        <span className="flex items-baseline gap-2 text-xs">
                          <span className="font-medium text-foreground">{h.filename}</span>
                          <span className="font-mono text-muted-foreground">p. {h.page}</span>
                        </span>
                        <span className="mt-0.5 block text-sm text-muted-foreground">
                          <Marked text={h.snippet} mark={term} />
                        </span>
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}

          <Input
            ref={versionInput}
            type="file"
            accept={ACCEPT}
            className="hidden"
            data-testid="vault-version-input"
            onChange={(e) => {
              const parent = versionOf;
              setVersionOf(null);
              if (parent) void upload(Array.from(e.target.files ?? []).slice(0, 1), parent);
              e.target.value = '';
            }}
          />
          <Input
            ref={input}
            type="file"
            multiple
            accept={ACCEPT}
            className="hidden"
            data-testid="vault-file-input"
            onChange={(e) => {
              void upload(Array.from(e.target.files ?? []));
              e.target.value = '';
            }}
          />

          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              void upload(Array.from(e.dataTransfer.files));
            }}
            className={cn('rounded-xl border border-dashed border-border bg-card transition-colors', dragging && 'border-brand bg-brand/5')}
          >
            {docs === undefined ? (
              <div className="space-y-2 p-4">
                {Array.from({ length: 6 }, (_, i) => (
                  <Skeleton key={i} className="h-9 w-full" />
                ))}
              </div>
            ) : docs.length === 0 && Object.keys(uploading).length === 0 ? (
              <Button
                variant="ghost"
                onClick={() => input.current?.click()}
                className="flex h-auto w-full flex-col items-center gap-2 px-6 py-16 text-center"
              >
                <UploadSimpleIcon className="size-6 text-muted-foreground" />
                <span className="text-sm font-medium">Drop contracts here</span>
                <span className="text-xs text-muted-foreground">PDF, DOCX or TXT, up to 15 MB each.</span>
              </Button>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead className="w-20">Version</TableHead>
                    <TableHead className="hidden w-24 text-right sm:table-cell">Pages</TableHead>
                    <TableHead className={cn('hidden w-24 text-right', !open && 'sm:table-cell')}>Size</TableHead>
                    <TableHead className={cn('hidden w-28', !open && 'md:table-cell')}>Added</TableHead>
                    <TableHead className={cn('w-28', !open && 'sm:w-44')}>Status</TableHead>
                    <TableHead className="w-10" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {Object.entries(uploading).map(([name, p]) => (
                    <TableRow key={`up-${name}`}>
                      <TableCell className="font-medium">{name}</TableCell>
                      <TableCell />
                      <TableCell className="hidden sm:table-cell" />
                      <TableCell className={cn('hidden', !open && 'sm:table-cell')} />
                      <TableCell className={cn('hidden', !open && 'md:table-cell')} />
                      <TableCell>
                        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                          <Loading className="size-3.5" /> {p < 1 ? 'Uploading…' : 'Extracting…'}
                        </span>
                      </TableCell>
                      <TableCell />
                    </TableRow>
                  ))}
                  {rows.map(({ doc: d, versions }) => {
                    const Icon = iconFor(d.filename);
                    return (
                      <TableRow
                        key={d._id}
                        data-testid="vault-row"
                        data-state={open?.id === d._id ? 'selected' : undefined}
                        className="cursor-pointer"
                        onClick={() => d.status === 'ready' && setOpen({ id: d._id })}
                      >
                        <TableCell>
                          <span className="flex items-center gap-2">
                            <Icon className="size-4 shrink-0 text-muted-foreground" />
                            <span className="truncate font-medium">{d.filename}</span>
                          </span>
                        </TableCell>
                        <TableCell onClick={(e) => versions.length > 1 && e.stopPropagation()}>
                          {versions.length > 1 ? (
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button variant="outline" size="sm" className="h-6 gap-1 rounded-full px-2 font-mono text-[11px]" data-testid="version-picker">
                                  V{d.version} <CaretDownIcon className="size-3" />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="start" className="w-72">
                                <DropdownMenuLabel>Versions</DropdownMenuLabel>
                                {versions.map((v) => (
                                  <DropdownMenuItem key={v._id} disabled={v.status !== 'ready'} onSelect={() => setOpen({ id: v._id })}>
                                    <span className="w-7 font-mono text-xs">V{v.version}</span>
                                    <span className="min-w-0 flex-1 truncate">{v.filename}</span>
                                    <span className="text-xs text-muted-foreground">
                                      {v.status === 'failed' ? 'Failed' : v.status !== 'ready' ? 'Reading…' : relativeTime(new Date(v._creationTime).toISOString())}
                                    </span>
                                    {v._id === d._id && <CheckIcon className="size-3.5 text-brand" />}
                                  </DropdownMenuItem>
                                ))}
                              </DropdownMenuContent>
                            </DropdownMenu>
                          ) : (
                            <span className="rounded-full border border-border px-2 py-0.5 font-mono text-[11px] text-muted-foreground">V{d.version}</span>
                          )}
                        </TableCell>
                        <TableCell className="hidden text-right font-mono text-xs tabular-nums sm:table-cell">{d.pages ?? '—'}</TableCell>
                        <TableCell className={cn('hidden text-right font-mono text-xs tabular-nums text-muted-foreground', !open && 'sm:table-cell')}>{kb(d.bytes)}</TableCell>
                        <TableCell className={cn('hidden text-xs text-muted-foreground', !open && 'md:table-cell')}>
                          {relativeTime(new Date(d._creationTime).toISOString())}
                        </TableCell>
                        <TableCell>
                          {d.status === 'ready' && (d.paras ?? 0) === 0 ? (
                            <Badge variant="warning">Scanned: text not searchable</Badge>
                          ) : d.status === 'ready' ? (
                            <Badge variant="success">Ready</Badge>
                          ) : d.status === 'failed' ? (
                            <span className="text-xs text-destructive">{d.error ?? 'Processing failed'}</span>
                          ) : (
                            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                              <Loading className="size-3.5" /> Extracting…
                            </span>
                          )}
                        </TableCell>
                        <TableCell onClick={(e) => e.stopPropagation()}>
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${d.filename}`} data-testid="doc-actions">
                                <DotsThreeIcon className="size-4 text-muted-foreground" weight="bold" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end" className="w-56">
                              <DropdownMenuItem disabled={d.status !== 'ready'} onSelect={() => setOpen({ id: d._id })}>
                                <EyeIcon className="size-4" /> Open
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                onSelect={() => {
                                  setVersionOf({ id: d._id, filename: d.filename });
                                  // The menu closes first; the picker opens on the next frame.
                                  requestAnimationFrame(() => versionInput.current?.click());
                                }}
                              >
                                <StackIcon className="size-4" /> Upload new version
                              </DropdownMenuItem>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem variant="destructive" onSelect={() => setToDelete({ id: d._id, filename: d.filename })}>
                                <TrashIcon className="size-4" /> Delete {versions.length > 1 ? `V${d.version}` : ''}
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </div>
        </div>
      </div>
      <ConfirmDialog
        open={!!toDelete}
        onOpenChange={(o) => !o && setToDelete(null)}
        title="Delete this document?"
        description={`${toDelete?.filename ?? ''} is removed from the vault and from every future answer.`}
        confirmLabel="Delete"
        confirmVariant="destructive"
        onConfirm={remove}
      />
      {open && (
        <div className="fixed inset-0 z-40 bg-background lg:static lg:z-auto lg:w-[46%] lg:max-w-2xl lg:shrink-0">
          <DocumentPanel documentId={open.id} focus={open.focus} onClose={() => setOpen(null)} />
        </div>
      )}
    </div>
  );
}
