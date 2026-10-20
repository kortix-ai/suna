'use client';

import { useMatter } from '@/components/access';
import { errorText, relativeTime } from '@/lib/utils';
import { api } from '@convex/_generated/api';
import { cn } from '@kortix/ui';
import { Badge } from '@kortix/ui/badge';
import { Button } from '@kortix/ui/button';
import { Input } from '@kortix/ui/input';
import Loading from '@kortix/ui/loading';
import { Skeleton } from '@kortix/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@kortix/ui/table';
import { errorToast, successToast } from '@kortix/ui/toast';
import { FileDocIcon, FilePdfIcon, FileTextIcon, TableIcon, UploadSimpleIcon } from '@phosphor-icons/react';
import { useAction, useMutation, useQuery } from 'convex/react';
import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';

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
  const startReview = useMutation(api.runs.startReview);
  const [uploading, setUploading] = useState<Record<string, number>>({});
  // 0 = sending to Lumen, 1 = stored, extracting.
  const [dragging, setDragging] = useState(false);
  const [starting, setStarting] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const ready = docs?.filter((d) => d.status === 'ready' && (d.paras ?? 0) > 0) ?? [];

  async function upload(files: File[]) {
    if (files.length > MAX_FILES) return errorToast(`Drop up to ${MAX_FILES} files at a time`);
    for (const file of files) {
      const refused = refuseReason(file);
      if (refused) {
        errorToast(`${file.name}: ${refused}`);
        continue;
      }
      setUploading((u) => ({ ...u, [file.name]: 0 }));
      try {
        await uploadDoc({ matterId: matter._id, filename: file.name, bytes: await file.arrayBuffer(), contentType: file.type });
      } catch (err) {
        errorToast(`${file.name}: could not upload`, { description: errorText(err) });
      } finally {
        setUploading(({ [file.name]: _, ...rest }) => rest);
      }
    }
  }

  async function review() {
    setStarting(true);
    try {
      const { runId } = await startReview({ matterId: matter._id });
      successToast('Review started');
      router.push(`/app/matters/${matter._id}/runs/${runId}`);
    } catch (err) {
      errorToast('Could not start the review', { description: errorText(err) });
      setStarting(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-5xl space-y-4 px-6 py-6">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-medium">Documents</h2>
          <p className="text-xs text-muted-foreground">
            {docs === undefined ? ' ' : `${docs.length} document${docs.length === 1 ? '' : 's'}, ${ready.length} ready`}
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => input.current?.click()}>
            <UploadSimpleIcon className="size-4" /> Upload
          </Button>
          <Button size="sm" disabled={ready.length === 0 || starting} onClick={review}>
            {starting ? <Loading className="size-4" /> : <TableIcon className="size-4" />} Review these
          </Button>
        </div>
      </div>

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
        className={cn(
          'rounded-xl border border-dashed border-border bg-card transition-colors',
          dragging && 'border-brand bg-brand/5',
        )}
      >
        {docs === undefined ? (
          <div className="space-y-2 p-4">
            {Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-9 w-full" />)}
          </div>
        ) : docs.length === 0 && Object.keys(uploading).length === 0 ? (
          <Button variant="ghost" onClick={() => input.current?.click()} className="flex h-auto w-full flex-col items-center gap-2 px-6 py-16 text-center">
            <UploadSimpleIcon className="size-6 text-muted-foreground" />
            <span className="text-sm font-medium">Drop contracts here</span>
            <span className="text-xs text-muted-foreground">PDF, DOCX or TXT, up to 15 MB each.</span>
          </Button>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead className="w-24 text-right">Pages</TableHead>
                <TableHead className="w-24 text-right">Size</TableHead>
                <TableHead className="w-28">Added</TableHead>
                <TableHead className="w-44">Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {Object.entries(uploading).map(([name, p]) => (
                <TableRow key={`up-${name}`}>
                  <TableCell className="font-medium">{name}</TableCell>
                  <TableCell />
                  <TableCell />
                  <TableCell />
                  <TableCell>
                    <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <Loading className="size-3.5" /> {p < 1 ? 'Uploading…' : 'Extracting…'}
                    </span>
                  </TableCell>
                </TableRow>
              ))}
              {docs.map((d) => {
                const Icon = iconFor(d.filename);
                return (
                  <TableRow key={d._id} data-testid="vault-row">
                    <TableCell>
                      <span className="flex items-center gap-2">
                        <Icon className="size-4 shrink-0 text-muted-foreground" />
                        <span className="truncate font-medium">{d.filename}</span>
                      </span>
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs tabular-nums">{d.pages ?? '—'}</TableCell>
                    <TableCell className="text-right font-mono text-xs tabular-nums text-muted-foreground">{kb(d.bytes)}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{relativeTime(new Date(d._creationTime).toISOString())}</TableCell>
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
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </div>
    </div>
  );
}
