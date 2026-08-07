import { readFile } from 'node:fs/promises';
import { posix, resolve, sep } from 'node:path';

export type AppSourceSpec =
  | {
      kind: 'static';
      root?: string;
      spa?: boolean;
      readinessPath?: string;
    }
  | {
      kind: 'bundle';
      installCommand?: string;
      buildCommand?: string;
      outputDir?: string;
      spa?: boolean;
      readinessPath?: string;
    }
  | {
      kind: 'dockerfile';
      dockerfile?: string;
      command: string[];
      port: number;
      readinessPath?: string;
      restartLimit?: number;
    }
  | {
      kind: 'oci_image';
      image: string;
      command?: string[];
      port: number;
      readinessPath?: string;
      restartLimit?: number;
    };

export interface NormalizedAppBuild {
  sourceKind: AppSourceSpec['kind'];
  dockerfile: string;
  runtimeSpec: Record<string, unknown>;
  sourceDir?: string;
  buildSpec: Record<string, unknown>;
}

const RELATIVE_PATH = /^(?!\/)(?![a-zA-Z]:\/)(?!.*(?:^|\/)\.\.(?:\/|$))[a-zA-Z0-9._/@+-]+(?:\/[a-zA-Z0-9._@+-]+)*$/;
const OCI_REFERENCE = /^[a-zA-Z0-9][a-zA-Z0-9._:/@-]{0,511}$/;

function relativePath(value: string, field: string): string {
  const normalized = value.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/$/, '');
  if (!normalized || !RELATIVE_PATH.test(normalized) || normalized.includes('\n')) {
    throw new Error(`${field} must be a safe relative path`);
  }
  return posix.normalize(normalized);
}

function readinessPath(value?: string): string {
  const path = value ?? '/';
  if (!path.startsWith('/') || path.includes('\r') || path.includes('\n') || path.length > 2048) {
    throw new Error('readinessPath must be an absolute HTTP path');
  }
  return path;
}

function targetPort(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 65535 || value === 7331 || value === 8080) {
    throw new Error('port must be an integer from 1 to 65535 and cannot be 7331 or 8080');
  }
  return value;
}

function command(value: string[], field = 'command'): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 128) {
    throw new Error(`${field} must contain 1 to 128 arguments`);
  }
  return value.map((item) => {
    if (!item || item.includes('\0') || item.length > 8192) {
      throw new Error(`${field} contains an invalid argument`);
    }
    return item;
  });
}

function restartLimit(value?: number): number {
  const limit = value ?? 3;
  if (!Number.isInteger(limit) || limit < 0 || limit > 20) {
    throw new Error('restartLimit must be an integer from 0 to 20');
  }
  return limit;
}

function shellRun(value: string): string {
  if (!value.trim() || value.length > 16_384 || value.includes('\0')) {
    throw new Error('build command is empty or too long');
  }
  return `RUN ${JSON.stringify(['sh', '-lc', value])}`;
}

function isWithin(root: string, child: string): boolean {
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  return child === root || child.startsWith(prefix);
}

async function loadDockerfile(sourceDir: string, requested = 'Dockerfile'): Promise<{ path: string; contents: string }> {
  const path = relativePath(requested, 'dockerfile');
  const absoluteRoot = resolve(sourceDir);
  const absolutePath = resolve(absoluteRoot, path);
  if (!isWithin(absoluteRoot, absolutePath)) throw new Error('dockerfile escapes the source directory');
  const contents = await readFile(absolutePath, 'utf8');
  if (!contents.trim()) throw new Error('Dockerfile is empty');
  if (Buffer.byteLength(contents) > 1024 * 1024) throw new Error('Dockerfile exceeds 1 MiB');
  return { path, contents };
}

export async function normalizeAppBuild(
  source: AppSourceSpec,
  extractedSourceDir?: string,
): Promise<NormalizedAppBuild> {
  if (source.kind !== 'oci_image' && !extractedSourceDir) {
    throw new Error(`${source.kind} deployment requires an uploaded source archive`);
  }

  switch (source.kind) {
    case 'static': {
      const root = source.root ? relativePath(source.root, 'root') : '.';
      const staticRoot = root === '.' ? '/kortix/app' : `/kortix/app/${root}`;
      return {
        sourceKind: source.kind,
        sourceDir: extractedSourceDir,
        dockerfile: [
          'FROM alpine:3.22',
          'WORKDIR /kortix/app',
          'COPY . /kortix/app',
        ].join('\n'),
        runtimeSpec: {
          static_root: staticRoot,
          spa: source.spa ?? false,
          readiness_path: readinessPath(source.readinessPath),
        },
        buildSpec: { root, spa: source.spa ?? false },
      };
    }
    case 'bundle': {
      const install = source.installCommand ?? 'corepack enable && pnpm install --frozen-lockfile';
      const build = source.buildCommand ?? 'pnpm build';
      const outputDir = relativePath(source.outputDir ?? 'dist', 'outputDir');
      return {
        sourceKind: source.kind,
        sourceDir: extractedSourceDir,
        dockerfile: [
          'FROM node:22-bookworm-slim AS build',
          'WORKDIR /source',
          'COPY . /source',
          shellRun(install),
          shellRun(build),
          'FROM alpine:3.22',
          'WORKDIR /kortix/app',
          `COPY --from=build /source/${outputDir} /kortix/app/public`,
        ].join('\n'),
        runtimeSpec: {
          static_root: '/kortix/app/public',
          spa: source.spa ?? true,
          readiness_path: readinessPath(source.readinessPath),
        },
        buildSpec: {
          installCommand: install,
          buildCommand: build,
          outputDir,
          spa: source.spa ?? true,
        },
      };
    }
    case 'dockerfile': {
      const loaded = await loadDockerfile(extractedSourceDir!, source.dockerfile);
      return {
        sourceKind: source.kind,
        sourceDir: extractedSourceDir,
        dockerfile: loaded.contents,
        runtimeSpec: {
          command: command(source.command),
          target_port: targetPort(source.port),
          readiness_path: readinessPath(source.readinessPath),
          restart_limit: restartLimit(source.restartLimit),
        },
        buildSpec: { dockerfile: loaded.path },
      };
    }
    case 'oci_image': {
      if (!OCI_REFERENCE.test(source.image) || source.image.includes('\n')) {
        throw new Error('image must be a valid public OCI image reference');
      }
      const appCommand = source.command ? command(source.command) : [];
      if (appCommand.length === 0) {
        throw new Error('OCI image deployments require command because kortix-appd owns ENTRYPOINT');
      }
      return {
        sourceKind: source.kind,
        dockerfile: `FROM ${source.image}`,
        runtimeSpec: {
          command: appCommand,
          target_port: targetPort(source.port),
          readiness_path: readinessPath(source.readinessPath),
          restart_limit: restartLimit(source.restartLimit),
        },
        buildSpec: { image: source.image },
      };
    }
  }
}
