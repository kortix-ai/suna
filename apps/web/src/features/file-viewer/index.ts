/**
 * file-viewer — the single, surface-agnostic file content renderer.
 *
 * The renderer is presentation-only. Each surface (the live workspace in
 * `features/files`, a project's git-ref view in `features/project-files`)
 * provides data access through a <FileSourceProvider>. See ./file-source.
 */
export { FileContentRenderer } from './file-content-renderer';
export type { FileContentRendererProps } from './file-content-renderer';
export { FilePreviewModal } from './file-preview-modal';
export type { FilePreviewModalProps, FilePreviewState } from './file-preview-modal';
export { FileSourceProvider, useFileSource } from './file-source';
export type {
  BinaryBlobResult,
  FileContent,
  FileContentResult,
  FilePatch,
  FilePatchHunk,
  FileSource,
} from './file-source';
export { HtmlPreview } from './html-preview';
export { PreviewFitProvider, isUsableIntrinsicSize } from './preview-fit';
export { framePolicy, getFileCategory, getLanguageFromExt } from './preview-policy';
export type { FileCategory, FrameContent, FramePolicy } from './preview-policy';
