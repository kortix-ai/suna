import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  listWhiteLabelTestFiles,
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
    `;

    expect(new Set(scanSource(fixture).map((violation) => violation.rule))).toEqual(
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
      ]),
    );
  });

  test('permits the documented same-origin BFF routes', () => {
    const fixture = `
      fetch('/api/auth/login');
      fetch('/api/mode');
      fetch('/api/preview-url');
      fetch('/api/usage');
    `;

    expect(scanSource(fixture)).toEqual([]);
  });

  test('detects provider names embedded inside legacy identifiers', () => {
    const fixture = `useCanonicalOpenCodeSession(projectId);`;
    expect(scanSource(fixture).map((violation) => violation.rule)).toContain('provider-term');
  });

  test('rejects dynamic fetch targets in client code', () => {
    const fixture = `fetch(resolveRuntimeEndpoint(projectId));`;
    expect(scanSource(fixture).map((violation) => violation.rule)).toContain('raw-kortix-fetch');
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

    expect(
      scanTestSource(fixture).map((violation) => violation.rule),
    ).toEqual(['test-raw-kortix-transport', 'test-raw-kortix-transport']);
  });

  test('rejects SDK source imports in application tests', () => {
    const fixture = `
      import { createScopedKortix } from '../../../packages/sdk/src/node/server';
    `;

    expect(
      scanTestSource(fixture).map((violation) => violation.rule),
    ).toEqual(['test-sdk-internal-import']);
  });

  test('the complete client stays inside the SDK and shadcn boundaries', () => {
    expect(scanWhiteLabelBoundary()).toEqual([]);
  });

  test('all application tests use the SDK for Kortix calls', () => {
    expect(scanWhiteLabelTestBoundary()).toEqual([]);
  });

  test('the boundary includes local tests and repository Playwright specs', () => {
    const files = listWhiteLabelTestFiles();

    expect(files.some((path) => path.endsWith('/tests/e2e/proxy.test.ts'))).toBe(true);
    expect(
      files.some((path) =>
        path.endsWith('/tests/e2e/specs/16-whitelabel-acp-rest-parity.spec.ts'),
      ),
    ).toBe(true);
  });

  test('project settings render the server-provided experimental catalog', () => {
    const source = readFileSync(
      resolve(import.meta.dir, '../../src/app/projects/[id]/settings/page.tsx'),
      'utf8',
    );

    expect(source).toContain('experimental_features');
    expect(source).toContain('.updateExperimentalFeature(');
    expect(source).not.toContain("'acp_runtime'");
  });
});
