/** The files a vault takes: PDF, DOCX or TXT, at most 15 MB each (Convex's argument cap). */
export const VAULT_ACCEPT = '.pdf,.docx,.txt';
export const VAULT_MAX_BYTES = 15 * 1024 * 1024;

/** Why the browser refuses a file before upload, or null. */
export function refuseReason(file: { name: string; size: number }): string | null {
  if (!/\.(pdf|docx|txt)$/i.test(file.name)) return 'PDF, DOCX or TXT only';
  if (file.size > VAULT_MAX_BYTES) return 'Files are limited to 15 MB';
  return null;
}
