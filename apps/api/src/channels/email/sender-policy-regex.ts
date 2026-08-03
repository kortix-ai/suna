import { RE2JS } from 're2js';

/**
 * Sender patterns are customer-controlled and run on every inbound email.
 * Keep both storage validation and webhook execution on the same linear-time
 * RE2-compatible engine; JavaScript's backtracking RegExp engine can hang on
 * patterns such as `^(a{1,3})+$` and `^(a|aa)+$`.
 */
export const MAX_EMAIL_SENDER_REGEX_LENGTH = 256;

const COMPILED_REGEX_CACHE_LIMIT = 256;
const compiledRegexCache = new Map<string, RE2JS | null>();

export class EmailSenderRegexError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmailSenderRegexError';
  }
}

export function compileEmailSenderRegex(pattern: string): RE2JS {
  if (!pattern) throw new EmailSenderRegexError('Email sender regex is required');
  if (pattern.length > MAX_EMAIL_SENDER_REGEX_LENGTH) {
    throw new EmailSenderRegexError(
      `Email sender regex must be at most ${MAX_EMAIL_SENDER_REGEX_LENGTH} characters`,
    );
  }

  try {
    return RE2JS.compile(pattern, RE2JS.CASE_INSENSITIVE);
  } catch {
    throw new EmailSenderRegexError(
      'Email sender regex is invalid or uses syntax unsupported by the safe RE2 engine',
    );
  }
}

function cachedEmailSenderRegex(pattern: string): RE2JS | null {
  if (compiledRegexCache.has(pattern)) return compiledRegexCache.get(pattern) ?? null;

  let compiled: RE2JS | null = null;
  try {
    compiled = compileEmailSenderRegex(pattern);
  } catch {
    // Stored policies from before RE2 enforcement may contain unsupported or
    // unsafe patterns. They fail closed at runtime rather than falling back to
    // JavaScript RegExp execution.
  }

  if (compiledRegexCache.size >= COMPILED_REGEX_CACHE_LIMIT) {
    const oldest = compiledRegexCache.keys().next().value;
    if (oldest !== undefined) compiledRegexCache.delete(oldest);
  }
  compiledRegexCache.set(pattern, compiled);
  return compiled;
}

/** Case-insensitive, unanchored matching, preserving the existing API contract. */
export function matchesEmailSenderRegex(pattern: string, email: string): boolean {
  const compiled = cachedEmailSenderRegex(pattern);
  if (!compiled) return false;
  try {
    return compiled.matcher(email).find();
  } catch {
    return false;
  }
}
