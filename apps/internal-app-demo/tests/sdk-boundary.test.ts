import { describe, expect, test } from 'bun:test';
import { scanSource } from '../scripts/sdk-boundary.mjs';

describe('internal app SDK boundary', () => {
  test('refuses every fetch, even a same-origin one', () => {
    expect(scanSource(`fetch('/api/preview-url');`).map((v) => v.rule)).toEqual(['any-fetch']);
  });

  test('inherits the Lumen client rules', () => {
    const fixture = `
      import { forwardKortixRequest } from '@kortix/sdk/server';
      const es = new EventSource('https://api.kortix.com/v1/x');
      import { cn } from '@kortix/ui/lib/utils';
      import { createClient } from '@opencode-ai/sdk';
    `;
    expect(new Set(scanSource(fixture).map((v) => v.rule))).toEqual(
      new Set(['client-server-sdk', 'raw-transport', 'deep-ui-entry', 'opencode-package', 'provider-term']),
    );
  });

  test('permits the SDK client, curated @kortix/ui entries and cn from the root', () => {
    const fixture = `
      import { createKortix } from '@kortix/sdk';
      import { useSession } from '@kortix/sdk/react';
      import { cn } from '@kortix/ui';
      import { Button } from '@kortix/ui/button';
    `;
    expect(scanSource(fixture)).toEqual([]);
  });
});
