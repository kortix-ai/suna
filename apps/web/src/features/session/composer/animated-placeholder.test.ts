import { describe, expect, test } from 'bun:test';

import { buildPlaceholderVariants, createSharedRotation } from './animated-placeholder';

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

describe('createSharedRotation', () => {
  function manualClock() {
    const ticks: Array<() => void> = [];
    let cancelled = 0;
    return {
      schedule: (tick: () => void) => {
        ticks.push(tick);
        return ticks.length;
      },
      cancel: () => {
        cancelled += 1;
      },
      fire: () => ticks.at(-1)?.(),
      started: () => ticks.length,
      cancelled: () => cancelled,
    };
  }

  test('two composers read the same hint after every tick', () => {
    // The instant shell and the session chat are both on screen for the
    // crossfade. Each used to count from its own mount and drew a different
    // hint over the other.
    const clock = manualClock();
    const rotation = createSharedRotation(6000, clock.schedule, clock.cancel);
    let shellSaw = -1;
    let chatSaw = -1;
    rotation.subscribe(() => (shellSaw = rotation.read()));
    clock.fire();
    clock.fire();
    rotation.subscribe(() => (chatSaw = rotation.read()));
    clock.fire();
    expect(shellSaw).toBe(3);
    expect(chatSaw).toBe(3);
    expect(clock.started()).toBe(1);
  });

  test('stops with its last subscriber and resumes where it was', () => {
    const clock = manualClock();
    const rotation = createSharedRotation(6000, clock.schedule, clock.cancel);
    const stop = rotation.subscribe(() => {});
    clock.fire();
    stop();
    expect(clock.cancelled()).toBe(1);
    rotation.subscribe(() => {});
    expect(rotation.read()).toBe(1);
    clock.fire();
    expect(rotation.read()).toBe(2);
  });
});
