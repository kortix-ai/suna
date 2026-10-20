import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  isLocalUiFile,
  listWhiteLabelTestFiles,
  scanConvexBoundary,
  scanConvexSource,
  scanSource,
  scanTestSource,
  scanWhiteLabelBoundary,
  scanWhiteLabelTestBoundary,
} from '../../scripts/sdk-boundary.mjs';

describe('white-label SDK boundary', () => {
  test('detects runtime imports, URLs, legacy stores, raw fetches, and native controls', () => {
    const fixture = `
      import { createClient } from '@opencode-ai/sdk';
      import { stream } from '@kortix/sdk/event-stream';
      const legacy = 'server-store';
      const runtime = '/p/sandbox-1/8000/global/event';
      session.previewUrl(3000);
      fetch('/api/kortix/projects');
      export const View = () => <button><Loader2 className="animate-spin" /></button>;
      import { Button } from '@/components/ui/button';
      import { Card } from './ui/card';
      import { X } from 'lucide-react';
      import { Slot } from 'radix-ui';
      import { toast } from 'sonner';
    `;

    expect(
      new Set(scanSource(fixture).map((violation) => violation.rule)),
    ).toEqual(
      new Set([
        'opencode-package',
        'direct-runtime-import',
        'legacy-runtime-store',
        'runtime-proxy-url',
        'runtime-url-api',
        'opencode-rest-path',
        'provider-term',
        'raw-kortix-fetch',
        'native-control',
        'spinner-icon',
        'local-ui-import',
        'foreign-ui-kit',
        'direct-toast',
      ]),
    );
  });

  test('permits @kortix/ui imports and the sonner toast host', () => {
    const fixture = `
      import { Button } from '@kortix/ui/button';
      import { SessionThread } from '@kortix/ui/session';
      import { errorToast } from '@kortix/ui/toast';
      import { Toaster } from 'sonner';
      import { XIcon } from '@phosphor-icons/react';
    `;

    expect(scanSource(fixture)).toEqual([]);
  });

  test('rejects the Dialog primitive and permits Modal and ConfirmDialog', () => {
    const fixture = `
      import { Dialog, DialogContent } from '@kortix/ui/dialog';
      import { Modal, ModalContent } from '@kortix/ui/modal';
      import { ConfirmDialog } from '@kortix/ui/confirm-dialog';
    `;

    expect(scanSource(fixture).map((violation) => [violation.rule, violation.match])).toEqual([
      ['dialog-primitive', "'@kortix/ui/dialog'"],
    ]);
  });

  test('rejects any file under src/components/ui', () => {
    const root = resolve(import.meta.dir, '../../src/components/ui');

    expect(isLocalUiFile(resolve(root, 'button.tsx'))).toBe(true);
    expect(isLocalUiFile(resolve(root, '../chat/scope-bar.tsx'))).toBe(false);
  });

  test('permits the documented same-origin BFF routes', () => {
    const fixture = `
      fetch('/api/auth/sign-in/email');
      fetch('/api/preview-url');
      fetch('/api/session-model?projectId=p');
    `;

    expect(scanSource(fixture)).toEqual([]);
    expect(scanSource(`fetch('/api/mode');`).map((v) => v.rule)).toEqual(['raw-kortix-fetch']);
  });

  test('Convex imports the SDK only in "use node" files and never fetches Kortix itself', () => {
    const node = `"use node";\nimport { createScopedKortix } from '@kortix/sdk/server';`;
    const plain = `import { createScopedKortix } from '@kortix/sdk/server';\nfetch('https://api.kortix.com/v1/projects');`;

    expect(scanConvexSource(node)).toEqual([]);
    expect(scanConvexSource(plain).map((v) => v.rule)).toEqual(['convex-sdk-outside-node', 'raw-kortix-fetch']);
    // A literal third-party prefix (Stripe) is allowed; a variable target is not.
    expect(scanConvexSource('fetch(`https://api.stripe.com/v1/${p}`);')).toEqual([]);
    expect(scanConvexSource('fetch(url);').map((v) => v.rule)).toEqual(['raw-kortix-fetch']);
    expect(scanConvexBoundary()).toEqual([]);
  });

  test('browser code cannot reach a credential-bearing SDK entry or open its own transport', () => {
    const fixture = `
      'use client';
      import { createScopedKortix, forwardKortixRequest } from '@kortix/sdk/server';
      const es = new EventSource('/api/kortix/projects/p/sessions/s/events');
      const xhr = new XMLHttpRequest();
      const ws = new WebSocket('wss://api.kortix.com/v1/p/x');
      const f = globalThis['fetch'];
      window.fetch('/api/kortix/projects');
      import { cn } from '@kortix/ui/lib/utils';
    `;
    expect(scanSource(fixture).map((v) => v.rule)).toEqual([
      'client-server-sdk',
      'raw-transport',
      'raw-transport',
      'raw-transport',
      'raw-transport',
      'raw-transport',
      'raw-kortix-fetch',
      'deep-ui-entry',
    ]);
    // The server routes are where @kortix/sdk/server belongs.
    expect(scanSource(`import { forwardKortixRequest } from '@kortix/sdk/server';`, { client: false })).toEqual([]);
    expect(scanSource(`import { cn } from '@kortix/ui';`)).toEqual([]);
  });

  test('a tagged-template fetch and a namespaced transport constructor are caught everywhere', () => {
    const tagged = 'await fetch`/api/kortix/projects`;';
    const namespaced = "const es = new window.EventSource('/api/kortix/x'); new globalThis . WebSocket('wss://x');";
    expect(scanSource(tagged).map((v) => v.rule)).toEqual(['raw-kortix-fetch']);
    expect(scanSource(tagged, { client: false }).map((v) => v.rule)).toEqual(['raw-kortix-fetch']);
    expect(scanConvexSource(tagged).map((v) => v.rule)).toEqual(['raw-kortix-fetch']);
    expect(scanSource(namespaced).map((v) => v.rule)).toEqual(['raw-transport', 'raw-transport']);
    expect(scanConvexSource(namespaced).map((v) => v.rule)).toEqual(['raw-transport', 'raw-transport']);
  });

  test('Convex catches a dynamic import or require of the SDK outside "use node"', () => {
    const fixture = `const m = await import('@kortix/sdk/server');\nconst r = require("@kortix/sdk");`;
    expect(scanConvexSource(fixture).map((v) => v.rule)).toEqual([
      'convex-sdk-outside-node',
      'convex-sdk-outside-node',
    ]);
  });

  test('only the public SDK entries pass: deprecated and internal subpaths are refused', () => {
    for (const entry of ['api-client', 'platform-client', 'instance-routes', 'internal/managed-storage', 'auth', 'config', 'session/url', 'turns']) {
      expect([entry, scanSource(`import x from '@kortix/sdk/${entry}';`).map((v) => v.rule)]).toEqual([entry, ['direct-runtime-import']]);
      expect([entry, scanConvexSource(`"use node";\nimport x from '@kortix/sdk/${entry}';`).map((v) => v.rule)]).toEqual([
        entry,
        ['direct-runtime-import'],
      ]);
    }
    const ok = `import a from '@kortix/sdk';\nimport b from '@kortix/sdk/react';\nimport c from '@kortix/sdk/genui/react';`;
    expect(scanSource(ok)).toEqual([]);
    expect(scanSource(`import { f } from '@kortix/sdk/server';`, { client: false })).toEqual([]);
  });

  test('an aliased fetch, a raw HTTP client or a backtick server import is refused', () => {
    const client = [
      "const f = fetch; f('https://api.kortix.com/v1/accounts/me');",
      "fetch.call(null, 'https://api.kortix.com/v1/accounts/me');",
      "navigator.sendBeacon('https://api.kortix.com/v1/x');",
      "import axios from 'axios';",
    ];
    expect(client.map((src) => scanSource(src).map((v) => v.rule))).toEqual([
      ['aliased-fetch'],
      ['aliased-fetch'],
      ['raw-transport-import'],
      ['raw-transport-import'],
    ]);
    expect(scanSource('const m = await import(`@kortix/sdk/server`);').map((v) => v.rule)).toEqual(['client-server-sdk']);
    const convex = [`"use node";\nimport https from 'node:https';`, `"use node";\nconst f = fetch;\nawait f(url);`];
    expect(convex.map((src) => scanConvexSource(src).map((v) => v.rule))).toEqual([['raw-transport-import'], ['aliased-fetch']]);
  });

  test('detects provider names embedded inside legacy identifiers', () => {
    const fixture = `useCanonicalOpenCodeSession(projectId);`;
    expect(scanSource(fixture).map((violation) => violation.rule)).toContain(
      'provider-term',
    );
  });

  test('rejects dynamic fetch targets in client code', () => {
    const fixture = `fetch(resolveRuntimeEndpoint(projectId));`;
    expect(scanSource(fixture).map((violation) => violation.rule)).toContain(
      'raw-kortix-fetch',
    );
  });

  test('rejects raw transport calls in server code', () => {
    const fixture = `fetch(upstreamUrl, { headers: { authorization } });`;
    expect(
      scanSource(fixture, { client: false }).map((violation) => violation.rule),
    ).toContain('raw-kortix-fetch');
  });

  test('rejects raw Kortix transport in application tests', () => {
    const fixture = `
      await fetch(app.baseUrl + '/api/kortix/projects');
      const result = await fetch(\`\${app.baseUrl}/api/kortix/p/\${runtime}/8000/status\`);
    `;

    expect(scanTestSource(fixture).map((violation) => violation.rule)).toEqual([
      'test-raw-kortix-transport',
      'test-raw-kortix-transport',
    ]);
  });

  test('rejects SDK source imports in application tests', () => {
    const fixture = `
      import { createScopedKortix } from '../../../packages/sdk/src/node/server';
    `;

    expect(scanTestSource(fixture).map((violation) => violation.rule)).toEqual([
      'test-sdk-internal-import',
    ]);
  });

  test('the complete client stays inside the SDK and @kortix/ui boundaries', () => {
    expect(scanWhiteLabelBoundary()).toEqual([]);
  });

  test('all application tests use the SDK for Kortix calls', () => {
    expect(scanWhiteLabelTestBoundary()).toEqual([]);
  });

  test('the boundary includes the local tests', () => {
    // The repository's SDK-only Playwright spec was deleted in the testing
    // reset (2026-10-16); a new white-label or sdk-only spec joins by name.
    const files = listWhiteLabelTestFiles();

    expect(files.some((path) => path.endsWith('/tests/unit/proxy-policy.test.ts'))).toBe(true);
  });
});
