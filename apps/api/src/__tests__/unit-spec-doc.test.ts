import { describe, expect, test } from 'bun:test';
import { parseSpecDocument } from '../executor/spec-doc';

const SRC = 'https://example.com/openapi';

describe('parseSpecDocument', () => {
  test('parses a JSON spec', () => {
    const doc = parseSpecDocument('{"openapi":"3.0.0","paths":{}}', SRC);
    expect(doc.openapi).toBe('3.0.0');
    expect(doc.paths).toEqual({});
  });

  test('parses a YAML spec (the common OpenAPI form)', () => {
    const yaml = ['openapi: 3.0.5', 'info:', '  title: Tugboat API', 'paths:', '  /version:', '    get: {}'].join('\n');
    const doc = parseSpecDocument(yaml, SRC);
    expect(doc.openapi).toBe('3.0.5');
    expect(doc.info.title).toBe('Tugboat API');
    expect(doc.paths['/version'].get).toEqual({});
  });

  test('strips a UTF-8 BOM before JSON', () => {
    const doc = parseSpecDocument('\uFEFF{"openapi":"3.0.0"}', SRC);
    expect(doc.openapi).toBe('3.0.0');
  });

  test('strips a UTF-8 BOM before YAML', () => {
    const doc = parseSpecDocument('\uFEFFopenapi: 3.0.0\n', SRC);
    expect(doc.openapi).toBe('3.0.0');
  });

  test('tolerates surrounding whitespace', () => {
    const doc = parseSpecDocument('\n\n  {"openapi":"3.0.0"}  \n', SRC);
    expect(doc.openapi).toBe('3.0.0');
  });

  test('rejects an empty / whitespace-only body', () => {
    expect(() => parseSpecDocument('   \n\t ', SRC)).toThrow(/is empty/);
  });

  test('rejects a JSON array root', () => {
    expect(() => parseSpecDocument('[1,2,3]', SRC)).toThrow(/did not parse to an object \(got array\)/);
  });

  test('rejects a scalar root (string / number)', () => {
    expect(() => parseSpecDocument('"just a string"', SRC)).toThrow(/got string/);
    expect(() => parseSpecDocument('42', SRC)).toThrow(/got number/);
  });

  test('rejects a YAML null root', () => {
    expect(() => parseSpecDocument('~', SRC)).toThrow(/got null/);
  });

  test('flags an HTML error page returned in place of a spec', () => {
    const html = '<!DOCTYPE html><html><body>404 Not Found</body></html>';
    expect(() => parseSpecDocument(html, SRC)).toThrow(/looks like an HTML\/XML page/);
  });

  test('rejects genuinely malformed content with the source in the message', () => {
    // Invalid in both JSON and YAML (unclosed flow mapping).
    expect(() => parseSpecDocument('{ this: is: not: valid', SRC)).toThrow(/not valid JSON or YAML/);
    expect(() => parseSpecDocument('{ this: is: not: valid', SRC)).toThrow(new RegExp(SRC.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });

  test('round-trips JSON and YAML to the same object', () => {
    const fromJson = parseSpecDocument('{"a":1,"b":["x","y"]}', SRC);
    const fromYaml = parseSpecDocument('a: 1\nb:\n  - x\n  - y\n', SRC);
    expect(fromYaml).toEqual(fromJson);
  });
});
