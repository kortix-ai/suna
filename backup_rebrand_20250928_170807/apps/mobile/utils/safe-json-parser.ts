export function safeJsonParse<T>(
  jsonString: string | undefined | null,
  fallback: T,
): T {
  if (!jsonString) {
    return fallback;
  }
  
  try {
    const parsed = JSON.parse(jsonString);
    
    if (typeof parsed === 'string' && 
        (parsed.startsWith('{') || parsed.startsWith('['))) {
      try {
        return JSON.parse(parsed) as T;
      } catch (innerError) {
        return parsed as unknown as T;
      }
    }
    
    return parsed as T;
  } catch (outerError) {
    if (typeof jsonString === 'object') {
      return jsonString as T;
    }
    
    if (typeof jsonString === 'string') {
      if (jsonString === 'true') return true as unknown as T;
      if (jsonString === 'false') return false as unknown as T;
      if (jsonString === 'null') return null as unknown as T;
      if (!isNaN(Number(jsonString))) return Number(jsonString) as unknown as T;
      
      if (!jsonString.startsWith('{') && !jsonString.startsWith('[')) {
        return jsonString as unknown as T;
      }
    }
    
    return fallback;
  }
} 