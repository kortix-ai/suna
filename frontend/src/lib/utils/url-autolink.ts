/**
 * URL Auto-linking Utility
 * 
 * Detects plain URLs (with or without protocol) and converts them to markdown links.
 * Handles patterns like:
 * - github.com/kubet/mk-blog
 * - https://github.com/kubet/mk-blog
 * - www.example.com
 * - example.com/path
 */

/**
 * Regex pattern to detect URLs
 * Matches:
 * - URLs with protocol (http://, https://)
 * - URLs without protocol but with common TLDs (github.com, example.org)
 * - URLs starting with www.
 * - Email addresses
 */
const URL_PATTERN = /(?:https?:\/\/)?(?:www\.)?[-a-zA-Z0-9@:%._\+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b(?:[-a-zA-Z0-9()@:%_\+.~#?&\/=]*)/g;

/**
 * Email pattern
 */
const EMAIL_PATTERN = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

/**
 * Checks if a string looks like a valid URL
 */
function isValidUrl(url: string): boolean {
  // Skip if it's already inside markdown link syntax
  if (url.includes('](') || url.includes(')[')) {
    return false;
  }
  
  // Skip if it's inside code blocks or inline code
  // (This is a simple check - more sophisticated parsing would be needed for nested cases)
  
  // Must have at least one dot and a valid TLD
  const hasValidTld = /\.(com|org|net|io|dev|co|uk|de|fr|it|es|jp|cn|in|br|au|ca|us|gov|edu|mil|int|xyz|info|app|tech|online|site|website|store|shop|blog|news|tv|me|cc|ws|name|mobi|asia|tel|travel|jobs|pro|museum|coop|aero|arpa|biz|cat|jobs|post|tel|xxx|ac|ad|ae|af|ag|ai|al|am|ao|aq|ar|as|at|aw|ax|az|ba|bb|bd|be|bf|bg|bh|bi|bj|bm|bn|bo|br|bs|bt|bv|bw|by|bz|ca|cc|cd|cf|cg|ch|ci|ck|cl|cm|cn|co|cr|cu|cv|cw|cx|cy|cz|de|dj|dk|dm|do|dz|ec|ee|eg|eh|er|es|et|eu|fi|fj|fk|fm|fo|fr|ga|gb|gd|ge|gf|gg|gh|gi|gl|gm|gn|gp|gq|gr|gs|gt|gu|gw|gy|hk|hm|hn|hr|ht|hu|id|ie|il|im|in|io|iq|ir|is|it|je|jm|jo|jp|ke|kg|kh|ki|km|kn|kp|kr|kw|ky|kz|la|lb|lc|li|lk|lr|ls|lt|lu|lv|ly|ma|mc|md|me|mg|mh|mk|ml|mm|mn|mo|mp|mq|mr|ms|mt|mu|mv|mw|mx|my|mz|na|nc|ne|nf|ng|ni|nl|no|np|nr|nu|nz|om|pa|pe|pf|pg|ph|pk|pl|pm|pn|pr|ps|pt|pw|py|qa|re|ro|rs|ru|rw|sa|sb|sc|sd|se|sg|sh|si|sj|sk|sl|sm|sn|so|sr|ss|st|su|sv|sx|sy|sz|tc|td|tf|tg|th|tj|tk|tl|tm|tn|to|tr|tt|tv|tw|tz|ua|ug|uk|um|us|uy|uz|va|vc|ve|vg|vi|vn|vu|wf|ws|ye|yt|za|zm|zw)(?:\/|$)/i.test(url);
  
  return hasValidTld;
}

/**
 * Normalizes a URL by adding https:// if no protocol is present
 */
function normalizeUrl(url: string): string {
  // Skip if already has protocol
  if (/^https?:\/\//i.test(url)) {
    return url;
  }
  
  // Add https:// for URLs without protocol
  return `https://${url}`;
}

/**
 * Auto-links plain URLs in text by converting them to markdown links
 * 
 * @param text - The text to process
 * @returns Text with plain URLs converted to markdown links
 * 
 * @example
 * autoLinkUrls("Check out github.com/kubet/mk-blog")
 * // Returns: "Check out [github.com/kubet/mk-blog](https://github.com/kubet/mk-blog)"
 */
export function autoLinkUrls(text: string): string {
  if (!text || typeof text !== 'string') {
    return text;
  }

  let result = text;
  
  // First, handle emails - collect matches first to avoid index issues
  const emailMatches: Array<{ email: string; index: number }> = [];
  let emailMatch;
  EMAIL_PATTERN.lastIndex = 0;
  
  while ((emailMatch = EMAIL_PATTERN.exec(result)) !== null) {
    const email = emailMatch[0];
    const index = emailMatch.index;
    
    // Skip if already in markdown link
    const beforeMatch = result.substring(0, index);
    const afterMatch = result.substring(index + email.length);
    
    if (!beforeMatch.endsWith('](') && !afterMatch.startsWith(')')) {
      emailMatches.push({ email, index });
    }
  }
  
  // Replace emails in reverse order to preserve indices
  for (let i = emailMatches.length - 1; i >= 0; i--) {
    const { email, index } = emailMatches[i];
    result = result.substring(0, index) + `[${email}](mailto:${email})` + result.substring(index + email.length);
  }
  
  // Then handle URLs - collect matches first to avoid index issues
  const urlMatches: Array<{ url: string; index: number }> = [];
  let urlMatch;
  URL_PATTERN.lastIndex = 0;
  
  while ((urlMatch = URL_PATTERN.exec(result)) !== null) {
    const url = urlMatch[0];
    const index = urlMatch.index;
    
    // Skip if it's an email (already handled)
    if (EMAIL_PATTERN.test(url)) {
      continue;
    }
    
    // Skip if already in markdown link
    const beforeMatch = result.substring(0, index);
    const afterMatch = result.substring(index + url.length);
    
    if (beforeMatch.endsWith('](') || afterMatch.startsWith(')')) {
      continue;
    }
    
    // Skip if it's inside code blocks (simple check)
    const codeBlockOpen = (beforeMatch.match(/```/g) || []).length;
    if (codeBlockOpen % 2 !== 0) {
      continue; // Inside code block
    }
    
    // Skip inline code (between backticks)
    const lastBacktick = beforeMatch.lastIndexOf('`');
    if (lastBacktick !== -1) {
      const afterLastBacktick = result.substring(lastBacktick + 1);
      const nextBacktick = afterLastBacktick.indexOf('`');
      if (nextBacktick !== -1 && nextBacktick > index - lastBacktick - 1) {
        continue; // Inside inline code
      }
    }
    
    if (isValidUrl(url)) {
      urlMatches.push({ url, index });
    }
  }
  
  // Replace URLs in reverse order to preserve indices
  for (let i = urlMatches.length - 1; i >= 0; i--) {
    const { url, index } = urlMatches[i];
    const normalizedUrl = normalizeUrl(url);
    result = result.substring(0, index) + `[${url}](${normalizedUrl})` + result.substring(index + url.length);
  }
  
  return result;
}

