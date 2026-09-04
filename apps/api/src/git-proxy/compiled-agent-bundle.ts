import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export interface CompiledAgentBundle {
  source: string;
  sha256: string;
  size: number;
}

let bundlePromise: Promise<CompiledAgentBundle> | null = null;

function agentRoot(): string {
  return resolve(import.meta.dir, '../../../kortix-sandbox-agent-server');
}

function validateBundle(source: string): CompiledAgentBundle {
  if (!source.trim()) throw new Error('compiled sandbox daemon bundle is empty');
  if (!source.includes('kortix-sandbox-agent-server starting')) {
    throw new Error('compiled sandbox daemon bundle has no daemon entrypoint');
  }
  return {
    source,
    sha256: createHash('sha256').update(source).digest('hex'),
    size: Buffer.byteLength(source),
  };
}

async function buildDevelopmentBundle(): Promise<string> {
  const result = await Bun.build({
    entrypoints: [resolve(agentRoot(), 'src/main.ts')],
    root: agentRoot(),
    target: 'bun',
    format: 'esm',
    sourcemap: 'none',
  });
  if (!result.success || result.outputs.length !== 1) {
    const details = result.logs.map((log) => log.message).join('; ');
    throw new Error(`compiled sandbox daemon build failed${details ? `: ${details}` : ''}`);
  }
  return result.outputs[0]!.text();
}

async function loadBundle(): Promise<CompiledAgentBundle> {
  const override = process.env.KORTIX_COMPILED_AGENT_BUNDLE_PATH?.trim();
  if (override) return validateBundle(await readFile(override, 'utf8'));
  const source =
    process.env.NODE_ENV === 'production'
      ? await readFile(resolve(agentRoot(), 'dist/server.mjs'), 'utf8')
      : await buildDevelopmentBundle();
  return validateBundle(source);
}

export function getCompiledAgentBundle(): Promise<CompiledAgentBundle> {
  bundlePromise ??= loadBundle().catch((error) => {
    bundlePromise = null;
    throw error;
  });
  return bundlePromise;
}

export function resetCompiledAgentBundleForTests(): void {
  bundlePromise = null;
}
