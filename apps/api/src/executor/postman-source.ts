import { parseSpecDocument } from './spec-doc';

export type PostmanSourceDocumentKind = 'openapi' | 'postman';

export interface PostmanSourceDocument {
  namespace: string;
  kind: PostmanSourceDocumentKind;
  source: string;
  doc: any;
}

export type PostmanSourceLoader = (source: string) => Promise<string>;

export interface PostmanSourceOptions {
  githubDefaultBranch?: (owner: string, repo: string) => Promise<string>;
  postmanApiKey?: string | null;
  resolveWorkspace?: (url: string, apiKey: string) => Promise<PostmanSourceDocument[]>;
  maxApis?: number;
  maxDocumentBytes?: number;
}

export interface PostmanApiEntity {
  type: PostmanSourceDocumentKind;
  files: string[];
}

const API_ID_RE = /^\s*apis\[\]\s*=\s*(\{.*\})\s*$/gm;
const ROOT_FILE_RE = /^\s*rootFiles\[\]\s*=\s*(.+?)\s*$/gm;
const FILE_RE = /^\s*files\[\]\s*=\s*(\{.*\})\s*$/gm;

export function parsePostmanApiIndex(raw: string): string[] {
  const ids: string[] = [];
  for (const match of raw.matchAll(API_ID_RE)) {
    try {
      const parsed = JSON.parse(match[1]!) as { apiId?: unknown };
      if (typeof parsed.apiId === 'string' && parsed.apiId.trim()) ids.push(parsed.apiId.trim());
    } catch {
      throw new Error('invalid JSON entry in .postman/api');
    }
  }
  if (ids.length === 0) throw new Error('.postman/api contains no API relations');
  return [...new Set(ids)];
}

function section(raw: string, name: string): string {
  const marker = `[${name}]`;
  const markerIndex = raw.indexOf(marker);
  if (markerIndex < 0) return '';
  const start = raw.indexOf('\n', markerIndex + marker.length);
  if (start < 0) return '';
  const tail = raw.slice(start + 1);
  const nextSection = tail.search(/^\s*\[/m);
  return nextSection < 0 ? tail : tail.slice(0, nextSection);
}

function jsonFilePaths(raw: string): string[] {
  const files: string[] = [];
  for (const match of raw.matchAll(FILE_RE)) {
    try {
      const parsed = JSON.parse(match[1]!) as { path?: unknown };
      if (typeof parsed.path === 'string' && parsed.path.trim()) files.push(parsed.path.trim());
    } catch {
      throw new Error('invalid files[] JSON entry in .postman API entity');
    }
  }
  return files;
}

export function parsePostmanApiEntity(raw: string): PostmanApiEntity {
  const definitionMetadata = section(raw, 'config.relations.apiDefinition.metaData');
  const definitionSection = section(raw, 'config.relations.apiDefinition');
  const openapi = /^\s*type\s*=\s*openapi:3\s*$/m.test(definitionMetadata);
  const rootFiles = [...definitionMetadata.matchAll(ROOT_FILE_RE)].map((match) => match[1]!.trim());
  const definitionFiles = jsonFilePaths(definitionSection);
  const preferred = rootFiles.length ? rootFiles : definitionFiles;
  if (openapi && preferred.length) {
    return { type: 'openapi', files: [...new Set(preferred)] };
  }

  const collections = section(raw, 'config.relations.collections');
  const rootDirectory = collections.match(/^\s*rootDirectory\s*=\s*(.+?)\s*$/m)?.[1]?.trim() ?? '';
  const collectionFiles = jsonFilePaths(collections).map((file) =>
    rootDirectory && !file.startsWith(rootDirectory) ? `${rootDirectory.replace(/\/$/, '')}/${file}` : file,
  );
  if (collectionFiles.length) return { type: 'postman', files: [...new Set(collectionFiles)] };
  throw new Error('.postman API entity has neither an OpenAPI definition nor a collection');
}

function namespaceFor(path: string): string {
  const withoutExtension = path.replace(/\.(?:json|ya?ml)$/i, '');
  return withoutExtension
    .split('/')
    .filter(Boolean)
    .slice(-2)
    .join('_')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .toLowerCase() || 'api';
}

function githubRepository(source: string): { owner: string; repo: string; ref: string | null } | null {
  try {
    const url = new URL(source);
    if (url.hostname.toLowerCase() !== 'github.com') return null;
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length < 2) return null;
    const owner = parts[0]!;
    const repo = parts[1]!.replace(/\.git$/i, '');
    const tree = parts[2] === 'tree' && parts[3] ? parts[3] : null;
    return { owner, repo, ref: tree };
  } catch {
    return null;
  }
}

function isPostmanWorkspaceUrl(source: string): boolean {
  try {
    const url = new URL(source);
    return /(^|\.)postman\.com$/i.test(url.hostname) && url.pathname.split('/').filter(Boolean).length >= 2;
  } catch {
    return false;
  }
}

function rawGithubBase(owner: string, repo: string, ref: string): string {
  return `https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(ref)}`;
}

function resolveRelative(base: string, path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  if (/^https?:\/\//i.test(base)) {
    const url = new URL(base);
    const rootMarker = '/.postman/api';
    if (url.pathname.endsWith(rootMarker) || /\/\.postman\/api_[^/]+$/.test(url.pathname)) {
      const root = url.pathname.replace(/\/\.postman\/api(?:_[^/]+)?$/, '');
      url.pathname = `${root}/${path.replace(/^\/+/, '')}`;
      return url.href;
    }
    return new URL(path, base).href;
  }
  const slash = base.lastIndexOf('/');
  const root = base.endsWith('/.postman/api') || /\/\.postman\/api_[^/]+$/.test(base)
    ? base.replace(/\/\.postman\/api(?:_[^/]+)?$/, '')
    : slash >= 0 ? base.slice(0, slash) : '';
  return `${root ? `${root}/` : ''}${path.replace(/^\/+/, '')}`;
}

function parseDocument(raw: string, source: string, expected: PostmanSourceDocumentKind): any {
  const doc = parseSpecDocument(raw, source);
  if (expected === 'openapi' && !String(doc.openapi ?? '').startsWith('3.')) {
    throw new Error(`Postman API definition at ${source} is not OpenAPI 3`);
  }
  if (expected === 'postman' && !String(doc?.info?.schema ?? '').includes('/collection/v2.')) {
    throw new Error(`Postman collection at ${source} is not Collection v2.0/v2.1`);
  }
  return doc;
}

async function resolveApiManifest(
  manifestSource: string,
  loader: PostmanSourceLoader,
  options: PostmanSourceOptions,
): Promise<PostmanSourceDocument[]> {
  const manifest = await loader(manifestSource);
  const ids = parsePostmanApiIndex(manifest);
  const maxApis = options.maxApis ?? 250;
  if (ids.length > maxApis) throw new Error(`Postman repository contains ${ids.length} APIs; limit is ${maxApis}`);

  const relations = await Promise.all(ids.map(async (id) => {
    const entitySource = manifestSource.replace(/\/api$/, `/api_${encodeURIComponent(id)}`);
    return { entitySource, entity: parsePostmanApiEntity(await loader(entitySource)) };
  }));
  const refs = relations.flatMap(({ entitySource, entity }) =>
    entity.files.map((path) => ({ kind: entity.type, source: resolveRelative(entitySource, path), path })),
  );
  refs.sort((a, b) => a.source.localeCompare(b.source));

  const maxBytes = options.maxDocumentBytes ?? 10 * 1024 * 1024;
  const documents = await Promise.all(refs.map(async (ref) => {
    const raw = await loader(ref.source);
    if (new TextEncoder().encode(raw).byteLength > maxBytes) {
      throw new Error(`Postman source document at ${ref.source} exceeds ${maxBytes} bytes`);
    }
    return {
      namespace: namespaceFor(ref.path),
      kind: ref.kind,
      source: ref.source,
      doc: parseDocument(raw, ref.source, ref.kind),
    } satisfies PostmanSourceDocument;
  }));
  return documents;
}

export async function resolvePostmanSource(
  source: string,
  loader: PostmanSourceLoader,
  options: PostmanSourceOptions = {},
): Promise<PostmanSourceDocument[]> {
  if (isPostmanWorkspaceUrl(source)) {
    const apiKey = options.postmanApiKey?.trim();
    if (!apiKey) {
      throw new Error('public Postman workspace import requires server-side POSTMAN_API_KEY; web scraping is intentionally unsupported');
    }
    if (!options.resolveWorkspace) {
      throw new Error('public Postman workspace resolver is not configured');
    }
    return options.resolveWorkspace(source, apiKey);
  }

  const github = githubRepository(source);
  if (github) {
    const branch = github.ref ?? await (options.githubDefaultBranch?.(github.owner, github.repo) ?? Promise.resolve('main'));
    const manifestSource = `${rawGithubBase(github.owner, github.repo, branch)}/.postman/api`;
    return resolveApiManifest(manifestSource, loader, options);
  }

  const raw = await loader(source);
  if (/^\s*apis\[\]\s*=/m.test(raw)) return resolveApiManifest(source, async (ref) => ref === source ? raw : loader(ref), options);

  const doc = parseSpecDocument(raw, source);
  if (!String(doc?.info?.schema ?? '').includes('/collection/v2.')) {
    throw new Error(`Postman source at ${source} is neither a Collection v2 document nor a .postman/api manifest`);
  }
  return [{ namespace: namespaceFor(String(doc.info.name ?? source)), kind: 'postman', source, doc }];
}
