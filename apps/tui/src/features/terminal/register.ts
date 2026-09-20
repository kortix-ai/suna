/**
 * `<embedded-terminal>` is not a built-in OpenTUI 0.5.11 JSX tag.
 *
 * `EmbeddedTerminalRenderable` ships in `@opentui/core`, but the React
 * binding's intrinsic-element map (`@opentui/react/jsx-namespace.d.ts:40`)
 * does not list it — `box`, `text`, `input`, `scrollbox` and friends are the
 * whole set. `extend()` adds the tag to the runtime registry; the module
 * augmentation below adds it to the JSX types. Both are required: one without
 * the other is either a type error or "unknown element" at render time.
 *
 * `registerEmbeddedTerminal()` is idempotent and must run before the first
 * `<embedded-terminal>` element is created. `terminal-panel.tsx` calls it at
 * module scope, so importing the panel is enough.
 */

import { EmbeddedTerminalRenderable } from '@opentui/core';
import { extend } from '@opentui/react';

declare module '@opentui/react' {
  interface OpenTUIComponents {
    'embedded-terminal': typeof EmbeddedTerminalRenderable;
  }
}

let registered = false;

export function registerEmbeddedTerminal(): void {
  if (registered) return;
  extend({ 'embedded-terminal': EmbeddedTerminalRenderable });
  registered = true;
}

/** Test seam: `extend` is process-global, so a test asserting the first call needs this. */
export function isEmbeddedTerminalRegistered(): boolean {
  return registered;
}
