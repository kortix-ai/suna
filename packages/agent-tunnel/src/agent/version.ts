import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const PACKAGE_NAME = '@kortix/agent-tunnel';
const MAX_LOOKUP_DEPTH = 8;

let cached: string | null = null;

function moduleDirectory(): string {
  try {
    return dirname(fileURLToPath(import.meta.url));
  } catch {
    return process.cwd();
  }
}

/**
 * Reads the shipped version out of package.json at runtime.
 *
 * It cannot be a build-time constant: scripts/publish-npm-package.sh builds the
 * bundle before scripts/stage-npm-publish.mjs stamps the release version into
 * package.json, so anything baked at build time captures the inert repo value.
 * The checked-in `version` field is deliberately not maintained by hand, the
 * same convention @kortix/sdk follows.
 *
 * Walks up from this module so it resolves in both layouts: `dist/agent-cli.js`
 * next to package.json when installed, and `src/agent/version.ts` in the repo.
 */
export function agentTunnelVersion(): string {
  if (cached !== null) return cached;

  let directory = moduleDirectory();
  for (let depth = 0; depth < MAX_LOOKUP_DEPTH; depth++) {
    try {
      const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
      if (manifest?.name === PACKAGE_NAME && typeof manifest.version === 'string') {
        const version: string = manifest.version;
        cached = version;
        return version;
      }
    } catch {
      // Keep walking: this directory has no readable manifest.
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }

  cached = 'unknown';
  return cached;
}
