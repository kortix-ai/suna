import type { ElementType } from 'react';
import { 
  ArrowDown, FileText, Terminal, ExternalLink, User, CheckCircle, CircleDashed,
  FileEdit, Search, Globe, Code, MessageSquare, Folder, FileX, CloudUpload, Wrench, Cog,
  Network, FileSearch, FilePlus
} from 'lucide-react';

// Flag to control whether tool result messages are rendered
export const SHOULD_RENDER_TOOL_RESULTS = false;

// Helper function to safely parse JSON strings from content/metadata
export function safeJsonParse<T>(jsonString: string | undefined | null, fallback: T): T {
  if (!jsonString) {
    return fallback;
  }
  try {
    return JSON.parse(jsonString);
  } catch (e) {
    // console.warn('Failed to parse JSON string:', jsonString, e); // Optional: log errors
    return fallback;
  }
}

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
    
    // Special handling for XML content - extract file_path from the actual attributes
    if (content.startsWith('<') && content.includes('>')) {
      const xmlAttrs = content.match(/<[^>]+\s+([^>]+)>/);
      if (xmlAttrs && xmlAttrs[1]) {
        const attrs = xmlAttrs[1].trim();
        const filePathMatch = attrs.match(/file_path=["']([^"']+)["']/);
        if (filePathMatch) {
          return filePathMatch[1].split('/').pop() || filePathMatch[1];
        }
        
        // Try to get command for execute-command
        if (toolName?.toLowerCase() === 'execute-command') {
          const commandMatch = attrs.match(/(?:command|cmd)=["']([^"']+)["']/);
          if (commandMatch) {
            const cmd = commandMatch[1];
            return cmd.length > 30 ? cmd.substring(0, 27) + '...' : cmd;
          }
        }
      }
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