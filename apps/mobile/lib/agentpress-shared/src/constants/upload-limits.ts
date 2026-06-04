export const UPLOAD_LIMITS = {
  MAX_FILE_SIZE_BYTES: 50 * 1024 * 1024,
  MAX_FILE_SIZE_MB: 50,
  MAX_PDF_PAGES: 500,
  MAX_EXCEL_ROWS: 100_000,
  MAX_EXCEL_SHEETS: 50,
  MAX_TEXT_CHARS: 10_000_000,
  MAX_ZIP_FILES: 50,
  MAX_ZIP_TOTAL_SIZE_BYTES: 100 * 1024 * 1024,
} as const;

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function isAllowedFile(file: { name: string; size?: number }): { allowed: boolean; reason?: string } {
  if (file.size && file.size > UPLOAD_LIMITS.MAX_FILE_SIZE_BYTES) {
    return { allowed: false, reason: `File exceeds ${UPLOAD_LIMITS.MAX_FILE_SIZE_MB}MB limit` };
  }
  return { allowed: true };
}

export function isExtractableArchive(file: { name: string }): boolean {
  return file.name.endsWith('.zip');
}
