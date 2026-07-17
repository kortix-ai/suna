import type { ActionBinding, NormalizedAction, Risk } from './types';

export interface PostmanNormalizationResult {
  actions: NormalizedAction[];
  warnings: string[];
}

const COLLECTION_SCHEMA = /schema\.getpostman\.com\/json\/collection\/v2(?:\.0|\.1)\.0\/collection\.json/i;
const TEMPLATE_RE = /{{\s*([^{}]+?)\s*}}/g;

function isCredentialName(value: string): boolean {
  const compact = value.toLowerCase().replace(/[^a-z0-9]/g, '');
  return /(?:apikey|hapikey|accesstoken|authtoken|authorization|password|passwd|secret|credential|cookie)$/.test(compact);
}

function segment(value: string): string {
  return value
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .toLowerCase();
}

function riskForMethod(method: string): Risk {
  const normalized = method.toUpperCase();
  if (normalized === 'GET' || normalized === 'HEAD' || normalized === 'OPTIONS') return 'read';
  if (normalized === 'DELETE') return 'destructive';
  return 'write';
}

function collectionVariables(raw: unknown): Map<string, string> {
  const values = new Map<string, string>();
  if (!Array.isArray(raw)) return values;
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const item = entry as Record<string, unknown>;
    if (
      item.disabled === true ||
      String(item.type ?? '').toLowerCase() === 'secret' ||
      isCredentialName(String(item.key ?? ''))
    ) continue;
    if (typeof item.key !== 'string') continue;
    const value = item.value;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      values.set(item.key, String(value));
    }
  }
  return values;
}

function resolveKnownVariables(value: string, variables: Map<string, string>): string {
  return value.replace(TEMPLATE_RE, (whole, key: string) => variables.get(key.trim()) ?? whole);
}

function requestUrl(raw: unknown): string | null {
  if (typeof raw === 'string') return raw;
  if (!raw || typeof raw !== 'object') return null;
  const url = raw as Record<string, unknown>;
  if (typeof url.raw === 'string') return url.raw;
  const protocol = typeof url.protocol === 'string' ? `${url.protocol}://` : '';
  const host = Array.isArray(url.host) ? url.host.join('.') : String(url.host ?? '');
  const path = Array.isArray(url.path) ? url.path.join('/') : String(url.path ?? '');
  const query = Array.isArray(url.query)
    ? url.query
        .filter((entry: any) => entry && entry.disabled !== true && typeof entry.key === 'string')
        .map((entry: any) => `${entry.key}=${entry.value ?? ''}`)
        .join('&')
    : '';
  if (!host) return null;
  return `${protocol}${host}${path ? `/${path}` : ''}${query ? `?${query}` : ''}`;
}

function stripCredentialQuery(url: string): { url: string; removed: boolean } {
  const question = url.indexOf('?');
  if (question < 0) return { url, removed: false };
  const hash = url.indexOf('#', question);
  const suffix = hash >= 0 ? url.slice(hash) : '';
  const query = url.slice(question + 1, hash >= 0 ? hash : undefined);
  const kept: string[] = [];
  let removed = false;
  for (const part of query.split('&')) {
    const rawKey = part.split('=', 1)[0] ?? '';
    let key = rawKey;
    try { key = decodeURIComponent(rawKey); } catch { /* keep raw */ }
    if (isCredentialName(key)) {
      removed = true;
      continue;
    }
    if (part) kept.push(part);
  }
  return {
    url: `${url.slice(0, question)}${kept.length ? `?${kept.join('&')}` : ''}${suffix}`,
    removed,
  };
}

function templateVariables(value: string): string[] {
  const out = new Set<string>();
  for (const match of value.matchAll(TEMPLATE_RE)) out.add(match[1]!.trim());
  return [...out];
}

function schemaForValue(value: unknown): Record<string, unknown> {
  if (value === null) return { type: 'null' };
  if (Array.isArray(value)) {
    return {
      type: 'array',
      ...(value.length ? { items: schemaForValue(value[0]) } : {}),
    };
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    return {
      type: 'object',
      properties: Object.fromEntries(entries.map(([key, child]) => [key, schemaForValue(child)])),
      ...(entries.length ? { required: entries.map(([key]) => key) } : {}),
    };
  }
  if (typeof value === 'number') return { type: Number.isInteger(value) ? 'integer' : 'number' };
  if (typeof value === 'boolean') return { type: 'boolean' };
  return { type: 'string' };
}

function jsonSchema(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    return schemaForValue(JSON.parse(raw));
  } catch {
    return null;
  }
}

function responseSchema(responses: unknown): Record<string, unknown> | null {
  if (!Array.isArray(responses)) return null;
  const preferred = responses.find((response: any) => {
    const code = Number(response?.code);
    return code >= 200 && code < 300 && typeof response?.body === 'string';
  });
  return jsonSchema(preferred?.body);
}

function descriptionText(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && typeof (value as any).content === 'string') {
    return (value as any).content;
  }
  return null;
}

function hasScripts(value: any): boolean {
  return Array.isArray(value?.event) && value.event.some((event: any) => event?.script);
}

export function normalizePostmanCollection(doc: any): PostmanNormalizationResult {
  if (
    !doc ||
    typeof doc !== 'object' ||
    !doc.info ||
    typeof doc.info !== 'object' ||
    !COLLECTION_SCHEMA.test(String(doc.info.schema ?? '')) ||
    !Array.isArray(doc.item)
  ) {
    throw new Error('document is not a Postman Collection v2.0 or v2.1');
  }

  const warnings: string[] = [];
  const actions: NormalizedAction[] = [];
  const rootVariables = collectionVariables(doc.variable);
  if (hasScripts(doc)) warnings.push('collection pre-request/test scripts were ignored');
  if (doc.auth) warnings.push('collection authentication was ignored; configure connector auth in Kortix');

  const walk = (items: unknown[], folders: string[], inherited: Map<string, string>) => {
    for (const candidate of items) {
      if (!candidate || typeof candidate !== 'object') continue;
      const item = candidate as Record<string, any>;
      if (item.disabled === true) continue;
      const name = typeof item.name === 'string' && item.name.trim() ? item.name.trim() : 'request';
      const variables = new Map([...inherited, ...collectionVariables(item.variable)]);
      if (hasScripts(item)) warnings.push(`${[...folders, name].join(' / ')} scripts were ignored`);

      if (Array.isArray(item.item)) {
        walk(item.item, [...folders, name], variables);
        continue;
      }
      if (!item.request || typeof item.request !== 'object') continue;

      const request = item.request as Record<string, any>;
      if (hasScripts(request)) warnings.push(`${[...folders, name].join(' / ')} scripts were ignored`);
      if (request.auth) warnings.push(`${[...folders, name].join(' / ')} authentication was ignored; configure connector auth in Kortix`);
      const method = String(request.method ?? 'GET').toUpperCase();
      const unresolvedUrl = requestUrl(request.url);
      if (!unresolvedUrl) {
        warnings.push(`${[...folders, name].join(' / ')} has no usable URL and was skipped`);
        continue;
      }
      const renderedUrl = resolveKnownVariables(unresolvedUrl, variables).replace(
        /(^|\/)\:([A-Za-z_][A-Za-z0-9_]*)/g,
        '$1{{$2}}',
      );
      const sanitizedUrl = stripCredentialQuery(renderedUrl);
      const url = sanitizedUrl.url;
      if (sanitizedUrl.removed) {
        warnings.push(`${[...folders, name].join(' / ')} credential-like query parameter was ignored; configure connector auth in Kortix`);
      }

      const headers: Record<string, string> = {};
      if (Array.isArray(request.header)) {
        for (const rawHeader of request.header) {
          if (!rawHeader || rawHeader.disabled === true || typeof rawHeader.key !== 'string') continue;
          const key = rawHeader.key.trim();
          if (!key || /^(authorization|proxy-authorization|cookie|set-cookie)$/i.test(key) || isCredentialName(key)) continue;
          headers[key] = resolveKnownVariables(String(rawHeader.value ?? ''), variables);
        }
      }

      const properties: Record<string, unknown> = {};
      const required = new Set<string>();
      for (const variable of templateVariables(url)) {
        properties[variable] = { type: 'string', 'x-in': url.includes(`?`) && url.slice(url.indexOf('?')).includes(`{{${variable}}}`) ? 'query' : 'path' };
        required.add(variable);
      }
      for (const [header, value] of Object.entries(headers)) {
        for (const variable of templateVariables(value)) {
          properties[variable] = { type: 'string', 'x-in': 'header', description: `Postman header ${header}` };
          required.add(variable);
        }
      }

      let bodyMode: Extract<ActionBinding, { kind: 'postman' }>['bodyMode'] = null;
      const body = request.body;
      if (body && typeof body === 'object' && body.disabled !== true) {
        const mode = String(body.mode ?? '');
        if (mode === 'raw') {
          const inferred = jsonSchema(body.raw);
          bodyMode = inferred ? 'json' : 'raw';
          properties.body = inferred ?? { type: 'string' };
          required.add('body');
        } else if (mode === 'urlencoded' && Array.isArray(body.urlencoded)) {
          bodyMode = 'urlencoded';
          const fields = body.urlencoded.filter((entry: any) => entry && entry.disabled !== true && typeof entry.key === 'string');
          properties.body = {
            type: 'object',
            properties: Object.fromEntries(fields.map((entry: any) => [entry.key, { type: 'string' }])),
          };
          required.add('body');
        } else if (mode) {
          warnings.push(`${[...folders, name].join(' / ')} uses unsupported ${mode} body mode`);
        }
      }

      const path = [...folders, name].map(segment).filter(Boolean).join('.') || 'request';
      actions.push({
        path,
        name,
        description: descriptionText(request.description) ?? `${method} ${url}`,
        inputSchema: Object.keys(properties).length
          ? { type: 'object', properties, ...(required.size ? { required: [...required] } : {}) }
          : null,
        outputSchema: responseSchema(item.response),
        risk: riskForMethod(method),
        binding: { kind: 'postman', method, url, headers, bodyMode },
      });
    }
  };

  walk(doc.item, [], rootVariables);

  const seen = new Map<string, number>();
  for (const action of actions) {
    const count = seen.get(action.path) ?? 0;
    seen.set(action.path, count + 1);
    if (count > 0) action.path = `${action.path}_${count + 1}`;
  }
  return { actions, warnings: [...new Set(warnings)] };
}
