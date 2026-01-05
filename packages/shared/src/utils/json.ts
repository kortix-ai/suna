/**
 * JSON parsing utilities with robust error handling
 */

/**
 * Safely parse a JSON string with fallback value
 * Handles:
 * - null/undefined input
 * - Pre-parsed objects (returns as-is)
 * - Double-escaped JSON strings
 * - Simple value strings (true, false, null, numbers)
 * 
 * @param jsonString - The JSON string or object to parse
 * @param defaultValue - Value to return if parsing fails
 * @returns The parsed value or the default value
 */
export function safeJsonParse<T>(
  jsonString: string | Record<string, any> | undefined | null,
  defaultValue: T
): T {
  if (jsonString === null || jsonString === undefined) {
    return defaultValue;
  }
  
  // Handle pre-parsed objects (from API)
  if (typeof jsonString === 'object') {
    return jsonString as T;
  }
  
  // Handle non-string values
  if (typeof jsonString !== 'string') {
    return defaultValue;
  }
  
  try {
    // First attempt: Parse as normal JSON
    const parsed = JSON.parse(jsonString);
    
    // Check if the result is a string that looks like JSON (double-escaped case)
    if (
      typeof parsed === 'string' &&
      (parsed.startsWith('{') || parsed.startsWith('['))
    ) {
      try {
        // Second attempt: Parse the string result as JSON (handles double-escaped)
        return JSON.parse(parsed) as T;
      } catch {
        // If inner parse fails, return the first parse result
        return parsed as unknown as T;
      }
    }
    
    return parsed as T;
  } catch {
    // If the input is a simple string that should be returned as-is
    if (typeof jsonString === 'string') {
      // Check if it's a string representation of a simple value
      if (jsonString === 'true') return true as unknown as T;
      if (jsonString === 'false') return false as unknown as T;
      if (jsonString === 'null') return null as unknown as T;
      if (!isNaN(Number(jsonString)) && jsonString.trim() !== '') {
        return Number(jsonString) as unknown as T;
      }
      
      // Return as string if it doesn't look like JSON
      if (!jsonString.startsWith('{') && !jsonString.startsWith('[')) {
        return jsonString as unknown as T;
      }
    }
    
    return defaultValue;
  }
}

/**
 * Stringify JSON with error handling
 * 
 * @param value - Value to stringify
 * @param defaultValue - Value to return if stringify fails
 * @returns JSON string or default value
 */
export function safeJsonStringify(
  value: any,
  defaultValue: string = '{}'
): string {
  try {
    return JSON.stringify(value);
  } catch {
    return defaultValue;
  }
}

