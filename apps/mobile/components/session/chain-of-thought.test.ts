import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

// KRTX-775: the chain machinery (ChainOfThought, ChainOfThoughtStep,
// useReportOpen, ChainOpenContext) was dead — no mobile file rendered the
// chain, so the open-state context was a permanent no-op. This pin keeps the
// deleted symbols out and the kept disclosure surface intact.

const SOURCE = readFileSync(`${import.meta.dir}/chain-of-thought.tsx`, 'utf8');

describe('chain-of-thought module contract', () => {
  test('keeps the disclosure primitives and carries no dead chain machinery', () => {
    expect(SOURCE).toContain('export function DisclosureContent(');
    expect(SOURCE).toContain('export function DisclosureCaret(');
    for (const symbol of [
      'ChainOpenContext',
      'useReportOpen',
      'ChainOfThought',
      'ChainOfThoughtStep',
    ]) {
      expect(SOURCE.includes(symbol), symbol).toBe(false);
    }
  });
});
