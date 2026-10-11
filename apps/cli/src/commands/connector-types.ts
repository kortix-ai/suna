/**
 * `kortix connectors types`: render the callable catalog as a declaration
 * file that fills `@kortix/sdk`'s `ConnectorActionRegistry`. Each action maps
 * to `{ args; result }`: `args` from its input schema, `result` from its
 * output schema (the call's `output`). A connector without an output schema
 * (managed Composio and Pipedream) gets `result: unknown`.
 *
 * ponytail: a minimal JSON Schema → TypeScript converter (types, enum, const,
 * anyOf/oneOf/allOf, local $ref as one named alias per definition). Anything
 * else becomes `unknown`, and so does an action whose types pass 256 KB: an
 * MCP server's output schema is remote input. Replace it
 * with json-schema-to-typescript if connectors need tuples, patterns or
 * named interfaces; that package bundles prettier into the CLI binary.
 */

type Schema = Record<string, unknown>;

export interface TypedCatalogConnector {
  slug: string;
  actions: Array<{
    path: string;
    description?: string;
    risk?: string;
    inputSchema: Schema | null;
    outputSchema?: Schema | null;
  }>;
}

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const MAX_DEPTH = 24;
/** Per action. An MCP server's output schema is remote input: a larger type becomes `unknown`. */
const MAX_ACTION_CHARS = 256 * 1024;
const ALIAS = 'KortixConnectorDef';

/**
 * One schema's rendering state. Each `$defs` / `definitions` entry becomes one
 * top-level alias (`type KortixConnectorDef<n> = …`), rendered once from a
 * worklist, so recursion and shared definitions cost one alias each.
 */
interface Ctx {
  root: unknown;
  /** Definition key → alias name. */
  names: Map<string, string>;
  /** Alias name → body, in creation order. */
  bodies: Map<string, string>;
  /** Alias name → aliases its body names outside `{}` and `[]` (union, intersection, bare). */
  direct: Map<string, string[]>;
  queue: Array<{ name: string; schema: unknown }>;
  /** The alias whose body is rendering; null for the action root. */
  current: string | null;
  nextId: () => number;
}

function key(name: string): string {
  return IDENTIFIER.test(name) ? name : JSON.stringify(name);
}

function doc(text: unknown, indent: string): string {
  if (typeof text !== 'string' || !text.trim()) return '';
  const line = text.replace(/\s+/g, ' ').trim().slice(0, 300).replace(/\*\//g, '*\\/');
  return `${indent}/** ${line} */\n`;
}

function literal(value: unknown): string | null {
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
    return JSON.stringify(value);
  }
  return null;
}

function union(parts: string[]): string {
  const unique = [...new Set(parts)];
  if (unique.includes('unknown')) return 'unknown';
  return unique.length === 0 ? 'never' : unique.join(' | ');
}

/** The alias for a local `#/$defs/*` or `#/definitions/*` ref, or null when it does not resolve. */
function aliasFor(ref: string, ctx: Ctx): string | null {
  const match = /^#\/(\$defs|definitions)\/(.+)$/.exec(ref);
  if (!match) return null;
  let name: string;
  try {
    name = decodeURIComponent(match[2]!);
  } catch {
    return null;
  }
  const defs = (ctx.root as Schema | null)?.[match[1]!];
  if (!defs || typeof defs !== 'object' || !Object.hasOwn(defs, name)) return null;
  const defKey = `${match[1]}/${name}`;
  let alias = ctx.names.get(defKey);
  if (!alias) {
    // The definition's name keeps an editor hover readable.
    alias = `${ALIAS}${ctx.nextId()}_${name.replace(/[^A-Za-z0-9_$]/g, '_').slice(0, 40)}`;
    ctx.names.set(defKey, alias);
    ctx.queue.push({ name: alias, schema: (defs as Schema)[name] });
  }
  return alias;
}

/**
 * The TypeScript type for `schema`. `direct` is true outside `{}` and `[]`:
 * an alias named there joins a union or intersection, where a cycle is a
 * TypeScript error (see `breakDirectCycles`).
 */
function schemaToTs(schema: unknown, ctx: Ctx, indent = '', depth = 0, direct = true): string {
  if (schema === false) return 'never';
  if (!schema || typeof schema !== 'object' || Array.isArray(schema) || depth > MAX_DEPTH) {
    return 'unknown';
  }
  const s = schema as Schema;
  const next = (child: unknown) => schemaToTs(child, ctx, indent, depth + 1, direct);
  let type: string;

  if (typeof s.$ref === 'string') {
    const alias = aliasFor(s.$ref, ctx);
    if (alias && direct && ctx.current) ctx.direct.get(ctx.current)!.push(alias);
    type = alias ?? 'unknown';
  } else if ('const' in s) {
    type = literal(s.const) ?? 'unknown';
  } else if (Array.isArray(s.enum)) {
    const values = s.enum.map(literal);
    type = values.includes(null) ? 'unknown' : union(values as string[]);
  } else if (Array.isArray(s.anyOf) || Array.isArray(s.oneOf)) {
    type = union(((s.anyOf ?? s.oneOf) as unknown[]).map((member) => wrap(next(member))));
  } else if (Array.isArray(s.allOf)) {
    const parts = (s.allOf as unknown[]).map((member) => wrap(next(member))).filter((t) => t !== 'unknown');
    type = parts.length === 0 ? 'unknown' : parts.join(' & ');
  } else if (Array.isArray(s.type)) {
    type = union([...new Set(s.type as unknown[])].map((one) => next({ ...s, type: one })));
  } else {
    type = typeFor(s, ctx, indent, depth);
  }
  return s.nullable === true && type !== 'unknown' ? union([type, 'null']) : type;
}

function wrap(type: string): string {
  return /[|&]/.test(type) ? `(${type})` : type;
}

function typeFor(s: Schema, ctx: Ctx, indent: string, depth: number): string {
  switch (s.type) {
    case 'string':
      return 'string';
    case 'number':
    case 'integer':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'null':
      return 'null';
    case 'array': {
      const items = Array.isArray(s.items) ? 'unknown' : schemaToTs(s.items, ctx, indent, depth + 1, false);
      return `${wrap(items)}[]`;
    }
    case 'object':
    case undefined:
      if (s.type === undefined && !s.properties) return 'unknown';
      return objectType(s, ctx, indent, depth);
    default:
      return 'unknown';
  }
}

function objectType(s: Schema, ctx: Ctx, indent: string, depth: number): string {
  const properties = (s.properties && typeof s.properties === 'object' ? s.properties : {}) as Record<
    string,
    unknown
  >;
  const names = Object.keys(properties);
  const extra = s.additionalProperties;
  if (names.length === 0) {
    const value = extra && typeof extra === 'object' ? schemaToTs(extra, ctx, indent, depth + 1, false) : 'unknown';
    return `{ [key: string]: ${value} }`;
  }
  const required = new Set(Array.isArray(s.required) ? (s.required as string[]) : []);
  const inner = `${indent}  `;
  const lines = names.map((name) => {
    const child = properties[name];
    const description = child && typeof child === 'object' ? (child as Schema).description : undefined;
    const optional = required.has(name) ? '' : '?';
    return `${doc(description, inner)}${inner}${key(name)}${optional}: ${schemaToTs(child, ctx, inner, depth + 1, false)};\n`;
  });
  // Closed unless the schema opens it: an unknown argument is a compile error.
  if (extra === true || (extra && typeof extra === 'object')) lines.push(`${inner}[key: string]: unknown;\n`);
  return `{\n${lines.join('')}${indent}}`;
}

/**
 * `type A = B | string; type B = A & {…}` does not compile. Every cycle of
 * direct references holds a DFS back edge; its target's body becomes `unknown`.
 */
function breakDirectCycles(ctx: Ctx): void {
  const state = new Map<string, 'open' | 'done'>();
  for (const start of ctx.bodies.keys()) {
    if (state.has(start)) continue;
    state.set(start, 'open');
    const stack: Array<{ name: string; edge: number }> = [{ name: start, edge: 0 }];
    while (stack.length) {
      const top = stack[stack.length - 1]!;
      const target = ctx.direct.get(top.name)![top.edge++];
      if (target === undefined) {
        state.set(top.name, 'done');
        stack.pop();
      } else if (state.get(target) === 'open') {
        ctx.bodies.set(target, 'unknown');
      } else if (!state.has(target)) {
        state.set(target, 'open');
        stack.push({ name: target, edge: 0 });
      }
    }
  }
}

/** The type of one action schema and the aliases it needs; `unknown` and no alias over budget. */
function renderSchema(schema: Schema, indent: string, nextId: () => number): { type: string; aliases: string } {
  const ctx: Ctx = { root: schema, names: new Map(), bodies: new Map(), direct: new Map(), queue: [], current: null, nextId };
  const type = schemaToTs(schema, ctx, indent);
  let size = type.length;
  for (let job = ctx.queue.shift(); job && size <= MAX_ACTION_CHARS; job = ctx.queue.shift()) {
    ctx.current = job.name;
    ctx.direct.set(job.name, []);
    const body = schemaToTs(job.schema, ctx);
    ctx.bodies.set(job.name, body);
    size += body.length;
  }
  if (size > MAX_ACTION_CHARS) return { type: 'unknown', aliases: '' };
  breakDirectCycles(ctx);
  const aliases = [...ctx.bodies].map(([name, body]) => `type ${name} = ${body};\n`).join('');
  return { type, aliases };
}

/** The whole declaration file for `connectors`, sorted by slug and action path. */
export function renderConnectorTypes(connectors: TypedCatalogConnector[]): string {
  let id = 0;
  const nextId = () => id++;
  const aliases: string[] = [];
  const typeOf = (schema: Schema | null | undefined, indent: string) => {
    if (!schema) return 'unknown';
    const rendered = renderSchema(schema, indent, nextId);
    aliases.push(rendered.aliases);
    return rendered.type;
  };
  const body = [...connectors]
    .sort((a, b) => a.slug.localeCompare(b.slug))
    .map((connector) => {
      const actions = [...connector.actions]
        .sort((a, b) => a.path.localeCompare(b.path))
        .map((action) => {
          const pad = '      ';
          const args = typeOf(action.inputSchema, `${pad}  `);
          const result = typeOf(action.outputSchema, `${pad}  `);
          const summary = [action.risk ? `[${action.risk}]` : '', action.description ?? '']
            .filter(Boolean)
            .join(' ');
          return (
            `${doc(summary, pad)}${pad}${key(action.path)}: {\n` +
            `${pad}  args: ${args === 'unknown' ? 'Record<string, unknown>' : args};\n` +
            `${pad}  result: ${result};\n` +
            `${pad}};\n`
          );
        })
        .join('');
      return `    ${key(connector.slug)}: {\n${actions}    };\n`;
    })
    .join('');
  return (
    '// Generated by `kortix connectors types`. Do not edit: re-run it after a\n' +
    '// connector changes. `result` is the call\'s `output`; it is `unknown` when\n' +
    '// the connector publishes no output schema (managed Composio and Pipedream).\n' +
    "// Use: kortix.project(id).connectors.callAction('<slug>', '<action>', args)\n" +
    'export {};\n\n' +
    aliases.join('') +
    (aliases.some(Boolean) ? '\n' : '') +
    "declare module '@kortix/sdk' {\n" +
    '  interface ConnectorActionRegistry {\n' +
    body +
    '  }\n' +
    '}\n'
  );
}
