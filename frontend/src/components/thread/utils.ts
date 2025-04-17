import type { ElementType } from 'react';
import { 
  ArrowDown, FileText, Terminal, ExternalLink, User, CheckCircle, CircleDashed,
  FileEdit, Search, Globe, Code, MessageSquare, Folder, FileX, CloudUpload, Wrench, Cog,
  Network, FileSearch, FilePlus
} from 'lucide-react';
import { ApiMessage, RenderItem, ToolSequence, isToolSequence } from './types';

// Flag to control whether tool result messages are rendered
export const SHOULD_RENDER_TOOL_RESULTS = false;

// Helper function to get an icon based on tool name
export const getToolIcon = (toolName: string): ElementType => {
  // Ensure we handle null/undefined toolName gracefully
  if (!toolName) return Cog;
  
  // Convert to lowercase for case-insensitive matching
  const normalizedName = toolName.toLowerCase();
  
  // Check for browser-related tools with a prefix check
  if (normalizedName.startsWith('browser-')) {
    return Globe;
  }
  switch (normalizedName) {
    // File operations
    case 'create-file':
      return FileEdit;
    case 'str-replace':
      return FileSearch;
    case 'full-file-rewrite':
      return FilePlus;
    case 'read-file':
      return FileText;
    
    // Shell commands
    case 'execute-command':
      return Terminal;
    
    // Web operations
    case 'web-search':
      return Search;
    case 'crawl-webpage':
      return Globe;
    
    // API and data operations
    case 'call-data-provider':
      return ExternalLink;
    case 'get-data-provider-endpoints':
      return Network;
    
    // Code operations
    case 'delete-file':
      return FileX;
    
    // Deployment
    case 'deploy-site':
      return CloudUpload;
    
    // Tools and utilities
    case 'execute-code':
      return Code;
    
    // Default case
    default:
      // Add logging for debugging unhandled tool types
      console.log(`[PAGE] Using default icon for unknown tool type: ${toolName}`);
      return Wrench; // Default icon for tools
  }
};

// Helper function to extract a primary parameter from XML/arguments
export const extractPrimaryParam = (toolName: string, content: string | undefined): string | null => {
  if (!content) return null;

  try {
    // Handle browser tools with a prefix check
    if (toolName?.toLowerCase().startsWith('browser-')) {
      // Try to extract URL for navigation
      const urlMatch = content.match(/url=(?:"|')([^"|']+)(?:"|')/);
      if (urlMatch) return urlMatch[1];
      
      // For other browser operations, extract the goal or action
      const goalMatch = content.match(/goal=(?:"|')([^"|']+)(?:"|')/);
      if (goalMatch) {
        const goal = goalMatch[1];
        return goal.length > 30 ? goal.substring(0, 27) + '...' : goal;
      }
      
      return null;
    }
    
    // Simple regex for common parameters - adjust as needed
    let match: RegExpMatchArray | null = null;
    
    switch (toolName?.toLowerCase()) {
      // File operations
      case 'create-file':
      case 'full-file-rewrite':
      case 'read-file':
      case 'delete-file':
      case 'str-replace':
        // Try to match file_path attribute
        match = content.match(/file_path=(?:"|')([^"|']+)(?:"|')/);
        // Return just the filename part
        return match ? match[1].split('/').pop() || match[1] : null;
      
      // Shell commands
      case 'execute-command':
        // Extract command content
        match = content.match(/command=(?:"|')([^"|']+)(?:"|')/);
        if (match) {
          const cmd = match[1];
          return cmd.length > 30 ? cmd.substring(0, 27) + '...' : cmd;
        }
        return null;
      
      // Web search
      case 'web-search':
        match = content.match(/query=(?:"|')([^"|']+)(?:"|')/);
        return match ? (match[1].length > 30 ? match[1].substring(0, 27) + '...' : match[1]) : null;
      
      // Data provider operations
      case 'call-data-provider':
        match = content.match(/service_name=(?:"|')([^"|']+)(?:"|')/);
        const route = content.match(/route=(?:"|')([^"|']+)(?:"|')/);
        return match && route ? `${match[1]}/${route[1]}` : (match ? match[1] : null);
      
      // Deployment
      case 'deploy-site':
        match = content.match(/site_name=(?:"|')([^"|']+)(?:"|')/);
        return match ? match[1] : null;
    }
    
    return null;
  } catch (e) {
    console.warn("Error parsing tool parameters:", e);
    return null;
  }
};

// Function to group consecutive assistant tool call / user tool result pairs
export function groupMessages(messages: ApiMessage[]): RenderItem[] {
  const grouped: RenderItem[] = [];
  let i = 0;

  while (i < messages.length) {
    const currentMsg = messages[i];
    const nextMsg = i + 1 < messages.length ? messages[i + 1] : null;

    let currentSequence: ApiMessage[] = [];

    // Check if current message is the start of a potential sequence
    if (currentMsg.role === 'assistant') {
      // Regex to find the first XML-like tag: <tagname ...> or <tagname> or self-closing tags
      const toolTagMatch = currentMsg.content?.match(/<(?!inform\b)([a-zA-Z\-_]+)(?:\s+[^>]*)?(?:\/)?>/);
      if (toolTagMatch && nextMsg && nextMsg.role === 'user') {
        const expectedTag = toolTagMatch[1];

        // Regex to check for <tool_result><tagname>...</tagname></tool_result>
        // Also handle self-closing tags in the response
        const toolResultRegex = new RegExp(`^<tool_result>\\s*<(${expectedTag})(?:\\s+[^>]*)?(?:/>|>[\\s\\S]*?</\\1>)\\s*</tool_result>`);

        if (nextMsg.content?.match(toolResultRegex)) {
          // Found a pair, start a sequence
          currentSequence.push(currentMsg);
          currentSequence.push(nextMsg);
          i += 2; // Move past this pair

          // Check for continuation
          while (i < messages.length) {
            const potentialAssistant = messages[i];
            const potentialUser = i + 1 < messages.length ? messages[i + 1] : null;

            if (potentialAssistant.role === 'assistant') {
              const nextToolTagMatch = potentialAssistant.content?.match(/<(?!inform\b)([a-zA-Z\-_]+)(?:\s+[^>]*)?(?:\/)?>/);
              if (nextToolTagMatch && potentialUser && potentialUser.role === 'user') {
                const nextExpectedTag = nextToolTagMatch[1];

                // Also handle self-closing tags in the response
                const nextToolResultRegex = new RegExp(`^<tool_result>\\s*<(${nextExpectedTag})(?:\\s+[^>]*)?(?:/>|>[\\s\\S]*?</\\1>)\\s*</tool_result>`);

                if (potentialUser.content?.match(nextToolResultRegex)) {
                  // Sequence continues
                  currentSequence.push(potentialAssistant);
                  currentSequence.push(potentialUser);
                  i += 2; // Move past the added pair
                } else {
                  // Assistant/User message, but not a matching tool result pair - break sequence
                  break;
                }
              } else {
                // Assistant message without tool tag, or no following user message - break sequence
                break;
              }
            } else {
              // Not an assistant message - break sequence
              break;
            }
          }
          // Add the completed sequence to grouped results
          grouped.push({ type: 'tool_sequence', items: currentSequence });
          continue; // Continue the outer loop from the new 'i'
        }
      }
    }

    // If no sequence was started or continued, add the current message normally
    if (currentSequence.length === 0) {
       grouped.push(currentMsg);
       i++; // Move to the next message
    }
  }
  return grouped;
} 