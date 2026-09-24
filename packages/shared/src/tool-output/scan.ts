// Character classes and searches the tool-output readers share. Each one means
// exactly what its regex counterpart meant, so a reader built from them
// matches the regex it replaces.

/** A regex `\s`: the JavaScript WhiteSpace and LineTerminator characters. */
export function isWhitespace(code: number): boolean {
  if (code === 32 || (code >= 9 && code <= 13)) return true;
  if (code < 160) return false;
  return (
    code === 0xa0 ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000 ||
    code === 0xfeff
  );
}

/** A line terminator: a character `.` does not match and `$` with the `m` flag stops before. */
export function isLineTerminator(code: number): boolean {
  return code === 10 || code === 13 || code === 0x2028 || code === 0x2029;
}

/** The first line terminator at or after `from`, or the length of the text. */
export function lineEnd(text: string, from: number): number {
  for (let i = from; i < text.length; i++) {
    if (isLineTerminator(text.charCodeAt(i))) return i;
  }
  return text.length;
}

/** The end of the run of regex `\s` characters that starts at `from`. */
export function whitespaceEnd(text: string, from: number): number {
  let i = from;
  while (i < text.length && isWhitespace(text.charCodeAt(i))) i++;
  return i;
}

/** A regex `\d` without the `u` flag: `0`–`9`. */
export function isDigit(code: number): boolean {
  return code >= 48 && code <= 57;
}
