import { describe, expect, test } from 'bun:test';
import { idempotencyKey, normalizeDomain } from './normalize';

/**
 * Project provisioning accepts an optional company domain and queues enrichment
 * for it. The rule that matters is that enrichment is a bonus on top of project
 * creation, never a precondition: whatever the user types, the project is still
 * created. These cover the decision the handler makes about that input.
 */
function resolveProvisionDomain(raw: unknown): string | null {
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  if (!trimmed) return null;
  try {
    return normalizeDomain(trimmed);
  } catch {
    return null;
  }
}

describe('provision domain handling', () => {
  test('no domain means no enrichment', () => {
    expect(resolveProvisionDomain(undefined)).toBeNull();
    expect(resolveProvisionDomain('')).toBeNull();
    expect(resolveProvisionDomain('   ')).toBeNull();
  });

  test('a bare domain is accepted', () => {
    expect(resolveProvisionDomain('example.com')).toBe('example.com');
  });

  test('a pasted url is reduced to its apex host', () => {
    expect(resolveProvisionDomain('https://www.Example.com/pricing?utm_source=x')).toBe(
      'example.com',
    );
  });

  test('unusable input is dropped rather than raised', () => {
    for (const junk of ['localhost', 'not a domain', '127.0.0.1', 'ftp://example.com', '???']) {
      expect(resolveProvisionDomain(junk)).toBeNull();
    }
  });

  test('a non-string body value is ignored', () => {
    expect(resolveProvisionDomain(42)).toBeNull();
    expect(resolveProvisionDomain(null)).toBeNull();
    expect(resolveProvisionDomain({ domain: 'example.com' })).toBeNull();
  });

  test('the queue key ties the job to the new project', () => {
    const domain = resolveProvisionDomain('example.com');
    expect(idempotencyKey('proj-1', domain!)).toBe('proj-1:example.com');
  });

  test('two spellings of the same site produce one queue key', () => {
    const a = resolveProvisionDomain('https://www.example.com/');
    const b = resolveProvisionDomain('EXAMPLE.com');
    expect(idempotencyKey('proj-1', a!)).toBe(idempotencyKey('proj-1', b!));
  });
});
