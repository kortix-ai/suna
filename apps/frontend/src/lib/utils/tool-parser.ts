// toolParser.ts
// A robust, agnostic parser to extract success flag, tool name, and JSON output from a ToolResult-like string.

interface ParseResult {
    success: boolean | null;
    toolName: string | null;
    output: any;
    error: string | null;
  }
  
  /**
   * Parses a raw tool-result string and extracts:
   *   - success: boolean
   *   - toolName: string (from metadata)
   *   - output: parsed JSON or raw string
   *   - error: detailed error if parsing fails
   *
   * Uses a stateful scanner for reliable extraction of arbitrarily complex JSON or quoted strings.
   */
  export function parseToolResult(raw: string): ParseResult {
    const result: ParseResult = {
      success: null,
      toolName: null,
      output: null,
      error: null,
    };
  
    try {
      // 1. Extract success flag via regex
      const successMatch = raw.match(/\bsuccess\s*=\s*(true|false)\b/i);
      if (successMatch) {
        result.success = successMatch[1].toLowerCase() === 'true';
      }
  
      // 2. Locate output= position
      const outIdx = raw.search(/\boutput\s*=/i);
      if (outIdx === -1) throw new Error('No output= found');
      // Move to the character after '='
      let i = raw.indexOf('=', outIdx) + 1;
      // Skip whitespace
      while (i < raw.length && /\s/.test(raw[i])) i++;
      if (i >= raw.length) throw new Error('Output value missing');
  
      const startChar = raw[i];
      let extracted: string;
  
      if (startChar === '"' || startChar === "'") {
        // Quoted string: find matching end quote
        const quote = startChar;
        i++;
        let esc = false;
        let buf = '';
        while (i < raw.length) {
          const ch = raw[i];
          if (esc) {
            buf += ch;
            esc = false;
          } else if (ch === '\\') {
            esc = true;
          } else if (ch === quote) {
            break;
          } else {
            buf += ch;
          }
          i++;
        }
        extracted = buf;
      } else if (startChar === '{' || startChar === '[') {
        // JSON object or array: bracket matching
        const open = startChar;
        const close = open === '{' ? '}' : ']';
        let depth = 0;
        let buf = '';
        while (i < raw.length) {
          const ch = raw[i];
          buf += ch;
          if (ch === '"') {
            // skip string contents
            i++;
            while (i < raw.length) {
              const c2 = raw[i];
              buf += c2;
              if (c2 === '\\') {
                i += 2;
                continue;
              }
              if (c2 === '"') break;
              i++;
            }
          } else if (ch === open) {
            depth++;
          } else if (ch === close) {
            depth--;
            if (depth === 0) {
              break;
            }
          }
          i++;
        }
        extracted = buf;
      } else {
        // Unquoted primitive: read until comma or closing parenthesis
        let buf = '';
        while (i < raw.length && !/[,)]/.test(raw[i])) {
          buf += raw[i];
          i++;
        }
        extracted = buf.trim();
      }
  
      // 3. Parse extracted value
      try {
        result.output = JSON.parse(extracted);
      } catch (e) {
        // Leave as raw string if JSON.parse fails
        result.error = `Output JSON.parse error: ${e instanceof Error ? e.message : String(e)}`;
        result.output = extracted;
      }
  
      // 4. Extract toolName from metadata if exists
      if (result.output && typeof result.output === 'object') {
        const md = (result.output as any).mcp_metadata;
        if (md) result.toolName = md.full_tool_name || md.tool_name || null;
      }
    } catch (err: any) {
      result.error = err.message || String(err);
    }
  
    return result;
  }
  


  type TokenType =
  | 'LBRACE' | 'RBRACE'
  | 'LBRACK' | 'RBRACK'
  | 'COLON'  | 'COMMA'
  | 'STRING' | 'NUMBER'
  | 'IDENT'  | 'EOF';

interface Token { type: TokenType; value: string; line: number; col: number; }

export function cleanAndParse(messy: string): string {
  // —————————————————————————————————————————
  // 1) Pre-process
  // —————————————————————————————————————————
  // Remove spurious \b’s and literal backspace chars
  messy = messy.replace(/\\b/g, '').replace(/\x08/g, '');

  // Strip JS-style comments
  messy = messy.replace(/\/\/.*$/gm, '')
               .replace(/\/\*[\s\S]*?\*\//g, '');

  // Normalize escaped newlines/tabs so they stay as two-char sequences
  messy = messy.replace(/\\r\\n|\\n|\\r/g, '\\n')
               .replace(/\\t/g, '\\t')
               .replace(/\btruen\b/gi, 'true')
               .replace(/,\s*([\]\}])/g, '$1'); // drop trailing commas

  // —————————————————————————————————————————
  // 2) Tokenization (regex with sticky /y)
  // —————————————————————————————————————————
  const TOKS = [
    ['WHITESPACE', /\s+/y],
    ['LBRACE'    , /\{/y],
    ['RBRACE'    , /\}/y],
    ['LBRACK'    , /\[/y],
    ['RBRACK'    , /\]/y],
    ['COLON'     , /:/y],
    ['COMMA'     , /,/y],
    // Single- or double-quoted strings, allowing escaped chars
    ['STRING'    , /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/y],
    ['NUMBER'    , /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y],
    ['IDENT'     , /[A-Za-z_]\w*/y],
    ['MISMATCH'  , /./y],
  ] as const;

  const tokens: Token[] = [];
  let line = 1, col = 1, idx = 0;
  while (idx < messy.length) {
    let matched = false;
    for (const [type, rx] of TOKS) {
      rx.lastIndex = idx;
      const m = rx.exec(messy);
      if (!m) continue;
      matched = true;
      const text = m[0];
      if (type !== 'WHITESPACE' && type !== 'MISMATCH') {
        tokens.push({ type: type as TokenType, value: text, line, col });
      }
      // update line/col
      const nl = text.match(/\n/g);
      if (nl) {
        line += nl.length;
        col = text.length - text.lastIndexOf('\n');
      } else {
        col += text.length;
      }
      idx = rx.lastIndex;
      break;
    }
    if (!matched) {
      // should never happen, but skip one char to avoid infinite loop
      idx++;
      col++;
    }
  }
  tokens.push({ type: 'EOF', value: '', line, col });

  // —————————————————————————————————————————
  // 3) Recursive-descent parser w/ error recovery
  // —————————————————————————————————————————
  let p = 0;
  function peek()      { return tokens[p]?.type; }
  function advance()   { return tokens[p++];  }

  function escapeControlChars(s: string) {
    return s.replace(/[\u0000-\u001F\x7F]/g, c =>
      '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')
    );
  }

  function parseValue(): any {
    const tk = tokens[p];
    try {
      switch (tk.type) {
        case 'LBRACE': return parseObject();
        case 'LBRACK': return parseArray();
        case 'STRING': {
          const raw = advance().value;
          let inner = raw.slice(1, -1);
          // re-escape control chars & backslashes & quotes
          inner = escapeControlChars(inner)
                   .replace(/\\/g, '\\\\')
                   .replace(/"/g, '\\"');
          return JSON.parse(`"${inner}"`);
        }
        case 'NUMBER': {
          const v = advance().value;
          return v.includes('.') || /[eE]/.test(v)
            ? parseFloat(v) : parseInt(v, 10);
        }
        case 'IDENT': {
          const lower = advance().value.toLowerCase();
          if (lower === 'true')  return true;
          if (lower === 'false') return false;
          if (lower === 'null')  return null;
          return lower;  // fallback
        }
        default:
          throw new Error(`Unexpected ${tk.type}`);
      }
    } catch (e) {
      console.warn(`Parse error at ${tk.line}:${tk.col}: ${e instanceof Error ? e.message : String(e)}`);
      // error recovery: skip to next comma or closing delimiter
      while (p < tokens.length &&
             !['COMMA','RBRACE','RBRACK','EOF'].includes(peek()!)) {
        advance();
      }
      return null;
    }
  }

  function parseObject(): any {
    const obj: Record<string, any> = {};
    advance(); // “{”
    while (peek() !== 'RBRACE' && peek() !== 'EOF') {
      if (peek() === 'COMMA') { advance(); continue; }
      // key
      let key: string | null = null;
      const tk = tokens[p];
      if (tk.type === 'STRING' || tk.type === 'IDENT') {
        key = tk.type === 'STRING'
          ? JSON.parse(advance().value.replace(/^['"]|['"]$/g, '"'))
          : advance().value;
      } else {
        console.warn(`Expected key at ${tk.line}:${tk.col}`);
        advance(); continue;
      }
      if (peek() === 'COLON') advance();
      else { console.warn(`Missing ':' after key at ${tk.line}:${tk.col}`); }

      const val = parseValue();
      if (key !== null) {
        obj[key] = val;
      }
      if (peek() === 'COMMA') advance();
    }
    if (peek() === 'RBRACE') advance();
    return obj;
  }

  function parseArray(): any[] {
    const arr: any[] = [];
    advance(); // “[”
    while (peek() !== 'RBRACK' && peek() !== 'EOF') {
      if (peek() === 'COMMA') { advance(); continue; }
      arr.push(parseValue());
    }
    if (peek() === 'RBRACK') advance();
    return arr;
  }

  const result = parseValue();
  return JSON.stringify(result, null, 2);
}
