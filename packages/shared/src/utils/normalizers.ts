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

/**
 * Normalize MIME types to match the allowed_mime_types in the staged-files bucket.
 * Maps unsupported MIME types to their supported equivalents.
 * 
 * This ensures compatibility between browser-detected MIME types and Supabase storage requirements.
 */
export function normalizeMimeType(mimeType: string): string {
  // Map of unsupported MIME types to supported ones
  const mimeTypeMapping: Record<string, string> = {
    // Python variants
    'text/x-python-script': 'text/x-python',
    'application/x-python': 'text/x-python',
    'text/python': 'text/x-python',
    
    // Other common variants that might not be in the allowed list
    'text/x-csrc': 'text/x-c',
    'text/x-chdr': 'text/x-c',
    'text/x-c++src': 'text/x-c++',
    'text/x-c++hdr': 'text/x-c++',
    'text/x-cpp': 'text/x-c++',
    'text/x-h': 'text/x-c',
    
    // Shell script variants
    'text/x-bash': 'text/x-shellscript',
    'text/x-sh': 'text/x-shellscript',
    'application/x-sh': 'text/x-shellscript',
    
    // YAML variants
    'text/yaml': 'text/x-yaml',
    'application/yaml': 'application/x-yaml',
    
    // JSON variants
    'text/json': 'application/json',
    
    // XML variants
    'text/x-xml': 'text/xml',
  };
  
  // Check if we have a direct mapping
  if (mimeType in mimeTypeMapping) {
    return mimeTypeMapping[mimeType];
  }
  
  // Return original if no mapping needed
  return mimeType;
}

