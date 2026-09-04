#!/usr/bin/env bun
import { resolve } from 'node:path';
import { buildWorkerQualityPlan } from '../src/core/worker-quality';

const root = resolve(import.meta.dir, '../..');

for (const step of buildWorkerQualityPlan()) {
  console.log(`[worker-quality] ${step.name}: ${step.command.join(' ')}`);
  const child = Bun.spawn(step.command, {
    cwd: resolve(root, step.cwd ?? '.'),
    env: { ...process.env, ...step.env },
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  });
  const code = await child.exited;
  if (code !== 0) {
    throw new Error(`worker quality step ${step.name} exited with code ${code}`);
  }
}
