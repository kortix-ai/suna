import { describe, expect, test } from 'bun:test';
import { RUNTIME_ARTIFACTS } from '../snapshots/templates';
import { metaRuntimeArtifacts } from '../snapshots/runtime-images';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const repoRoot = resolve(import.meta.dir, '../../../..');

describe('API image sandbox runtime artifacts', () => {
  test('copies every file staged by the runtime snapshot builder', () => {
    const dockerfile = readFileSync(resolve(repoRoot, 'apps/api/Dockerfile'), 'utf8');

    expect(dockerfile).toContain('COPY apps/sandbox/MACHINE.md ./apps/sandbox/MACHINE.md');
    // The daemon fingerprint hashes the compile recipe; a missing input fails
    // every template listing (ENOENT).
    expect(dockerfile).toContain(
      'COPY apps/kortix-sandbox-agent-server/scripts/build.sh ./apps/kortix-sandbox-agent-server/scripts/build.sh',
    );
  });

  test('refreshes the compiled agent time after the final source copy', () => {
    const dockerfile = readFileSync(resolve(repoRoot, 'apps/api/Dockerfile'), 'utf8');
    const sourceCopy = dockerfile.lastIndexOf(
      'COPY apps/kortix-sandbox-agent-server/src ./apps/kortix-sandbox-agent-server/src',
    );
    const artifactRefresh = dockerfile.lastIndexOf(
      'touch apps/kortix-sandbox-agent-server/dist/kortix-agent',
    );

    expect(sourceCopy).toBeGreaterThan(-1);
    expect(artifactRefresh).toBeGreaterThan(sourceCopy);
  });

  test('runtime SDK keeps its node_modules link to @kortix/llm-catalog', () => {
    // The context copy has no node_modules (.dockerignore); the API crash-looped
    // on "Cannot find module '@kortix/llm-catalog/lite'" from the SDK.
    const dockerfile = readFileSync(resolve(repoRoot, 'apps/api/Dockerfile'), 'utf8');
    const runtime = dockerfile.slice(dockerfile.lastIndexOf('\nFROM '));
    expect(runtime).toContain('COPY --from=deps /app/packages/sdk ./packages/sdk');
    expect(runtime).not.toMatch(/^COPY packages\/sdk \.\/packages\/sdk$/m);
  });

  test('a package copied piecemeal keeps the node_modules links to its workspace dependencies', () => {
    // 2026-10-11: manifest-schema gained a runtime import of @kortix/shared; the
    // runtime stage copied only its src, so dev API tasks exited at boot with
    // "Cannot find module '@kortix/shared/app-config'". Same class as the SDK
    // link above.
    const dockerfile = readFileSync(resolve(repoRoot, 'apps/api/Dockerfile'), 'utf8');
    const runtime = dockerfile.slice(dockerfile.lastIndexOf('\nFROM '));
    const piecemeal = [...runtime.matchAll(/^COPY --from=deps \/app\/packages\/([\w-]+)\/src /gm)].map((m) => m[1]!);
    expect(piecemeal.length).toBeGreaterThan(3);
    const missing = piecemeal.filter((name) => {
      const manifest = JSON.parse(readFileSync(resolve(repoRoot, 'packages', name, 'package.json'), 'utf8'));
      const deps: Record<string, string> = { ...manifest.dependencies, ...manifest.peerDependencies };
      const workspaceDeps = Object.values(deps).some((version) => version.startsWith('workspace:'));
      return workspaceDeps && !runtime.includes(`COPY --from=deps /app/packages/${name}/node_modules ./packages/${name}/node_modules`);
    });
    expect(missing).toEqual([]);
  });

  test('copies every migration runner dependency into the self-host image', () => {
    const dockerfile = readFileSync(resolve(repoRoot, 'apps/api/Dockerfile'), 'utf8');
    const scriptsDir = resolve(repoRoot, 'packages/db/scripts');
    const pending = ['migrate.ts'];
    const runnerFiles = new Set<string>();
    while (pending.length > 0) {
      const file = pending.pop() as string;
      if (runnerFiles.has(file)) continue;
      runnerFiles.add(file);
      const source = readFileSync(resolve(scriptsDir, file), 'utf8');
      for (const match of source.matchAll(/from '\.\/([\w-]+)'/g)) {
        pending.push(`${match[1]}.ts`);
      }
    }

    expect(runnerFiles.size).toBeGreaterThan(1);
    for (const file of runnerFiles) {
      expect(dockerfile).toContain(
        `COPY --from=deps /app/packages/db/scripts/${file} ./packages/db/scripts/${file}`,
      );
    }
  });

  test('copies every input the image fingerprints hash into the runtime stage', () => {
    // A fingerprint input missing from the image fails every session start with
    // ENOENT at image resolve: dev 2026-11-03, `lstat '/app/packages/voice/src'`
    // after the voice runtime joined KORTIXD_SHARED_SOURCES.
    const dockerfile = readFileSync(resolve(repoRoot, 'apps/api/Dockerfile'), 'utf8');
    const runtime = dockerfile.slice(dockerfile.lastIndexOf('\nFROM '));
    const destinations = [...runtime.matchAll(/^COPY\s+(?:--from=\S+\s+)?(?:\S+\s+)+?(\S+)\s*$/gm)].map((m) =>
      m[1]!.replace(/^\.\//, '').replace(/\/$/, ''),
    );
    // Present in the image: copied itself, inside a copied directory, or a
    // directory whose contents were copied piecemeal.
    const copied = (path: string) =>
      destinations.some((dest) => path === dest || path.startsWith(`${dest}/`) || dest.startsWith(`${path}/`));
    const inputs = [...RUNTIME_ARTIFACTS, ...metaRuntimeArtifacts(repoRoot)].map((artifact) =>
      artifact.path.slice(repoRoot.length + 1),
    );
    expect(inputs.filter((path) => !copied(path))).toEqual([]);
  });
});
