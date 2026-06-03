/**
 * File Utilities
 * Helper functions for file handling and conversion
 */

/**
 * Normalize and sanitize filename for Unix compatibility
 * - Normalizes to NFC (Normalized Form Canonical Composition)
 * - Replaces Unicode spaces with regular spaces
 * - Sanitizes special characters that cause issues in Unix
 * - URL-decodes percent-encoded characters
 */
export function normalizeFilenameToNFC(filename: string): string {
  try {
    // First, URL-decode if needed (handles %20, %E2%80%AF, etc.)
    let normalized = filename;
    try {
      normalized = decodeURIComponent(filename);
    } catch {
      // If decode fails, use original
      normalized = filename;
    }
    
    // Normalize to NFC (Normalized Form Composed)
    normalized = normalized.normalize('NFC');
    
    // Replace problematic Unicode spaces with regular ASCII spaces
    const unicodeSpaces = [
      '\u00A0', // Non-breaking space
      '\u2000', // En quad
      '\u2001', // Em quad  
      '\u2002', // En space
      '\u2003', // Em space
      '\u2004', // Three-per-em space
      '\u2005', // Four-per-em space
      '\u2006', // Six-per-em space
      '\u2007', // Figure space
      '\u2008', // Punctuation space
      '\u2009', // Thin space
      '\u200A', // Hair space
      '\u202F', // Narrow no-break space (common in macOS screenshots)
      '\u205F', // Medium mathematical space
      '\u3000', // Ideographic space
    ];
    
    for (const unicodeSpace of unicodeSpaces) {
      normalized = normalized.replaceAll(unicodeSpace, ' ');
    }
    
    // Replace problematic characters for Unix filesystems
    // These can cause issues with shell commands and file operations
    const replacements: Record<string, string> = {
      ':': '-',  // Colons not allowed in many filesystems
      '/': '-',  // Forward slash is path separator
      '\\': '-', // Backslash is escape character
      '*': '-',  // Wildcard character
      '?': '-',  // Wildcard character
      '"': "'",  // Double quotes can break shell commands
      '<': '-',  // Redirect operator
      '>': '-',  // Redirect operator
      '|': '-',  // Pipe operator
    };
    
    for (const [bad, good] of Object.entries(replacements)) {
      normalized = normalized.replaceAll(bad, good);
    }
    
    // Trim leading/trailing spaces and dots (can cause issues)
    normalized = normalized.trim().replace(/^\.+|\.+$/g, '');
    
    // If filename is empty after sanitization, use a default
    if (!normalized) {
      normalized = 'file';
    }
    
    return normalized;
  } catch (error) {
    console.warn('Failed to normalize filename:', filename, error);
    return filename.replace(/[^a-zA-Z0-9._-]/g, '_'); // Fallback: keep only safe chars
  }
}

/**
 * Validate file size (default max 50MB)
 */
export function validateFileSize(
  size: number | undefined,
  maxSizeMB: number = 50
): { valid: boolean; error?: string } {
  if (!size) {
    return { valid: true };
  }
  
  const maxSizeBytes = maxSizeMB * 1024 * 1024;
  
  if (size > maxSizeBytes) {
    return {
      valid: false,
      error: `File size exceeds ${maxSizeMB}MB limit`,
    };
  }
  
  return { valid: true };
}
