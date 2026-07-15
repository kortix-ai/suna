#!/usr/bin/env bun

import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { materializeAppBundle, type AppImageRole } from './bundles.ts';
import { materializeSupabaseBundle } from './bundles.ts';

const flags = parseFlags(process.argv.slice(2));
const version = required(flags, 'version');
const output = resolve(required(flags, 'output-dir'));
mkdirSync(output, { recursive: true, mode: 0o700 });
// The app bundle needs the three app image digests it locks. They are the same
// digest-pinned refs generate-manifest.ts consumes; the release pipeline passes
// them here too. The bundle is emitted under `platform/` so the release CI's
// existing `tar output/platform` step (→ the platform_bundle artifact slot)
// keeps working unchanged — the slot now carries the app bundle, not Terraform.
const imageDigests = Object.fromEntries((['api', 'frontend', 'gateway'] as const).map((role) => {
  const source = required(flags, `${role}-image`);
  const digest = source.match(/@(sha256:[a-f0-9]{64})$/)?.[1];
  if (!digest) throw new Error(`--${role}-image must be digest-pinned`);
  return [role, digest];
})) as Record<AppImageRole, string>;
const app = materializeAppBundle(join(output, 'platform'), version, imageDigests);
const supabase = materializeSupabaseBundle(join(output, 'supabase'), version);
process.stdout.write(`${JSON.stringify({ version, output, app, supabase })}\n`);

function parseFlags(args: string[]): Map<string, string> {
  const result = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!name?.startsWith('--') || !value || value.startsWith('--')) throw new Error(`invalid argument near ${name ?? '<end>'}`);
    if (result.has(name.slice(2))) throw new Error(`duplicate option ${name}`);
    result.set(name.slice(2), value);
  }
  return result;
}

function required(flags: Map<string, string>, name: string): string {
  const value = flags.get(name);
  if (!value) throw new Error(`missing --${name}`);
  return value;
}
