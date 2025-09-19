// Import at the top
// import { formatDistanceToNow } from 'date-fns';
import {
  FileText,
  FileCode,
  FileImage,
  FileJson,
  File,
  FolderOpen,
  FileType,
  FileVideo,
  FileAudio,
  FileArchive,
  Table,
} from 'lucide-react';
import { parseXmlToolCalls, isNewXmlFormat } from './xml-parser';
import { parseToolResult, ParsedToolResult } from './tool-result-parser';

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
    'check-command-output': 'Check Command Output',
    'str-replace': 'String Replace',
    'create-file': 'Create File',
    'full-file-rewrite': 'Rewrite File',
    'delete-file': 'Delete File',
    'web-search': 'Web Search',
    'image-search': 'Image Search',
    'crawl-webpage': 'Web Crawl',
    'scrape-webpage': 'Web Scrape',
    'browser-navigate-to': 'Browser Navigate',
    'browser-act': 'Browser Action',
    'browser-extract-content': 'Browser Extract',
    'browser-screenshot': 'Browser Screenshot',
    'load-image': 'Load Image',
    'ask': 'Ask',
    'complete': 'Task Complete',
    'execute-data-provider-call': 'Data Provider Call',
    'get-data-provider-endpoints': 'Data Endpoints',
    'search-mcp-servers': 'Search MCP Servers',
    'get-app-details': 'Get App Details',
    'create-credential-profile': 'Create Credential Profile',
    'connect-credential-profile': 'Connect Credential Profile',
    'check-profile-connection': 'Check Profile Connection',
    'configure-profile-for-agent': 'Configure Profile For Agent',
    'get-credential-profiles': 'Get Credential Profiles',
    'get-current-agent-config': 'Get Current Agent Config',
    'deploy': 'Deploy',
    'create-presentation': 'Create Presentation',
    'export-presentation': 'Export Presentation',
    'create-presentation-outline': 'Create Presentation Outline',
    'list-presentation-templates': 'List Presentation Templates',
    'upload-file': 'Upload File',
    
    // Docs tools
    'create-document': 'Create Document',
    'update-document': 'Update Document',
    'read-document': 'Read Document',
    'list-documents': 'List Documents',
    'delete-document': 'Delete Document',
    'export-document': 'Export Document',
    
    // Agent Creation Tools
    'create-new-agent': 'Create New Agent',
    'search-mcp-servers-for-agent': 'Search MCP Servers for Agent',
    'get-mcp-server-details': 'Get MCP Server Details',
    'create-credential-profile-for-agent': 'Create Credential Profile for Agent',
    'discover-mcp-tools-for-agent': 'Discover MCP Tools for Agent',
    'configure-agent-integration': 'Configure Agent Integration',
    'list-available-integrations': 'List Available Integrations',
    'create-agent-workflow': 'Create Agent Workflow',
    'list-agent-workflows': 'List Agent Workflows',
    'activate-agent-workflow': 'Activate Agent Workflow',
    'create-agent-scheduled-trigger': 'Create Scheduled Trigger',
    'list-agent-scheduled-triggers': 'List Scheduled Triggers',
    'delete-agent-workflow': 'Delete Agent Workflow',
    'delete-agent-scheduled-trigger': 'Delete Scheduled Trigger',
    'toggle-agent-scheduled-trigger': 'Toggle Scheduled Trigger',

    'generic-tool': 'Tool',
    'default': 'Tool',
  };

  // Return the mapped title or a formatted version of the name
  if (toolTitles[normalizedName]) {
    return toolTitles[normalizedName];
  }

  // For browser tools not explicitly mapped
  if (normalizedName.startsWith('browser_')) {
    const operation = normalizedName.replace('browser_', '').replace(/_/g, ' ');
    return 'Browser ' + operation.charAt(0).toUpperCase() + operation.slice(1);
  }

  // Format any other tool name
  return toolName
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

// Helper to extract command from execute-command content
export function extractCommand(content: string | object | undefined | null): string | null {
  const contentStr = normalizeContentToString(content);
  if (!contentStr) return null;
  
  // First try to extract from XML tags (with or without attributes)
  const commandMatch = contentStr.match(
    /<execute-command[^>]*>([\s\S]*?)<\/execute-command>/,
  );
  if (commandMatch) {
    return commandMatch[1].trim();
  }
  
  // Try to find command in JSON structure (for native tool calls)
  try {
    const parsed = JSON.parse(contentStr);
    if (parsed.tool_calls && Array.isArray(parsed.tool_calls)) {
      const execCommand = parsed.tool_calls.find((tc: any) => 
        tc.function?.name === 'execute-command' || 
        tc.function?.name === 'execute_command'
      );
      if (execCommand && execCommand.function?.arguments) {
        try {
          const args = typeof execCommand.function.arguments === 'string' 
            ? JSON.parse(execCommand.function.arguments)
            : execCommand.function.arguments;
          if (args.command) return args.command;
        } catch (e) {
          // If arguments parsing fails, continue
        }
      }
    }
  } catch (e) {
    // Not JSON, continue with other checks
  }
  
  // If no XML tags found, check if the content itself is the command
  // This handles cases where the command is passed directly
  if (!contentStr.includes('<execute-command') && !contentStr.includes('</execute-command>')) {
    // Check if it looks like a command (not JSON, not XML)
    if (!contentStr.startsWith('{') && !contentStr.startsWith('<')) {
      // Don't return content that looks like a tool result or error message
      if (!contentStr.includes('ToolResult') && !contentStr.includes('No command')) {
        return contentStr.trim();
      }
    }
  }
  return null;
}

// Helper to extract session name from check-command-output content
export function extractSessionName(content: string | object | undefined | null): string | null {
  const contentStr = normalizeContentToString(content);
  if (!contentStr) return null;
  
  // First try to extract from XML tags (with or without attributes)
  const sessionMatch = contentStr.match(
    /<check-command-output[^>]*session_name=["']([^"']+)["']/,
  );
  if (sessionMatch) {
    return sessionMatch[1].trim();
  }
  
  // Try to find session_name in JSON structure (for native tool calls)
  try {
    const parsed = JSON.parse(contentStr);
    if (parsed.tool_calls && Array.isArray(parsed.tool_calls)) {
      const checkCommand = parsed.tool_calls.find((tc: any) => 
        tc.function?.name === 'check-command-output' || 
        tc.function?.name === 'check_command_output'
      );
      if (checkCommand && checkCommand.function?.arguments) {
        try {
          const args = typeof checkCommand.function.arguments === 'string' 
            ? JSON.parse(checkCommand.function.arguments)
            : checkCommand.function.arguments;
          if (args.session_name) return args.session_name;
        } catch (e) {
          // If arguments parsing fails, continue
        }
      }
    }
  } catch (e) {
    // Not JSON, continue with other checks
  }
  
  // Look for session_name attribute in the content
  const sessionNameMatch = contentStr.match(/session_name=["']([^"']+)["']/);
  if (sessionNameMatch) {
    return sessionNameMatch[1].trim();
  }
  
  return null;
}

// Helper to extract command output from tool result content
export function extractCommandOutput(
  content: string | object | undefined | null,
): string | null {
  const contentStr = normalizeContentToString(content);
  if (!contentStr) return null;

  try {
    // First try to parse the JSON content
    const parsedContent = JSON.parse(contentStr);
    
    // Handle check-command-output specific format
    if (parsedContent.output && typeof parsedContent.output === 'string') {
      return parsedContent.output;
    }
    
    if (parsedContent.content && typeof parsedContent.content === 'string') {
      // Look for a tool_result tag
      const toolResultMatch = parsedContent.content.match(
        /<tool_result>\s*<(?:execute-command|check-command-output)>([\s\S]*?)<\/(?:execute-command|check-command-output)>\s*<\/tool_result>/,
      );
      if (toolResultMatch) {
        return toolResultMatch[1].trim();
      }

      // Look for output field in a ToolResult pattern
      const outputMatch = parsedContent.content.match(
        /ToolResult\(.*?output='([\s\S]*?)'.*?\)/,
      );
      if (outputMatch) {
        return outputMatch[1];
      }

      // Return the content itself as a fallback
      return parsedContent.content;
    }
    
    // If parsedContent is the actual output (new format)
    if (typeof parsedContent === 'string') {
      return parsedContent;
    }
  } catch (e) {
    // If JSON parsing fails, try regex directly
    const toolResultMatch = contentStr.match(
      /<tool_result>\s*<(?:execute-command|check-command-output)>([\s\S]*?)<\/(?:execute-command|check-command-output)>\s*<\/tool_result>/,
    );
    if (toolResultMatch) {
      return toolResultMatch[1].trim();
    }

    const outputMatch = contentStr.match(
      /ToolResult\(.*?output='([\s\S]*?)'.*?\)/,
    );
    if (outputMatch) {
      return outputMatch[1];
    }
    
    // If no special format is found, return the content as-is
    // This handles cases where the output is stored directly
    if (!contentStr.startsWith('<') && !contentStr.includes('ToolResult')) {
      return contentStr;
    }
  }

  return contentStr;
}

// Helper to extract the exit code from tool result
export function extractExitCode(content: string | object | undefined | null): number | null {
  const contentStr = normalizeContentToString(content);
  if (!contentStr) return null;

  try {
    const exitCodeMatch = contentStr.match(/exit_code=(\d+)/);
    if (exitCodeMatch && exitCodeMatch[1]) {
      return parseInt(exitCodeMatch[1], 10);
    }
    return 0; // Assume success if no exit code found but command completed
  } catch (e) {
    return null;
  }
}

// Helper to extract file path from commands
export function extractFilePath(content: string | object | undefined | null): string | null {
  const contentStr = normalizeContentToString(content);
  if (!contentStr) return null;

  try {
    // Try to parse content as JSON first
    const parsedContent = JSON.parse(contentStr);
    if (parsedContent.content) {
      // Check if it's the new XML format
      if (isNewXmlFormat(parsedContent.content)) {
        const toolCalls = parseXmlToolCalls(parsedContent.content);
        if (toolCalls.length > 0 && toolCalls[0].parameters.file_path) {
          return cleanFilePath(toolCalls[0].parameters.file_path);
        }
      }
      
      // Fall back to old format
      const oldFormatMatch = parsedContent.content.match(
        /file_path=["']([^"']+)["']/,
      );
      if (oldFormatMatch) {
        return cleanFilePath(oldFormatMatch[1]);
      }
    }
  } catch (e) {
    // Fall back to direct regex search if JSON parsing fails
  }

  // Check if it's the new XML format in raw content
  if (isNewXmlFormat(contentStr)) {
    const toolCalls = parseXmlToolCalls(contentStr);
    if (toolCalls.length > 0 && toolCalls[0].parameters.file_path) {
      return cleanFilePath(toolCalls[0].parameters.file_path);
    }
  }

  // Direct regex search in the content string (old format)
  const directMatch = contentStr.match(/file_path=["']([^"']+)["']/);
  if (directMatch) {
    return cleanFilePath(directMatch[1]);
  }

  // Handle double-escaped JSON (old format)
  if (typeof content === 'string' && content.startsWith('"{') && content.endsWith('}"')) {
    try {
      // First parse to get the inner JSON string
      const innerString = JSON.parse(content);
      // Then parse the inner string to get the actual object
      const parsed = JSON.parse(innerString);
      if (parsed && typeof parsed === 'object') {
        if (parsed.file_path) {
          return cleanFilePath(parsed.file_path);
        }
        if (parsed.arguments && parsed.arguments.file_path) {
          return cleanFilePath(parsed.arguments.file_path);
        }
      }
    } catch (e) {
      // Continue with normal extraction
    }
  }

  // First, check if content is already a parsed object (new format after double-escape fix)
  if (typeof content === 'object' && content !== null) {
    try {
      // Check if it's a direct object with content field
      if ('content' in content && typeof content.content === 'string') {
        // Look for XML tags in the content string
        const xmlFilePathMatch =
          content.content.match(/<(?:create-file|delete-file|full-file-rewrite|str-replace|edit-file)[^>]*\s+file_path=["']([\s\S]*?)["']/i) ||
          content.content.match(/<edit-file[^>]*\s+target_file=["']([\s\S]*?)["']/i) ||
          content.content.match(/<delete[^>]*\s+file_path=["']([\s\S]*?)["']/i) ||
          content.content.match(/<delete-file[^>]*>([^<]+)<\/delete-file>/i) ||
          content.content.match(/<(?:create-file|delete-file|full-file-rewrite|edit-file)\s+file_path=["']([^"']+)/i) ||
          content.content.match(/<edit-file\s+target_file=["']([^"']+)/i);
        if (xmlFilePathMatch) {
          return cleanFilePath(xmlFilePathMatch[1]);
        }
      }
      
      // Check for direct file_path property
      if ('file_path' in content) {
        return cleanFilePath(content.file_path as string);
      }
      
      // Check for direct target_file property (edit-file tool)
      if ('target_file' in content) {
        return cleanFilePath(content.target_file as string);
      }
      
      // Check for arguments.file_path
      if ('arguments' in content && content.arguments && typeof content.arguments === 'object') {
        const args = content.arguments as any;
        if (args.file_path) {
          return cleanFilePath(args.file_path);
        }
        if (args.target_file) {
          return cleanFilePath(args.target_file);
        }
      }
    } catch (e) {
      // Continue with string parsing if object parsing fails
    }
  }

  // Try parsing as JSON string (old format)
  try {
    const parsedContent = JSON.parse(contentStr);
    if (parsedContent.file_path) {
      return cleanFilePath(parsedContent.file_path);
    }
    if (parsedContent.arguments && parsedContent.arguments.file_path) {
      return cleanFilePath(parsedContent.arguments.file_path);
    }
  } catch (e) {
    // Continue with original content if parsing fails
  }

  // Look for file_path in different formats
  const filePathMatch =
    contentStr.match(/file_path=["']([\s\S]*?)["']/i) ||
    contentStr.match(/target_file=["']([\s\S]*?)["']/i) ||
    contentStr.match(/path=["']([\s\S]*?)["']/i);
  if (filePathMatch) {
    const path = filePathMatch[1].trim();
    // Handle newlines and return first line if multiple lines
    return cleanFilePath(path);
  }

  // Look for file_path in XML-like tags (including incomplete ones for streaming)
  const xmlFilePathMatch =
    contentStr.match(/<(?:create-file|delete-file|full-file-rewrite|str-replace|edit-file)[^>]*\s+file_path=["']([\s\S]*?)["']/i) ||
    contentStr.match(/<edit-file[^>]*\s+target_file=["']([\s\S]*?)["']/i) ||
    contentStr.match(/<delete[^>]*\s+file_path=["']([\s\S]*?)["']/i) ||
    contentStr.match(/<delete-file[^>]*>([^<]+)<\/delete-file>/i) ||
    // Handle incomplete tags during streaming
    contentStr.match(/<(?:create-file|delete-file|full-file-rewrite|edit-file)\s+file_path=["']([^"']+)/i) ||
    contentStr.match(/<edit-file\s+target_file=["']([^"']+)/i);
  if (xmlFilePathMatch) {
    return cleanFilePath(xmlFilePathMatch[1]);
  }

  // Look for file paths in delete operations in particular
  if (
    contentStr.toLowerCase().includes('delete') ||
    contentStr.includes('delete-file')
  ) {
    // Look for patterns like "Deleting file: path/to/file.txt"
    const deletePathMatch = contentStr.match(
      /(?:delete|remove|deleting)\s+(?:file|the file)?:?\s+["']?([\w\-./\\]+\.\w+)["']?/i,
    );
    if (deletePathMatch) return cleanFilePath(deletePathMatch[1]);

    // Look for isolated file paths with extensions
    const fileMatch = contentStr.match(/["']?([\w\-./\\]+\.\w+)["']?/);
    if (fileMatch) return cleanFilePath(fileMatch[1]);
  }

  return null;
}

// Helper to clean and process a file path string, handling escaped chars
function cleanFilePath(path: string): string {
  if (!path) return path;

  // Handle escaped newlines and other escaped characters
  return path
    .replace(/\\n/g, '\n') // Replace \n with actual newlines
    .replace(/\\t/g, '\t') // Replace \t with actual tabs
    .replace(/\\r/g, '') // Remove \r
    .replace(/\\\\/g, '\\') // Replace \\ with \
    .replace(/\\"/g, '"') // Replace \" with "
    .replace(/\\'/g, "'") // Replace \' with '
    .split('\n')[0] // Take only the first line if multiline
    .trim(); // Trim whitespace
}

// Helper to extract str-replace old and new strings
export function extractStrReplaceContent(content: string | object | undefined | null): {
  oldStr: string | null;
  newStr: string | null;
} {
  const contentStr = normalizeContentToString(content);
  if (!contentStr) return { oldStr: null, newStr: null };

  // First try to extract from a str-replace tag with attributes
  const strReplaceMatch = contentStr.match(/<str-replace[^>]*>([\s\S]*?)<\/str-replace>/);
  if (strReplaceMatch) {
    const innerContent = strReplaceMatch[1];
    const oldMatch = innerContent.match(/<old_str>([\s\S]*?)<\/old_str>/);
    const newMatch = innerContent.match(/<new_str>([\s\S]*?)<\/new_str>/);
    
    return {
      oldStr: oldMatch ? oldMatch[1] : null,
      newStr: newMatch ? newMatch[1] : null,
    };
  }

  // Fall back to direct search for old_str and new_str tags
  const oldMatch = contentStr.match(/<old_str>([\s\S]*?)<\/old_str>/);
  const newMatch = contentStr.match(/<new_str>([\s\S]*?)<\/new_str>/);

  return {
    oldStr: oldMatch ? oldMatch[1] : null,
    newStr: newMatch ? newMatch[1] : null,
  };
}

// Helper to extract file content from create-file or file-rewrite
export function extractFileContent(
  content: string | object | undefined | null,
  toolType: 'create-file' | 'full-file-rewrite' | 'edit-file',
): string | null {
  const contentStr = normalizeContentToString(content);
  if (!contentStr) return null;

  try {
    // Try to parse content as JSON first
    const parsedContent = JSON.parse(contentStr);
    if (parsedContent.content) {
      // Check if it's the new XML format
      if (isNewXmlFormat(parsedContent.content)) {
        const toolCalls = parseXmlToolCalls(parsedContent.content);
        if (toolCalls.length > 0 && toolCalls[0].parameters.file_contents) {
          return processFileContent(toolCalls[0].parameters.file_contents);
        }
      }
      
      // Fall back to old format
      const tagName = toolType === 'create-file' ? 'create-file' : toolType === 'edit-file' ? 'edit-file' : 'full-file-rewrite';
      const fileContentMatch = parsedContent.content.match(
        new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'i'),
      );
      if (fileContentMatch) {
        return processFileContent(fileContentMatch[1]);
      }
    }
  } catch (e) {
    // Fall back to direct regex search if JSON parsing fails
  }

  // Check if it's the new XML format in raw content
  if (isNewXmlFormat(contentStr)) {
    const toolCalls = parseXmlToolCalls(contentStr);
    if (toolCalls.length > 0 && toolCalls[0].parameters.file_contents) {
      return processFileContent(toolCalls[0].parameters.file_contents);
    }
  }

  // Direct regex search in the content string (old format)
  const tagName = toolType === 'create-file' ? 'create-file' : toolType === 'edit-file' ? 'edit-file' : 'full-file-rewrite';
  const fileContentMatch = contentStr.match(
    new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'i'),
  );
  if (fileContentMatch) {
    return processFileContent(fileContentMatch[1]);
  }

  return null;
}

function processFileContent(content: string | object): string {
  if (!content) return '';
  if (typeof content === 'object') {
    return JSON.stringify(content, null, 2);
  }

  const trimmedContent = content.trim();
  const isLikelyJson = (trimmedContent.startsWith('{') && trimmedContent.endsWith('}')) ||
                       (trimmedContent.startsWith('[') && trimmedContent.endsWith(']'));
  
  if (isLikelyJson) {
    try {
      const parsed = JSON.parse(content);
      return JSON.stringify(parsed, null, 2);
    } catch (e) {
    }
  }
  return content
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\r/g, '')
    .replace(/\\\\/g, '\\')
    .replace(/\\"/g, '"')
    .replace(/\\'/g, "'");
}

// Helper to determine file type (for syntax highlighting)
export function getFileType(filePath: string): string {
  const extension = filePath.split('.').pop()?.toLowerCase() || '';

  switch (extension) {
    case 'js':
      return 'JavaScript';
    case 'ts':
      return 'TypeScript';
    case 'jsx':
    case 'tsx':
      return 'React';
    case 'py':
      return 'Python';
    case 'html':
      return 'HTML';
    case 'css':
      return 'CSS';
    case 'json':
      return 'JSON';
    case 'md':
      return 'Markdown';
    default:
      return extension.toUpperCase() || 'Text';
  }
}

// Helper to extract URL from browser navigate operations
export function extractBrowserUrl(content: string | object | undefined | null): string | null {
  const contentStr = normalizeContentToString(content);
  if (!contentStr) return null;
  
  const urlMatch = contentStr.match(/url=["'](https?:\/\/[^"']+)["']/);
  return urlMatch ? urlMatch[1] : null;
}

// Helper to extract browser operation type
export function extractBrowserOperation(toolName: string | undefined): string {
  if (!toolName) return 'Browser Operation';

  const operation = toolName.replace('browser_', '').replace(/_/g, ' ');
  return operation.charAt(0).toUpperCase() + operation.slice(1);
}

// Helper to extract search query
export function extractSearchQuery(content: string | object | undefined | null): string | null {
  const contentStr = normalizeContentToString(content);
  if (!contentStr) return null;

  // First, look for ToolResult pattern in the content string
  const toolResultMatch = contentStr.match(
    /ToolResult\(.*?output='([\s\S]*?)'.*?\)/,
  );
  
  if (toolResultMatch) {
    try {
      // Parse the output JSON from ToolResult
      const outputJson = JSON.parse(toolResultMatch[1]);
      
      // Check if this is the new Tavily response format with query field
      if (outputJson.query && typeof outputJson.query === 'string') {
        return outputJson.query;
      }
    } catch (e) {
      // Continue with other extraction methods
    }
  }

  let contentToSearch = contentStr; // Start with the normalized content

  // Try parsing as JSON first
  try {
    const parsedContent = JSON.parse(contentStr);
    
    // Check if it's the new Tavily response format
    if (parsedContent.query && typeof parsedContent.query === 'string') {
      return parsedContent.query;
    }
    
    // Continue with existing logic for backward compatibility
    if (typeof parsedContent.content === 'string') {
      // If the outer content is JSON and has a 'content' string field,
      // use that inner content for searching the query.
      contentToSearch = parsedContent.content;

      // Also check common JSON structures within the outer parsed object itself
      if (typeof parsedContent.query === 'string') {
        return parsedContent.query;
      }
      if (
        typeof parsedContent.arguments === 'object' &&
        parsedContent.arguments !== null &&
        typeof parsedContent.arguments.query === 'string'
      ) {
        return parsedContent.arguments.query;
      }
      if (
        Array.isArray(parsedContent.tool_calls) &&
        parsedContent.tool_calls.length > 0
      ) {
        const toolCall = parsedContent.tool_calls[0];
        if (
          typeof toolCall.arguments === 'object' &&
          toolCall.arguments !== null &&
          typeof toolCall.arguments.query === 'string'
        ) {
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

  // 1. Try regex for attribute within <web-search ...> tag (with or without attributes)
  const xmlQueryMatch = contentToSearch.match(
    /<web-search[^>]*\s+query=[\"']([^\"']*)["'][^>]*>/i,
  );
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
export function extractUrlsAndTitles(
  content: string,
): Array<{ title: string; url: string; snippet?: string }> {
  const results: Array<{ title: string; url: string; snippet?: string }> = [];

  // Try to parse as JSON first to extract proper results
  try {
    const parsed = JSON.parse(content);
    if (Array.isArray(parsed)) {
      return parsed.map(result => ({
        title: result.title || '',
        url: result.url || '',
        snippet: result.content || result.snippet || '',
      }));
    }
    if (parsed.results && Array.isArray(parsed.results)) {
      return parsed.results.map((result: any) => ({
        title: result.title || '',
        url: result.url || '',
        snippet: result.content || '',
      }));
    }
  } catch (e) {
    // Not valid JSON, continue with regex extraction
  }

  // Look for properly formatted JSON objects with title and url
  const jsonObjectPattern = /\{\s*"title"\s*:\s*"([^"]+)"\s*,\s*"url"\s*:\s*"(https?:\/\/[^"]+)"\s*(?:,\s*"content"\s*:\s*"([^"]*)")?\s*\}/g;
  let objectMatch;

  while ((objectMatch = jsonObjectPattern.exec(content)) !== null) {
    const title = objectMatch[1];
    const url = objectMatch[2];
    const snippet = objectMatch[3] || '';

    if (url && title && !results.some((r) => r.url === url)) {
      results.push({ title, url, snippet });
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
      const searchStartIndex =
        protocolEndIndex !== -1 ? protocolEndIndex + 3 : 0;

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
      url = url
        .replace(/<\/?url>$/, '')
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
        try {
          // Try decoding once if double decoding failed
          url = decodeURIComponent(url);
        } catch (e2) {
          console.warn('Failed to decode URL component:', url, e2);
        }
      }

      // Final cleaning for specific problematic sequences like ellipsis or remaining tags
      url = url.replace(/\u2026$/, ''); // Remove trailing ellipsis (…)
      url = url.replace(/<\/?url>$/, '').replace(/<\/?content>$/, ''); // Re-apply tag removal after decode

      // Try to find a title near this URL
      const urlIndex = match.index;
      const surroundingText = content.substring(
        Math.max(0, urlIndex - 100),
        urlIndex + url.length + 200,
      );

      // Look for title patterns more robustly
      const titleMatch =
        surroundingText.match(/title"?\s*:\s*"([^"]+)"/i) ||
        surroundingText.match(/Title[:\s]+([^\n<]+)/i) ||
        surroundingText.match(/\"(.*?)\"[\s\n]*?https?:\/\//);

      let title = cleanUrl(url); // Default to cleaned URL hostname/path
      if (titleMatch && titleMatch[1].trim()) {
        title = titleMatch[1].trim();
      }

      // Avoid adding duplicates if the cleaning resulted in the same URL
      if (url && !results.some((r) => r.url === url)) {
        results.push({
          title: title,
          url: url,
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
    return (
      urlObj.hostname.replace('www.', '') +
      (urlObj.pathname !== '/' ? urlObj.pathname : '')
    );
  } catch (e) {
    return url;
  }
}

// Helper to extract URL for webpage crawling/scraping
export function extractCrawlUrl(content: string | object | undefined | null): string | null {
  const contentStr = normalizeContentToString(content);
  if (!contentStr) return null;

  try {
    // Try to parse content as JSON first (for the new format)
    const parsedContent = JSON.parse(contentStr);
    if (parsedContent.content) {
      // Look for URL in the content string (with or without attributes)
      const urlMatch = parsedContent.content.match(
        /<(?:crawl|scrape)-webpage[^>]*\s+url=["'](https?:\/\/[^"']+)["']/i,
      );
      if (urlMatch) return urlMatch[1];
    }
  } catch (e) {
    // Fall back to direct regex search if JSON parsing fails
  }

  // Direct regex search in the content string (updated to handle attributes)
  const urlMatch =
    contentStr.match(
      /<(?:crawl|scrape)-webpage[^>]*\s+url=["'](https?:\/\/[^"']+)["']/i,
    ) || contentStr.match(/url=["'](https?:\/\/[^"']+)["']/i);

  return urlMatch ? urlMatch[1] : null;
}

// Helper to extract webpage content from crawl/scrape result
export function extractWebpageContent(
  content: string | object | undefined | null,
): { title: string; text: string } | null {
  const contentStr = normalizeContentToString(content);
  if (!contentStr) return null;

  try {
    // Try to parse the JSON content
    const parsedContent = JSON.parse(contentStr);

    // Handle case where content is in parsedContent.content field
    if (parsedContent.content && typeof parsedContent.content === 'string') {
      // Look for tool_result tag (with attributes)
      const toolResultMatch = parsedContent.content.match(
        /<tool_result[^>]*>\s*<(?:crawl|scrape)-webpage[^>]*>([\s\S]*?)<\/(?:crawl|scrape)-webpage>\s*<\/tool_result>/,
      );
      if (toolResultMatch) {
        try {
          // Try to parse the content inside the tags
          const rawData = toolResultMatch[1];

          // Look for ToolResult pattern in the raw data
          const toolResultOutputMatch = rawData.match(
            /ToolResult\(.*?output='([\s\S]*?)'.*?\)/,
          );
          if (toolResultOutputMatch) {
            try {
              // If ToolResult pattern found, try to parse its output which may be a stringified JSON
              const outputJson = JSON.parse(
                toolResultOutputMatch[1]
                  .replace(/\\\\n/g, '\\n')
                  .replace(/\\\\u/g, '\\u'),
              );

              // Handle array format (first item)
              if (Array.isArray(outputJson) && outputJson.length > 0) {
                const item = outputJson[0];
                return {
                  title: item.Title || item.title || '',
                  text: item.Text || item.text || item.content || '',
                };
              }

              // Handle direct object format
              return {
                title: outputJson.Title || outputJson.title || '',
                text:
                  outputJson.Text ||
                  outputJson.text ||
                  outputJson.content ||
                  '',
              };
            } catch (e) {
              // If parsing fails, use the raw output
              return {
                title: 'Webpage Content',
                text: toolResultOutputMatch[1],
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
              text: item.Text || item.text || item.content || '',
            };
          }

          // Handle direct object format
          return {
            title: crawlData.Title || crawlData.title || '',
            text: crawlData.Text || crawlData.text || crawlData.content || '',
          };
        } catch (e) {
          // Fallback to basic text extraction
          return {
            title: 'Webpage Content',
            text: toolResultMatch[1],
          };
        }
      }

      // Handle ToolResult pattern in the content directly
      const toolResultOutputMatch = parsedContent.content.match(
        /ToolResult\(.*?output='([\s\S]*?)'.*?\)/,
      );
      if (toolResultOutputMatch) {
        try {
          // Parse the output which might be a stringified JSON
          const outputJson = JSON.parse(
            toolResultOutputMatch[1]
              .replace(/\\\\n/g, '\\n')
              .replace(/\\\\u/g, '\\u'),
          );

          // Handle array format
          if (Array.isArray(outputJson) && outputJson.length > 0) {
            const item = outputJson[0];
            return {
              title: item.Title || item.title || '',
              text: item.Text || item.text || item.content || '',
            };
          }

          // Handle direct object format
          return {
            title: outputJson.Title || outputJson.title || '',
            text:
              outputJson.Text || outputJson.text || outputJson.content || '',
          };
        } catch (e) {
          // If parsing fails, use the raw output
          return {
            title: 'Webpage Content',
            text: toolResultOutputMatch[1],
          };
        }
      }
    }

    // Direct handling of <crawl-webpage> or <scrape-webpage> format outside of content field (with attributes)
    const webpageMatch = contentStr.match(
      /<(?:crawl|scrape)-webpage[^>]*>([\s\S]*?)<\/(?:crawl|scrape)-webpage>/,
    );
    if (webpageMatch) {
      const rawData = webpageMatch[1];

      // Look for ToolResult pattern
      const toolResultOutputMatch = rawData.match(
        /ToolResult\(.*?output='([\s\S]*?)'.*?\)/,
      );
      if (toolResultOutputMatch) {
        try {
          // Parse the output which might be a stringified JSON
          const outputString = toolResultOutputMatch[1]
            .replace(/\\\\n/g, '\\n')
            .replace(/\\\\u/g, '\\u');
          const outputJson = JSON.parse(outputString);

          // Handle array format
          if (Array.isArray(outputJson) && outputJson.length > 0) {
            const item = outputJson[0];
            return {
              title:
                item.Title ||
                item.title ||
                (item.URL ? new URL(item.URL).hostname : ''),
              text: item.Text || item.text || item.content || '',
            };
          }

          // Handle direct object format
          return {
            title: outputJson.Title || outputJson.title || '',
            text:
              outputJson.Text || outputJson.text || outputJson.content || '',
          };
        } catch (e) {
          // If parsing fails, use the raw output
          return {
            title: 'Webpage Content',
            text: toolResultOutputMatch[1],
          };
        }
      }
    }

    // Direct content extraction from parsed JSON if it's an array
    if (Array.isArray(parsedContent) && parsedContent.length > 0) {
      const item = parsedContent[0];
      return {
        title: item.Title || item.title || '',
        text: item.Text || item.text || item.content || '',
      };
    }

    // Direct content extraction from parsed JSON as object
    if (typeof parsedContent === 'object' && parsedContent !== null) {
      // Check if it's already the webpage data (new format after double-escape fix)
      if ('Title' in parsedContent || 'title' in parsedContent || 'Text' in parsedContent || 'text' in parsedContent) {
      return {
        title: parsedContent.Title || parsedContent.title || 'Webpage Content',
        text:
          parsedContent.Text ||
          parsedContent.text ||
          parsedContent.content ||
            '',
        };
      }
      
      // Otherwise, try to stringify it
      return {
        title: 'Webpage Content',
        text: JSON.stringify(parsedContent),
      };
    }
  } catch (e) {
    // Last resort, try to match the ToolResult pattern directly in the raw content
    const toolResultMatch = contentStr.match(
      /ToolResult\(.*?output='([\s\S]*?)'.*?\)/,
    );
    if (toolResultMatch) {
      try {
        // Try to parse the output which might be a stringified JSON
        const outputJson = JSON.parse(
          toolResultMatch[1].replace(/\\\\n/g, '\\n').replace(/\\\\u/g, '\\u'),
        );

        // Handle array format
        if (Array.isArray(outputJson) && outputJson.length > 0) {
          const item = outputJson[0];
          return {
            title: item.Title || item.title || '',
            text: item.Text || item.text || item.content || '',
          };
        }

        // Handle direct object format
        return {
          title: outputJson.Title || outputJson.title || '',
          text: outputJson.Text || outputJson.text || outputJson.content || '',
        };
      } catch (e) {
        // If parsing fails, use the raw output
        return {
          title: 'Webpage Content',
          text: toolResultMatch[1],
        };
      }
    }

    // If all else fails, return the content as-is
    if (contentStr) {
      return {
        title: 'Webpage Content',
        text: contentStr,
      };
    }
  }

  return null;
}

// Helper to extract search results from tool response
export function extractSearchResults(
  content: string | object | undefined | null,
): Array<{ title: string; url: string; snippet?: string }> {
  const contentStr = normalizeContentToString(content);
  if (!contentStr) return [];

    try {
    // Instead of trying to parse the complex ToolResult JSON, 
    // let's look for the results array pattern directly in the content
    
    // Look for the results array pattern within the content
    const resultsPattern = /"results":\s*\[([^\]]*(?:\[[^\]]*\][^\]]*)*)\]/;
    const resultsMatch = contentStr.match(resultsPattern);
    
    if (resultsMatch) {
      try {
        // Extract just the results array and parse it
        const resultsArrayStr = '[' + resultsMatch[1] + ']';
        const results = JSON.parse(resultsArrayStr);
        
        if (Array.isArray(results)) {
          return results.map(result => ({
            title: result.title || '',
            url: result.url || '',
            snippet: result.content || '',
          }));
        }
      } catch (e) {
        console.warn('Failed to parse results array:', e);
      }
    }
    
    // Fallback: Look for individual result objects
    const resultObjectPattern = /\{\s*"url":\s*"([^"]+)"\s*,\s*"title":\s*"([^"]+)"\s*,\s*"content":\s*"([^"]*)"[^}]*\}/g;
    const results = [];
    let match;
    
    while ((match = resultObjectPattern.exec(contentStr)) !== null) {
      results.push({
        url: match[1],
        title: match[2],
        snippet: match[3],
      });
    }
    
    if (results.length > 0) {
      return results;
    }

    // Try parsing the entire content as JSON (for direct Tavily responses)
    const parsedContent = JSON.parse(contentStr);
    
    // Check if this is the new Tavily response format
    if (parsedContent.results && Array.isArray(parsedContent.results)) {
      return parsedContent.results.map((result: any) => ({
        title: result.title || '',
        url: result.url || '',
        snippet: result.content || '',
      }));
    }
    
    // Continue with existing logic for backward compatibility
    if (parsedContent.content && typeof parsedContent.content === 'string') {
      // Look for a tool_result tag (with attributes)
      const toolResultTagMatch = parsedContent.content.match(
        /<tool_result[^>]*>\s*<web-search[^>]*>([\s\S]*?)<\/web-search>\s*<\/tool_result>/,
      );
      if (toolResultTagMatch) {
        // Try to parse the results array
        try {
          return JSON.parse(toolResultTagMatch[1]);
        } catch (e) {
          // Fallback to regex extraction of URLs and titles
          return extractUrlsAndTitles(toolResultTagMatch[1]);
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
    return extractUrlsAndTitles(contentStr);
  }

  // Last resort fallback
  return extractUrlsAndTitles(contentStr);
}

// Function to determine which tool component to render based on the tool name
export function getToolComponent(toolName: string): string {
  if (!toolName) return 'GenericToolView';

  const normalizedName = toolName.toLowerCase();

  // Map specific tool names to their respective components
  switch (normalizedName) {
    // Browser tools
    case 'browser_navigate_to':
    case 'browser_act':
    case 'browser_extract_content':
    case 'browser_screenshot':
      return 'BrowserToolView';

    // Command execution
    case 'execute-command':
      return 'CommandToolView';

    // File operations
    case 'create-file':
    case 'delete-file':
    case 'full-file-rewrite':
    case 'read-file':
    case 'edit-file':
      return 'FileOperationToolView';

    // String operations
    case 'str-replace':
      return 'StrReplaceToolView';

    // Web operations
    case 'web-search':
      return 'WebSearchToolView';
    case 'image-search':
      return 'WebSearchToolView';
    case 'crawl-webpage':
      return 'WebCrawlToolView';
    case 'scrape-webpage':
      return 'WebScrapeToolView';

    // Data provider operations
    case 'execute-data-provider-call':
    case 'get-data-provider-endpoints':
      return 'DataProviderToolView';

    // MCP operations
    case 'search-mcp-servers':
      return 'SearchMcpServersToolView';
    case 'get-app-details':
      return 'GetAppDetailsToolView';
    case 'create-credential-profile':
      return 'CreateCredentialProfileToolView';
    case 'connect-credential-profile':
      return 'ConnectCredentialProfileToolView';
    case 'check-profile-connection':
      return 'CheckProfileConnectionToolView';
    case 'configure-profile-for-agent':
      return 'ConfigureProfileForAgentToolView';
    case 'get-credential-profiles':
      return 'GetCredentialProfilesToolView';
    case 'get-current-agent-config':
      return 'GetCurrentAgentConfigToolView';

    //Deploy
    case 'deploy':
      return 'DeployToolView';

    // Upload operations
    case 'upload-file':
      return 'UploadFileToolView';
    
    // Docs operations
    case 'create-document':
    case 'update-document':
    case 'read-document':
    case 'list-documents':
    case 'delete-document':
    case 'export-document':
      return 'DocsToolView';

    // Port operations
    case 'expose-port':
      return 'ExposePortToolView';

    // Default
    default:
      return 'GenericToolView';
  }
}

// Helper function to normalize content to string
export function normalizeContentToString(content: string | object | undefined | null): string | null {
  if (!content) return null;
  
  if (typeof content === 'string') {
    // Check if it's a double-escaped JSON string (old format)
    if (content.startsWith('"{') && content.endsWith('}"')) {
      try {
        // First parse to get the inner JSON string
        const innerString = JSON.parse(content);
        // Then parse the inner string to get the actual object
        const parsed = JSON.parse(innerString);
        // Return the content field if it exists
        if (parsed && typeof parsed === 'object' && 'content' in parsed) {
          return parsed.content;
        }
        // Otherwise return the stringified object
        return JSON.stringify(parsed);
      } catch (e) {
        // If parsing fails, return as is
      }
    }
    return content;
  }
  
  if (typeof content === 'object' && content !== null) {
    try {
      // Handle case where content is a parsed object with content field (new format)
      if ('content' in content && typeof content.content === 'string') {
        return content.content;
      } 
      // Handle case where content is a parsed object with content field that's also an object
      else if ('content' in content && typeof content.content === 'object' && content.content !== null) {
        // Check if the nested content has a content field
        if ('content' in content.content && typeof content.content.content === 'string') {
          return content.content.content;
        }
        // Try to stringify nested content object
        return JSON.stringify(content.content);
      }
      // Handle message format {role: 'tool', content: '...'}
      else if ('role' in content && 'content' in content && typeof content.content === 'string') {
        return content.content;
      } 
      // Handle nested message format {role: 'assistant', content: {role: 'assistant', content: '...'}}
      else if ('role' in content && 'content' in content && typeof content.content === 'object' && content.content !== null) {
        if ('content' in content.content && typeof content.content.content === 'string') {
          return content.content.content;
        }
        // Try to stringify nested content object
        return JSON.stringify(content.content);
      } 
      // Handle direct object that might be the content itself (new format)
      else {
        // If it looks like it might contain XML or structured content, stringify it
        const stringified = JSON.stringify(content);
        // Check if the stringified version contains XML tags or other structured content
        if (stringified.includes('<') || stringified.includes('file_path') || stringified.includes('command')) {
          return stringified;
        }
        // Otherwise, try to extract meaningful content
        return stringified;
      }
    } catch (e) {
      console.error('Error in normalizeContentToString:', e, 'Content:', content);
      return null;
    }
  }
  
  return null;
}

// Helper function to extract file content for streaming (handles incomplete XML)
export function extractStreamingFileContent(
  content: string | object | undefined | null,
  toolType: 'create-file' | 'full-file-rewrite' | 'edit-file',
): string | null {
  const contentStr = normalizeContentToString(content);
  if (!contentStr) return null;

  const tagName = toolType === 'create-file' ? 'create-file' : toolType === 'edit-file' ? 'edit-file' : 'full-file-rewrite';
  
  // First check if content is already a parsed object (new format)
  if (typeof content === 'object' && content !== null) {
    try {
      if ('content' in content && typeof content.content === 'string') {
        // Look for the opening tag
        const openTagMatch = content.content.match(new RegExp(`<${tagName}[^>]*>`, 'i'));
        if (openTagMatch) {
          // Find where the tag ends
          const tagEndIndex = content.content.indexOf(openTagMatch[0]) + openTagMatch[0].length;
          // Extract everything after the opening tag
          const afterTag = content.content.substring(tagEndIndex);
          
          // Check if there's a closing tag
          const closeTagMatch = afterTag.match(new RegExp(`<\\/${tagName}>`, 'i'));
          if (closeTagMatch) {
            // Return content between tags
            return processFileContent(afterTag.substring(0, closeTagMatch.index));
          } else {
            // No closing tag yet (streaming), return what we have
            return processFileContent(afterTag);
          }
        }
      }
    } catch (e) {
      // Continue with string parsing
    }
  }

  // Fallback to string-based extraction
  // Look for the opening tag
  const openTagMatch = contentStr.match(new RegExp(`<${tagName}[^>]*>`, 'i'));
  if (openTagMatch) {
    // Find where the tag ends
    const tagEndIndex = contentStr.indexOf(openTagMatch[0]) + openTagMatch[0].length;
    // Extract everything after the opening tag
    const afterTag = contentStr.substring(tagEndIndex);
    
    // Check if there's a closing tag
    const closeTagMatch = afterTag.match(new RegExp(`<\\/${tagName}>`, 'i'));
    if (closeTagMatch) {
      // Return content between tags
      return processFileContent(afterTag.substring(0, closeTagMatch.index));
    } else {
      // No closing tag yet (streaming), return what we have
      return processFileContent(afterTag);
    }
  }

  return null;
}

export const getFileIconAndColor = (filename: string) => {
  const ext = filename.split('.').pop()?.toLowerCase();
  
  switch (ext) {
    case 'js':
    case 'jsx':
    case 'ts':
    case 'tsx':
      return { 
        icon: FileCode, 
        color: 'text-yellow-500 dark:text-yellow-400', 
        bgColor: 'bg-gradient-to-br from-yellow-500/20 to-yellow-600/10 border border-yellow-500/20' 
      };
    case 'py':
      return { 
        icon: FileCode, 
        color: 'text-blue-500 dark:text-blue-400', 
        bgColor: 'bg-gradient-to-br from-blue-500/20 to-blue-600/10 border border-blue-500/20' 
      };
    case 'html':
    case 'css':
    case 'scss':
      return { 
        icon: FileCode, 
        color: 'text-orange-500 dark:text-orange-400', 
        bgColor: 'bg-gradient-to-br from-orange-500/20 to-orange-600/10 border border-orange-500/20' 
      };
    
    // Data files
    case 'json':
      return { 
        icon: FileJson, 
        color: 'text-green-500 dark:text-green-400', 
        bgColor: 'bg-gradient-to-br from-green-500/20 to-green-600/10 border border-green-500/20' 
      };
    case 'csv':
      return { 
        icon: Table, 
        color: 'text-emerald-500 dark:text-emerald-400', 
        bgColor: 'bg-gradient-to-br from-emerald-500/20 to-emerald-600/10 border border-emerald-500/20' 
      };
    case 'xml':
    case 'yaml':
    case 'yml':
      return { 
        icon: FileCode, 
        color: 'text-purple-500 dark:text-purple-400', 
        bgColor: 'bg-gradient-to-br from-purple-500/20 to-purple-600/10 border border-purple-500/20' 
      };
    
    // Image files
    case 'jpg':
    case 'jpeg':
    case 'png':
    case 'gif':
    case 'svg':
    case 'webp':
      return { 
        icon: FileImage, 
        color: 'text-pink-500 dark:text-pink-400', 
        bgColor: 'bg-gradient-to-br from-pink-500/20 to-pink-600/10 border border-pink-500/20' 
      };
    
    // Document files
    case 'md':
    case 'mdx':
      return { 
        icon: FileText, 
        color: 'text-slate-500 dark:text-slate-400', 
        bgColor: 'bg-gradient-to-br from-slate-500/20 to-slate-600/10 border border-slate-500/20' 
      };
    case 'txt':
      return { 
        icon: FileText, 
        color: 'text-zinc-500 dark:text-zinc-400', 
        bgColor: 'bg-gradient-to-br from-zinc-500/20 to-zinc-600/10 border border-zinc-500/20' 
      };
    case 'pdf':
      return { 
        icon: FileType, 
        color: 'text-red-500 dark:text-red-400', 
        bgColor: 'bg-gradient-to-br from-red-500/20 to-red-600/10 border border-red-500/20' 
      };
    
    // Media files
    case 'mp4':
    case 'avi':
    case 'mov':
      return { 
        icon: FileVideo, 
        color: 'text-indigo-500 dark:text-indigo-400', 
        bgColor: 'bg-gradient-to-br from-indigo-500/20 to-indigo-600/10 border border-indigo-500/20' 
      };
    case 'mp3':
    case 'wav':
    case 'ogg':
      return { 
        icon: FileAudio, 
        color: 'text-teal-500 dark:text-teal-400', 
        bgColor: 'bg-gradient-to-br from-teal-500/20 to-teal-600/10 border border-teal-500/20' 
      };
    
    // Archive files
    case 'zip':
    case 'tar':
    case 'gz':
    case 'rar':
      return { 
        icon: FileArchive, 
        color: 'text-amber-500 dark:text-amber-400', 
        bgColor: 'bg-gradient-to-br from-amber-500/20 to-amber-600/10 border border-amber-500/20' 
      };
    
    // Default
    default:
      if (!ext || filename.includes('/')) {
        return { 
          icon: FolderOpen, 
          color: 'text-blue-500 dark:text-blue-400', 
          bgColor: 'bg-gradient-to-br from-blue-500/20 to-blue-600/10 border border-blue-500/20' 
        };
      }
      return { 
        icon: File, 
        color: 'text-zinc-500 dark:text-zinc-400', 
        bgColor: 'bg-gradient-to-br from-zinc-500/20 to-zinc-600/10 border border-zinc-500/20' 
      };
  }
};

/**
 * Extract tool data from content using the new parser with backwards compatibility
 */
export function extractToolData(content: any): {
  toolResult: ParsedToolResult | null;
  arguments: Record<string, any>;
  filePath: string | null;
  fileContent: string | null;
  command: string | null;
  url: string | null;
  query: string | null;
} {
  const toolResult = parseToolResult(content);
  
  if (toolResult) {
    const args = toolResult.arguments || {};
    return {
      toolResult,
      arguments: args,
      filePath: args.file_path || args.path || null,
      fileContent: args.file_contents || args.content || null,
      command: args.command || null,
      url: args.url || null,
      query: args.query || null,
    };
  }

  // Fallback to legacy parsing if new format not detected
  return {
    toolResult: null,
    arguments: {},
    filePath: null,
    fileContent: null,
    command: null,
    url: null,
    query: null,
  };
}