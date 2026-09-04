// WHICH BYTES OF A SOURCE FILE ARE COMMENTARY.
//
// Both auditors find their mutation sites with a regex over raw text, and this
// file's own package caught them out: r2.js opens with
//
//   //   • a missing object is NULL, not a 404 exception. Code that does
//   //     `const o = await bucket.get(k); if (!o) ...` is the normal shape
//
// `; if (!o)` matches the "a conditional starts here" pattern, so the auditor
// dutifully rewrote a sentence to `if (false)`, ran the suites, saw nothing
// change and reported r2.js:10 as an untested guard. It is prose.
//
// A finding that is not real costs more than a missing one: it sends someone to
// write a claim for code that does not exist. Same failure the suite map had —
// the tool reporting confidently about something it never actually examined.
//
// COMMENTS ONLY, not string literals. Masking strings as well would need to
// tell a regex literal from a division, and a regex holding a quote — this
// package has `/^([\w-]+)(?:([~^$*|]?=)"?'?([^"']*)"?'?)?$/` — would swallow
// real code up to the next matching quote and silently shrink the audit.
// Under-auditing while reporting success is the failure worth avoiding here, so
// the scanner does less and stays right.

/** A byte mask over `src`: 1 where the byte is inside a // or /* comment. */
export function commentMask(src) {
  const mask = new Uint8Array(src.length);
  let i = 0;
  while (i < src.length) {
    if (src[i] === "/" && src[i + 1] === "/") {
      const nl = src.indexOf("\n", i);
      const end = nl === -1 ? src.length : nl;
      mask.fill(1, i, end);
      i = end;
      continue;
    }
    if (src[i] === "/" && src[i + 1] === "*") {
      const close = src.indexOf("*/", i + 2);
      const end = close === -1 ? src.length : close + 2;
      mask.fill(1, i, end);
      i = end;
      continue;
    }
    i++;
  }
  return mask;
}

// WHICH BYTES ARE NOT CODE — comments, strings, templates AND regex literals.
//
// commentMask above says, correctly for what it does, that masking strings
// would need to tell a regex literal from a division and would otherwise
// swallow real code. That is true, and it is also the reason a boundary
// auditor could not exist: shifting `>=` to `>` has to skip the `>` inside
// `/\s*(>)\s*|\s+/`, and skipping it needs exactly the distinction that comment
// declines to make. So it is made here rather than avoided.
//
// The distinction is the standard one and it is a heuristic, not a parse: a `/`
// starts a regex when the previous significant token cannot END an expression.
// After an identifier, a number, `)`, `]` or `}` it is division; after `(`, a
// comma, an operator, `return`, `typeof` and friends it is a regex. The only
// shapes this gets wrong are ones no file here contains — a `}` that closes a
// block rather than an object immediately followed by a regex.
//
// Template literals nest: inside `${ ... }` the bytes are code again, and a
// template inside that substitution is another level. Tracked with a depth
// stack, because `${`-in-a-template is common in this package's serializers.
const ENDS_EXPRESSION = /[\w$)\]]$/;
const KEYWORD_BEFORE_REGEX = /\b(return|typeof|instanceof|in|of|new|delete|void|throw|case|do|else|yield|await)$/;

/** A byte mask over `src`: 1 where the byte is NOT code. */
export function literalMask(src) {
  const mask = new Uint8Array(src.length);
  const stack = [];            // template-literal nesting: {} depth per level
  let i = 0;
  let lastSignificant = "";    // code seen so far, for the regex/division call

  const inTemplate = () => stack.length > 0 && stack[stack.length - 1].braces === 0;

  while (i < src.length) {
    const c = src[i];

    if (src[i] === "/" && src[i + 1] === "/" && !inTemplate()) {
      const nl = src.indexOf("\n", i);
      const end = nl === -1 ? src.length : nl;
      mask.fill(1, i, end); i = end; continue;
    }
    if (src[i] === "/" && src[i + 1] === "*" && !inTemplate()) {
      const close = src.indexOf("*/", i + 2);
      const end = close === -1 ? src.length : close + 2;
      mask.fill(1, i, end); i = end; continue;
    }

    if (inTemplate()) {
      // Inside a template's text: only `${` and the closing backtick end it.
      if (c === "\\") { mask.fill(1, i, i + 2); i += 2; continue; }
      if (c === "$" && src[i + 1] === "{") { stack[stack.length - 1].braces = 1; mask.fill(1, i, i + 2); i += 2; lastSignificant = "("; continue; }
      if (c === "`") { stack.pop(); mask[i] = 1; i++; lastSignificant = "x"; continue; }
      mask[i] = 1; i++; continue;
    }

    if (stack.length && (c === "{" || c === "}")) {
      const top = stack[stack.length - 1];
      if (c === "{") top.braces++;
      else if (--top.braces === 0) { mask[i] = 1; i++; continue; } // back to template text
    }

    if (c === "'" || c === '"') {
      const q = c; let j = i + 1;
      while (j < src.length && src[j] !== q) { if (src[j] === "\\") j++; j++; }
      mask.fill(1, i, Math.min(j + 1, src.length)); i = j + 1; lastSignificant = "x"; continue;
    }

    if (c === "`") { stack.push({ braces: 0 }); mask[i] = 1; i++; continue; }

    if (c === "/") {
      const tail = lastSignificant;
      const isRegex = !(ENDS_EXPRESSION.test(tail) && !KEYWORD_BEFORE_REGEX.test(tail));
      if (isRegex) {
        let j = i + 1, klass = false;
        for (; j < src.length; j++) {
          const d = src[j];
          if (d === "\\") { j++; continue; }
          if (d === "[") klass = true;
          else if (d === "]") klass = false;
          else if (d === "/" && !klass) break;
          else if (d === "\n") { j = i; break; }   // not a regex after all
        }
        if (j > i) {
          while (j + 1 < src.length && /[dgimsuvy]/.test(src[j + 1])) j++;
          mask.fill(1, i, Math.min(j + 1, src.length)); i = j + 1; lastSignificant = "x"; continue;
        }
      }
    }

    if (!/\s/.test(c)) lastSignificant = (lastSignificant + c).slice(-12);
    i++;
  }
  return mask;
}
