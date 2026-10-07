/**
 * `kortix connectors types`: render the callable catalog as a declaration
 * file that fills `@kortix/sdk`'s `ConnectorActionRegistry`. Each action maps
 * to `{ args; result }`: `args` from its input schema, `result` from its
 * output schema (the call's `output`). A connector without an output schema
 * (managed Composio and Pipedream) gets `result: unknown`.
 *
 * ponytail: a minimal JSON Schema → TypeScript converter (types, enum, const,
 * anyOf/oneOf/allOf, local $ref). Anything else becomes `unknown`. Replace it
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

/** The TypeScript type for `schema`. `root` resolves `#/$defs/*` and `#/definitions/*`. */
export function schemaToTs(schema: unknown, root: unknown = schema, indent = '', depth = 0): string {
  if (schema === false) return 'never';
  if (!schema || typeof schema !== 'object' || Array.isArray(schema) || depth > MAX_DEPTH) {
    return 'unknown';
  }
  const s = schema as Schema;
  const next = (child: unknown) => schemaToTs(child, root, indent, depth + 1);
  let type: string;

  if (typeof s.$ref === 'string') {
    const match = /^#\/(\$defs|definitions)\/(.+)$/.exec(s.$ref);
    const defs = match ? ((root as Schema)?.[match[1]!] as Schema | undefined) : undefined;
    type = match && defs ? next(defs[decodeURIComponent(match[2]!)]) : 'unknown';
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
    type = union((s.type as unknown[]).map((one) => next({ ...s, type: one })));
  } else {
    type = typeFor(s, root, indent, depth);
  }
  return s.nullable === true && type !== 'unknown' ? union([type, 'null']) : type;
}

function wrap(type: string): string {
  return /[|&]/.test(type) ? `(${type})` : type;
}

function typeFor(s: Schema, root: unknown, indent: string, depth: number): string {
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
      const items = Array.isArray(s.items) ? 'unknown' : schemaToTs(s.items, root, indent, depth + 1);
      return `${wrap(items)}[]`;
    }
    case 'object':
    case undefined:
      if (s.type === undefined && !s.properties) return 'unknown';
      return objectType(s, root, indent, depth);
    default:
      return 'unknown';
  }
}

function objectType(s: Schema, root: unknown, indent: string, depth: number): string {
  const properties = (s.properties && typeof s.properties === 'object' ? s.properties : {}) as Record<
    string,
    unknown
  >;
  const names = Object.keys(properties);
  const extra = s.additionalProperties;
  if (names.length === 0) {
    const value = extra && typeof extra === 'object' ? schemaToTs(extra, root, indent, depth + 1) : 'unknown';
    return `{ [key: string]: ${value} }`;
  }
  const required = new Set(Array.isArray(s.required) ? (s.required as string[]) : []);
  const inner = `${indent}  `;
  const lines = names.map((name) => {
    const child = properties[name];
    const description = child && typeof child === 'object' ? (child as Schema).description : undefined;
    const optional = required.has(name) ? '' : '?';
    return `${doc(description, inner)}${inner}${key(name)}${optional}: ${schemaToTs(child, root, inner, depth + 1)};\n`;
  });
  // Closed unless the schema opens it: an unknown argument is a compile error.
  if (extra === true || (extra && typeof extra === 'object')) lines.push(`${inner}[key: string]: unknown;\n`);
  return `{\n${lines.join('')}${indent}}`;
}

/** The whole declaration file for `connectors`, sorted by slug and action path. */
export function renderConnectorTypes(connectors: TypedCatalogConnector[]): string {
  const body = [...connectors]
    .sort((a, b) => a.slug.localeCompare(b.slug))
    .map((connector) => {
      const actions = [...connector.actions]
        .sort((a, b) => a.path.localeCompare(b.path))
        .map((action) => {
          const pad = '      ';
          const args = action.inputSchema ? schemaToTs(action.inputSchema, action.inputSchema, `${pad}  `) : 'unknown';
          const result = action.outputSchema
            ? schemaToTs(action.outputSchema, action.outputSchema, `${pad}  `)
            : 'unknown';
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
    "declare module '@kortix/sdk' {\n" +
    '  interface ConnectorActionRegistry {\n' +
    body +
    '  }\n' +
    '}\n'
  );
}
