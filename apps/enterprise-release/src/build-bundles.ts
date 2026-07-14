#!/usr/bin/env bun

import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { materializePlatformBundle, materializeSupabaseBundle } from './bundles.ts';

const flags = parseFlags(process.argv.slice(2));
const version = required(flags, 'version');
const output = resolve(required(flags, 'output-dir'));
mkdirSync(output, { recursive: true, mode: 0o700 });
const platform = materializePlatformBundle(join(output, 'platform'), version);
const supabase = materializeSupabaseBundle(join(output, 'supabase'), version);
process.stdout.write(`${JSON.stringify({ version, output, platform, supabase })}\n`);

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
