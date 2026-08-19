import { describe, expect, test } from 'bun:test';

import { buildPlaceholderVariants } from './animated-placeholder';

describe('buildPlaceholderVariants', () => {
  test('the base placeholder is always index 0 — the SSR-rendered frame', () => {
    expect(buildPlaceholderVariants('Ask anything...', true)[0]).toBe('Ask anything...');
    expect(buildPlaceholderVariants('Ask anything...', false)[0]).toBe('Ask anything...');
  });

  test('mac renders ⌘ shortcuts, other platforms render Ctrl+', () => {
    const mac = buildPlaceholderVariants('Ask anything...', true);
    const win = buildPlaceholderVariants('Ask anything...', false);
    expect(mac).toContain('Press ⌘K to open the command palette');
    expect(mac).toContain('Press ⌘, to open settings');
    expect(win).toContain('Press Ctrl+K to open the command palette');
    expect(win).toContain('Press Ctrl+, to open settings');
    expect(mac.join('\n')).not.toContain('Ctrl');
    expect(win.join('\n')).not.toContain('⌘');
  });

  test('every variant is unique — AnimatePresence keys on the string', () => {
    const variants = buildPlaceholderVariants('Ask anything...', true);
    expect(new Set(variants).size).toBe(variants.length);
  });

  test('never advertises the dropped textarea-era features', () => {
    // "Up arrow recalls your last prompt" did not survive the TipTap rebuild
    // (b841ac7d8b); the list must not claim it. Same for "modes" — Tab cycles
    // AGENTS (`cycleAgent` in composer.tsx).
    const all = buildPlaceholderVariants('Ask anything...', true).join('\n');
    expect(all).not.toContain('Up arrow');
    expect(all).not.toContain('modes');
  });
});
