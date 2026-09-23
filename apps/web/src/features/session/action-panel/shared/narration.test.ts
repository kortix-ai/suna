import { describe, expect, it } from 'bun:test';
import { ToolRegistry } from '../../tool/tool-renderers';
import '../../tool/tools/register';
import { familyForTool } from './narration';

// Narration and its unit tests live in `@kortix/sdk`
// (`packages/sdk/src/core/turns/segments/narration.test.ts`). This file keeps
// the one case that needs web's own tool registry.

describe('registry coverage', () => {
  it('every registered tool resolves to a family, hidden, or the fallback', () => {
    // ToolRegistry exposes its keys for this check — see Step 7.
    for (const key of ToolRegistry.keys()) {
      const family = familyForTool(key);
      expect(family).toBeTruthy();
      // 'other' is legal, but a *registered* tool landing there means the map
      // has fallen behind — surface it loudly.
      if (family === 'other') {
        throw new Error(
          `Registered tool "${key}" has no narration family — add it to @kortix/sdk core/turns/segments/narration.ts`,
        );
      }
    }
  });
});
