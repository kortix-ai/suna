import { describe, expect, test } from 'bun:test';
import { parseManifestText } from '@kortix/manifest-schema';

import { getStarterFiles } from '../index';

describe('starter passive continuation policy', () => {
  test('does not ship or register the passive continuation plugin', () => {
    const files = getStarterFiles({ projectName: 'Test Project', template: 'minimal', manifestVersion: 3 });
    const manifest = files.find((file) => file.path === 'kortix.yaml');

    expect(files.some((file) => file.path.includes('continuation'))).toBe(false);
    expect(manifest).toBeDefined();
    const { extensions } = parseManifestText(manifest!.content, 'yaml') as { extensions?: Record<string, unknown> };
    expect(Object.keys(extensions ?? {})).toEqual(['pty']);
  });
});
