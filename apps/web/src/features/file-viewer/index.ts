/**
 * file-viewer — the single, surface-agnostic file content renderer.
 *
 * The renderer is presentation-only. Each surface (the live workspace in
 * `features/files`, a project's git-ref view in `features/project-files`)
 * provides data access through a <FileSourceProvider>. See ./file-source.
 */
export {
  FileContentRenderer,
  getFileCategory,
  getLanguageFromExt,
} from './file-content-renderer';
export type { FileContentRendererProps, FileCategory } from './file-content-renderer';
export { FilePreviewModal } from './file-preview-modal';
export { FileSourceProvider } from './file-source';
export type {
  FileSource,
} from './file-source';
