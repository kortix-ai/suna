#!/usr/bin/env bun
import { resolve } from 'node:path';
import { runLocalTests } from '../src/core/local-runner';

const root = resolve(import.meta.dir, '../..');
process.exitCode = await runLocalTests(root, process.argv.slice(2));
