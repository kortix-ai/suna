'use client';

import {
  FileContentRenderer as BaseFileContentRenderer,
  type FileCategory,
  type FileContentRendererProps,
  FileSourceProvider,
  getFileCategory,
  getLanguageFromExt,
} from '@/features/file-viewer';
import { workspaceFileSource } from '../file-source';

// Re-export the shared helpers/types so existing import sites keep working.
export { getFileCategory, getLanguageFromExt };
export type { FileCategory, FileContentRendererProps };

/** The shared file viewer, bound to the live sandbox workspace. */
export function FileContentRenderer(props: FileContentRendererProps) {
  return (
    <FileSourceProvider value={workspaceFileSource}>
      <BaseFileContentRenderer {...props} />
    </FileSourceProvider>
  );
}
