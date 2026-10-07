import { describe, expect, test } from 'bun:test';
import { renderConnectorTypes, type TypedCatalogConnector } from './connector-types';

/** One connector with one action whose output schema is `outputSchema`. */
function render(outputSchema: Record<string, unknown>, inputSchema: Record<string, unknown> | null = null) {
  const connectors: TypedCatalogConnector[] = [
    { slug: 'remote-mcp', actions: [{ path: 'get', inputSchema, outputSchema }] },
  ];
  return renderConnectorTypes(connectors);
}

/** `{$defs:{a:{properties:{p0..pN:{$ref:a}}}}}`: a 171-byte schema that inlined to 932 MB at fan-out 4. */
function recursive(fanOut: number) {
  const properties = Object.fromEntries(
    Array.from({ length: fanOut }, (_, i) => [`p${i}`, { $ref: '#/$defs/a' }]),
  );
  return { $defs: { a: { type: 'object', properties } }, $ref: '#/$defs/a' };
}

describe('renderConnectorTypes() with hostile output schemas', () => {
  test('a recursive $defs entry is emitted once as a named alias', () => {
    const source = render(recursive(8));
    expect(source.length).toBeLessThan(4_000);
    expect(source).toContain('type KortixConnectorDef0_a = {\n  p0?: KortixConnectorDef0_a;\n');
    expect(source).toContain('result: KortixConnectorDef0_a;');
  });

  test('a $ref with a malformed percent escape is unknown, not a URIError', () => {
    const source = render({
      type: 'object',
      properties: { x: { $ref: '#/$defs/%E0%A4%A' } },
      $defs: { 'x': { type: 'string' } },
    });
    expect(source).toContain('x?: unknown;');
  });

  test('a $ref to a prototype key is unknown', () => {
    const source = render({ type: 'object', properties: { x: { $ref: '#/$defs/constructor' } }, $defs: {} });
    expect(source).toContain('x?: unknown;');
  });

  test('a direct union or intersection cycle is broken with unknown', () => {
    const source = render({
      $defs: {
        a: { anyOf: [{ $ref: '#/$defs/b' }, { type: 'string' }] },
        b: { allOf: [{ $ref: '#/$defs/a' }, { type: 'object', properties: { n: { type: 'number' } } }] },
      },
      $ref: '#/$defs/a',
    });
    // TypeScript rejects `type A = B | string; type B = A & {…}`: the back edge's target becomes unknown.
    expect(source).toContain('type KortixConnectorDef0_a = unknown;');
    expect(source).toContain('type KortixConnectorDef1_b = KortixConnectorDef0_a & {\n  n?: number;\n};');
  });

  test('an action over the output budget is unknown and leaves no alias behind', () => {
    const properties = Object.fromEntries(
      Array.from({ length: 20_000 }, (_, i) => [`field_${i}`, { type: 'string', description: 'x'.repeat(20) }]),
    );
    const source = render({ type: 'object', properties });
    expect(source.length).toBeLessThan(2_000);
    expect(source).toContain('result: unknown;');
  });
});
