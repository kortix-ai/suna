/**
 * Content preprocessing utilities
 * Handles XML tag stripping and text-only tool extraction
 */

import { HIDE_STREAMING_XML_TAGS } from './display-names';

/**
 * Preprocess content to extract text from ask/complete tools
 * Removes XML wrapper for text-only ask/complete calls (when no attachments)
 */
export function preprocessTextOnlyTools(content: string): string {
  if (!content || typeof content !== 'string') {
    return content || '';
  }

  // New format: <function_calls><invoke name="ask">...</invoke></function_calls>
  content = content.replace(/<function_calls>\s*<invoke name="ask">\s*<parameter name="text">([\s\S]*?)<\/parameter>\s*<\/invoke>\s*<\/function_calls>/gi, (match) => {
    if (match.includes('<parameter name="attachments"')) return match;
    return match.replace(/<function_calls>\s*<invoke name="ask">\s*<parameter name="text">([\s\S]*?)<\/parameter>\s*<\/invoke>\s*<\/function_calls>/gi, '$1');
  });

  content = content.replace(/<function_calls>\s*<invoke name="complete">\s*<parameter name="text">([\s\S]*?)<\/parameter>\s*<\/invoke>\s*<\/function_calls>/gi, (match) => {
    if (match.includes('<parameter name="attachments"')) return match;
    return match.replace(/<function_calls>\s*<invoke name="complete">\s*<parameter name="text">([\s\S]*?)<\/parameter>\s*<\/invoke>\s*<\/function_calls>/gi, '$1');
  });

  // Handle incomplete/streaming ask tags
  content = content.replace(/<function_calls>\s*<invoke name="ask">\s*<parameter name="text">([\s\S]*?)$/gi, (match) => {
    if (match.includes('<parameter name="attachments"')) return match;
    return match.replace(/<function_calls>\s*<invoke name="ask">\s*<parameter name="text">([\s\S]*?)$/gi, '$1');
  });

  content = content.replace(/<function_calls>\s*<invoke name="complete">\s*<parameter name="text">([\s\S]*?)$/gi, (match) => {
    if (match.includes('<parameter name="attachments"')) return match;
    return match.replace(/<function_calls>\s*<invoke name="complete">\s*<parameter name="text">([\s\S]*?)$/gi, '$1');
  });

  // Old format: <ask>...</ask> or <complete>...</complete>
  content = content.replace(/<ask[^>]*>([\s\S]*?)<\/ask>/gi, (match) => {
    if (match.match(/<ask[^>]*attachments=/i)) return match;
    return match.replace(/<ask[^>]*>([\s\S]*?)<\/ask>/gi, '$1');
  });

  content = content.replace(/<complete[^>]*>([\s\S]*?)<\/complete>/gi, (match) => {
    if (match.match(/<complete[^>]*attachments=/i)) return match;
    return match.replace(/<complete[^>]*>([\s\S]*?)<\/complete>/gi, '$1');
  });
  
  return content;
}

/**
 * Strip XML tags from content, preserving HTML tags
 */
export function stripXMLTags(content: string): string {
  if (!content || typeof content !== 'string') return '';
  
  let cleaned = content;
  
  // Remove function_calls wrapper
  cleaned = cleaned.replace(/<function_calls>[\s\S]*?<\/function_calls>/gi, '');
  
  // Remove tool XML tags but preserve HTML tags
  const htmlTags = 'br|p|div|span|strong|em|ul|ol|li|a|code|pre|h[1-6]|blockquote|img';
  cleaned = cleaned.replace(
    new RegExp(`<(?!${htmlTags})([a-zA-Z\\-_]+)(?:\\s+[^>]*)?>(?:[\\s\\S]*?)<\\/\\1>`, 'g'),
    ''
  );
  
  // Remove self-closing tags (except br and img)
  cleaned = cleaned.replace(
    new RegExp(`<(?!br|img)([a-zA-Z\\-_]+)(?:\\s+[^>]*)?\\/>`, 'g'),
    ''
  );
  
  // Normalize multiple newlines
  return cleaned.replace(/\n\n\n+/g, '\n\n').trim();
}

/**
 * Detect and strip partial XML from streaming content
 * Returns content up to the first incomplete XML tag
 */
export function detectAndStripPartialXML(content: string): string {
  if (!content || typeof content !== 'string') return content;
  
  // If we see a complete function_calls tag, strip everything from there
  if (content.includes('<function_calls>')) {
    const index = content.indexOf('<function_calls>');
    return content.substring(0, index).trim();
  }
  
  // Check for incomplete XML tags at the end
  const partialXmlMatch = content.match(/<[a-zA-Z_:][a-zA-Z0-9_:]*$|<$/);
  if (partialXmlMatch && partialXmlMatch.index !== undefined) {
    return content.substring(0, partialXmlMatch.index).trim();
  }
  
  // Check for known streaming XML tags
  for (const tag of HIDE_STREAMING_XML_TAGS) {
    const openingTagPattern = `<${tag}`;
    const index = content.indexOf(openingTagPattern);
    if (index !== -1) {
      return content.substring(0, index).trim();
    }
  }
  
  return content;
}

/**
 * Extract streaming content from XML tool call
 * Looks for common parameter names (text, content, data, etc.)
 */
export function extractStreamingContent(content: string, toolName: string): string {
  if (!content || typeof content !== 'string') return '';
  
  const commonParams = ['text', 'content', 'data', 'config', 'description', 'prompt', 'command', 'file_contents'];
  
  for (const param of commonParams) {
    const match = content.match(new RegExp(`<parameter\\s+name=["']${param}["']>([\\s\\S]*?)(<\\/parameter>|$)`, 'i'));
    if (match && match[1]) {
      return match[1].trim();
    }
  }
  
  // Fallback: strip all XML tags
  const cleaned = content
    .replace(/<function_calls[^>]*>/gi, '')
    .replace(/<\/function_calls>/gi, '')
    .replace(/<invoke[^>]*>/gi, '')
    .replace(/<\/invoke>/gi, '')
    .replace(/<\/?parameter[^>]*>/gi, '');
  
  return cleaned.trim();
}

