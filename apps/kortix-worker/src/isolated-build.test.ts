import { expect, test } from 'bun:test';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, resolve } from 'node:path';

test('the Docker worker stage builds with only its declared files and locked dependencies', async () => {
  const repo = resolve(import.meta.dir, '../../..');
  const root = mkdtempSync(resolve(tmpdir(), 'kortix-pi-isolated-build-'));
  const dockerfile = readFileSync(resolve(repo, 'apps/api/Dockerfile'), 'utf8');
  const stage = dockerfile.split(' AS pi-worker\n')[1]!.split('\n# ---- Deps Stage')[0]!;
  const instructions = stage.replace(/\\\r?\n/g, ' ').split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('#'));
  const targetPath = (path: string, cwd: string) => path.startsWith('/repo')
    ? resolve(root, path.slice('/repo'.length).replace(/^\//, ''))
    : resolve(cwd, path);
  let cwd = root;
  let child: ReturnType<typeof Bun.spawn> | undefined;
  try {
    for (const instruction of instructions) {
      if (instruction.startsWith('WORKDIR ')) {
        cwd = targetPath(instruction.slice(8), cwd);
        mkdirSync(cwd, {recursive:true});
      } else if (instruction.startsWith('COPY ')) {
        const paths = instruction.slice(5).trim().split(/\s+/);
        const destination = paths.pop()!;
        for (const source of paths) {
          const from = resolve(repo, source);
          let to = targetPath(destination, cwd);
          if (!statSync(from).isDirectory() && (destination.endsWith('/') || paths.length > 1)) to = resolve(to, basename(source));
          mkdirSync(resolve(to, statSync(from).isDirectory() ? '.' : '..'), {recursive:true});
          cpSync(from, to, {recursive:true,filter:path => !['node_modules','dist','.git'].includes(basename(path))});
        }
      } else if (instruction.startsWith('RUN ')) {
        const command = Bun.spawn(['sh','-c',instruction.slice(4).replaceAll('/repo', root)], {cwd,stdout:'pipe',stderr:'pipe',timeout:25000});
        child = command;
        const [stdout,stderr,exit] = await Promise.all([new Response(command.stdout).text(),new Response(command.stderr).text(),command.exited]);
        if (exit !== 0) throw new Error(`Isolated worker stage failed (${exit}):\n${stdout}\n${stderr}`);
        child = undefined;
      } else {
        throw new Error(`Unverified Docker worker instruction: ${instruction}`);
      }
    }
    const artifact = readFileSync(resolve(root, 'apps/kortix-worker/dist/worker-runtime.mjs'), 'utf8');
    expect(artifact).toContain('kortix-worker starting');
    expect(artifact).toContain('connector_call');
    expect(artifact).not.toContain('../../../packages/sdk/src/node/server');
  } finally {
    if (child) {child.kill();await child.exited;}
    rmSync(root, {recursive:true,force:true});
  }
}, 60000);
