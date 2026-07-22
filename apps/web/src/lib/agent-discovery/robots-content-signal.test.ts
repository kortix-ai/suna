import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

const robots = fs.readFileSync(path.join(process.cwd(), 'public', 'robots.txt'), 'utf8');

describe('robots.txt content signals', () => {
  test('declares the Kortix stance: findable and citable, not trainable', () => {
    expect(robots).toContain('Content-Signal: search=yes, ai-input=yes, ai-train=no');
  });

  test('the directive sits inside the User-agent: * group', () => {
    const lines = robots.split('\n').map((line) => line.trim());
    const groupStart = lines.indexOf('User-agent: *');
    const signal = lines.findIndex((line) => line.startsWith('Content-Signal:'));
    expect(groupStart).toBeGreaterThanOrEqual(0);
    expect(signal).toBeGreaterThan(groupStart);

    // No other User-agent group may open between the two, or the signal would
    // bind to the wrong agent group.
    const between = lines.slice(groupStart + 1, signal);
    expect(between.some((line) => line.startsWith('User-agent:'))).toBe(false);
  });
});
