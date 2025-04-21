// Helper function to format timestamp
export function formatTimestamp(isoString?: string): string {
  if (!isoString) return '';
  try {
    const date = new Date(isoString);
    return isNaN(date.getTime()) ? 'Invalid date' : date.toLocaleString();
  } catch (e) {
    return 'Invalid date';
  }
}

// Get standardized tool title
export function getToolTitle(toolName: string): string {
  // Normalize tool name
  const normalizedName = toolName.toLowerCase();
  
  // Map of tool names to their display titles
  const toolTitles: Record<string, string> = {
    'execute-command': 'Execute Command',
    'str-replace': 'String Replace',
    'create-file': 'Create File',
    'full-file-rewrite': 'Rewrite File',
    'delete-file': 'Delete File',
    'web-search': 'Web Search',
    'web-crawl': 'Web Crawl',
    'browser-navigate': 'Browser Navigate',
    'browser-click': 'Browser Click',
    'browser-extract': 'Browser Extract',
    'browser-fill': 'Browser Fill',
    'browser-wait': 'Browser Wait'
  };
  
  // Return the mapped title or a formatted version of the name
  if (toolTitles[normalizedName]) {
    return toolTitles[normalizedName];
  }
  
  // For browser tools not explicitly mapped
  if (normalizedName.startsWith('browser-')) {
    const operation = normalizedName.replace('browser-', '').replace(/-/g, ' ');
    return 'Browser ' + operation.charAt(0).toUpperCase() + operation.slice(1);
  }
  
  // Format any other tool name
  return toolName.split('-')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

// Helper to extract command from execute-command content
export function extractCommand(content: string | undefined): string | null {
  if (!content) return null;
  const commandMatch = content.match(/<execute-command>([\s\S]*?)<\/execute-command>/);
  return commandMatch ? commandMatch[1].trim() : null;
}

// Helper to extract command output from tool result content
export function extractCommandOutput(content: string | undefined): string | null {
  if (!content) return null;
  
  try {
    // First try to parse the JSON content
    const parsedContent = JSON.parse(content);
    if (parsedContent.content && typeof parsedContent.content === 'string') {
      // Look for a tool_result tag
      const toolResultMatch = parsedContent.content.match(/<tool_result>\s*<execute-command>([\s\S]*?)<\/execute-command>\s*<\/tool_result>/);
      if (toolResultMatch) {
        return toolResultMatch[1].trim();
      }
      
      // Look for output field in a ToolResult pattern
      const outputMatch = parsedContent.content.match(/ToolResult\(.*?output='([\s\S]*?)'.*?\)/);
      if (outputMatch) {
        return outputMatch[1];
      }
      
      // Return the content itself as a fallback
      return parsedContent.content;
    }
  } catch (e) {
    // If JSON parsing fails, try regex directly
    const toolResultMatch = content.match(/<tool_result>\s*<execute-command>([\s\S]*?)<\/execute-command>\s*<\/tool_result>/);
    if (toolResultMatch) {
      return toolResultMatch[1].trim();
    }
    
    const outputMatch = content.match(/ToolResult\(.*?output='([\s\S]*?)'.*?\)/);
    if (outputMatch) {
      return outputMatch[1];
    }
  }
  
  return content;
}

// Helper to extract the exit code from tool result
export function extractExitCode(content: string | undefined): number | null {
  if (!content) return null;
  
  try {
    const exitCodeMatch = content.match(/exit_code=(\d+)/);
    if (exitCodeMatch && exitCodeMatch[1]) {
      return parseInt(exitCodeMatch[1], 10);
    }
    return 0; // Assume success if no exit code found but command completed
  } catch (e) {
    return null;
  }
}

// Helper to extract file path from commands
export function extractFilePath(content: string | undefined): string | null {
  if (!content) return null;
  
  // Try to parse JSON content first
  try {
    const parsedContent = JSON.parse(content);
    if (parsedContent.content && typeof parsedContent.content === 'string') {
      content = parsedContent.content;
    }
  } catch (e) {
    // Continue with original content if parsing fails
  }
  
  // Look for file_path in different formats
  const filePathMatch = content.match(/file_path=["']([\s\S]*?)["']/i) || 
                       content.match(/target_file=["']([\s\S]*?)["']/i) ||
                       content.match(/path=["']([\s\S]*?)["']/i);
  if (filePathMatch) {
    const path = filePathMatch[1].trim();
    // Handle newlines and return first line if multiple lines
    return cleanFilePath(path);
  }
  
  // Look for file_path in XML-like tags
  const xmlFilePathMatch = content.match(/<str-replace\s+file_path=["']([\s\S]*?)["']/i) ||
                          content.match(/<delete[^>]*file_path=["']([\s\S]*?)["']/i) ||
                          content.match(/<delete-file[^>]*>([^<]+)<\/delete-file>/i);
  if (xmlFilePathMatch) {
    return cleanFilePath(xmlFilePathMatch[1]);
  }
  
  // Look for file paths in delete operations in particular
  if (content.toLowerCase().includes('delete') || content.includes('delete-file')) {
    // Look for patterns like "Deleting file: path/to/file.txt"
    const deletePathMatch = content.match(/(?:delete|remove|deleting)\s+(?:file|the file)?:?\s+["']?([\w\-./\\]+\.\w+)["']?/i);
    if (deletePathMatch) return cleanFilePath(deletePathMatch[1]);
    
    // Look for isolated file paths with extensions 
    const fileMatch = content.match(/["']?([\w\-./\\]+\.\w+)["']?/);
    if (fileMatch) return cleanFilePath(fileMatch[1]);
  }
  
  return null;
}

// Helper to clean and process a file path string, handling escaped chars
function cleanFilePath(path: string): string {
  if (!path) return path;
  
  // Handle escaped newlines and other escaped characters
  return path
    .replace(/\\n/g, '\n')    // Replace \n with actual newlines
    .replace(/\\t/g, '\t')    // Replace \t with actual tabs
    .replace(/\\r/g, '')      // Remove \r
    .replace(/\\\\/g, '\\')   // Replace \\ with \
    .replace(/\\"/g, '"')     // Replace \" with "
    .replace(/\\'/g, "'")     // Replace \' with '
    .split('\n')[0]           // Take only the first line if multiline
    .trim();                  // Trim whitespace
}

// Helper to extract str-replace old and new strings
export function extractStrReplaceContent(content: string | undefined): { oldStr: string | null, newStr: string | null } {
  if (!content) return { oldStr: null, newStr: null };
  
  const oldMatch = content.match(/<old_str>([\s\S]*?)<\/old_str>/);
  const newMatch = content.match(/<new_str>([\s\S]*?)<\/new_str>/);
  
  return {
    oldStr: oldMatch ? oldMatch[1] : null,
    newStr: newMatch ? newMatch[1] : null
  };
}

// Helper to extract file content from create-file or file-rewrite
export function extractFileContent(content: string | undefined, toolType: 'create-file' | 'full-file-rewrite'): string | null {
  if (!content) return null;
  
  const tagName = toolType === 'create-file' ? 'create-file' : 'full-file-rewrite';
  const contentMatch = content.match(new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'i'));
  
  if (contentMatch && contentMatch[1]) {
    return processFileContent(contentMatch[1]);
  }
  
  return null;
}

// Helper to process and clean file content
function processFileContent(content: string): string {
  if (!content) return content;
  
  // Handle escaped characters
  return content
    .replace(/\\n/g, '\n')   // Replace \n with actual newlines
    .replace(/\\t/g, '\t')   // Replace \t with actual tabs
    .replace(/\\r/g, '')     // Remove \r
    .replace(/\\\\/g, '\\')  // Replace \\ with \
    .replace(/\\"/g, '"')    // Replace \" with "
    .replace(/\\'/g, "'");   // Replace \' with '
}

// Helper to determine file type (for syntax highlighting)
export function getFileType(filePath: string): string {
  const extension = filePath.split('.').pop()?.toLowerCase() || '';
  
  switch (extension) {
    case 'js': return 'JavaScript';
    case 'ts': return 'TypeScript';
    case 'jsx': case 'tsx': return 'React';
    case 'py': return 'Python';
    case 'html': return 'HTML';
    case 'css': return 'CSS';
    case 'json': return 'JSON';
    case 'md': return 'Markdown';
    default: return extension.toUpperCase() || 'Text';
  }
}

// Helper to extract URL from browser navigate operations
export function extractBrowserUrl(content: string | undefined): string | null {
  if (!content) return null;
  const urlMatch = content.match(/url=["'](https?:\/\/[^"']+)["']/);
  return urlMatch ? urlMatch[1] : null;
}

// Helper to extract browser operation type
export function extractBrowserOperation(toolName: string | undefined): string {
  if (!toolName) return 'Browser Operation';
  
  const operation = toolName.replace('browser-', '').replace(/-/g, ' ');
  return operation.charAt(0).toUpperCase() + operation.slice(1);
}

// Helper to extract search query
export function extractSearchQuery(content: string | undefined): string | null {
  if (!content) return null;

  let contentToSearch = content; // Start with the original content

  // 3. Try parsing as JSON first, as the relevant content might be nested
  try {
    const parsedOuter = JSON.parse(content);
    if (typeof parsedOuter.content === 'string') {
      // If the outer content is JSON and has a 'content' string field,
      // use that inner content for searching the query.
      contentToSearch = parsedOuter.content;
      
      // Also check common JSON structures within the outer parsed object itself
      if (typeof parsedOuter.query === 'string') {
        return parsedOuter.query;
      }
      if (typeof parsedOuter.arguments === 'object' && parsedOuter.arguments !== null && typeof parsedOuter.arguments.query === 'string') {
        return parsedOuter.arguments.query;
      }
      if (Array.isArray(parsedOuter.tool_calls) && parsedOuter.tool_calls.length > 0) {
        const toolCall = parsedOuter.tool_calls[0];
        if (typeof toolCall.arguments === 'object' && toolCall.arguments !== null && typeof toolCall.arguments.query === 'string') {
          return toolCall.arguments.query;
        }
        if (typeof toolCall.arguments === 'string') {
            try {
                const argsParsed = JSON.parse(toolCall.arguments);
                if (typeof argsParsed.query === 'string') {
                    return argsParsed.query;
                }
            } catch {} 
        }
      }
    }
  } catch (e) {
    // If parsing fails, continue with the original content string
  }

  // Now search within contentToSearch (either original or nested content)
  
  // 1. Try regex for attribute within <web-search ...> tag
  const xmlQueryMatch = contentToSearch.match(/<web-search[^>]*query=[\"']([^\"']*)["'][^>]*>/i);
  if (xmlQueryMatch && xmlQueryMatch[1]) {
    return xmlQueryMatch[1].trim();
  }

  // 2. Try simple attribute regex (fallback, less specific)
  const simpleAttrMatch = contentToSearch.match(/query=[\"']([\s\S]*?)["']/i);
  if (simpleAttrMatch && simpleAttrMatch[1]) {
    return simpleAttrMatch[1].split(/[\"']/)[0].trim(); 
  }

  // 4. If nothing found after checking original/nested content and JSON structure, return null
  return null;
}

// Helper to extract search results from tool response
export function extractSearchResults(content: string | undefined): Array<{ title: string, url: string, snippet?: string }> {
  if (!content) return [];
  
  try {
    // Try to parse JSON content first
    const parsedContent = JSON.parse(content);
    if (parsedContent.content && typeof parsedContent.content === 'string') {
      // Look for a tool_result tag
      const toolResultMatch = parsedContent.content.match(/<tool_result>\s*<web-search>([\s\S]*?)<\/web-search>\s*<\/tool_result>/);
      if (toolResultMatch) {
        // Try to parse the results array
        try {
          return JSON.parse(toolResultMatch[1]);
        } catch (e) {
          // Fallback to regex extraction of URLs and titles
          return extractUrlsAndTitles(toolResultMatch[1]);
        }
      }
      
      // Look for ToolResult pattern
      const outputMatch = parsedContent.content.match(/ToolResult\(.*?output='([\s\S]*?)'.*?\)/);
      if (outputMatch) {
        try {
          return JSON.parse(outputMatch[1]);
        } catch (e) {
          return extractUrlsAndTitles(outputMatch[1]);
        }
      }
      
      // Try to find JSON array in the content
      const jsonArrayMatch = parsedContent.content.match(/\[\s*{[\s\S]*}\s*\]/);
      if (jsonArrayMatch) {
        try {
          return JSON.parse(jsonArrayMatch[0]);
        } catch (e) {
          return [];
        }
      }
    }
  } catch (e) {
    // If JSON parsing fails, try regex direct extraction
    const urlMatch = content.match(/https?:\/\/[^\s"]+/g);
    if (urlMatch) {
      return urlMatch.map(url => ({ 
        title: cleanUrl(url), 
        url 
      }));
    }
  }
  
  return [];
}

// Helper to extract URLs and titles with regex
export function extractUrlsAndTitles(content: string): Array<{ title: string, url: string, snippet?: string }> {
  const results: Array<{ title: string, url: string, snippet?: string }> = [];
  
  // Regex to find URLs, attempting to exclude common trailing unwanted characters/tags
  const urlRegex = /https?:\/\/[^\s"<]+/g;
  let match;
  
  while ((match = urlRegex.exec(content)) !== null) {
    let url = match[0];
    
    // --- Start: New Truncation Logic ---
    // Find the first occurrence of potential garbage separators like /n or \n after the protocol.
    const protocolEndIndex = url.indexOf('://');
    const searchStartIndex = protocolEndIndex !== -1 ? protocolEndIndex + 3 : 0;
    
    const newlineIndexN = url.indexOf('/n', searchStartIndex);
    const newlineIndexSlashN = url.indexOf('\\n', searchStartIndex);
    
    let firstNewlineIndex = -1;
    if (newlineIndexN !== -1 && newlineIndexSlashN !== -1) {
      firstNewlineIndex = Math.min(newlineIndexN, newlineIndexSlashN);
    } else if (newlineIndexN !== -1) {
      firstNewlineIndex = newlineIndexN;
    } else if (newlineIndexSlashN !== -1) {
      firstNewlineIndex = newlineIndexSlashN;
    }
    
    // If a newline indicator is found, truncate the URL there.
    if (firstNewlineIndex !== -1) {
      url = url.substring(0, firstNewlineIndex);
    }
    // --- End: New Truncation Logic ---

    // Basic cleaning: remove common tags or artifacts if they are directly appended
    url = url.replace(/<\/?url>$/, '')
             .replace(/<\/?content>$/, '')
             .replace(/%3C$/, ''); // Remove trailing %3C (less than sign)
             
    // Aggressive trailing character removal (common issues)
    // Apply this *after* potential truncation
    while (/[);.,\/]$/.test(url)) {
      url = url.slice(0, -1);
    }
    
    // Decode URI components to handle % sequences, but catch errors
    try {
      // Decode multiple times? Sometimes needed for double encoding
      url = decodeURIComponent(decodeURIComponent(url));
    } catch (e) {
      try { // Try decoding once if double decoding failed
        url = decodeURIComponent(url);
      } catch (e2) {
        console.warn("Failed to decode URL component:", url, e2);
      }
    }
    
    // Final cleaning for specific problematic sequences like ellipsis or remaining tags
    url = url.replace(/\u2026$/, ''); // Remove trailing ellipsis (…)
    url = url.replace(/<\/?url>$/, '').replace(/<\/?content>$/, ''); // Re-apply tag removal after decode

    // Try to find a title near this URL - simplified logic
    const urlIndex = match.index;
    const surroundingText = content.substring(Math.max(0, urlIndex - 100), urlIndex + url.length + 150); // Increased lookahead for content
    
    // Look for title patterns more robustly
    const contentMatch = surroundingText.match(/<content>([^<]+)<\/content>/i);
    const titleMatch = surroundingText.match(/Title[:\s]+([^\n<]+)/i) || 
                      surroundingText.match(/\"(.*?)\"[\s\n]*?https?:\/\//);
                      
    let title = cleanUrl(url); // Default to cleaned URL hostname/path
    if (contentMatch && contentMatch[1].trim()) {
      title = contentMatch[1].trim();
    } else if (titleMatch && titleMatch[1].trim()) {
      title = titleMatch[1].trim();
    }

    // Avoid adding duplicates if the cleaning resulted in the same URL
    if (url && !results.some(r => r.url === url)) { // Added check for non-empty url
      results.push({
        title: title,
        url: url
        // Snippet extraction could be added here if needed
      });
    }
  }
  
  return results;
}

// Helper to clean URL for display
export function cleanUrl(url: string): string {
  try {
    const urlObj = new URL(url);
    return urlObj.hostname.replace('www.', '') + (urlObj.pathname !== '/' ? urlObj.pathname : '');
  } catch (e) {
    return url;
  }
}

// Helper to extract URL for webpage crawling
export function extractCrawlUrl(content: string | undefined): string | null {
  if (!content) return null;
  const urlMatch = content.match(/url=["'](https?:\/\/[^"']+)["']/);
  return urlMatch ? urlMatch[1] : null;
}

// Helper to extract webpage content from crawl result
export function extractWebpageContent(content: string | undefined): { title: string, text: string } | null {
  if (!content) return null;
  
  try {
    // Try to parse the JSON content
    const parsedContent = JSON.parse(content);
    if (parsedContent.content && typeof parsedContent.content === 'string') {
      // Look for tool_result tag
      const toolResultMatch = parsedContent.content.match(/<tool_result>\s*<crawl-webpage>([\s\S]*?)<\/crawl-webpage>\s*<\/tool_result>/);
      if (toolResultMatch) {
        try {
          const crawlData = JSON.parse(toolResultMatch[1]);
          return {
            title: crawlData.title || '',
            text: crawlData.text || crawlData.content || ''
          };
        } catch (e) {
          // Fallback to basic text extraction
          return {
            title: 'Webpage Content',
            text: toolResultMatch[1]
          };
        }
      }
    }
    
    // Direct content extraction from parsed JSON
    if (parsedContent.content) {
      return {
        title: 'Webpage Content',
        text: parsedContent.content
      };
    }
  } catch (e) {
    // If JSON parsing fails, return the content as-is
    if (content) {
      return {
        title: 'Webpage Content',
        text: content
      };
    }
  }
  
  return null;
} 