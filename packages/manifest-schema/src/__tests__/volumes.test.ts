import { describe, expect, test } from 'bun:test';
import {
  type ManifestImportReader,
  parseAgentVolumes,
  parseManifestText,
  resolveAgentVolumes,
  resolveManifestImports,
  validateManifest,
  volumeCredentialIdentifiers,
} from '../index.ts';

const VALID = `
kortix_version: 2
default_agent: analyst
volumes:
  datasets:
    type: s3
    bucket: acme-data
    prefix: training/2026
    region: us-east-1
    access_key_id: DATASETS_KEY_ID
    secret_access_key: DATASETS_SECRET
  reports:
    type: s3
    bucket: acme-reports
    endpoint: https://abc123.r2.cloudflarestorage.com
    access_key_id: R2_KEY_ID
    secret_access_key: R2_SECRET
  noaa:
    type: s3
    bucket: noaa-ghcn-pds
agents:
  analyst:
    secrets: [DATASETS_KEY_ID, DATASETS_SECRET, R2_KEY_ID, R2_SECRET]
    volumes:
      datasets: read-only
      reports: read-write
  reader:
    volumes: [noaa]
`;

function errors(yaml: string): string[] {
  return validateManifest(yaml, 'yaml')
    .issues.filter((issue) => issue.severity === 'error')
    .map((issue) => `${issue.path}: ${issue.message}`);
}

/** VALID with one `old` → `new` substitution; fails loudly if `old` is absent. */
function variant(old: string, replacement: string): string {
  expect(VALID).toContain(old);
  return VALID.replace(old, replacement);
}

describe('volumes: validation', () => {
  test('a manifest with private, S3-compatible and public volumes is valid', () => {
    expect(errors(VALID)).toEqual([]);
  });

  test('type must be s3', () => {
    expect(errors(variant('  noaa:\n    type: s3', '  noaa:\n    type: sftp'))).toEqual([
      'volumes.noaa.type: type must be one of: s3 (got "sftp").',
    ]);
  });

  test('bucket is required and cannot contain a path', () => {
    expect(errors(variant('bucket: noaa-ghcn-pds', 'bucket: noaa/ghcn'))).toEqual([
      'volumes.noaa.bucket: is required: a bucket name (letters, digits, dots, dashes, underscores; no "/").',
    ]);
  });

  test('prefix cannot escape the bucket', () => {
    for (const prefix of ['/abs', '../up', 'a/../b', './x']) {
      expect(errors(variant('prefix: training/2026', `prefix: "${prefix}"`))).toEqual([
        'volumes.datasets.prefix: must be a path inside the bucket: no leading "/", no "." or ".." segments.',
      ]);
    }
  });

  test('endpoint must be an http(s) URL without embedded credentials', () => {
    for (const endpoint of ['ftp://x.example.com', 'https://user:pass@x.example.com', 'not a url']) {
      expect(errors(variant('https://abc123.r2.cloudflarestorage.com', endpoint))).toEqual([
        'volumes.reports.endpoint: must be an http(s) URL without credentials, e.g. https://<account>.r2.cloudflarestorage.com.',
      ]);
    }
  });

  test('credentials are secret identifiers, both or neither', () => {
    expect(errors(variant('    secret_access_key: R2_SECRET\n', ''))).toEqual([
      'volumes.reports: set both access_key_id and secret_access_key, or neither for a public bucket.',
    ]);
    expect(errors(variant('access_key_id: R2_KEY_ID', 'access_key_id: "AKIA 123/xyz"'))).toContain(
      'volumes.reports.access_key_id: must name a project secret identifier, never the credential value.',
    );
  });

  test('unknown volume fields are rejected', () => {
    expect(errors(variant('    bucket: noaa-ghcn-pds', '    bucket: noaa-ghcn-pds\n    password: hunter2'))).toEqual([
      'volumes.noaa.password: is not a supported volume field.',
    ]);
  });

  test('volume names are slugs', () => {
    expect(errors(variant('  noaa:\n', '  NOAA:\n').replace('volumes: [noaa]', 'volumes: []'))).toEqual([
      'volumes.NOAA: "NOAA" is not a valid volume name (lowercase letters, digits, dashes, underscores).',
    ]);
  });

  test('an agent may only attach declared volumes', () => {
    expect(errors(variant('volumes: [noaa]', 'volumes: [noaa, ghost]'))).toEqual([
      'agents.reader.volumes.ghost: volume "ghost" is not declared under the top-level `volumes`.',
    ]);
  });

  test("a volume's credential secrets must be in the agent's secrets grant", () => {
    expect(errors(variant('secrets: [DATASETS_KEY_ID, DATASETS_SECRET, R2_KEY_ID, R2_SECRET]', 'secrets: [DATASETS_KEY_ID, R2_KEY_ID, R2_SECRET]'))).toEqual([
      'agents.analyst.volumes.datasets: credential secret "DATASETS_SECRET" (volumes.datasets.secret_access_key) must also be granted in agents.analyst.secrets — attaching a volume gives the agent its credentials.',
    ]);
    // v2 default for an omitted grant is `none`.
    expect(errors(variant('volumes: [noaa]', 'volumes: [datasets]'))).toHaveLength(2);
    // `all` covers every credential; grant matching is case-insensitive like the runtime.
    expect(errors(variant('secrets: [DATASETS_KEY_ID, DATASETS_SECRET, R2_KEY_ID, R2_SECRET]', 'secrets: all'))).toEqual([]);
    expect(errors(variant('secrets: [DATASETS_KEY_ID, DATASETS_SECRET, R2_KEY_ID, R2_SECRET]', 'secrets: [datasets_key_id, datasets_secret, r2_key_id, r2_secret]'))).toEqual([]);
  });

  test('agent volume modes are read-only or read-write, and names are unique', () => {
    expect(errors(variant('reports: read-write', 'reports: rw'))).toEqual([
      'agents.analyst.volumes.reports: mode must be one of: read-only, read-write.',
    ]);
    expect(errors(variant('volumes: [noaa]', 'volumes: [noaa, noaa]'))).toEqual([
      'agents.reader.volumes[1]: volume "noaa" is listed twice.',
    ]);
    expect(errors(variant('volumes: [noaa]', 'volumes: noaa'))).toEqual([
      'agents.reader.volumes: must be a list of volume names (read-only) or a map of volume name → read-only | read-write.',
    ]);
  });
});

describe('volumes: runtime resolution', () => {
  const manifest = parseManifestText(VALID, 'yaml') as Record<string, unknown>;

  test('resolveAgentVolumes joins attachments to their declarations', () => {
    expect(resolveAgentVolumes(manifest, 'analyst')).toEqual([
      {
        name: 'datasets',
        mode: 'read-only',
        volume: {
          type: 's3',
          bucket: 'acme-data',
          prefix: 'training/2026',
          region: 'us-east-1',
          access_key_id: 'DATASETS_KEY_ID',
          secret_access_key: 'DATASETS_SECRET',
        },
      },
      {
        name: 'reports',
        mode: 'read-write',
        volume: {
          type: 's3',
          bucket: 'acme-reports',
          endpoint: 'https://abc123.r2.cloudflarestorage.com',
          access_key_id: 'R2_KEY_ID',
          secret_access_key: 'R2_SECRET',
        },
      },
    ]);
    expect(resolveAgentVolumes(manifest, 'reader')).toEqual([
      { name: 'noaa', mode: 'read-only', volume: { type: 's3', bucket: 'noaa-ghcn-pds' } },
    ]);
  });

  test('an undeclared or invalid volume resolves with volume: null instead of throwing', () => {
    const broken = parseManifestText(
      variant('volumes: [noaa]', 'volumes: [noaa, ghost]').replace('bucket: noaa-ghcn-pds', 'bucket: "a/b"'),
      'yaml',
    ) as Record<string, unknown>;
    expect(resolveAgentVolumes(broken, 'reader')).toEqual([
      { name: 'noaa', mode: 'read-only', volume: null },
      { name: 'ghost', mode: 'read-only', volume: null },
    ]);
  });

  test('no volumes for v1 manifests, unknown agents, or agents without volumes', () => {
    expect(resolveAgentVolumes({ ...manifest, kortix_version: 1 }, 'analyst')).toEqual([]);
    expect(resolveAgentVolumes(manifest, 'nobody')).toEqual([]);
    expect(resolveAgentVolumes({ kortix_version: 2, agents: { a: {} } }, 'a')).toEqual([]);
  });

  test('parseAgentVolumes drops invalid entries and keeps the first duplicate', () => {
    expect(parseAgentVolumes(['a', 'a', 'B', 3, 'c'])).toEqual([
      { name: 'a', mode: 'read-only' },
      { name: 'c', mode: 'read-only' },
    ]);
    expect(parseAgentVolumes({ a: 'read-write', b: 'rw' })).toEqual([{ name: 'a', mode: 'read-write' }]);
    expect(parseAgentVolumes('a')).toEqual([]);
  });

  test('volumeCredentialIdentifiers lists key id then secret', () => {
    expect(volumeCredentialIdentifiers({ type: 's3', bucket: 'b', access_key_id: 'K', secret_access_key: 'S' })).toEqual(['K', 'S']);
    expect(volumeCredentialIdentifiers({ type: 's3', bucket: 'b' })).toEqual([]);
  });
});

describe('volumes: imports', () => {
  test('a volumes map in an imported file merges into the root manifest', async () => {
    const files: Record<string, string> = {
      'kortix.yaml': 'kortix_version: 2\ndefault_agent: a\nimports:\n  - .kortix/volumes.yaml\nagents:\n  a:\n    volumes: [noaa]\n',
      '.kortix/volumes.yaml': 'volumes:\n  noaa:\n    type: s3\n    bucket: noaa-ghcn-pds\n',
    };
    const reader: ManifestImportReader = {
      async list(path) {
        return Object.keys(files)
          .filter((p) => p === path || p.startsWith(`${path.replace(/\/+$/, '')}/`))
          .map((p) => ({ path: p, revision: `sha-${p}` }));
      },
      async read(path) {
        return files[path]!;
      },
    };
    const root = parseManifestText(files['kortix.yaml']!, 'yaml') as Record<string, unknown>;
    const resolved = await resolveManifestImports({ path: 'kortix.yaml', raw: root, revision: 'root' }, reader);
    expect(resolveAgentVolumes(resolved.raw as Record<string, unknown>, 'a')).toEqual([
      { name: 'noaa', mode: 'read-only', volume: { type: 's3', bucket: 'noaa-ghcn-pds' } },
    ]);
    expect(resolved.origins.volumes).toEqual({ noaa: '.kortix/volumes.yaml' });
  });
});
