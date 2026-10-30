import { afterEach, describe, expect, test } from 'bun:test';

import {
  peekFileAvailability,
  probeFileAvailability,
  resetFileAvailability,
  type ProbeDeps,
} from './file-availability';

// Injected, never `mock.module`: the mock registry in this workspace is
// process-wide, so faking `@kortix/sdk/react` here would break every sibling
// suite that imports a key the fake happens to omit.
const reads: string[] = [];

function deps(read: (path: string) => Promise<unknown> = async () => 'contents'): ProbeDeps {
  return {
    resolve: async (path) => path,
    read: (path) => {
      reads.push(path);
      return read(path);
    },
  };
}

const enoent = async () => {
  throw new Error('ENOENT');
};

afterEach(() => {
  resetFileAvailability();
  reads.length = 0;
});

describe('peekFileAvailability', () => {
  test('an unprobed path is unknown, so the affordance stays optimistic', () => {
    expect(peekFileAvailability('src/app.ts')).toBe('unknown');
  });
});

describe('probeFileAvailability', () => {
  test('a readable file is available', async () => {
    expect(await probeFileAvailability('src/app.ts', deps())).toBe('available');
    expect(peekFileAvailability('src/app.ts')).toBe('available');
  });

  test('a file the runtime cannot produce is missing', async () => {
    // The reported case: the agent deleted build_comp_xlsx.py, and the row
    // announcing the deletion still rendered it as a live button.
    expect(await probeFileAvailability('build_comp_xlsx.py', deps(enoent))).toBe('missing');
    expect(peekFileAvailability('build_comp_xlsx.py')).toBe('missing');
  });

  test('the resolved path is what gets read, not the raw one', async () => {
    // The other half of the bug: the panel takes project-relative paths and
    // this span was handing it `/workspace/…` verbatim.
    const d: ProbeDeps = {
      resolve: async (p) => p.replace(/^\/workspace\//, ''),
      read: async (p) => {
        reads.push(p);
        return 'contents';
      },
    };
    await probeFileAvailability('/workspace/src/app.ts', d);
    expect(reads).toEqual(['src/app.ts']);
  });

  test('a verdict is cached — a path repeated down a long thread costs one read', async () => {
    await probeFileAvailability('src/app.ts', deps());
    await probeFileAvailability('src/app.ts', deps());
    await probeFileAvailability('src/app.ts', deps());
    expect(reads).toEqual(['src/app.ts']);
  });

  test('concurrent probes for one path share a single read', async () => {
    const d = deps();
    const verdicts = await Promise.all([
      probeFileAvailability('src/app.ts', d),
      probeFileAvailability('src/app.ts', d),
      probeFileAvailability('src/app.ts', d),
    ]);
    expect(verdicts).toEqual(['available', 'available', 'available']);
    expect(reads).toEqual(['src/app.ts']);
  });

  test('a missing verdict is cached too — a dead path is not re-asked', async () => {
    await probeFileAvailability('gone.py', deps(enoent));
    await probeFileAvailability('gone.py', deps(enoent));
    expect(reads).toEqual(['gone.py']);
  });

  test('verdicts are per path, not shared', async () => {
    const d = deps(async (path) => {
      if (path === 'gone.py') throw new Error('ENOENT');
      return 'contents';
    });
    expect(await probeFileAvailability('gone.py', d)).toBe('missing');
    expect(await probeFileAvailability('src/app.ts', d)).toBe('available');
  });

  test('a resolver failure is missing, not a crash', async () => {
    const d: ProbeDeps = {
      resolve: async () => {
        throw new Error('no sandbox');
      },
      read: async () => 'contents',
    };
    expect(await probeFileAvailability('src/app.ts', d)).toBe('missing');
  });
});
