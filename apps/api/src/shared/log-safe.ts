/**
 * Make an untrusted string safe to put in a log line.
 *
 * `end_user_ref` is chosen by the wrapper's own backend and reaches us as opaque
 * text. The create path trims it and bounds its length, but does not reject
 * control characters — so a crafted value containing CR/LF can forge whole log
 * lines, and line-oriented ingestion (Betterstack, CloudWatch, journald) will
 * happily index the forgery as its own event.
 *
 * Anything that could end or restructure a line becomes a visible escape rather
 * than being dropped: an operator reading the log should be able to tell the
 * value contained something odd, which is itself the signal.
 */
export function logSafe(value: string | null | undefined, maxLength = 120): string {
  if (value == null) return 'none';
  const escaped = value
    // Backslash FIRST, so a literal `\x0a` in the input cannot be mistaken for an
    // escape this function produced — otherwise a value could fake having been
    // sanitised.
    .replace(/\\/g, '\\\\')
    // biome-ignore lint/suspicious/noControlCharactersInRegex: escaping them is the point
    .replace(/[\u0000-\u001f\u007f]/g, (ch) => `\\x${ch.charCodeAt(0).toString(16).padStart(2, '0')}`);
  return escaped.length > maxLength ? `${escaped.slice(0, maxLength)}…` : escaped;
}
