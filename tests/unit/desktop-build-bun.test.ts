import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

// The desktop installer bundles the computer agent, which
// apps/desktop-electron/scripts/ensure-runtime.js builds with bun. A job that
// builds the app without bun fails only after the merge (learnings ledger,
// 2026-09-29: "When a build step gains a tool dependency…").
const root = resolve(import.meta.dirname, '../..');
const dir = resolve(root, '.github/workflows');

/** Job bodies: from `  <id>:` under `jobs:` to the next job at the same indent. */
function jobs(yaml: string): Array<{ id: string; body: string }> {
  const start = yaml.indexOf('\njobs:\n');
  if (start === -1) return [];
  const text = yaml.slice(start + 7);
  const heads = [...text.matchAll(/^ {2}([A-Za-z0-9_-]+):\s*$/gm)];
  return heads.map((head, i) => ({
    id: head[1],
    body: text.slice(head.index, i + 1 < heads.length ? heads[i + 1].index : undefined),
  }));
}

describe('desktop builds set up bun', () => {
  const builders = readdirSync(dir)
    .filter((file) => /\.ya?ml$/.test(file))
    .flatMap((file) =>
      jobs(readFileSync(resolve(dir, file), 'utf8'))
        .filter((job) => /ensure-runtime\.js|electron-builder/.test(job.body))
        .map((job) => ({ where: `${file} → ${job.id}`, body: job.body })),
    );

  test('at least one workflow builds the desktop app', () => {
    expect(builders.length).toBeGreaterThan(0);
  });

  test.each(builders.map((b) => [b.where, b.body] as const))('%s installs bun', (_where, body) => {
    expect(body).toContain('oven-sh/setup-bun');
  });

  // ensure-runtime.js also stages the pinned Kortix Capture engine from the
  // private kortix-ai/capture releases; a pinned lock without a token fails.
  // Every job that reads AWS secrets for a desktop build reads the token too.
  test.each(
    builders.filter((b) => b.body.includes('ensure-runtime.js') && b.body.includes('actions/aws-env')).map((b) => [b.where, b.body] as const),
  )('%s reads CAPTURE_RELEASES_TOKEN from AWS', (_where, body) => {
    expect(body).toContain('CAPTURE_RELEASES_TOKEN?');
  });
});
