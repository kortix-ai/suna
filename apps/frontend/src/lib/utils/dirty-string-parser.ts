// tool-parser.ts

// ————————————————————————————————————————————————
// 1) AST Node Definitions
// ————————————————————————————————————————————————

type ASTNode = ObjectNode | ArrayNode | LiteralNode;

interface ObjectNode {
  type: 'Object';
  properties: PropertyNode[];
}

interface PropertyNode {
  key: string;
  value: ASTNode;
}

interface ArrayNode {
  type: 'Array';
  elements: ASTNode[];
}

interface LiteralNode {
  type: 'Literal';
  value: string | number | boolean | null;
}

// ————————————————————————————————————————————————
// 2) Tokenizer
// ————————————————————————————————————————————————

enum TokenType {
  LBrace, RBrace, LBracket, RBracket,
  Colon, Comma,
  String, Number, Ident,
  EOF
}

interface Token {
  type: TokenType;
  value: string;
  pos: number;
}

class Tokenizer {
  private pos = 0;
  private tokens: Token[] = [];

  constructor(private input: string) {
    this.tokenize();
    this.tokens.push({ type: TokenType.EOF, value: '', pos: this.pos });
  }
  private tokenize() {
    const re = /\s+|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|([{}[\]:,])|([A-Za-z_]\w*)|(.)/gy;
    let m: RegExpExecArray | null;
    while ((m = re.exec(this.input)) !== null) {
      const [raw, str, num, punct, ident, bad] = m;
      if (raw.match(/^\s+$/)) continue;
      let type: TokenType;
      let val: string;
      if (str)       { type = TokenType.String;  val = str; }
      else if (num)  { type = TokenType.Number;  val = num; }
      else if (punct){
        switch (punct) {
          case '{': type = TokenType.LBrace;  break;
          case '}': type = TokenType.RBrace;  break;
          case '[': type = TokenType.LBracket;break;
          case ']': type = TokenType.RBracket;break;
          case ':': type = TokenType.Colon;   break;
          case ',': type = TokenType.Comma;   break;
          default:  continue;
        }
        val = punct;
      }
      else if (ident){ type = TokenType.Ident;   val = ident; }
      else if (bad)  { /* skip stray */          continue; }
      else           { continue; }
      this.tokens.push({ type, value: val, pos: m.index });
    }
  }

  peek(offset = 0): Token {
    return this.tokens[this.pos + offset] || this.tokens[this.tokens.length - 1];
  }
  next(): Token {
    return this.tokens[this.pos++];
  }
}

// ————————————————————————————————————————————————
// 3) Parser
// ————————————————————————————————————————————————

class Parser {
  private warnings: string[] = [];

  constructor(private tz: Tokenizer) {}

  parse(): ASTNode {
    const node = this.parseValue();
    if (this.tz.peek().type !== TokenType.EOF) {
      this.warnings.push(`Extra data at pos ${this.tz.peek().pos}`);
    }
    if (this.warnings.length) {
      console.warn('Parse warnings:\n ' + this.warnings.join('\n '));
    }
    return node;
  }

  private parseValue(): ASTNode {
    const tok = this.tz.peek();
    switch (tok.type) {
      case TokenType.LBrace:   return this.parseObject();
      case TokenType.LBracket: return this.parseArray();
      case TokenType.String:   return this.parseString();
      case TokenType.Number:   return this.parseNumber();
      case TokenType.Ident:    return this.parseIdent();
      default:
        this.warnings.push(`Unexpected token '${tok.value}' at pos ${tok.pos}, inserting null`);
        this.tz.next();
        return { type: 'Literal', value: null };
    }
  }

  private parseObject(): ObjectNode {
    this.tz.next(); // skip {
    const props: PropertyNode[] = [];
    while (this.tz.peek().type !== TokenType.RBrace &&
           this.tz.peek().type !== TokenType.EOF) {
      if (this.tz.peek().type === TokenType.Comma) {
        this.tz.next();
        continue;
      }
      // key
      const keyTok = this.tz.peek();
      let key: string;
      if (keyTok.type === TokenType.String) {
        key = this.unquote(this.tz.next().value);
      } else if (keyTok.type === TokenType.Ident) {
        key = this.tz.next().value;
      } else {
        this.warnings.push(`Expected property name at pos ${keyTok.pos}, skipping token`);
        this.tz.next();
        continue;
      }
      // colon
      if (this.tz.peek().type === TokenType.Colon) {
        this.tz.next();
      } else {
        this.warnings.push(`Missing ':' after key "${key}" at pos ${keyTok.pos}`);
      }
      // value
      const val = this.parseValue();
      props.push({ key, value: val });
      // optional comma
      if (this.tz.peek().type === TokenType.Comma) {
        this.tz.next();
      }
    }
    if (this.tz.peek().type === TokenType.RBrace) {
      this.tz.next();
    } else {
      this.warnings.push(`Unclosed '{'`);
    }
    return { type: 'Object', properties: props };
  }

  private parseArray(): ArrayNode {
    this.tz.next(); // skip [
    const elems: ASTNode[] = [];
    while (this.tz.peek().type !== TokenType.RBracket &&
           this.tz.peek().type !== TokenType.EOF) {
      if (this.tz.peek().type === TokenType.Comma) {
        this.tz.next();
        continue;
      }
      elems.push(this.parseValue());
    }
    if (this.tz.peek().type === TokenType.RBracket) {
      this.tz.next();
    } else {
      this.warnings.push(`Unclosed '['`);
    }
    return { type: 'Array', elements: elems };
  }

  private parseString(): LiteralNode {
    const raw = this.tz.next().value;
    return { type: 'Literal', value: this.unquote(raw) };
  }

  private parseNumber(): LiteralNode {
    const num = this.tz.next().value;
    return num.includes('.') || /[eE]/.test(num)
      ? { type: 'Literal', value: parseFloat(num) }
      : { type: 'Literal', value: parseInt(num, 10) };
  }

  private parseIdent(): LiteralNode {
    const id = this.tz.next().value.toLowerCase();
    if (id === 'true')  return { type: 'Literal', value: true };
    if (id === 'false') return { type: 'Literal', value: false };
    if (id === 'null')  return { type: 'Literal', value: null };
    // fallback: treat as string
    return { type: 'Literal', value: id };
  }

  private unquote(str: string): string {
    // strip leading+trailing quote and unescape
    return JSON.parse(
      '"' +
      str
        .slice(1, -1)
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\n/g, '\\n')
        .replace(/\r/g, '\\r')
        .replace(/\t/g, '\\t') +
      '"'
    );
  }
}

// ————————————————————————————————————————————————
// 4) AST Evaluator
// ————————————————————————————————————————————————

function evalAST(node: ASTNode): any {
  switch (node.type) {
    case 'Literal':
      return node.value;
    case 'Array':
      return node.elements.map(evalAST);
    case 'Object':
      const obj: Record<string, any> = {};
      for (const p of node.properties) {
        obj[p.key] = evalAST(p.value);
      }
      return obj;
  }
}

// ————————————————————————————————————————————————
// 5) Public API
// ————————————————————————————————————————————————

export function parseDirtyJSON(raw: string): any {
  // 0) Strip literal backspaces/control-chars
  raw = raw.replace(/[\u0000-\u001F]/g, c =>
    `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`
  );

  const tz = new Tokenizer(raw);
  const parser = new Parser(tz);
  const ast = parser.parse();
  return evalAST(ast);
}
