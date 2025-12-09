/**
 * Extracts a user-friendly error message from various error formats
 * Handles nested error structures, JSON strings, and standard Error objects
 */
export function extractErrorMessage(error: any): string {
  // Handle null/undefined
  if (!error) {
    return 'An unexpected error occurred';
  }

  // If it's already a clean string, return it
  if (typeof error === 'string') {
    // Check if it's a JSON string that needs parsing
    const trimmed = error.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed);
        return extractErrorMessage(parsed);
      } catch {
        // If parsing fails, return the string as-is
        return error;
      }
    }
    return error;
  }

  // Handle Error objects
  if (error instanceof Error) {
    const message = error.message;
    // Check if the message is a JSON string
    if (message && typeof message === 'string') {
      const trimmed = message.trim();
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        try {
          const parsed = JSON.parse(trimmed);
          return extractErrorMessage(parsed);
        } catch {
          // If parsing fails, return the message as-is
          return message;
        }
      }
      return message;
    }
    return error.message || 'An unexpected error occurred';
  }

  // Handle objects with nested error structures
  if (typeof error === 'object') {
    // Check for nested error structure: { error: { message: ... } }
    if (error.error?.message) {
      return String(error.error.message);
    }

    // Check for direct message
    if (error.message) {
      return String(error.message);
    }

    // Check for detail (can be string or object)
    if (error.detail) {
      if (typeof error.detail === 'string') {
        return error.detail;
      }
      if (error.detail.message) {
        return String(error.detail.message);
      }
    }

    // Check for response.data (common in axios/fetch errors)
    if (error.response?.data) {
      return extractErrorMessage(error.response.data);
    }

    // Check for data property
    if (error.data) {
      return extractErrorMessage(error.data);
    }
  }

  // Fallback: try to stringify if it's an object
  try {
    return JSON.stringify(error);
  } catch {
    return 'An unexpected error occurred';
  }
}

