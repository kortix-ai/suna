import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeAppBuild } from './spec';

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('normalizeAppBuild', () => {
  test('normalizes a static directory into an immutable static runtime', async () => {
    const build = await normalizeAppBuild(
      { kind: 'static', root: 'public', spa: true },
      '/tmp/source',
    );
    expect(build.dockerfile).toContain('COPY . /kortix/app');
    expect(build.runtimeSpec).toEqual({
      static_root: '/kortix/app/public',
      spa: true,
      readiness_path: '/',
    });
  });

  test('normalizes a JavaScript bundle with explicit reproducible commands', async () => {
    const build = await normalizeAppBuild(
      {
        kind: 'bundle',
        installCommand: 'npm ci',
        buildCommand: 'npm run build',
        outputDir: 'build',
      },
      '/tmp/source',
    );
    expect(build.dockerfile).toContain('RUN ["sh","-lc","npm ci"]');
    expect(build.dockerfile).toContain('COPY --from=build /source/build /kortix/app/public');
    expect(build.runtimeSpec).toMatchObject({ static_root: '/kortix/app/public', spa: true });
  });

  test('loads a user Dockerfile and validates its dynamic runtime contract', async () => {
    const source = await mkdtemp(join(tmpdir(), 'kortix-app-spec-'));
    cleanup.push(source);
    await writeFile(
      join(source, 'Dockerfile'),
      [
        'FROM node:22-alpine AS build',
        'WORKDIR /source',
        'FROM node:22-alpine',
        'WORKDIR /app',
        'COPY . /app',
      ].join('\n'),
    );
    const build = await normalizeAppBuild(
      { kind: 'dockerfile', command: ['node', '/app/server.js'], port: 3000 },
      source,
    );
    expect(build.dockerfile).toContain('FROM node:22-alpine');
    expect(build.runtimeSpec).toMatchObject({
      command: ['node', '/app/server.js'],
      workdir: '/app',
      target_port: 3000,
      restart_limit: 3,
    });
  });

  test('layers appd over a public OCI image', async () => {
    const build = await normalizeAppBuild({
      kind: 'oci_image',
      image: 'ghcr.io/kortix/example@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      command: ['/usr/local/bin/server'],
      port: 4000,
    });
    expect(build.dockerfile).toStartWith('FROM ghcr.io/kortix/example@sha256:');
    expect(build.sourceDir).toBeUndefined();
    expect(build.runtimeSpec).toMatchObject({ target_port: 4000 });
  });

  test('rejects traversal, reserved ports, and OCI command ambiguity', async () => {
    await expect(normalizeAppBuild({ kind: 'static', root: '../secret' }, '/tmp/source'))
      .rejects.toThrow(/safe relative path/);
    await expect(normalizeAppBuild({
      kind: 'oci_image', image: 'nginx:latest', command: ['nginx'], port: 8080,
    })).rejects.toThrow(/cannot be 7331 or 8080/);
    await expect(normalizeAppBuild({
      kind: 'oci_image', image: 'nginx:latest', port: 80,
    })).rejects.toThrow(/require command/);
  });
});
