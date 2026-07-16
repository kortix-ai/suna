// local-docker snapshot adapter: "build" = docker build against the local
// daemon, tag = the content-addressed snapshot name, no registry push. Mirrors
// e2b.test.ts / daytona-errors.test.ts's mocked-transport shape.
import { beforeEach, describe, expect, mock, test } from 'bun:test';

process.env.ALLOWED_SANDBOX_PROVIDERS = 'local-docker';
process.env.KORTIX_URL = 'https://api.example.com';
process.env.INTERNAL_KORTIX_ENV = 'dev';
process.env.FRONTEND_URL = 'https://app.example.com';
process.env.LOCAL_DOCKER_NETWORK = 'kortix-local-docker-test';

let stagedContexts: Array<{ snapshotName: string; userDockerfile: string }> = [];

mock.module('../build-context', () => ({
  DEFAULT_CPU: 2,
  DEFAULT_MEMORY_GB: 6,
  DEFAULT_DISK_GB: 20,
  KORTIX_ENTRYPOINT: '/usr/local/bin/kortix-entrypoint',
  stageBuildContext: async (snapshotName: string, userDockerfile: string) => {
    stagedContexts.push({ snapshotName, userDockerfile });
    return {
      contextDir: '/tmp/kortix-local-docker-adapter-test-does-not-exist',
      composedPath: '/tmp/kortix-local-docker-adapter-test-does-not-exist/.kortix-snapshot.Dockerfile',
      dockerfileName: '.kortix-snapshot.Dockerfile',
    };
  },
  stageAgentBinaryGz: async () => {
    throw new Error('stageAgentBinaryGz is not used by the local-docker adapter test');
  },
}));

function normalizeTag(name: string): string {
  return name.includes(':') ? name : `${name}:latest`;
}

function dockerError(statusCode: number, message: string): Error {
  const err = new Error(message) as Error & { statusCode: number };
  err.statusCode = statusCode;
  return err;
}

class FakeDocker {
  images = new Set<string>();
  buildImageCalls: Array<{ context: unknown; opts: Record<string, unknown> }> = [];
  buildErrorMessage: string | null = null;
  buildThrows: Error | null = null;

  modem = {
    followProgress: (
      _stream: unknown,
      done: (err: Error | null, output: Array<Record<string, unknown>>) => void,
      onProgress: (event: Record<string, unknown>) => void,
    ) => {
      onProgress({ stream: 'Step 1/12 : FROM ubuntu:24.04\n' });
      if (this.buildErrorMessage) {
        const frame = { error: this.buildErrorMessage, errorDetail: { message: this.buildErrorMessage } };
        onProgress(frame);
        done(null, [{ stream: 'Step 1/12 : FROM ubuntu:24.04\n' }, frame]);
        return;
      }
      onProgress({ stream: 'Successfully tagged image\n' });
      done(null, [{ stream: 'ok' }]);
    },
  };

  async buildImage(context: unknown, opts: Record<string, unknown>) {
    this.buildImageCalls.push({ context, opts });
    if (this.buildThrows) throw this.buildThrows;
    if (!this.buildErrorMessage) this.images.add(normalizeTag(opts.t as string));
    return 'fake-build-stream';
  }

  getImage(name: string) {
    const tag = normalizeTag(name);
    return {
      inspect: async () => {
        if (!this.images.has(tag)) throw dockerError(404, `No such image: ${tag}`);
        return { Id: `sha256:${tag}` };
      },
      remove: async () => {
        if (!this.images.has(tag)) throw dockerError(404, `No such image: ${tag}`);
        this.images.delete(tag);
      },
    };
  }

  async listImages() {
    return [...this.images].map((tag) => ({ RepoTags: [tag] }));
  }
}

const { __setDockerClientForTest } = await import('../../platform/providers/local-docker');
const { localDockerSnapshotProvider } = await import('./local-docker');
const { getSandboxProvider } = await import('./index');

let fakeDocker: FakeDocker;

beforeEach(() => {
  fakeDocker = new FakeDocker();
  __setDockerClientForTest(fakeDocker);
  stagedContexts = [];
});

describe('local-docker snapshot adapter — registry', () => {
  test('is registered under the "local-docker" id', () => {
    expect(getSandboxProvider('local-docker')).toBe(localDockerSnapshotProvider);
    expect(localDockerSnapshotProvider.id).toBe('local-docker');
  });
});

describe('local-docker snapshot adapter — buildSnapshot', () => {
  test('docker-builds the composed context and tags it with the content-addressed snapshot name', async () => {
    await localDockerSnapshotProvider.buildSnapshot({
      snapshotName: 'kortix-default-abc123',
      userDockerfile: 'FROM ubuntu:24.04\n',
      spec: {},
      slug: 'default',
      isShared: true,
    });

    expect(stagedContexts[0]!.snapshotName).toBe('kortix-default-abc123');
    const call = fakeDocker.buildImageCalls[0]!;
    expect(call.opts.t).toBe('kortix-default-abc123');
    expect(call.opts.dockerfile).toBe('.kortix-snapshot.Dockerfile');
    expect(await localDockerSnapshotProvider.getSnapshotState('kortix-default-abc123')).toBe('active');
  });

  test('streams build log lines to the tap', async () => {
    const lines: string[] = [];
    await localDockerSnapshotProvider.buildSnapshot(
      { snapshotName: 'kortix-tpl-xyz', userDockerfile: 'FROM ubuntu:24.04\n', spec: {}, slug: 'custom' },
      { onLine: (line) => lines.push(line) },
    );
    expect(lines).toContain('Step 1/12 : FROM ubuntu:24.04');
    expect(lines).toContain('Successfully tagged image');
  });

  test('throws when the build stream reports an error frame even though the HTTP response was 200', async () => {
    fakeDocker.buildErrorMessage = "The command '/bin/sh -c apt-get install -y bogus-package' returned a non-zero code: 100";
    await expect(
      localDockerSnapshotProvider.buildSnapshot({
        snapshotName: 'kortix-tpl-broken',
        userDockerfile: 'FROM ubuntu:24.04\nRUN apt-get install -y bogus-package\n',
        spec: {},
        slug: 'custom',
      }),
    ).rejects.toThrow(/bogus-package/);
    expect(await localDockerSnapshotProvider.getSnapshotState('kortix-tpl-broken')).toBe('missing');
  });

  test('propagates a hard daemon error (e.g. socket unreachable) from buildImage itself', async () => {
    fakeDocker.buildThrows = new Error('connect ECONNREFUSED /var/run/docker.sock');
    await expect(
      localDockerSnapshotProvider.buildSnapshot({
        snapshotName: 'kortix-tpl-nodaemon',
        userDockerfile: 'FROM ubuntu:24.04\n',
        spec: {},
        slug: 'custom',
      }),
    ).rejects.toThrow(/ECONNREFUSED/);
  });
});

describe('local-docker snapshot adapter — getSnapshotState / deleteSnapshot / listSnapshots', () => {
  test('missing image reports "missing"', async () => {
    expect(await localDockerSnapshotProvider.getSnapshotState('kortix-default-never-built')).toBe('missing');
  });

  test('deleteSnapshot removes the local image tag; a repeat delete is a no-op', async () => {
    await localDockerSnapshotProvider.buildSnapshot({
      snapshotName: 'kortix-default-todelete',
      userDockerfile: 'FROM ubuntu:24.04\n',
      spec: {},
      slug: 'default',
    });
    expect(await localDockerSnapshotProvider.getSnapshotState('kortix-default-todelete')).toBe('active');
    await localDockerSnapshotProvider.deleteSnapshot('kortix-default-todelete');
    expect(await localDockerSnapshotProvider.getSnapshotState('kortix-default-todelete')).toBe('missing');
    await expect(localDockerSnapshotProvider.deleteSnapshot('kortix-default-todelete')).resolves.toBeUndefined();
  });

  test('listSnapshots only returns Kortix-managed image tags (reapable prefixes)', async () => {
    await localDockerSnapshotProvider.buildSnapshot({
      snapshotName: 'kortix-default-listme',
      userDockerfile: 'FROM ubuntu:24.04\n',
      spec: {},
      slug: 'default',
    });
    fakeDocker.images.add('ubuntu:24.04'); // an unrelated base image must be excluded
    const names = (await localDockerSnapshotProvider.listSnapshots()).map((s) => s.name);
    expect(names).toContain('kortix-default-listme');
    expect(names).not.toContain('ubuntu');
  });
});
