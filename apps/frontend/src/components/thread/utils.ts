/**
 * Thread utilities for rendering tool calls and messages
 * Re-exports from @agentpress/shared plus frontend-specific utilities
 */

// Re-export shared utilities
export { 
  safeJsonParse,
  getUserFriendlyToolName,
  getCompletedToolName,
  extractAppSlugFromToolCall,
  HIDE_STREAMING_XML_TAGS,
} from '@agentpress/shared';

// Re-export getToolIcon from frontend icon resolver
export { getToolIcon } from '@/lib/icons/tool-icons';

// Frontend-specific flags
export const SHOULD_RENDER_TOOL_RESULTS = false;
export const HIDE_BROWSER_TAB = true;

/**
 * Extract a primary parameter from tool call arguments for display
 * Frontend-specific implementation
 */
export const extractPrimaryParam = (
  toolName: string,
  content: string | undefined,
): string | null => {
  if (!content) return null;

  try {
    const parsed = JSON.parse(content);
    
    if (parsed.query) {
      const query = Array.isArray(parsed.query) ? parsed.query[0] : parsed.query;
      return query.length > 30 ? query.substring(0, 27) + '...' : query;
    }
    if (parsed.arguments?.query) {
      const query = Array.isArray(parsed.arguments.query) ? parsed.arguments.query[0] : parsed.arguments.query;
      return query.length > 30 ? query.substring(0, 27) + '...' : query;
    }
    
    if (toolName?.toLowerCase().startsWith('browser_')) {
      if (parsed.url) return parsed.url;
      if (parsed.arguments?.url) return parsed.arguments.url;
      if (parsed.goal) {
        const goal = parsed.goal;
        return goal.length > 30 ? goal.substring(0, 27) + '...' : goal;
      }
      return null;
    }

    if (parsed.file_path) {
      const path = parsed.file_path;
      return typeof path === 'string' ? path.split('/').pop() || path : null;
    }
    if (parsed.arguments?.file_path) {
      const path = parsed.arguments.file_path;
      return typeof path === 'string' ? path.split('/').pop() || path : null;
    }

    if (toolName?.toLowerCase() === 'execute-command') {
      if (parsed.command) {
        const cmd = parsed.command;
        return cmd.length > 30 ? cmd.substring(0, 27) + '...' : cmd;
      }
      if (parsed.arguments?.command) {
        const cmd = parsed.arguments.command;
        return cmd.length > 30 ? cmd.substring(0, 27) + '...' : cmd;
      }
    }
  } catch {
    // Fallback to regex extraction
  }

  // Regex fallback for plain text content
  try {
    if (toolName?.toLowerCase().startsWith('browser_')) {
      const urlMatch = content.match(/url["']?\s*[:=]\s*["']?([^"'\s]+)/i);
      if (urlMatch) return urlMatch[1];

      const goalMatch = content.match(/goal["']?\s*[:=]\s*["']?([^"'\s]+)/i);
      if (goalMatch) {
        const goal = goalMatch[1];
        return goal.length > 30 ? goal.substring(0, 27) + '...' : goal;
      }
      return null;
    }

    const filePathMatch = content.match(/file_path["']?\s*[:=]\s*["']?([^"'\s]+)/i);
    if (filePathMatch) {
      const path = filePathMatch[1];
      return path.split('/').pop() || path;
    }

    if (toolName?.toLowerCase() === 'execute-command') {
      const commandMatch = content.match(/(?:command|cmd)["']?\s*[:=]\s*["']?([^"'\n]+)/i);
      if (commandMatch) {
        const cmd = commandMatch[1];
        return cmd.length > 30 ? cmd.substring(0, 27) + '...' : cmd;
      }
    }
  } catch {
    // Continue
  }

  // Tool-specific extraction
  let match: RegExpMatchArray | null = null;

  switch (toolName?.toLowerCase()) {
    case 'create-file':
    case 'full-file-rewrite':
    case 'read-file':
    case 'delete-file':
    case 'str-replace':
      match = content.match(/file_path["']?\s*[:=]\s*["']?([^"'\s]+)/i);
      return match ? match[1].split('/').pop() || match[1] : null;
    case 'edit-file':
      match = content.match(/target_file["']?\s*[:=]\s*["']?([^"'\s]+)/i);
      return match ? (match[1].split('/').pop() || match[1]).trim() : null;

    case 'execute-command':
      match = content.match(/(?:command|cmd)["']?\s*[:=]\s*["']?([^"'\n]+)/i);
      if (match) {
        const cmd = match[1];
        return cmd.length > 30 ? cmd.substring(0, 27) + '...' : cmd;
      }
      return null;

    case 'web-search':
    case 'image-search':
      match = content.match(/query["']?\s*[:=]\s*["']?([^"'\s]+)/i);
      return match
        ? match[1].length > 30
          ? match[1].substring(0, 27) + '...'
          : match[1]
        : null;

    case 'call-data-provider':
      match = content.match(/service_name["']?\s*[:=]\s*["']?([^"'\s]+)/i);
      const route = content.match(/route["']?\s*[:=]\s*["']?([^"'\s]+)/i);
      return match && route
        ? `${match[1]}/${route[1]}`
        : match
          ? match[1]
          : null;
  }

  return null;
};
