#!/usr/bin/env node

/**
 * Audit the published pi-acp session/new source path.
 *
 * Usage:
 *   node audit-pi-acp-session-new.mjs
 *   node audit-pi-acp-session-new.mjs 0.0.31 0.0.32
 *
 * The script downloads npm packages into a temporary directory. It reads the
 * TypeScript sources embedded in the published source map. It does not install
 * either package into this repository.
 */

import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const versions = process.argv.slice(2);
if (versions.length === 0) versions.push('0.0.31', '0.0.32');

function count(source, expression) {
  return [...source.matchAll(expression)].length;
}

function section(source, start, end) {
  const startIndex = source.indexOf(start);
  if (startIndex < 0) throw new Error(`missing source marker: ${start}`);

  const endIndex = source.indexOf(end, startIndex);
  if (endIndex < 0) throw new Error(`missing source marker: ${end}`);

  return source.slice(startIndex, endIndex);
}

function sourceFromMap(sourceMap, suffix) {
  const index = sourceMap.sources.findIndex((source) =>
    source.endsWith(suffix),
  );

  if (index < 0) throw new Error(`missing source map entry: ${suffix}`);

  return sourceMap.sourcesContent[index];
}

function audit(version, root) {
  const packOutput = execFileSync(
    'npm',
    ['pack', `pi-acp@${version}`, '--pack-destination', root, '--json'],
    { encoding: 'utf8' },
  );
  const [{ filename }] = JSON.parse(packOutput);
  const extractRoot = join(root, `pi-acp-${version}`);

  execFileSync('mkdir', [extractRoot]);
  execFileSync('tar', [
    '-xzf',
    join(root, filename),
    '-C',
    extractRoot,
  ]);

  const sourceMap = JSON.parse(
    readFileSync(join(extractRoot, 'package/dist/index.js.map'), 'utf8'),
  );
  const processSource = sourceFromMap(sourceMap, 'src/pi-rpc/process.ts');
  const sessionSource = sourceFromMap(sourceMap, 'src/acp/session.ts');
  const agentSource = sourceFromMap(sourceMap, 'src/acp/agent.ts');

  const spawnSource = section(
    processSource,
    'static async spawn',
    '\n  onEvent',
  );
  const managerCreateSource = section(
    sessionSource,
    'async create(params: SessionCreateParams)',
    '\n  get(sessionId',
  );
  const newSessionSource = section(
    agentSource,
    'async newSession',
    '\n  async authenticate',
  );

  const result = {
    version,
    pi_rpc_spawn: {
      child_process_spawn: count(spawnSource, /const child = spawn\(/g),
      get_state: count(spawnSource, /\.getState\(/g),
      rpc_mode: spawnSource.includes("'--mode', 'rpc'"),
      no_themes: spawnSource.includes("'--no-themes'"),
    },
    session_manager_create: {
      pi_rpc_process_spawn: count(
        managerCreateSource,
        /PiRpcProcess\.spawn\(/g,
      ),
      get_state: count(managerCreateSource, /\.getState\(/g),
    },
    acp_new_session: {
      session_manager_create: count(
        newSessionSource,
        /this\.sessions\.create\(/g,
      ),
      get_state: count(newSessionSource, /\.getState\(/g),
      get_available_models: count(
        newSessionSource,
        /\.getAvailableModels\(/g,
      ),
    },
  };

  result.total = {
    pi_child_processes: result.pi_rpc_spawn.child_process_spawn,
    get_state:
      result.pi_rpc_spawn.get_state +
      result.session_manager_create.get_state +
      result.acp_new_session.get_state,
    get_available_models: result.acp_new_session.get_available_models,
  };

  return result;
}

const root = mkdtempSync(join(tmpdir(), 'kortix-pi-acp-audit-'));

try {
  console.log(
    JSON.stringify(
      {
        package: 'pi-acp',
        versions: versions.map((version) => audit(version, root)),
      },
      null,
      2,
    ),
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
