// TYPESCRIPT IN A CELL: ERASED, NOT COMPILED.
//
// A project that writes its tools in TypeScript had one answer here until now —
// "ship .js" — which is the wrong answer for anyone whose repo is TypeScript,
// which is most of them. The cell cannot run tsc: no compiler fits in a 1.4 MiB
// isolate, and bundling one would dwarf the agent it is there to serve.
//
// It does not need to. Every construct a plugin actually uses is ERASABLE, and
// Node settled this in 22.6: `--experimental-strip-types` blanks the types and
// runs the JavaScript underneath, refusing only the few forms that need code
// generated for them. This does the same thing and refuses the same forms BY
// NAME — enum, namespace and module blocks, parameter properties, decorators —
// because "nothing happened" is the worst possible answer to a plugin author.
//
// MEASURED AGAINST A REAL CORPUS, not against my idea of TypeScript: the 18
// files of the starter's own `opencode-pty` plugin, 1378 lines, which use
// import type, interfaces, type aliases, generics, `as`, class member
// modifiers and annotated methods — and none of the four refused forms.
//
// ERASURE, NOT REWRITING, is the whole design. Every character removed becomes
// a space and every newline survives, so line and column never move: a throw on
// line 40 column 12 of the .ts is a throw on line 40 column 12 of what ran. A
// transform would need a source map the cell has nowhere to put.

export const TS_EXTENSIONS = [".ts", ".mts", ".cts"];
export const isTypeScript = (filename) => TS_EXTENSIONS.some((e) => String(filename ?? "").endsWith(e));

const isIdStart = (c) => c !== undefined && (c === "_" || c === "$" || (c >= "a" && c <= "z") || (c >= "A" && c <= "Z"));
const isIdPart = (c) => c !== undefined && (isIdStart(c) || (c >= "0" && c <= "9"));
const isWs = (c) => c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f" || c === "\v";
const isDigit = (c) => c !== undefined && c >= "0" && c <= "9";

// Words after which a `/` starts a regular expression and a `!` is logical not.
const BEFORE_EXPRESSION = new Set([
  "return", "typeof", "instanceof", "in", "of", "case", "do", "else", "yield", "await",
  "new", "delete", "void", "throw", "export", "default", "extends", "if", "while", "switch",
]);
// Words that may lead a second identifier inside a type: `keyof T`, `A extends B`.
const TYPE_WORDS = new Set(["keyof", "typeof", "infer", "readonly", "extends", "new", "is", "asserts", "in", "out", "abstract", "unique", "import"]);
// Class member modifiers, all erasable where they stand.
const MEMBER_MODIFIERS = new Set(["public", "private", "protected", "readonly", "override", "declare", "abstract", "accessor"]);
// Words after which a `{` is an object literal rather than a block.
const OBJECT_AFTER = new Set(["return", "yield", "await", "typeof", "case", "of", "in", "delete", "void", "throw", "instanceof", "new"]);
// Words that keep a class member's name still to come.
const MEMBER_LEAD = new Set(["static", "async", "get", "set", "declare", "abstract", "override", "accessor", "readonly", "public", "private", "protected"]);
// Parens that belong to control flow, never to a parameter list.
const CONTROL_PARENS = new Set(["if", "for", "while", "switch", "with"]);
// Characters that continue a type across a line break.
const TYPE_CONTINUERS = new Set(["|", "&", ".", "<", ">", "[", "]", ")", "}", ",", ";", "=", "?", ":"]);

/**
 * Erase the types from one TypeScript source.
 *
 * Returns `{ ok: true, code }` with the same length and the same line breaks as
 * the input, or `{ ok: false, error }` naming the construct that needs a
 * compiler. Never throws: a plugin author gets a sentence, not a stack.
 */
export function stripTypes(source, filename = "<ts>") {
  const src = String(source ?? "");
  const n = src.length;
  const out = src.split("");
  let error = null;

  const fail = (message, at) => {
    if (error) return;
    let line = 1;
    for (let k = 0; k < at && k < n; k++) if (src[k] === "\n") line++;
    error = `${filename}:${line}: ${message}`;
  };
  const blank = (a, b) => { for (let k = Math.max(0, a); k < b && k < n; k++) if (out[k] !== "\n") out[k] = " "; };

  const endOfString = (i) => {
    const q = src[i];
    for (let k = i + 1; k < n; k++) {
      if (src[k] === "\\") { k++; continue; }
      if (src[k] === q) return k + 1;
      if (src[k] === "\n") return k;
    }
    return n;
  };
  const endOfComment = (i) => {
    if (src[i + 1] === "/") { let k = i + 2; while (k < n && src[k] !== "\n") k++; return k; }
    let k = i + 2;
    while (k < n && !(src[k] === "*" && src[k + 1] === "/")) k++;
    return Math.min(n, k + 2);
  };
  const endOfTemplate = (i) => {
    let k = i + 1;
    while (k < n) {
      if (src[k] === "\\") { k += 2; continue; }
      if (src[k] === "`") return k + 1;
      if (src[k] === "$" && src[k + 1] === "{") { k = matchPair(k + 1); continue; }
      k++;
    }
    return n;
  };
  const endOfRegex = (i) => {
    let k = i + 1, inClass = false;
    while (k < n) {
      const c = src[k];
      if (c === "\\") { k += 2; continue; }
      if (c === "\n") return i + 1;
      if (inClass) { if (c === "]") inClass = false; k++; continue; }
      if (c === "[") { inClass = true; k++; continue; }
      if (c === "/") { k++; while (k < n && isIdPart(src[k])) k++; return k; }
      k++;
    }
    return n;
  };
  const OPEN = { "{": "}", "(": ")", "[": "]" };
  // The index after the bracket matching the one at `i`. Strings, templates,
  // comments and regexes inside are skipped whole, so a `}` in a string never
  // closes a block.
  const matchPair = (i) => {
    const open = src[i], close = OPEN[open];
    if (!close) return i + 1;
    let depth = 0, k = i, lastReal = "";
    while (k < n) {
      const c = src[k];
      if (isWs(c)) { k++; continue; }
      if (c === "/" && (src[k + 1] === "/" || src[k + 1] === "*")) { k = endOfComment(k); continue; }
      if (c === "'" || c === '"') { k = endOfString(k); lastReal = "s"; continue; }
      if (c === "`") { k = endOfTemplate(k); lastReal = "s"; continue; }
      if (c === "/" && !(lastReal === "s" || isIdPart(lastReal) || lastReal === ")" || lastReal === "]")) { k = endOfRegex(k); lastReal = "s"; continue; }
      if (c === "{" || c === "(" || c === "[") {
        if (c === open) { depth++; k++; lastReal = c; continue; }
        k = matchPair(k); lastReal = ")"; continue;
      }
      if (c === close) { depth--; if (depth === 0) return k + 1; k++; lastReal = c; continue; }
      lastReal = c; k++;
    }
    return n;
  };
  // The index after the `>` matching the `<` at `i`, treating the inside as a
  // type. `-1` when the inside contains something no type can hold, which is
  // how `a < b && c > d` stays a comparison.
  const matchAngle = (i) => {
    let depth = 0, k = i;
    while (k < n) {
      const c = src[k];
      if (isWs(c)) { k++; continue; }
      if (c === "/" && (src[k + 1] === "/" || src[k + 1] === "*")) { k = endOfComment(k); continue; }
      if (c === "'" || c === '"') { k = endOfString(k); continue; }
      if (c === "`") { k = endOfTemplate(k); continue; }
      if (c === "<") { depth++; k++; continue; }
      if (c === ">") { depth--; if (depth === 0) return k + 1; k++; continue; }
      if (c === "(" || c === "[" || c === "{") { k = matchPair(k); continue; }
      if (c === ")" || c === "]" || c === "}" || c === ";") return -1;
      if (c === "=") { if (src[k + 1] === ">") { k += 2; continue; } k++; continue; }
      if ("+*%^~!@".includes(c)) return -1;
      if (c === "&" && src[k + 1] === "&") return -1;
      if (c === "|" && src[k + 1] === "|") return -1;
      k++;
    }
    return -1;
  };
  const skipTrivia = (i) => {
    let k = i;
    while (k < n) {
      if (isWs(src[k])) { k++; continue; }
      if (src[k] === "/" && (src[k + 1] === "/" || src[k + 1] === "*")) { k = endOfComment(k); continue; }
      break;
    }
    return k;
  };
  const wordAt = (i) => {
    if (!isIdStart(src[i])) return null;
    let k = i;
    while (k < n && isIdPart(src[k])) k++;
    return { value: src.slice(i, k), end: k };
  };
  const startsLine = (at) => { let k = at - 1; while (k >= 0 && (src[k] === " " || src[k] === "\t" || src[k] === "\r")) k--; return k < 0 || src[k] === "\n"; };
  const trimBack = (from, to) => { let k = to; while (k > from && isWs(src[k - 1])) k--; return k; };
  const lineOf = (i) => { let l = 1; for (let k = 0; k < i; k++) if (src[k] === "\n") l++; return l; };

  /**
   * The end of one type expression starting at `start`.
   *
   * Stops where a type cannot continue: a `,` `)` `]` `}` `;` or `=` at the top
   * level, a `{` or `(` once the type is already complete (that is the function
   * body, not an object type), an `=>` unless the type began as a function
   * type, and — the case that matters for code without semicolons — a second
   * name that no type keyword introduced, which is the next statement.
   */
  const endOfType = (start) => {
    let k = skipTrivia(start);
    const first = src[k];
    const leadWord = isIdStart(first) ? wordAt(k).value : "";
    const functionType = first === "(" || first === "<" || leadWord === "new" || leadWord === "abstract";
    let last = "none";
    let cond = 0;
    // Where to stop if the type turns out to have ENDED at the last line: the
    // comment that followed it belongs to whatever comes next, not to the type,
    // and blanking it would delete a member's documentation.
    let stopBeforeComment = -1;
    let lastLine = lineOf(k);
    while (k < n) {
      const c = src[k];
      if (isWs(c)) { k++; continue; }
      const complete = last === "name" || last === "close";
      if (c === "/" && (src[k + 1] === "/" || src[k + 1] === "*")) {
        if (complete && stopBeforeComment < 0 && lineOf(k) > lastLine) stopBeforeComment = k;
        k = endOfComment(k); continue;
      }
      if (complete) {
        const here = lineOf(k);
        const continues = c === ":" ? cond > 0 : TYPE_CONTINUERS.has(c);
        if (here > lastLine && !continues && !(isIdStart(c) && wordAt(k).value === "extends")) return stopBeforeComment >= 0 ? stopBeforeComment : k;
      }
      stopBeforeComment = -1;
      if (c === "'" || c === '"') { k = endOfString(k); last = "close"; lastLine = lineOf(k - 1); continue; }
      if (c === "`") { k = endOfTemplate(k); last = "close"; lastLine = lineOf(k - 1); continue; }
      if (c === "(" || c === "{") {
        if (complete) return k;
        k = matchPair(k); last = "close"; lastLine = lineOf(k - 1); continue;
      }
      if (c === "[") { k = matchPair(k); last = "close"; lastLine = lineOf(k - 1); continue; }
      if (c === "<") { const e = matchAngle(k); if (e < 0) return k; k = e; last = "close"; lastLine = lineOf(k - 1); continue; }
      if (c === ")" || c === "]" || c === "}" || c === "," || c === ";") return stopBeforeComment >= 0 ? stopBeforeComment : k;
      if (c === "=") {
        if (src[k + 1] === ">") { if (!functionType && complete) return k; k += 2; last = "op"; continue; }
        return k;
      }
      if (isIdStart(c)) {
        const w = wordAt(k);
        if (complete && !TYPE_WORDS.has(w.value)) return k;
        k = w.end; last = TYPE_WORDS.has(w.value) ? "op" : "name"; lastLine = lineOf(k - 1); continue;
      }
      if (isDigit(c) || c === "-" || c === "+") { k++; while (k < n && (isIdPart(src[k]) || src[k] === ".")) k++; last = "name"; lastLine = lineOf(k - 1); continue; }
      if (c === "?") { cond++; k++; last = "op"; continue; }
      if (c === ":") { if (cond === 0) return k; cond--; k++; last = "op"; continue; }
      if (c === "|" || c === "&" || c === "." || c === ">") { k++; last = "op"; continue; }
      return k;
    }
    return n;
  };

  // `import ... "x"` and `export ... "x"` end at their module specifier; an
  // `export { A }` with no `from` ends at its brace.
  const endOfModuleStatement = (start) => {
    let k = start;
    while (k < n) {
      const c = src[k];
      if (isWs(c)) { k++; continue; }
      if (c === "/" && (src[k + 1] === "/" || src[k + 1] === "*")) { k = endOfComment(k); continue; }
      if (c === "'" || c === '"') { k = endOfString(k); break; }
      if (c === "{") { const e = matchPair(k); const after = skipTrivia(e); if (!(isIdStart(src[after]) && wordAt(after).value === "from")) { k = e; break; } k = e; continue; }
      if (c === ";") break;
      if (c === "\n") { k++; continue; }
      k++;
    }
    const after = skipTrivia(k);
    return src[after] === ";" ? after + 1 : k;
  };

  // Inside an import or export clause, `{ type A, B }` must lose the whole
  // specifier, not only the word: leaving `A` behind imports a binding the
  // module never exported.
  const stripTypeSpecifiers = (braceAt) => {
    const end = matchPair(braceAt) - 1;
    let k = braceAt + 1;
    while (k < end) {
      k = skipTrivia(k);
      if (k >= end) break;
      const w = wordAt(k);
      if (!w) { k++; continue; }
      let specEnd = k;
      let depth = 0;
      while (specEnd < end && !(src[specEnd] === "," && depth === 0)) specEnd++;
      if (w.value === "type") {
        const nextTok = skipTrivia(w.end);
        if (isIdStart(src[nextTok]) || src[nextTok] === '"' || src[nextTok] === "'") {
          const comma = specEnd < end && src[specEnd] === "," ? specEnd + 1 : specEnd;
          blank(k, comma);
        }
      }
      k = specEnd + 1;
    }
  };

  let i = 0;
  let prev = null; // { kind: "ident" | "punct" | "value", value }
  const stack = [{ kind: "top" }];
  const top = () => stack[stack.length - 1];
  let classHeader = false;
  let pendingClassBody = false;
  let declarator = false;
  let declFrame = null;
  let expectReturnType = false;
  let memberStart = false;
  let memberNamed = false;
  let declPosition = false; // a `<` here opens type parameters, not a comparison

  // A template literal is not one token: `${(x as T).y}` holds code, and code
  // inside it carries types like any other. Step to the next `${`, hand the
  // main loop what is inside, and resume the string when its `}` closes.
  const templateStep = (k) => {
    while (k < n) {
      if (src[k] === "\\") { k += 2; continue; }
      if (src[k] === "`") return { done: true, next: k + 1 };
      if (src[k] === "$" && src[k + 1] === "{") return { done: false, next: k + 2 };
      k++;
    }
    return { done: true, next: n };
  };
  const enterTemplate = (k) => {
    const step = templateStep(k);
    if (step.done) { prev = { kind: "value", value: "" }; return step.next; }
    stack.push({ kind: "tsub" });
    prev = { kind: "punct", value: "{" };
    return step.next;
  };

  // `export interface X {}` erases whole: leaving `export` behind is a syntax
  // error, and a type is not a value anyone can import.
  const typeStatementStart = (at) => (prev && prev.kind === "ident" && prev.value === "export" && prev.start !== undefined ? prev.start : at);

  const valueEnding = () => prev !== null && (prev.kind === "value" || (prev.kind === "ident" && !BEFORE_EXPRESSION.has(prev.value)) || (prev.kind === "punct" && (prev.value === ")" || prev.value === "]" || prev.value === "}")));
  const regexAllowed = () => prev === null || (prev.kind === "ident" && BEFORE_EXPRESSION.has(prev.value)) || (prev.kind === "punct" && !(prev.value === ")" || prev.value === "]" || prev.value === "}"));

  // A `(` opens a parameter list when an arrow or a return type follows its
  // close, or when it is a declaration's own parens — never for `if (...)`.
  const parenIsParams = (openAt) => {
    const close = matchPair(openAt);
    const after = skipTrivia(close);
    if (src[after] === "=" && src[after + 1] === ">") return true;
    if (src[after] === ":" && !top().ternary) return true;
    if (prev && prev.kind === "ident" && prev.value === "catch") return true;
    if (prev && prev.kind === "ident" && CONTROL_PARENS.has(prev.value)) return false;
    if (declPosition) return true;
    if (src[after] === "{" && prev && (prev.kind === "ident" || (prev.kind === "punct" && prev.value === ">"))) return true;
    return false;
  };

  while (i < n && !error) {
    const c = src[i];
    if (isWs(c)) { if (c === "\n" && top().kind === "class") { memberStart = true; memberNamed = false; } i++; continue; }
    if (c === "/" && (src[i + 1] === "/" || src[i + 1] === "*")) { i = endOfComment(i); continue; }
    if (c === "'" || c === '"') { i = endOfString(i); prev = { kind: "value", value: "" }; continue; }
    if (c === "`") { i = enterTemplate(i + 1); continue; }
    if (c === "/" && regexAllowed()) { i = endOfRegex(i); prev = { kind: "value", value: "" }; continue; }
    if (c === "@" && isIdStart(src[i + 1])) { fail("a decorator needs a compiler, not type erasure — call the function yourself", i); break; }
    if (isDigit(c)) { let k = i; while (k < n && (isIdPart(src[k]) || src[k] === "." || ((src[k] === "-" || src[k] === "+") && (src[k - 1] === "e" || src[k - 1] === "E")))) k++; i = k; prev = { kind: "value", value: "" }; continue; }

    if (isIdStart(c)) {
      const w = wordAt(i);
      const word = w.value;
      if (prev && prev.kind === "punct" && (prev.value === "." || prev.value === "?.")) {
        i = w.end; prev = { kind: "value", value: word }; continue;
      }
      const atStatement = prev === null || (prev.kind === "punct" && (prev.value === ";" || prev.value === "{" || prev.value === "}")) || (prev.kind === "ident" && (prev.value === "export" || prev.value === "default")) || startsLine(i);
      const nextTok = skipTrivia(w.end);

      if (atStatement && (word === "enum" || (word === "const" && isIdStart(src[nextTok]) && wordAt(nextTok).value === "enum"))) {
        fail("an enum needs a compiler, not type erasure — export a plain object instead", i); break;
      }
      if (atStatement && (word === "namespace" || word === "module") && isIdStart(src[nextTok])) {
        const braceAt = skipTrivia(wordAt(nextTok).end);
        if (src[braceAt] === "{") { fail(`a ${word} block needs a compiler, not type erasure — use a module instead`, i); break; }
      }
      if (top().kind === "params" && MEMBER_MODIFIERS.has(word) && isIdStart(src[nextTok])) {
        fail(`a parameter property (\`${word}\` in a constructor) needs a compiler, not type erasure — assign it in the body`, i); break;
      }

      // AN OVERLOAD SIGNATURE IS A TYPE, not a function: `function f(a: A): B;`
      // with no body declares a call shape for the implementation below it.
      // Leaving one behind is a function whose body is a stray `;`.
      if (atStatement && word === "function") {
        let k = skipTrivia(w.end);
        if (src[k] === "*") k = skipTrivia(k + 1);
        if (isIdStart(src[k])) k = skipTrivia(wordAt(k).end);
        if (src[k] === "<") { const e = matchAngle(k); if (e > 0) k = skipTrivia(e); }
        if (src[k] === "(") {
          k = skipTrivia(matchPair(k));
          if (src[k] === ":") k = skipTrivia(endOfType(k + 1));
          const nextWord = isIdStart(src[k]) ? wordAt(k).value : "";
          const overload = src[k] === ";" || (src[k] !== "{" && startsLine(k) && (nextWord === "export" || nextWord === "function" || nextWord === "declare"));
          if (overload) {
            const end = src[k] === ";" ? k + 1 : k;
            blank(typeStatementStart(i), end);
            i = end; prev = { kind: "punct", value: ";" }; continue;
          }
        }
      }
      if (atStatement && word === "interface" && isIdStart(src[nextTok])) {
        let k = nextTok;
        while (k < n && src[k] !== "{") k++;
        blank(typeStatementStart(i), matchPair(k));
        i = matchPair(k); prev = { kind: "punct", value: "}" }; continue;
      }
      if (atStatement && word === "type" && isIdStart(src[nextTok])) {
        const afterName = skipTrivia(wordAt(nextTok).end);
        if (src[afterName] === "=" || src[afterName] === "<") {
          let eq = afterName;
          if (src[eq] === "<") { const e = matchAngle(eq); eq = e < 0 ? eq + 1 : skipTrivia(e); }
          if (src[eq] === "=") {
            const end = endOfType(eq + 1);
            const semi = skipTrivia(end);
            blank(typeStatementStart(i), src[semi] === ";" ? semi + 1 : end);
            i = src[semi] === ";" ? semi + 1 : end; prev = { kind: "punct", value: ";" }; continue;
          }
        }
      }
      if (atStatement && word === "declare") {
        let k = w.end, depth = 0, end = n;
        while (k < n) {
          if (src[k] === "{") { end = matchPair(k); break; }
          if (src[k] === ";" || src[k] === "\n") { end = src[k] === ";" ? k + 1 : k; break; }
          k++;
        }
        blank(typeStatementStart(i), end); i = end; prev = { kind: "punct", value: ";" }; continue;
      }
      if (atStatement && (word === "import" || word === "export")
          && (isIdStart(src[nextTok]) || src[nextTok] === "{" || src[nextTok] === "*" || src[nextTok] === "'" || src[nextTok] === '"' || src[nextTok] === "(")) {
        const typeWord = isIdStart(src[nextTok]) ? wordAt(nextTok) : null;
        if (word === "import" && src[nextTok] === "(") { i = w.end; prev = { kind: "ident", value: word, start: w.end - word.length }; continue; }
        if (typeWord && typeWord.value === "type") {
          // `export type X = ...` is an alias the next pass erases; `import
          // type ...` and `export type { ... }` are whole statements.
          const after = skipTrivia(typeWord.end);
          const aliasLike = word === "export" && isIdStart(src[after]) && (() => { const a = skipTrivia(wordAt(after).end); return src[a] === "=" || src[a] === "<"; })();
          if (!aliasLike) { const end = endOfModuleStatement(nextTok); blank(i, end); i = end; prev = { kind: "punct", value: ";" }; continue; }
          i = w.end; prev = { kind: "ident", value: "export", start: w.end - 6 }; continue;
        }
        // `export class`, `export function`, `export interface`, `export
        // default` — a declaration that happens to be exported. Only `export {`
        // and `export *` are module statements of their own.
        if (word === "export" && isIdStart(src[nextTok])) { i = w.end; prev = { kind: "ident", value: "export", start: w.end - 6 }; continue; }
        const end = endOfModuleStatement(w.end);
        let k = w.end;
        while (k < end) {
          if (src[k] === "{") { stripTypeSpecifiers(k); k = matchPair(k); continue; }
          if (src[k] === "'" || src[k] === '"') { k = endOfString(k); continue; }
          k++;
        }
        i = end; prev = { kind: "punct", value: ";" }; continue;
      }
      if (word === "this" && top().kind === "params" && src[nextTok] === ":") {
        const end = endOfType(nextTok + 1);
        const after = skipTrivia(end);
        blank(i, src[after] === "," ? after + 1 : end);
        i = src[after] === "," ? after + 1 : end; prev = { kind: "punct", value: "(" }; continue;
      }
      if ((word === "as" || word === "satisfies") && valueEnding()) {
        const end = trimBack(i, endOfType(w.end));
        blank(i, end); i = end; prev = { kind: "value", value: "" }; continue;
      }
      if (word === "implements" && classHeader) {
        let k = w.end;
        while (k < n && src[k] !== "{") k++;
        blank(i, k); i = k; prev = { kind: "punct", value: ")" }; continue;
      }
      if (top().kind === "class" && memberStart && MEMBER_MODIFIERS.has(word) && (isIdStart(src[nextTok]) || src[nextTok] === "#" || src[nextTok] === "[" || src[nextTok] === "*")) {
        blank(i, w.end); i = w.end; continue;
      }
      if (word === "abstract" && atStatement && isIdStart(src[nextTok]) && wordAt(nextTok).value === "class") {
        blank(i, w.end); i = w.end; continue;
      }

      if (word === "class") { classHeader = true; pendingClassBody = true; declPosition = true; }
      else if (word === "function") { declPosition = true; }
      else if ((word === "let" || word === "const" || word === "var") && top().kind !== "object" && (isIdStart(src[nextTok]) || src[nextTok] === "[" || src[nextTok] === "{")) { declarator = true; declFrame = top(); }
      else if (top().kind === "class" && memberStart && !MEMBER_LEAD.has(word)) { memberStart = false; memberNamed = true; declPosition = true; }
      else if (!MEMBER_LEAD.has(word) && !(prev && prev.kind === "ident" && (prev.value === "function" || prev.value === "class"))) { declPosition = false; }

      i = w.end; prev = { kind: "ident", value: word, start: w.end - word.length }; continue;
    }

    if (c === "(") {
      const kind = parenIsParams(i) ? "params" : "expr";
      stack.push({ kind });
      declPosition = false; memberStart = false;
      i++; prev = { kind: "punct", value: "(" }; continue;
    }
    if (c === ")") {
      const frame = stack.length > 1 ? stack.pop() : { kind: "top" };
      expectReturnType = frame.kind === "params";
      i++; prev = { kind: "punct", value: ")" }; continue;
    }
    if (c === "[") { stack.push({ kind: "array" }); i++; prev = { kind: "punct", value: "[" }; continue; }
    if (c === "]") { if (stack.length > 1) stack.pop(); i++; prev = { kind: "punct", value: "]" }; continue; }
    if (c === "{") {
      const objectLiteral = prev !== null && ((prev.kind === "punct" && (["(", ",", "=", "[", "?", "??"].includes(prev.value) || (prev.value === ":" && top().kind === "object"))) || (prev.kind === "ident" && OBJECT_AFTER.has(prev.value)));
      const kind = pendingClassBody ? "class" : objectLiteral ? "object" : "block";
      stack.push({ kind });
      pendingClassBody = false; classHeader = false; expectReturnType = false; declarator = false;
      memberStart = kind === "class"; memberNamed = false; declPosition = false;
      i++; prev = { kind: "punct", value: "{" }; continue;
    }
    if (c === "}") {
      if (top().kind === "tsub") { stack.pop(); i = enterTemplate(i + 1); continue; }
      if (stack.length > 1) stack.pop();
      memberStart = top().kind === "class"; memberNamed = false; expectReturnType = false;
      i++; prev = { kind: "punct", value: "}" }; continue;
    }
    if (c === ";") {
      declarator = false; declFrame = null; expectReturnType = false;
      memberStart = top().kind === "class"; memberNamed = false; declPosition = false;
      i++; prev = { kind: "punct", value: ";" }; continue;
    }
    if (c === "," ) {
      if (top().kind === "class") { memberStart = true; memberNamed = false; }
      if (declFrame === top()) declarator = true;
      expectReturnType = false;
      i++; prev = { kind: "punct", value: "," }; continue;
    }
    if (c === ":") {
      if (top().ternary) { top().ternary--; i++; prev = { kind: "punct", value: ":" }; continue; }
      const annotation = top().kind === "params" || declarator || expectReturnType || (top().kind === "class" && memberNamed);
      if (annotation) {
        const end = endOfType(i + 1);
        const after = skipTrivia(end);
        const arrowAcrossLines = src[after] === "=" && src[after + 1] === ">" && src.slice(i, after).includes("\n");
        const stop = trimBack(i, end);
        blank(i, stop);
        if (arrowAcrossLines && stop - i >= 2) { out[i] = "="; out[i + 1] = ">"; blank(after, after + 2); }
        declarator = false; expectReturnType = false; memberNamed = false;
        i = stop; prev = { kind: "value", value: "" }; continue;
      }
      i++; prev = { kind: "punct", value: ":" }; continue;
    }
    if (c === "<") {
      const plausible = declPosition || (prev !== null && (prev.kind === "value" || (prev.kind === "ident" && !BEFORE_EXPRESSION.has(prev.value)) || (prev.kind === "punct" && (prev.value === ")" || prev.value === "]"))));
      if (plausible || prev === null || (prev.kind === "punct" && ["=", "(", ",", ":", ";", "=>", "?", "&&", "||"].includes(prev.value))) {
        const end = matchAngle(i);
        if (end > 0) {
          const after = skipTrivia(end);
          const isCall = src[after] === "(" || src[after] === "`";
          if (declPosition || isCall || classHeader) {
            blank(i, end); i = end; prev = { kind: "punct", value: ">" }; continue;
          }
        }
      }
      i++; prev = { kind: "punct", value: "<" }; continue;
    }
    if (c === "!") {
      const after = skipTrivia(i + 1);
      if (valueEnding() && src[after] !== "=") { blank(i, i + 1); i++; continue; }
      i++; prev = { kind: "punct", value: "!" }; continue;
    }
    if (c === "?") {
      if (src[i + 1] === "?") { i += src[i + 2] === "=" ? 3 : 2; prev = { kind: "punct", value: "??" }; continue; }
      if (src[i + 1] === "." || src[i + 1] === "[" || src[i + 1] === "(") { i += 2; prev = { kind: "punct", value: "?." }; continue; }
      const after = skipTrivia(i + 1);
      const marker = (top().kind === "params" || (top().kind === "class" && memberNamed)) && (src[after] === ":" || src[after] === "," || src[after] === ")" || src[after] === "(" || src[after] === ";" || src[after] === "=");
      if (marker) { blank(i, i + 1); i++; continue; }
      top().ternary = (top().ternary ?? 0) + 1;
      i++; prev = { kind: "punct", value: "?" }; continue;
    }
    if (c === "=") {
      declarator = false; expectReturnType = false; memberNamed = false;
      if (src[i + 1] === ">") { i += 2; prev = { kind: "punct", value: "=>" }; continue; }
      i++; prev = { kind: "punct", value: "=" }; continue;
    }
    i++; prev = { kind: "punct", value: c };
  }

  if (error) return { ok: false, error };
  return { ok: true, code: out.join("") };
}
