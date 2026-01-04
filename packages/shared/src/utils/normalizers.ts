/**
 * Value normalization utilities
 * Handles conversion of various input types to consistent formats
 */

/**
 * Normalizes an array value that might be a string, array, or other type
 * Handles JSON strings, comma-separated strings, and arrays
 */
export function normalizeArrayValue(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
  }
  
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) {
        return parsed.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
      }
    } catch {
      // If parsing fails, treat as comma-separated string
      return value.split(',').map(a => a.trim()).filter(a => a.length > 0);
    }
  }
  
  return [];
}

/**
 * Normalizes attachments value (can be string, array, or empty)
 * Handles JSON stringified arrays, comma-separated strings, and arrays
 */
export function normalizeAttachments(attachments: unknown): string[] {
  if (Array.isArray(attachments)) {
    return attachments;
  }
  
  if (typeof attachments === 'string') {
    // Try parsing as JSON first (handles JSON stringified arrays like "[\"file1.json\", \"file2.json\"]")
    const trimmed = attachments.trim();
    if ((trimmed.startsWith('[') && trimmed.endsWith(']')) || 
        (trimmed.startsWith('{') && trimmed.endsWith('}'))) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) {
          return parsed.filter((a: any) => a && typeof a === 'string' && a.trim().length > 0);
        }
      } catch {
        // Not valid JSON, fall through to comma-separated parsing
      }
    }
    
    // Fallback to comma-separated string parsing
    return attachments.split(',').map(a => a.trim()).filter(a => a.length > 0);
  }
  
  return [];
}

