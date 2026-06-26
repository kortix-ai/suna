import type { UploadResult } from '@/features/files/api/opencode-files';
import type { AttachedFile } from '@/features/session/session-chat-input';

export type PromptFilePart = {
  type: 'file';
  mime: string;
  url: string;
  filename: string;
};

export type UploadFileForPrompt = (
  file: File | Blob,
  targetPath?: string,
  filename?: string,
) => Promise<UploadResult[]>;

export type UploadedFileRef = {
  path: string;
  mime: string;
  filename: string;
};

export const UPLOADS_DIR = '/workspace/uploads';

export function sanitizeUploadFilename(name: string): string {
  const sanitized = name.replace(/[^a-zA-Z0-9._-]/g, '_');
  return sanitized || 'upload';
}

function xmlAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function uploadedFileRefXml(input: UploadedFileRef): string {
  return `<file path="${xmlAttr(input.path)}" mime="${xmlAttr(input.mime)}" filename="${xmlAttr(input.filename)}">\nThis file has been uploaded and is available at the path above.\n</file>`;
}

export function optimisticUploadPath(file: Extract<AttachedFile, { kind: 'local' }>): string {
  return `${UPLOADS_DIR}/${sanitizeUploadFilename(file.file.name)}`;
}

export function optimisticUploadedFileRef(file: AttachedFile): UploadedFileRef {
  if (file.kind === 'local') {
    return {
      path: optimisticUploadPath(file),
      mime: file.file.type || 'application/octet-stream',
      filename: file.file.name,
    };
  }

  return {
    path: file.filename,
    mime: file.mime,
    filename: file.filename,
  };
}

export function buildOptimisticPromptTextWithUploads(
  text: string,
  files: AttachedFile[] | undefined,
): string {
  const refs = (files ?? [])
    .map((file) => uploadedFileRefXml(optimisticUploadedFileRef(file)))
    .join('\n');

  return refs ? `${text}\n\n${refs}` : text;
}

function splitFiles(files: AttachedFile[] | undefined): {
  localFiles: Extract<AttachedFile, { kind: 'local' }>[];
  remoteParts: PromptFilePart[];
} {
  const localFiles: Extract<AttachedFile, { kind: 'local' }>[] = [];
  const remoteParts: PromptFilePart[] = [];

  for (const file of files ?? []) {
    if (file.kind === 'local') {
      localFiles.push(file);
    } else {
      remoteParts.push({
        type: 'file',
        mime: file.mime,
        url: file.url,
        filename: file.filename,
      });
    }
  }

  return { localFiles, remoteParts };
}

async function uploadLocalFile(
  file: Extract<AttachedFile, { kind: 'local' }>,
  uploadFile: UploadFileForPrompt,
): Promise<UploadedFileRef> {
  const safeName = sanitizeUploadFilename(file.file.name);
  const results = await uploadFile(file.file, UPLOADS_DIR, safeName);
  const path = results[0]?.path;
  if (typeof path !== 'string' || !path.trim()) {
    throw new Error(`Upload failed: ${file.file.name} did not return a file path.`);
  }
  return {
    path,
    mime: file.file.type || 'application/octet-stream',
    filename: file.file.name,
  };
}

export async function buildPromptPartsWithUploads(
  text: string,
  files: AttachedFile[] | undefined,
  uploadFile: UploadFileForPrompt,
): Promise<{
  text: string;
  remoteParts: PromptFilePart[];
}> {
  const { localFiles, remoteParts } = splitFiles(files);
  if (localFiles.length === 0) return { text, remoteParts };

  const uploaded = await Promise.all(localFiles.map((file) => uploadLocalFile(file, uploadFile)));
  const refs = uploaded.map(uploadedFileRefXml).join('\n');
  return {
    text: `${text}\n\n${refs}`,
    remoteParts,
  };
}
