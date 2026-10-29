import type { ArtifactCommentAnchor } from '@kortix/sdk';

export function artifactCommentAnchor(version: string, options: { quote?: string; selector?: string }, text = ''): ArtifactCommentAnchor {
  if (options.quote !== undefined && options.selector !== undefined) throw new Error('Use --quote or --selector, not both.');
  if (options.selector !== undefined) {
    if (!options.selector.trim() || options.selector.length > 2048 || /[\u0000\uD800-\uDFFF]/u.test(options.selector)) throw new Error('--selector must contain 1–2048 valid characters.');
    return { type: 'point', version, selector: options.selector, snippet: '', offset: { x: 0.5, y: 0.5 }, viewport_width: 1280, scroll: { x: 0, y: 0 } };
  }
  if (options.quote === undefined) return { type: 'none', version };
  const quote = options.quote;
  if (!quote || quote.length > 32 || /[\u0000\uD800-\uDFFF]/u.test(quote)) throw new Error('--quote must contain 1–32 valid characters.');
  const start = text.indexOf(quote);
  if (start < 0) throw new Error('quote not found in the current saved version');
  let prefix = text.slice(Math.max(0, start - 32), start);
  let suffix = text.slice(start + quote.length, start + quote.length + 32);
  if (/^[\uDC00-\uDFFF]/.test(prefix)) prefix = prefix.slice(1);
  if (/[\uD800-\uDBFF]$/.test(suffix)) suffix = suffix.slice(0, -1);
  return { type: 'text', version, quote, prefix, suffix };
}
