import { build as buildJavaScript } from 'esbuild';
import { createHash } from 'node:crypto';
import { builtinModules } from 'node:module';
import { dirname, posix, resolve } from 'node:path';
import { manifestDefaultConfigDir } from '@kortix/manifest-schema';

const behavior = new Set([
  'description',
  'mode',
  'model',
  'temperature',
  'top_p',
  'color',
  'steps',
  'hidden',
  'permission',
  'disable',
]);
export function validatePiAgentFrontmatter(fields: Record<string, unknown>, agent: string): void {
  for (const [key, value] of Object.entries(fields)) {
    if (
      (key === 'variant' && value === '') ||
      (key === 'options' &&
        value &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        Object.keys(value).length === 0)
    )
      continue;
    if (!behavior.has(key))
      throw new Error(
        `Pi agent "${agent}" behavior field "${key}" is not supported. Use its Pi source for custom hooks and tools.`,
      );
  }
}

export function resolvePiConfigDir(manifest: Record<string, unknown>): string {
  for (const key of ['pi', 'opencode']) {
    const block = manifest[key];
    if (block === undefined || block === null) continue;
    if (typeof block !== 'object' || Array.isArray(block))
      throw new Error(`${key} must be an object`);
    for (const field of Object.keys(block))
      if (field !== 'config_dir')
        throw new Error(`${key}.${field} is not supported by the Pi compiler`);
  }
  const pi = (manifest.pi as any)?.config_dir;
  const oc = (manifest.opencode as any)?.config_dir;
  if (pi !== undefined && oc !== undefined && pi !== oc)
    throw new Error('pi.config_dir and opencode.config_dir disagree');
  const value = pi ?? oc ?? manifestDefaultConfigDir(Number(manifest.kortix_version));
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value !== value.trim() ||
    value.startsWith('/') ||
    value.includes('\\') ||
    value.includes('\0') ||
    value.split('/').some((p) => p === '..' || p === '.') ||
    value.includes('//')
  )
    throw new Error('Pi config_dir must be a repository-relative directory');
  return value.replace(/\/$/, '');
}

export interface PiAgentModule {
  entry: string;
  source: string;
  sha256: string;
  dependencyLockSha256?: string;
}
const builtins = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));
const sdkRoot = resolve(import.meta.dir, '../../../../packages/sdk');
const sdkAgent = resolve(sdkRoot, 'src/core/pi/agent.ts');
function platformPackage(name: string): string | undefined {
  if (name === '@kortix/sdk/pi') return sdkAgent;
  if (name === '@earendil-works/pi-agent-core') return Bun.resolveSync(name, sdkRoot);
  const core = Bun.resolveSync('@earendil-works/pi-agent-core', sdkRoot);
  if (name === '@earendil-works/pi-ai' || name === 'typebox')
    return Bun.resolveSync(name, dirname(core));
  return undefined;
}

export async function compilePiAgentModule(input: {
  entry: string;
  files: Record<string, string>;
  dependencyRoot?: string;
  dependencyLockSha256?: string;
}): Promise<PiAgentModule> {
  if (!Object.hasOwn(input.files, input.entry))
    throw new Error(`Pi agent source "${input.entry}" is missing`);
  if (
    Object.keys(input.files).length > 256 ||
    Object.values(input.files).reduce((n, s) => n + Buffer.byteLength(s), 0) > 8 * 1024 * 1024
  )
    throw new Error('Pi agent source exceeds 256 files or 8 MiB');
  const find = (path: string) =>
    [
      path,
      ...['.ts', '.js', '.mjs', '.cjs', '.json', '/index.ts', '/index.js'].map((ext) => path + ext),
    ].find((p) => Object.hasOwn(input.files, p));
  const result = await buildJavaScript({
    entryPoints: ['kortix-pi-agent-entry'],
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    minify: true,
    sourcemap: false,
    bundle: true,
    write: false,
    logLevel: 'silent',
    plugins: [
      {
        name: 'immutable-pi-source',
        setup(build) {
          for (const namespace of ['', 'file', 'pi-entry', 'pi-project'])
            build.onResolve({ filter: /.*/, namespace }, async (args) => {
              if (args.pluginData?.kortixResolvingDependency) return;
              if (args.with?.type === 'macro')
                throw new Error('Pi agent compile-time macros are not supported');
              if (args.path === 'kortix-pi-agent-entry')
                return { path: args.path, namespace: 'pi-entry' };
              const dependencyImport =
                input.dependencyRoot && args.importer.startsWith(input.dependencyRoot + '/');
              if (
                args.namespace !== 'pi-project' &&
                args.namespace !== 'pi-entry' &&
                !dependencyImport
              )
                return;
              if (args.path === 'kortix-selected-agent')
                return { path: input.entry, namespace: 'pi-project' };
              if (builtins.has(args.path))
                return {
                  path: args.path.startsWith('node:') ? args.path : `node:${args.path}`,
                  external: true,
                };
              const platform = platformPackage(args.path);
              if (platform) return { path: platform, namespace: 'file' };
              if (dependencyImport) {
                if (args.path.startsWith('/') || args.path.includes('://'))
                  throw new Error('Pi dependency import escapes its locked package tree');
                const resolved = await build.resolve(args.path, {
                  resolveDir: dirname(args.importer),
                  kind: args.kind,
                  pluginData: { kortixResolvingDependency: true },
                });
                if (resolved.errors.length)
                  throw new Error(`Pi dependency import ${args.path} is missing from the lock`);
                const path = resolved.path;
                if (!path.startsWith(input.dependencyRoot + '/'))
                  throw new Error('Pi dependency import is not in the lock');
                return { path, namespace: 'file' };
              }
              if (args.path.startsWith('.')) {
                const path = posix.normalize(posix.join(posix.dirname(args.importer), args.path));
                if (path.startsWith('../') || path.startsWith('/'))
                  throw new Error('Pi agent import escapes its config directory');
                const match = find(path);
                if (!match) throw new Error(`Pi agent import "${args.path}" is missing`);
                return { path: match, namespace: 'pi-project' };
              }
              if (
                input.dependencyRoot &&
                !args.path.startsWith('/') &&
                !args.path.includes('://')
              ) {
                const resolved = await build.resolve(args.path, {
                  resolveDir: input.dependencyRoot,
                  kind: args.kind,
                  pluginData: { kortixResolvingDependency: true },
                });
                if (resolved.errors.length)
                  throw new Error(`Pi dependency ${args.path} is missing from the lock`);
                const path = resolved.path;
                if (path.startsWith(input.dependencyRoot + '/')) return { path, namespace: 'file' };
              }
              throw new Error(
                `Pi agent dependency "${args.path}" is not bundled. Add it to the Pi package lock.`,
              );
            });
          build.onLoad({ filter: /.*/, namespace: 'pi-entry' }, () => ({
            contents: `import factory from 'kortix-selected-agent';globalThis.__KORTIX_PI_AGENT__=factory;`,
            loader: 'js',
          }));
          build.onLoad({ filter: /.*/, namespace: 'pi-project' }, (args) => ({
            contents: input.files[args.path]!,
            loader: args.path.endsWith('.json')
              ? 'json'
              : /\.(md|txt)$/.test(args.path)
                ? 'text'
                : args.path.endsWith('.tsx')
                  ? 'tsx'
                  : args.path.endsWith('.ts')
                    ? 'ts'
                    : 'js',
          }));
        },
      },
    ],
  });
  if (result.outputFiles?.length !== 1)
    throw new Error('Pi agent must compile into one JavaScript module');
  const source = result.outputFiles[0]!.text;
  return {
    entry: input.entry,
    source,
    sha256: createHash('sha256').update(source).digest('hex'),
    ...(input.dependencyLockSha256 ? { dependencyLockSha256: input.dependencyLockSha256 } : {}),
  };
}
