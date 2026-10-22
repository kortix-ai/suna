'use client';

// A read-only @kortix/ui FileSource over one Vault document. The bytes come from
// Lumen's backend (Convex action documents.bytes, access-checked), never a raw URL.
// The renderer picks PDF / DOCX / text by the file name, so the path is the filename.

import type { BinaryBlobResult, FileContentResult, FileSource } from '@kortix/ui/file-viewer';
import { api } from '@convex/_generated/api';
import type { Id } from '@convex/_generated/dataModel';
import { useQuery } from '@tanstack/react-query';
import { useAction } from 'convex/react';
import { useEffect, useMemo, useState } from 'react';

const readOnly = () => Promise.reject(new Error('The Vault preview is read-only'));

const base64 = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });

export function useVaultFileSource(documentId: Id<'documents'> | null, mime: string): FileSource {
  const read = useAction(api.documents.bytes);
  const fetchBlob = useMemo(() => async () => new Blob([await read({ documentId: documentId! })], { type: mime }), [read, documentId, mime]);
  return useBlobFileSource(documentId && `lumen-vault:${documentId}`, mime, fetchBlob);
}

/** A read-only FileSource over any blob from Lumen's backend (a Vault document, a run's redline or draft). `key` null = nothing yet. */
export function useBlobFileSource(key: string | null, mime: string, fetchBlob: () => Promise<Blob>): FileSource {
  return useMemo<FileSource>(() => {
    const useBlobQuery = (path: string | null) =>
      useQuery({ queryKey: ['lumen-blob', key], queryFn: fetchBlob, enabled: !!key && !!path, staleTime: Infinity });

    // Text files come back as text; binaries as base64 (the PDF renderer reads it from `content`).
    function useFileContent(path: string | null): FileContentResult {
      const q = useBlobQuery(path);
      const text = mime.startsWith('text/');
      const [content, setContent] = useState<string | null>(null);
      useEffect(() => {
        if (q.data) void (text ? q.data.text() : base64(q.data)).then(setContent);
      }, [q.data, text]);
      // Stable identity: the renderer resets its state when `data` changes.
      const data = useMemo(
        () =>
          content === null
            ? undefined
            : text
              ? { type: 'text' as const, content, mimeType: mime }
              : { type: 'binary' as const, content, encoding: 'base64' as const, mimeType: mime },
        [text, content],
      );
      return {
        data,
        isLoading: q.isLoading || (!!q.data && content === null),
        error: q.error,
        refetch: q.refetch,
        dataUpdatedAt: q.dataUpdatedAt,
      };
    }

    function useBinaryBlob(path: string | null): BinaryBlobResult {
      const q = useBlobQuery(path);
      const [blobUrl, setBlobUrl] = useState<string | null>(null);
      useEffect(() => {
        if (!q.data) return;
        const u = URL.createObjectURL(q.data);
        setBlobUrl(u);
        return () => URL.revokeObjectURL(u);
      }, [q.data]);
      const error = q.error ? String(q.error) : null;
      return useMemo(() => ({ blobUrl, blob: q.data ?? null, isLoading: q.isLoading, error }), [blobUrl, q.data, q.isLoading, error]);
    }

    return {
      id: key ?? 'lumen-none',
      useFileContent,
      useBinaryBlob,
      bytesOnly: true,
      download: async (_path, fileName) => {
        const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(await fetchBlob()), download: fileName });
        a.click();
        URL.revokeObjectURL(a.href);
      },
      upload: readOnly,
    };
  }, [key, mime, fetchBlob]);
}
