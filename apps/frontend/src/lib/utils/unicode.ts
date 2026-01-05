/**
 * Normalize filename to NFC (Normalized Form Composed) and sanitize Unicode spaces
 * to ensure consistent representation across different systems, especially macOS which
 * can use NFD (Normalized Form Decomposed) and Unicode spaces in timestamps.
 * 
 * @param filename The filename to normalize
 * @returns The filename normalized to NFC form with Unicode spaces converted to regular spaces
 */
export const normalizeFilenameToNFC = (filename: string): string => {
  try {
    // First normalize to NFC (Normalized Form Composed)
    let normalized = filename.normalize('NFC');
    
    // Replace problematic Unicode spaces with regular ASCII spaces
    // This fixes the common macOS issue where screenshots have Unicode spaces before PM/AM
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
    
    // Replace all Unicode spaces with regular ASCII space
    for (const unicodeSpace of unicodeSpaces) {
      normalized = normalized.replaceAll(unicodeSpace, ' ');
    }
    
    return normalized;
  } catch (error) {
    console.warn('Failed to normalize filename to NFC:', filename, error);
    return filename;
  }
};

/**
 * Normalize file path to NFC (Normalized Form Composed) to ensure consistent
 * Unicode representation across different systems.
 * 
 * @param path The file path to normalize
 * @returns The path with all components normalized to NFC form
 */
export const normalizePathToNFC = (path: string): string => {
  try {
    // Normalize to NFC (Normalized Form Composed)
    return path.normalize('NFC');
  } catch (error) {
    console.warn('Failed to normalize path to NFC:', path, error);
    return path;
  }
}; 