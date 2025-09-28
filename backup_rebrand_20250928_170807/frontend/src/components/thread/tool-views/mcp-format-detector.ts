// Define content formats we can detect
export enum ContentFormat {
  JSON = 'json',
  SEARCH_RESULTS = 'search_results',
  TABLE = 'table',
  MARKDOWN = 'markdown',
  CSV = 'csv',
  XML = 'xml',
  HTML = 'html',
  CODE = 'code',
  URL_LIST = 'url_list',
  KEY_VALUE = 'key_value',
  ERROR = 'error',
  PLAIN_TEXT = 'plain_text'
}

// Pattern matchers for different formats
const FORMAT_PATTERNS = {
  // JSON patterns
  json: [
    /^\s*\{[\s\S]*\}\s*$/,
    /^\s*\[[\s\S]*\]\s*$/
  ],
  
  // Search result patterns
  searchResults: [
    /\d+\.\s+.*\n\s*(URL|url|Url):\s*/,
    /results?:\s*\[/i,
    /search results/i,
    /"results"\s*:\s*\[/,
    /found \d+ (result|match)/i
  ],
  
  // Table patterns (ASCII tables, markdown tables)
  table: [
    /[|\+\-]{3,}/,
    /\|.*\|.*\|/,
    /^[\s\S]*\|\s*\w+\s*\|[\s\S]*$/m
  ],
  
  // CSV patterns
  csv: [
    /^[^,\n]+,[^,\n]+/m,
    /^"[^"]+","[^"]+"/m
  ],
  
  // Markdown patterns
  markdown: [
    /^#{1,6}\s+/m,
    /\*\*[^*]+\*\*/,
    /\[[^\]]+\]\([^)]+\)/,
    /^[\*\-]\s+/m,
    /^>\s+/m,
    /```[\s\S]*```/
  ],
  
  // XML/HTML patterns
  xml: [
    /^<\?xml/,
    /<[^>]+>[\s\S]*<\/[^>]+>/
  ],
  
  html: [
    /<!DOCTYPE html/i,
    /<html[\s>]/i,
    /<(div|span|p|h[1-6]|table|ul|ol)[\s>]/i
  ],
  
  // Code patterns
  code: [
    /^(function|class|const|let|var|def|import|export)\s+/m,
    /^(if|else|for|while|switch)\s*\(/m,
    /[{}();]\s*$/m
  ],
  
  // URL list patterns
  urlList: [
    /^https?:\/\/\S+$/m,
    /(https?:\/\/\S+\s*\n){2,}/
  ],
  
  // Key-value patterns
  keyValue: [
    /^\s*\w+\s*:\s*.+$/m,
    /^\s*"[^"]+"\s*:\s*.+$/m
  ],
  
  // Error patterns
  error: [
    /error|exception|failed|failure/i,
    /stack trace/i,
    /at\s+\w+\s*\([^)]*\)/
  ]
};

// Content analysis result
export interface FormatDetectionResult {
  format: ContentFormat;
  confidence: number;
  metadata?: {
    isJson?: boolean;
    hasUrls?: boolean;
    hasTable?: boolean;
    lineCount?: number;
    wordCount?: number;
    hasCode?: boolean;
    errorType?: string;
  };
  parsedData?: any;
}

// Smart format detector
export class MCPFormatDetector {
  /**
   * Detect the format of content with confidence scoring
   */
  static detect(content: any): FormatDetectionResult {
    // Handle null/undefined
    if (!content) {
      return {
        format: ContentFormat.PLAIN_TEXT,
        confidence: 1,
        metadata: { lineCount: 0, wordCount: 0 }
      };
    }
    
    // If already an object, check its structure
    if (typeof content === 'object') {
      return this.detectObjectFormat(content);
    }
    
    // Convert to string for analysis
    const text = String(content).trim();
    
    // Try JSON parsing first
    try {
      const parsed = JSON.parse(text);
      return this.detectObjectFormat(parsed, text);
    } catch {
      // Not JSON, continue with text analysis
    }
    
    // Analyze text patterns
    return this.detectTextFormat(text);
  }
  
  /**
   * Detect format of parsed objects
   */
  private static detectObjectFormat(obj: any, originalText?: string): FormatDetectionResult {
    // Check for search results structure
    if (this.isSearchResultStructure(obj)) {
      return {
        format: ContentFormat.SEARCH_RESULTS,
        confidence: 0.95,
        parsedData: obj,
        metadata: {
          isJson: true,
          hasUrls: true
        }
      };
    }
    
    // Check for table-like structure (array of similar objects)
    if (Array.isArray(obj) && obj.length > 0 && this.isTableLike(obj)) {
      return {
        format: ContentFormat.TABLE,
        confidence: 0.85,
        parsedData: obj,
        metadata: {
          isJson: true,
          hasTable: true
        }
      };
    }
    
    // Generic JSON object
    return {
      format: ContentFormat.JSON,
      confidence: 0.9,
      parsedData: obj,
      metadata: {
        isJson: true
      }
    };
  }
  
  /**
   * Detect format of text content
   */
  private static detectTextFormat(text: string): FormatDetectionResult {
    const scores: Record<ContentFormat, number> = {
      [ContentFormat.JSON]: 0,
      [ContentFormat.SEARCH_RESULTS]: 0,
      [ContentFormat.TABLE]: 0,
      [ContentFormat.MARKDOWN]: 0,
      [ContentFormat.CSV]: 0,
      [ContentFormat.XML]: 0,
      [ContentFormat.HTML]: 0,
      [ContentFormat.CODE]: 0,
      [ContentFormat.URL_LIST]: 0,
      [ContentFormat.KEY_VALUE]: 0,
      [ContentFormat.ERROR]: 0,
      [ContentFormat.PLAIN_TEXT]: 0.1 // Base score
    };
    
    // Calculate pattern matches
    for (const [format, patterns] of Object.entries(FORMAT_PATTERNS)) {
      for (const pattern of patterns) {
        if (pattern.test(text)) {
          const formatKey = this.patternKeyToFormat(format);
          scores[formatKey] += 0.3;
        }
      }
    }
    
    // Additional heuristics
    const lines = text.split('\n');
    const metadata: any = {
      lineCount: lines.length,
      wordCount: text.split(/\s+/).length,
      hasUrls: /https?:\/\/\S+/.test(text),
      hasCode: /[{}();]/.test(text)
    };
    
    // Boost scores based on content characteristics
    if (metadata.hasUrls && scores[ContentFormat.SEARCH_RESULTS] > 0) {
      scores[ContentFormat.SEARCH_RESULTS] += 0.2;
    }
    
    if (lines.length > 5 && this.hasConsistentStructure(lines)) {
      scores[ContentFormat.TABLE] += 0.2;
      scores[ContentFormat.CSV] += 0.1;
    }
    
    // Find highest scoring format
    let bestFormat = ContentFormat.PLAIN_TEXT;
    let highestScore = scores[ContentFormat.PLAIN_TEXT];
    
    for (const [format, score] of Object.entries(scores)) {
      if (score > highestScore) {
        highestScore = score;
        bestFormat = format as ContentFormat;
      }
    }
    
    return {
      format: bestFormat,
      confidence: Math.min(highestScore, 1),
      metadata
    };
  }
  
  /**
   * Check if object looks like search results
   */
  private static isSearchResultStructure(obj: any): boolean {
    // Direct results array
    if (obj.results && Array.isArray(obj.results)) {
      return obj.results.some((item: any) => 
        item.title && (item.url || item.link)
      );
    }
    
    // Data array
    if (obj.data && Array.isArray(obj.data)) {
      return obj.data.some((item: any) => 
        item.title && (item.url || item.link)
      );
    }
    
    // Direct array
    if (Array.isArray(obj)) {
      return obj.some((item: any) => 
        item.title && (item.url || item.link)
      );
    }
    
    return false;
  }
  
  /**
   * Check if array of objects has table-like structure
   */
  private static isTableLike(arr: any[]): boolean {
    if (arr.length < 2) return false;
    
    // Get keys from first object
    const firstKeys = Object.keys(arr[0]).sort();
    
    // Check if all objects have similar structure
    return arr.every(item => {
      const keys = Object.keys(item).sort();
      return keys.length === firstKeys.length &&
             keys.every((key, i) => key === firstKeys[i]);
    });
  }
  
  /**
   * Check if lines have consistent structure (for tables)
   */
  private static hasConsistentStructure(lines: string[]): boolean {
    const nonEmptyLines = lines.filter(l => l.trim());
    if (nonEmptyLines.length < 3) return false;
    
    // Check for consistent delimiters
    const delimiterCounts = nonEmptyLines.map(line => {
      const pipes = (line.match(/\|/g) || []).length;
      const commas = (line.match(/,/g) || []).length;
      const tabs = (line.match(/\t/g) || []).length;
      return { pipes, commas, tabs };
    });
    
    // Check if any delimiter is consistent
    return ['pipes', 'commas', 'tabs'].some(delim => {
      const counts = delimiterCounts.map(c => c[delim as keyof typeof c]);
      const first = counts[0];
      return first > 0 && counts.every(c => Math.abs(c - first) <= 1);
    });
  }
  
  /**
   * Convert pattern key to ContentFormat enum
   */
  private static patternKeyToFormat(key: string): ContentFormat {
    const mapping: Record<string, ContentFormat> = {
      json: ContentFormat.JSON,
      searchResults: ContentFormat.SEARCH_RESULTS,
      table: ContentFormat.TABLE,
      markdown: ContentFormat.MARKDOWN,
      csv: ContentFormat.CSV,
      xml: ContentFormat.XML,
      html: ContentFormat.HTML,
      code: ContentFormat.CODE,
      urlList: ContentFormat.URL_LIST,
      keyValue: ContentFormat.KEY_VALUE,
      error: ContentFormat.ERROR
    };
    
    return mapping[key] || ContentFormat.PLAIN_TEXT;
  }
}

// Export utility function for easy use
export function detectMCPFormat(content: any): FormatDetectionResult {
  return MCPFormatDetector.detect(content);
} 