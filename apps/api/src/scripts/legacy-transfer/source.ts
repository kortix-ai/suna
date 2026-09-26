/** Read-only source adapter. It never imports the destination API configuration. */
export type JsonRow = Record<string, unknown>;
export type RequestFn = typeof fetch;

export class SourceError extends Error {
  constructor(public status: number, public operation: string) {
    super(`${operation}: HTTP ${status}`);
  }
}

export class LegacySource {
  readonly origin: string;
  constructor(ref: string, private key: string, private request: RequestFn = fetch) {
    if (!/^[a-z]{20}$/.test(ref)) throw new Error('Expected a 20-letter Supabase project ref');
    if (!key || key.startsWith('sbp_')) throw new Error('A source service-role key is required; a PAT is not a Data API key');
    this.origin = `https://${ref}.supabase.co`;
  }

  private async read(path: string, options: { method?: 'GET' | 'HEAD' | 'POST'; schema?: string; body?: unknown; count?: boolean } = {}): Promise<Response> {
    const method = options.method ?? 'GET';
    // POST is restricted to Storage's documented, read-only object listing endpoint.
    if (method === 'POST' && !/^\/storage\/v1\/object\/list-v2\/[a-zA-Z0-9_-]+$/.test(path)) {
      throw new Error('Remote writes are disabled');
    }
    if (!path.startsWith('/rest/v1/') && !path.startsWith('/storage/v1/')) throw new Error('Unsupported source endpoint');
    const headers: Record<string, string> = { apikey: this.key, Authorization: `Bearer ${this.key}` };
    if (options.schema) headers['Accept-Profile'] = options.schema;
    if (options.count) headers.Prefer = 'count=exact';
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    for (let attempt = 0; ; attempt++) {
      const response = await this.request(this.origin + path, {
        method, headers, redirect: 'error', signal: AbortSignal.timeout(30_000),
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      });
      if (response.ok) return response;
      // Do not print source error bodies: they can contain content or credentials.
      if (attempt >= 2 || ![429, 502, 503, 504].includes(response.status)) {
        throw new SourceError(response.status, `${method} ${path.split('?')[0]}`);
      }
      await response.body?.cancel();
      await Bun.sleep(500 * 2 ** attempt);
    }
  }

  async schema(): Promise<JsonRow> {
    return (await this.read('/rest/v1/')).json();
  }

  async count(table: string, schema = 'public', filters: Record<string, string> = {}): Promise<number> {
    assertIdentifier(table); assertIdentifier(schema);
    const query = new URLSearchParams({ ...filters, select: '*' });
    const response = await this.read(`/rest/v1/${table}?${query}`, { method: 'HEAD', schema, count: true });
    const total = response.headers.get('content-range')?.split('/')[1];
    if (!total || !/^\d+$/.test(total)) throw new Error(`Missing exact count for ${schema}.${table}`);
    return Number(total);
  }

  async *rows(table: string, primaryKey: string, options: {
    select?: string; schema?: string; filters?: Record<string, string>; pageSize?: number;
  } = {}): AsyncGenerator<JsonRow[]> {
    assertIdentifier(table); assertIdentifier(primaryKey);
    const schema = options.schema ?? 'public'; assertIdentifier(schema);
    const pageSize = options.pageSize ?? 250;
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 1000) throw new Error('pageSize must be 1..1000');
    if (options.filters && ['select', 'order', 'limit', 'offset', primaryKey].some(k => k in options.filters!)) {
      throw new Error('Filters cannot override pagination');
    }
    let previous: string | undefined;
    while (true) {
      const query = new URLSearchParams({ ...options.filters, select: options.select ?? '*', order: `${primaryKey}.asc`, limit: String(pageSize) });
      if (previous) query.set(primaryKey, `gt.${previous}`);
      const rows = await (await this.read(`/rest/v1/${table}?${query}`, { schema })).json() as JsonRow[];
      if (!Array.isArray(rows)) throw new Error(`Expected rows for ${table}`);
      if (!rows.length) return;
      // Do not stop on a short page: PostgREST can enforce a smaller server cap.
      for (const row of rows) {
        const key = row[primaryKey];
        if (typeof key !== 'string' || !key || (previous !== undefined && key <= previous)) {
          throw new Error(`Unordered or duplicate primary key in ${table}`);
        }
        previous = key;
      }
      yield rows;
    }
  }

  async buckets(): Promise<JsonRow[]> { return (await this.read('/storage/v1/bucket')).json(); }

  async *objects(bucket: string): AsyncGenerator<JsonRow[]> {
    if (!/^[a-zA-Z0-9_-]+$/.test(bucket)) throw new Error('Unsupported bucket name');
    let cursor: string | undefined;
    const seen = new Set<string>();
    while (true) {
      const data = await (await this.read(`/storage/v1/object/list-v2/${bucket}`, {
        method: 'POST', body: { prefix: '', limit: 1000, with_delimiter: false, sortBy: { column: 'name', order: 'asc' }, ...(cursor ? { cursor } : {}) },
      })).json() as { objects: JsonRow[]; folders?: unknown[]; hasNext: boolean; nextCursor?: string };
      if (!Array.isArray(data.objects) || data.folders?.length || typeof data.hasNext !== 'boolean') throw new Error('Invalid recursive Storage listing');
      yield data.objects;
      if (!data.hasNext) return;
      if (!data.nextCursor || seen.has(data.nextCursor)) throw new Error('Missing or repeated Storage cursor');
      cursor = data.nextCursor; seen.add(cursor);
    }
  }
}

function assertIdentifier(value: string): void {
  if (!/^[a-z][a-z0-9_]*$/.test(value)) throw new Error('Invalid source identifier');
}

/** Resolve both historical sandbox representations without silently choosing a conflict. */
export function resolveSandbox(project: JsonRow, resources: Map<string, JsonRow>): {
  id: string | null; source: 'resource' | 'legacy-json' | 'none'; problems: string[];
} {
  const problems: string[] = [];
  const resource = typeof project.sandbox_resource_id === 'string' ? resources.get(project.sandbox_resource_id) : undefined;
  if (project.sandbox_resource_id && !resource) problems.push('missing-resource');
  if (resource && resource.type !== 'sandbox') problems.push('resource-not-sandbox');
  if (resource && resource.account_id !== project.account_id) problems.push('resource-account-mismatch');
  const old = project.sandbox && typeof project.sandbox === 'object' ? project.sandbox as JsonRow : {};
  const oldId = typeof old.id === 'string' && old.id ? old.id : null;
  const resourceId = typeof resource?.external_id === 'string' && resource.external_id ? resource.external_id : null;
  if (resource && !resourceId) problems.push('missing-external-id');
  if (oldId && resourceId && oldId !== resourceId) problems.push('sandbox-id-conflict');
  if (!resourceId && !oldId) problems.push('missing-sandbox-reference');
  return { id: resourceId ?? oldId, source: resourceId ? 'resource' : oldId ? 'legacy-json' : 'none', problems };
}
