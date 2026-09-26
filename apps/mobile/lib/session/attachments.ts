/**
 * attachments — files a composer sends with a prompt.
 *
 * Shared by the thread composer (SessionChatInput) and the project home
 * composer (ProjectHome). Both upload each file when it is picked, through
 * `components/session/useComposerAttachments.ts`, and send the upload handles
 * as prompt parts (COR-185). Picking lives in
 * `components/session/useAttachmentPicker.ts`.
 */

export interface AttachedFile {
  /** Local file URI from the image or document picker. */
  uri: string;
  /** Original file name, shown in the composer and sent to the agent. */
  name: string;
  mimeType: string;
  size?: number;
  /** Renders a thumbnail instead of a file icon. */
  isImage: boolean;
  /**
   * The `PromptAttachmentController` id once `useComposerAttachments` has
   * started this file's upload (`lib/session/composer-uploads.ts`,
   * `lib/session/prompt-parts.ts`). Unset while the file is still being read
   * off the device, and stripped when a Cancel-restored file uploads again.
   */
  uploadId?: string;
}
