#!/usr/bin/env bun

import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  buildCliConnectorSourceDigest,
  buildFileSha256,
} from '@kortix/shared/sandbox-runtime-artifact';

const cliRoot = resolve(import.meta.dir, '..');
const [command, rawPath, rawBinaryPath, expectedSourceDigest, target] = process.argv.slice(2);

function usage(): never {
  console.error(
    'usage: bun run scripts/sandbox-runtime-attestation.ts print-source | write <attestation-path> <binary-path> <expected-source-sha256> <target>',
  );
  process.exit(2);
}

const digest = await buildCliConnectorSourceDigest(cliRoot);

if (command === 'print-source') {
  console.log(digest);
  process.exit(0);
}

if (command !== 'write' || !rawPath || !rawBinaryPath || !expectedSourceDigest || !target) {
  usage();
}

if (digest !== expectedSourceDigest) {
  console.error(
    `CLI source changed during compilation: expected ${expectedSourceDigest}, current ${digest}`,
  );
  process.exit(1);
}

const attestationPath = resolve(process.cwd(), rawPath);
const binaryPath = resolve(process.cwd(), rawBinaryPath);
const binarySha256 = await buildFileSha256(binaryPath);
const attestation = {
  schema_version: 1,
  source_sha256: digest,
  binary_sha256: binarySha256,
  target,
};
await writeFile(attestationPath, `${JSON.stringify(attestation, null, 2)}\n`, 'utf8');
console.log(
  `Wrote ${attestationPath} (source ${digest}; binary ${binarySha256}; target ${target})`,
);
