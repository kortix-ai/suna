import * as F from '../files/client';
import type { SessionRuntimeEntry } from '../session/session-runtime-registry';
export function bindSessionFiles(ensureReady: () => Promise<SessionRuntimeEntry>) {
  return {
    list: async (dirPath: string) => F.listFiles(dirPath, (await ensureReady()).runtimeUrl),
    read: async (filePath: string) => F.readFile(filePath, (await ensureReady()).runtimeUrl),
    readBlob: async (filePath: string) => F.readBlob(filePath, (await ensureReady()).runtimeUrl),
    status: async () => F.getFileStatus((await ensureReady()).runtimeUrl),
    findFiles: async (query: string, options?: { type?: 'file' | 'directory'; limit?: number }) =>
      F.findFiles(query, options, (await ensureReady()).runtimeUrl),
    findText: async (pattern: string) => F.findText(pattern, (await ensureReady()).runtimeUrl),
    upload: async (
      file: File | Blob,
      targetPath?: string,
      filename?: string,
      options?: F.UploadFileOptions,
    ) => F.uploadFile(file, targetPath, filename, (await ensureReady()).runtimeUrl, options),
    /**
     * Overwrite `filePath` in place. The daemon's upload endpoint never
     * overwrites (it uniquifies a colliding name), so a plain `upload` over
     * an existing path silently writes a DIFFERENT file — see `writeFile`.
     */
    write: async (filePath: string, content: Blob | File) =>
      F.writeFile(filePath, content, (await ensureReady()).runtimeUrl),
    create: async (filePath: string) => F.createFile(filePath, (await ensureReady()).runtimeUrl),
    copy: async (sourcePath: string, destPath: string) =>
      F.copyFile(sourcePath, destPath, (await ensureReady()).runtimeUrl),
    remove: async (filePath: string) => F.deleteFile(filePath, (await ensureReady()).runtimeUrl),
    mkdir: async (dirPath: string) => F.mkdir(dirPath, (await ensureReady()).runtimeUrl),
    rename: async (from: string, to: string) =>
      F.renameFile(from, to, (await ensureReady()).runtimeUrl),
  };
}
