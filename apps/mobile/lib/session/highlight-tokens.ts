/**
 * Lightweight bash / code / markdown tokenizers for session tool cards.
 * Temporary: Shiki replaces these later (COR-83).
 */

// ─── Bash syntax highlighting ────────────────────────────────────────────────

// Common bash commands/builtins to highlight
const BASH_COMMANDS = new Set([
  'ls', 'cd', 'cat', 'echo', 'grep', 'find', 'mkdir', 'rm', 'cp', 'mv',
  'touch', 'chmod', 'chown', 'head', 'tail', 'sort', 'uniq', 'wc', 'diff',
  'sed', 'awk', 'curl', 'wget', 'tar', 'zip', 'unzip', 'git', 'npm', 'npx',
  'node', 'python', 'python3', 'pip', 'pip3', 'yarn', 'pnpm', 'docker',
  'which', 'export', 'source', 'eval', 'exec', 'xargs', 'tee', 'tr',
  'cut', 'paste', 'test', 'read', 'set', 'unset', 'true', 'false',
  'pwd', 'env', 'printenv', 'date', 'sleep', 'kill', 'pkill', 'ps',
  'apt', 'brew', 'make', 'cmake', 'go', 'cargo', 'rustc', 'javac', 'java',
  'ssh', 'scp', 'rsync', 'jq', 'rg', 'fd', 'bat', 'exa',
]);

// Bash operators and redirections
const BASH_OPERATORS = new Set(['&&', '||', '|', ';', '>>', '2>', '2>&1', '>&2']);

export interface BashToken {
  text: string;
  type: 'prompt' | 'command' | 'flag' | 'string' | 'operator' | 'redirect' | 'path' | 'plain';
}

export function tokenizeBash(command: string): BashToken[] {
  const tokens: BashToken[] = [];
  // Add prompt
  tokens.push({ text: '$ ', type: 'prompt' });

  let i = 0;
  let isFirstWord = true;
  let afterOperator = false;

  while (i < command.length) {
    // Skip whitespace
    if (command[i] === ' ' || command[i] === '\t') {
      let ws = '';
      while (i < command.length && (command[i] === ' ' || command[i] === '\t')) {
        ws += command[i];
        i++;
      }
      tokens.push({ text: ws, type: 'plain' });
      continue;
    }

    // Quoted strings
    if (command[i] === '"' || command[i] === "'") {
      const quote = command[i];
      let str = quote;
      i++;
      while (i < command.length && command[i] !== quote) {
        if (command[i] === '\\' && i + 1 < command.length) {
          str += command[i] + command[i + 1];
          i += 2;
        } else {
          str += command[i];
          i++;
        }
      }
      if (i < command.length) { str += command[i]; i++; }
      tokens.push({ text: str, type: 'string' });
      isFirstWord = false;
      afterOperator = false;
      continue;
    }

    // Multi-char operators: &&, ||, >>, 2>, 2>&1
    const rest = command.slice(i);
    let matchedOp = '';
    for (const op of ['2>&1', '>&2', '2>', '>>', '&&', '||']) {
      if (rest.startsWith(op)) { matchedOp = op; break; }
    }
    if (matchedOp) {
      tokens.push({ text: matchedOp, type: 'operator' });
      i += matchedOp.length;
      isFirstWord = true;
      afterOperator = true;
      continue;
    }

    // Single-char operators: |, ;, >, <
    if ('|;><'.includes(command[i])) {
      tokens.push({ text: command[i], type: 'operator' });
      i++;
      isFirstWord = true;
      afterOperator = true;
      continue;
    }

    // Word
    let word = '';
    while (i < command.length && !' \t|;&><"\''.includes(command[i])) {
      word += command[i];
      i++;
    }

    if (!word) { i++; continue; }

    // Classify word
    if (isFirstWord || afterOperator) {
      // Command position
      if (BASH_COMMANDS.has(word)) {
        tokens.push({ text: word, type: 'command' });
      } else {
        tokens.push({ text: word, type: 'command' });
      }
      isFirstWord = false;
      afterOperator = false;
    } else if (word.startsWith('-')) {
      tokens.push({ text: word, type: 'flag' });
    } else if (word.startsWith('/') || word.includes('/') || word.startsWith('~')) {
      tokens.push({ text: word, type: 'path' });
    } else {
      tokens.push({ text: word, type: 'plain' });
    }
  }

  return tokens;
}

// ─── Lightweight code syntax highlighting ────────────────────────────────────

export type CodeTokenType = 'keyword' | 'string' | 'comment' | 'number' | 'heading' | 'bold' | 'bullet' | 'operator' | 'property' | 'tag' | 'attr' | 'plain';

export interface CodeToken {
  text: string;
  type: CodeTokenType;
}

export function getExtFromPath(filePath: string): string {
  const dot = filePath.lastIndexOf('.');
  if (dot < 0) return '';
  return filePath.slice(dot + 1).toLowerCase();
}

const MD_HEADING_RE = /^(#{1,6}\s)/;
const MD_BOLD_RE = /\*\*[^*]+\*\*/g;
const MD_BULLET_RE = /^(\s*[-*+]|\s*\d+\.)\s/;

export function tokenizeMarkdown(line: string): CodeToken[] {
  // Headings
  const headingMatch = line.match(MD_HEADING_RE);
  if (headingMatch) {
    return [{ text: line, type: 'heading' }];
  }
  // Bullets
  const bulletMatch = line.match(MD_BULLET_RE);
  if (bulletMatch) {
    const tokens: CodeToken[] = [{ text: bulletMatch[0], type: 'bullet' }];
    const rest = line.slice(bulletMatch[0].length);
    tokens.push(...tokenizeMarkdownInline(rest));
    return tokens;
  }
  return tokenizeMarkdownInline(line);
}

function tokenizeMarkdownInline(text: string): CodeToken[] {
  const tokens: CodeToken[] = [];
  let lastIdx = 0;
  const boldRe = /\*\*([^*]+)\*\*/g;
  let m: RegExpExecArray | null;
  while ((m = boldRe.exec(text)) !== null) {
    if (m.index > lastIdx) tokens.push({ text: text.slice(lastIdx, m.index), type: 'plain' });
    tokens.push({ text: m[0], type: 'bold' });
    lastIdx = m.index + m[0].length;
  }
  if (lastIdx < text.length) tokens.push({ text: text.slice(lastIdx), type: 'plain' });
  if (tokens.length === 0) tokens.push({ text, type: 'plain' });
  return tokens;
}

// Generic code tokenizer for JS/TS/Python/JSON/etc
const CODE_KEYWORDS = new Set([
  'import', 'export', 'from', 'const', 'let', 'var', 'function', 'return',
  'if', 'else', 'for', 'while', 'class', 'extends', 'new', 'this', 'super',
  'try', 'catch', 'finally', 'throw', 'async', 'await', 'yield',
  'default', 'switch', 'case', 'break', 'continue', 'typeof', 'instanceof',
  'in', 'of', 'true', 'false', 'null', 'undefined', 'void',
  'def', 'elif', 'except', 'pass', 'raise', 'with', 'as', 'lambda',
  'None', 'True', 'False', 'self', 'type', 'interface', 'enum',
]);

export function tokenizeCode(line: string): CodeToken[] {
  const tokens: CodeToken[] = [];
  // Comment
  const commentIdx = line.indexOf('//');
  const hashIdx = line.indexOf('#');
  const commentStart = commentIdx >= 0 ? commentIdx : (hashIdx === 0 ? 0 : -1);

  const codePart = commentStart >= 0 ? line.slice(0, commentStart) : line;
  const commentPart = commentStart >= 0 ? line.slice(commentStart) : '';

  // Tokenize code part
  const re = /("[^"]*"|'[^']*'|`[^`]*`|\b\d+\.?\d*\b|\b[a-zA-Z_]\w*\b|[{}()[\]:;,=<>!+\-*/&|?.]+|\s+)/g;
  let m: RegExpExecArray | null;
  let lastIdx = 0;
  while ((m = re.exec(codePart)) !== null) {
    if (m.index > lastIdx) tokens.push({ text: codePart.slice(lastIdx, m.index), type: 'plain' });
    const word = m[0];
    if (/^["'`]/.test(word)) {
      tokens.push({ text: word, type: 'string' });
    } else if (/^\d/.test(word)) {
      tokens.push({ text: word, type: 'number' });
    } else if (CODE_KEYWORDS.has(word)) {
      tokens.push({ text: word, type: 'keyword' });
    } else if (/^[{}()[\]:;,=<>!+\-*/&|?.]+$/.test(word)) {
      tokens.push({ text: word, type: 'operator' });
    } else if (/^\s+$/.test(word)) {
      tokens.push({ text: word, type: 'plain' });
    } else {
      tokens.push({ text: word, type: 'plain' });
    }
    lastIdx = m.index + m[0].length;
  }
  if (lastIdx < codePart.length) tokens.push({ text: codePart.slice(lastIdx), type: 'plain' });

  if (commentPart) tokens.push({ text: commentPart, type: 'comment' });
  if (tokens.length === 0) tokens.push({ text: line, type: 'plain' });
  return tokens;
}

export function tokenizeLine(line: string, ext: string): CodeToken[] {
  if (ext === 'md' || ext === 'mdx' || ext === 'markdown') return tokenizeMarkdown(line);
  if (['json', 'js', 'jsx', 'ts', 'tsx', 'py', 'rb', 'go', 'rs', 'java', 'c', 'cpp', 'h', 'cs', 'swift', 'kt'].includes(ext)) {
    return tokenizeCode(line);
  }
  // Default: try code tokenizer
  return tokenizeCode(line);
}

/**
 * Strip markdown code fences from content.
 * Tool inputs sometimes wrap code in ```lang ... ``` which should not be rendered literally.
 * Strips opening fence (first line if it matches ```lang) and closing fence (last non-empty line if ```).
 * Also filters out any stray ``` lines that are purely fence markers.
 */
export function stripCodeFences(text: string): string {
  // Normalize line endings
  let t = text.replace(/\r\n?/g, '\n');

  // Strip opening fence: ```lang, ```lang filename, or just ``` (anything after ```)
  t = t.replace(/^\s*```[^\n]*\n/, '');

  // Strip closing fence: ``` at end (with optional trailing whitespace/newlines)
  t = t.replace(/\n\s*```\s*\n?\s*$/, '');

  // Also strip if closing ``` is the very last line with no preceding newline (edge)
  t = t.replace(/\s*```\s*$/, '');

  return t;
}
