/**
 * Tool name formatting utilities
 * Converts tool identifiers to human-readable display names
 */

import { TOOL_DISPLAY_NAMES, TOOL_COMPLETED_NAMES } from './display-names';

/**
 * Server name mappings for MCP tools
 */
const MCP_SERVER_NAMES: Record<string, string> = {
  'exa': 'Exa Search',
  'github': 'GitHub',
  'notion': 'Notion',
  'slack': 'Slack',
  'filesystem': 'File System',
  'memory': 'Memory',
  'anthropic': 'Anthropic',
  'openai': 'OpenAI',
  'composio': 'Composio',
  'langchain': 'LangChain',
  'llamaindex': 'LlamaIndex',
};

/**
 * Known MCP server names for detection
 */
const KNOWN_MCP_SERVERS = new Set([
  'exa', 'github', 'notion', 'slack', 'filesystem', 
  'memory', 'anthropic', 'openai', 'composio', 
  'langchain', 'llamaindex'
]);

/**
 * Format an MCP tool name for display
 * Converts "mcp_serverName_toolName" to "Server Name: Tool Name"
 * 
 * @param serverName - The MCP server name
 * @param toolName - The tool name within the server
 * @returns Formatted display name
 */
export function formatMCPToolName(serverName: string, toolName: string): string {
  const formattedServerName = MCP_SERVER_NAMES[serverName.toLowerCase()] || 
    serverName.charAt(0).toUpperCase() + serverName.slice(1);
  
  let formattedToolName = toolName;
  
  if (toolName.includes('-')) {
    formattedToolName = toolName
      .split('-')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  } else if (toolName.includes('_')) {
    formattedToolName = toolName
      .split('_')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  } else if (/[a-z][A-Z]/.test(toolName)) {
    // camelCase to Title Case
    formattedToolName = toolName
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .split(' ')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  } else {
    formattedToolName = toolName.charAt(0).toUpperCase() + toolName.slice(1);
  }
  
  return `${formattedServerName}: ${formattedToolName}`;
}

/**
 * Get a user-friendly display name for a tool
 * 
 * @param toolName - The tool identifier (can be kebab-case, snake_case, or MCP format)
 * @returns Human-readable display name
 */
export function getUserFriendlyToolName(toolName: string): string {
  if (!toolName) return 'Unknown Tool';
  
  // Handle MCP tools: mcp_serverName_toolName
  if (toolName.startsWith('mcp_')) {
    const parts = toolName.split('_');
    if (parts.length >= 3) {
      const serverName = parts[1];
      const toolNamePart = parts.slice(2).join('_');
      return formatMCPToolName(serverName, toolNamePart);
    }
  }
  
  // Handle MCP tools in kebab-case: serverName-toolName (if not in display names map)
  if (toolName.includes('-') && !TOOL_DISPLAY_NAMES.has(toolName)) {
    const parts = toolName.split('-');
    if (parts.length >= 2) {
      const serverName = parts[0];
      const toolNamePart = parts.slice(1).join('-');
      // Only format as MCP if it looks like an MCP tool
      if (KNOWN_MCP_SERVERS.has(serverName.toLowerCase()) || serverName === serverName.toLowerCase()) {
        return formatMCPToolName(serverName, toolNamePart);
      }
    }
  }
  
  // Return mapped display name or the tool name itself
  return TOOL_DISPLAY_NAMES.get(toolName) || toolName;
}

/**
 * Get a completed/past-tense display name for a tool
 * Falls back to the regular display name if no completed name exists
 * 
 * @param toolName - The tool identifier
 * @returns Human-readable completed display name
 */
export function getCompletedToolName(toolName: string): string {
  if (!toolName) return 'Unknown Tool';
  
  const completedName = TOOL_COMPLETED_NAMES.get(toolName);
  if (completedName) return completedName;
  
  return getUserFriendlyToolName(toolName);
}

/**
 * Extract app slug from a Composio tool call
 * 
 * @param toolCall - The tool call object
 * @returns The app slug, or null if not found
 */
export function extractAppSlugFromToolCall(toolCall: any): string | null {
  if (!toolCall) return null;

  // Check for explicit app filter
  if (toolCall._app_filter) {
    const filter = toolCall._app_filter;
    const appName = filter.split(' ')[0].toLowerCase();
    if (appName) return appName;
  }

  // Check for Composio custom type
  if (toolCall.custom_type === 'composio' || toolCall.customType === 'composio' || toolCall.isComposio) {
    const slug = toolCall.toolkit_slug || toolCall.toolkitSlug || toolCall.config?.toolkit_slug;
    if (slug) return slug;
  }

  // Check qualified name
  const qualifiedName = toolCall.mcp_qualified_name || toolCall.qualifiedName || toolCall.function_name;
  if (qualifiedName && qualifiedName.startsWith('composio.')) {
    return qualifiedName.substring(9);
  }

  if (qualifiedName && qualifiedName.includes('_COMPOSIO_')) {
    const parts = qualifiedName.split('_COMPOSIO_');
    if (parts.length > 1) {
      return parts[1].split('_')[0];
    }
  }

  // Check function name for known apps
  if (toolCall.function_name) {
    const functionName = toolCall.function_name;
    
    const knownApps = [
      'TWITTER', 'GITHUB', 'SLACK', 'GMAIL', 'GOOGLE', 'NOTION', 'ASANA', 'JIRA',
      'TRELLO', 'DISCORD', 'LINKEDIN', 'FACEBOOK', 'INSTAGRAM', 'YOUTUBE', 'SPOTIFY',
      'DROPBOX', 'ONEDRIVE', 'SALESFORCE', 'HUBSPOT', 'ZENDESK', 'INTERCOM', 'MAILCHIMP',
      'STRIPE', 'PAYPAL', 'TWILIO', 'SENDGRID', 'AIRTABLE', 'MONDAY', 'CLICKUP',
      'FIGMA', 'MIRO', 'SHOPIFY', 'WOOCOMMERCE', 'WORDPRESS', 'MEDIUM', 'REDDIT',
      'TELEGRAM', 'WHATSAPP', 'ZOOM', 'CALENDAR', 'DRIVE', 'SHEETS', 'DOCS', 'SLIDES'
    ];
    
    for (const app of knownApps) {
      if (functionName.startsWith(app + '_')) {
        return app.toLowerCase();
      }
    }
    
    // Check if function name starts with an uppercase word (likely app name)
    const parts = functionName.split('_');
    if (parts.length >= 2 && parts[0].length > 0 && parts[0] === parts[0].toUpperCase()) {
      return parts[0].toLowerCase();
    }
  }

  return null;
}

