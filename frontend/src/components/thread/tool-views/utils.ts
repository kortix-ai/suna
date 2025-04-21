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
    'crawl-webpage': 'Web Crawl',
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

// Helper to extract URLs and titles with regex
export function extractUrlsAndTitles(content: string): Array<{ title: string, url: string, snippet?: string }> {
  const results: Array<{ title: string, url: string, snippet?: string }> = [];
  
  // First try to handle the case where content contains fragments of JSON objects
  // This pattern matches both complete and partial result objects
  const jsonFragmentPattern = /"?title"?\s*:\s*"([^"]+)"[^}]*"?url"?\s*:\s*"?(https?:\/\/[^",\s]+)"?|https?:\/\/[^",\s]+[",\s]*"?title"?\s*:\s*"([^"]+)"/g;
  let fragmentMatch;
  
  while ((fragmentMatch = jsonFragmentPattern.exec(content)) !== null) {
    // Extract title and URL from the matched groups
    // Groups can match in different orders depending on the fragment format
    const title = fragmentMatch[1] || fragmentMatch[3] || '';
    let url = fragmentMatch[2] || '';
    
    // If no URL was found in the JSON fragment pattern but we have a title,
    // try to find a URL on its own line above the title
    if (!url && title) {
      // Look backwards from the match position
      const beforeText = content.substring(0, fragmentMatch.index);
      const urlMatch = beforeText.match(/https?:\/\/[^\s",]+\s*$/);
      if (urlMatch && urlMatch[0]) {
        url = urlMatch[0].trim();
      }
    }
    
    if (url && title && !results.some(r => r.url === url)) {
      results.push({ title, url });
    }
  }
  
  // If we didn't find any results with the JSON fragment approach, fall back to standard URL extraction
  if (results.length === 0) {
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

      // Try to find a title near this URL
      const urlIndex = match.index;
      const surroundingText = content.substring(Math.max(0, urlIndex - 100), urlIndex + url.length + 200);
      
      // Look for title patterns more robustly
      const titleMatch = surroundingText.match(/title"?\s*:\s*"([^"]+)"/i) || 
                        surroundingText.match(/Title[:\s]+([^\n<]+)/i) || 
                        surroundingText.match(/\"(.*?)\"[\s\n]*?https?:\/\//);
                        
      let title = cleanUrl(url); // Default to cleaned URL hostname/path
      if (titleMatch && titleMatch[1].trim()) {
        title = titleMatch[1].trim();
      }

      // Avoid adding duplicates if the cleaning resulted in the same URL
      if (url && !results.some(r => r.url === url)) {
        results.push({
          title: title,
          url: url
        });
      }
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
  
  try {
    // Try to parse content as JSON first (for the new format)
    const parsedContent = JSON.parse(content);
    if (parsedContent.content) {
      // Look for URL in the content string
      const urlMatch = parsedContent.content.match(/<crawl-webpage\s+url=["'](https?:\/\/[^"']+)["']/i);
      if (urlMatch) return urlMatch[1];
    }
  } catch (e) {
    // Fall back to direct regex search if JSON parsing fails
  }
  
  // Direct regex search in the content string
  const urlMatch = content.match(/<crawl-webpage\s+url=["'](https?:\/\/[^"']+)["']/i) || 
                   content.match(/url=["'](https?:\/\/[^"']+)["']/i);
  
  return urlMatch ? urlMatch[1] : null;
}

// Helper to extract webpage content from crawl result
export function extractWebpageContent(content: string | undefined): { title: string, text: string } | null {
  if (!content) return null;
  
  try {
    // Try to parse the JSON content
    const parsedContent = JSON.parse(content);
    
    // Handle case where content is in parsedContent.content field
    if (parsedContent.content && typeof parsedContent.content === 'string') {
      // Look for tool_result tag
      const toolResultMatch = parsedContent.content.match(/<tool_result>\s*<crawl-webpage>([\s\S]*?)<\/crawl-webpage>\s*<\/tool_result>/);
      if (toolResultMatch) {
        try {
          // Try to parse the content inside the tags
          const rawData = toolResultMatch[1];
          
          // Look for ToolResult pattern in the raw data
          const toolResultOutputMatch = rawData.match(/ToolResult\(.*?output='([\s\S]*?)'.*?\)/);
          if (toolResultOutputMatch) {
            try {
              // If ToolResult pattern found, try to parse its output which may be a stringified JSON
              const outputJson = JSON.parse(toolResultOutputMatch[1].replace(/\\\\n/g, '\\n').replace(/\\\\u/g, '\\u'));
              
              // Handle array format (first item)
              if (Array.isArray(outputJson) && outputJson.length > 0) {
                const item = outputJson[0];
                return {
                  title: item.Title || item.title || '',
                  text: item.Text || item.text || item.content || ''
                };
              }
              
              // Handle direct object format
              return {
                title: outputJson.Title || outputJson.title || '',
                text: outputJson.Text || outputJson.text || outputJson.content || ''
              };
            } catch (e) {
              // If parsing fails, use the raw output
              return {
                title: 'Webpage Content',
                text: toolResultOutputMatch[1]
              };
            }
          }
          
          // Try to parse as direct JSON if no ToolResult pattern
          const crawlData = JSON.parse(rawData);
          
          // Handle array format
          if (Array.isArray(crawlData) && crawlData.length > 0) {
            const item = crawlData[0];
            return {
              title: item.Title || item.title || '',
              text: item.Text || item.text || item.content || ''
            };
          }
          
          // Handle direct object format
          return {
            title: crawlData.Title || crawlData.title || '',
            text: crawlData.Text || crawlData.text || crawlData.content || ''
          };
        } catch (e) {
          // Fallback to basic text extraction
          return {
            title: 'Webpage Content',
            text: toolResultMatch[1]
          };
        }
      }
      
      // Handle ToolResult pattern in the content directly
      const toolResultOutputMatch = parsedContent.content.match(/ToolResult\(.*?output='([\s\S]*?)'.*?\)/);
      if (toolResultOutputMatch) {
        try {
          // Parse the output which might be a stringified JSON
          const outputJson = JSON.parse(toolResultOutputMatch[1].replace(/\\\\n/g, '\\n').replace(/\\\\u/g, '\\u'));
          
          // Handle array format
          if (Array.isArray(outputJson) && outputJson.length > 0) {
            const item = outputJson[0];
            return {
              title: item.Title || item.title || '',
              text: item.Text || item.text || item.content || ''
            };
          }
          
          // Handle direct object format
          return {
            title: outputJson.Title || outputJson.title || '',
            text: outputJson.Text || outputJson.text || outputJson.content || ''
          };
        } catch (e) {
          // If parsing fails, use the raw output
          return {
            title: 'Webpage Content',
            text: toolResultOutputMatch[1]
          };
        }
      }
    }
    
    // Direct handling of <crawl-webpage> format outside of content field
    const crawlWebpageMatch = content.match(/<crawl-webpage>([\s\S]*?)<\/crawl-webpage>/);
    if (crawlWebpageMatch) {
      const rawData = crawlWebpageMatch[1];
      
      // Look for ToolResult pattern
      const toolResultOutputMatch = rawData.match(/ToolResult\(.*?output='([\s\S]*?)'.*?\)/);
      if (toolResultOutputMatch) {
        try {
          // Parse the output which might be a stringified JSON
          const outputString = toolResultOutputMatch[1].replace(/\\\\n/g, '\\n').replace(/\\\\u/g, '\\u');
          const outputJson = JSON.parse(outputString);
          
          // Handle array format
          if (Array.isArray(outputJson) && outputJson.length > 0) {
            const item = outputJson[0];
            return {
              title: item.Title || item.title || (item.URL ? new URL(item.URL).hostname : ''),
              text: item.Text || item.text || item.content || ''
            };
          }
          
          // Handle direct object format
          return {
            title: outputJson.Title || outputJson.title || '',
            text: outputJson.Text || outputJson.text || outputJson.content || ''
          };
        } catch (e) {
          // If parsing fails, use the raw output
          return {
            title: 'Webpage Content',
            text: toolResultOutputMatch[1]
          };
        }
      }
    }
    
    // Direct content extraction from parsed JSON if it's an array
    if (Array.isArray(parsedContent) && parsedContent.length > 0) {
      const item = parsedContent[0];
      return {
        title: item.Title || item.title || '',
        text: item.Text || item.text || item.content || ''
      };
    }
    
    // Direct content extraction from parsed JSON as object
    if (typeof parsedContent === 'object') {
      return {
        title: parsedContent.Title || parsedContent.title || 'Webpage Content',
        text: parsedContent.Text || parsedContent.text || parsedContent.content || JSON.stringify(parsedContent)
      };
    }
  } catch (e) {
    // Last resort, try to match the ToolResult pattern directly in the raw content
    const toolResultMatch = content.match(/ToolResult\(.*?output='([\s\S]*?)'.*?\)/);
    if (toolResultMatch) {
      try {
        // Try to parse the output which might be a stringified JSON
        const outputJson = JSON.parse(toolResultMatch[1].replace(/\\\\n/g, '\\n').replace(/\\\\u/g, '\\u'));
        
        // Handle array format
        if (Array.isArray(outputJson) && outputJson.length > 0) {
          const item = outputJson[0];
          return {
            title: item.Title || item.title || '',
            text: item.Text || item.text || item.content || ''
          };
        }
        
        // Handle direct object format
        return {
          title: outputJson.Title || outputJson.title || '',
          text: outputJson.Text || outputJson.text || outputJson.content || ''
        };
      } catch (e) {
        // If parsing fails, use the raw output
        return {
          title: 'Webpage Content',
          text: toolResultMatch[1]
        };
      }
    }
    
    // If all else fails, return the content as-is
    if (content) {
      return {
        title: 'Webpage Content',
        text: content
      };
    }
  }
  
  return null;
}

// Helper to extract search results from tool response
export function extractSearchResults(content: string | undefined): Array<{ title: string, url: string, snippet?: string }> {
  if (!content) return [];
  
  // First try the standard JSON extraction methods
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
          return extractUrlsAndTitles(parsedContent.content);
        }
      }
      
      // If none of the above worked, try the whole content
      return extractUrlsAndTitles(parsedContent.content);
    }
  } catch (e) {
    // If JSON parsing fails, extract directly from the content
    return extractUrlsAndTitles(content);
  }
  
  // Last resort fallback
  return extractUrlsAndTitles(content);
}

// Function to determine which tool component to render based on the tool name
export function getToolComponent(toolName: string): string {
  if (!toolName) return 'GenericToolView';
  
  const normalizedName = toolName.toLowerCase();
  
  // Map specific tool names to their respective components
  switch (normalizedName) {
    // Browser tools
    case 'browser-navigate':
    case 'browser-click':
    case 'browser-extract':
    case 'browser-fill':
    case 'browser-wait':
    case 'browser-screenshot':
      return 'BrowserToolView';
    
    // Command execution
    case 'execute-command':
      return 'CommandToolView';
    
    // File operations
    case 'create-file':
    case 'delete-file':
    case 'full-file-rewrite':
    case 'read-file':
      return 'FileOperationToolView';
    
    // String operations
    case 'str-replace':
      return 'StrReplaceToolView';
    
    // Web operations
    case 'web-search':
      return 'WebSearchToolView';
    case 'crawl-webpage':
      return 'WebCrawlToolView';
      
    // Data provider operations
    case 'execute-data-provider-call':
    case 'get-data-provider-endpoints':
      return 'DataProviderToolView';
    
    // Default
    default:
      return 'GenericToolView';
  }
} 