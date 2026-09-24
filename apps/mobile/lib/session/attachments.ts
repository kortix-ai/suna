/**
 * attachments — files a composer sends with a prompt.
 *
 * Shared by the thread composer (SessionChatInput, uploads on send) and the
 * project home composer (ProjectScreen, uploads once the new session's sandbox
 * is up). Picking lives in `components/session/useAttachmentPicker.ts`.
 */
import { getAuthToken } from '@/api/config';

export interface AttachedFile {
  /** Local file URI from the image or document picker. */
  uri: string;
  /** Original file name, shown in the composer and sent to the agent. */
  name: string;
  mimeType: string;
  size?: number;
  /** Renders a thumbnail instead of a file icon. */
  isImage: boolean;
}

/**
 * Upload files into a session sandbox's `/workspace/uploads` and return the
 * `<file>` reference block the agent reads. `/file/upload` picks
 * collision-free paths and returns them; a non-OK response falls back to the
 * optimistic path. A network failure throws, and callers then send the text
 * without references. Ported from web 04f8296.
 */
export async function uploadAttachments(sandboxUrl: string, files: AttachedFile[]): Promise<string> {
  if (files.length === 0) return '';
  const base = sandboxUrl.replace(/\/$/, '');
  const token = await getAuthToken();

  const parts = await Promise.all(
    files.map(async (f) => {
      const safeName = f.name.replace(/[^a-zA-Z0-9._-]/g, '_');
      const optimisticPath = `/workspace/uploads/${safeName}`;

      const formData = new FormData();
      formData.append('path', '/workspace/uploads');
      formData.append('file', { uri: f.uri, name: safeName, type: f.mimeType } as any);

      const res = await fetch(`${base}/file/upload`, {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: formData,
      });
      const uploadedPath = res.ok
        ? (((await res.json()) as Array<{ path: string }>)[0]?.path ?? optimisticPath)
        : optimisticPath;

      return `<file path="${uploadedPath}" mime="${f.mimeType}" filename="${f.name}">\nThis file has been uploaded and is available at the path above.\n</file>`;
    }),
  );
  return parts.join('\n');
}

/** The prompt text with the `<file>` block appended. */
export function withAttachments(text: string, fileBlock: string): string {
  if (!fileBlock) return text;
  return text ? `${text}\n\n${fileBlock}` : fileBlock;
}
