/**
 * Pure connector-auth discovery. Source loading stays in sync.ts; this module
 * only interprets already-loaded documents and never retains credential values.
 */

export type DiscoveredAuthScheme =
  | 'none'
  | 'bearer'
  | 'basic'
  | 'api_key'
  | 'oauth1'
  | 'oauth2'
  | 'openid_connect'
  | 'mutual_tls'
  | 'digest'
  | 'hawk'
  | 'ntlm'
  | 'aws_v4'
  | 'edgegrid'
  | 'asap'
  | 'unknown';

export interface ExecutableConnectorAuth {
  type: 'none' | 'bearer' | 'basic' | 'custom' | 'oauth1';
  in: 'header' | 'query';
  name: string | null;
  prefix: string | null;
}

export interface DiscoveredOAuthMetadata {
  authorizationUrl?: string;
  tokenUrl?: string;
  refreshUrl?: string;
  openIdConnectUrl?: string;
  protectedResourceMetadataUrl?: string;
  scopes: string[];
}

export interface ConnectorAuthCandidate {
  id: string;
  source: string;
  scheme: DiscoveredAuthScheme;
  label: string;
  supported: boolean;
  requestCount: number;
  totalRequests: number;
  placement: 'header' | 'query' | 'cookie' | null;
  parameterName: string | null;
  prefix: string | null;
  parameterNames: string[];
  variables: string[];
  oauth?: DiscoveredOAuthMetadata;
  executable: ExecutableConnectorAuth | null;
}

export interface ConnectorAuthDiscovery {
  status: 'detected' | 'none' | 'ambiguous' | 'unsupported';
  recommended: ExecutableConnectorAuth | null;
  candidates: ConnectorAuthCandidate[];
  warnings: string[];
  totalRequests: number;
}

const OPENAPI_METHODS = new Set([
  'get',
  'put',
  'post',
  'delete',
  'patch',
  'head',
  'options',
  'trace',
]);
const TEMPLATE_RE = /{{\s*([^{}]+?)\s*}}/g;

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function templateVariables(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  return [
    ...new Set(
      [...value.matchAll(TEMPLATE_RE)].map((match) => match[1]!.trim()),
    ),
  ].sort();
}

function executable(
  type: ExecutableConnectorAuth['type'],
  placement: 'header' | 'query' = 'header',
  name: string | null = null,
  prefix: string | null = null,
): ExecutableConnectorAuth {
  return { type, in: placement, name, prefix };
}

function finish(
  candidates: ConnectorAuthCandidate[],
  totalRequests: number,
  warnings: string[],
): ConnectorAuthDiscovery {
  const nonNone = candidates.filter((candidate) => candidate.scheme !== 'none');
  const ranked = nonNone
    .map((candidate, index) => ({ candidate, index }))
    .filter(({ candidate }) => candidate.supported && candidate.executable)
    .sort(
      (a, b) =>
        b.candidate.requestCount - a.candidate.requestCount ||
        a.index - b.index,
    );
  const recommended = ranked[0]?.candidate.executable ?? null;
  const compound = warnings.some((warning) =>
    warning.includes('requires multiple authentication schemes'),
  );
  const status: ConnectorAuthDiscovery['status'] = recommended
    ? compound
      ? 'ambiguous'
      : 'detected'
    : nonNone.length
      ? 'unsupported'
      : 'none';
  return {
    status,
    recommended,
    candidates,
    warnings: [...new Set(warnings)],
    totalRequests,
  };
}

function openApiCandidate(
  id: string,
  raw: any,
  source: string,
  requestCount: number,
  totalRequests: number,
): ConnectorAuthCandidate {
  const type = String(raw?.type ?? '').toLowerCase();
  const httpScheme = String(raw?.scheme ?? '').toLowerCase();
  let scheme: DiscoveredAuthScheme = 'unknown';
  let placement: ConnectorAuthCandidate['placement'] = null;
  let parameterName: string | null = null;
  let prefix: string | null = null;
  let mapped: ExecutableConnectorAuth | null = null;
  let oauth: DiscoveredOAuthMetadata | undefined;

  if (type === 'apikey') {
    scheme = 'api_key';
    placement =
      raw?.in === 'query'
        ? 'query'
        : raw?.in === 'cookie'
          ? 'cookie'
          : 'header';
    parameterName = stringValue(raw?.name) ?? null;
    if (placement !== 'cookie' && parameterName) {
      mapped = executable('custom', placement, parameterName, null);
    }
  } else if (type === 'basic' || (type === 'http' && httpScheme === 'basic')) {
    scheme = 'basic';
    placement = 'header';
    parameterName = 'Authorization';
    mapped = executable('basic', 'header', 'Authorization', null);
  } else if (type === 'http' && httpScheme === 'bearer') {
    scheme = 'bearer';
    placement = 'header';
    parameterName = 'Authorization';
    prefix = 'Bearer';
    mapped = executable('bearer', 'header', 'Authorization', 'Bearer');
  } else if (type === 'http' && httpScheme === 'digest') {
    scheme = 'digest';
    placement = 'header';
    parameterName = 'Authorization';
  } else if (type === 'oauth2') {
    scheme = 'oauth2';
    placement = 'header';
    parameterName = 'Authorization';
    prefix = 'Bearer';
    mapped = executable('bearer', 'header', 'Authorization', 'Bearer');
    const flows =
      raw?.flows && typeof raw.flows === 'object'
        ? (Object.values(raw.flows) as any[])
        : [raw];
    const first = flows.find((flow) => flow && typeof flow === 'object') ?? {};
    const scopes = new Set<string>();
    for (const flow of flows) {
      for (const scope of Object.keys(flow?.scopes ?? {})) scopes.add(scope);
    }
    oauth = {
      ...(stringValue(first.authorizationUrl ?? raw?.authorizationUrl)
        ? {
            authorizationUrl: stringValue(
              first.authorizationUrl ?? raw?.authorizationUrl,
            ),
          }
        : {}),
      ...(stringValue(first.tokenUrl ?? raw?.tokenUrl)
        ? { tokenUrl: stringValue(first.tokenUrl ?? raw?.tokenUrl) }
        : {}),
      ...(stringValue(first.refreshUrl)
        ? { refreshUrl: stringValue(first.refreshUrl) }
        : {}),
      scopes: [...scopes].sort(),
    };
  } else if (type === 'openidconnect') {
    scheme = 'openid_connect';
    placement = 'header';
    parameterName = 'Authorization';
    prefix = 'Bearer';
    mapped = executable('bearer', 'header', 'Authorization', 'Bearer');
    oauth = {
      ...(stringValue(raw?.openIdConnectUrl)
        ? { openIdConnectUrl: stringValue(raw.openIdConnectUrl) }
        : {}),
      scopes: [],
    };
  } else if (type === 'mutualtls') {
    scheme = 'mutual_tls';
  } else if (type === 'oauth1') {
    scheme = 'oauth1';
    placement = 'header';
    parameterName = 'Authorization';
    prefix = 'OAuth';
    mapped = executable('oauth1', 'header', 'Authorization', 'OAuth');
  }

  return {
    id,
    source,
    scheme,
    label: stringValue(raw?.description) ?? id,
    supported: mapped !== null,
    requestCount,
    totalRequests,
    placement,
    parameterName,
    prefix,
    parameterNames: parameterName ? [parameterName] : [],
    variables: [],
    ...(oauth ? { oauth } : {}),
    executable: mapped,
  };
}

export function discoverOpenApiAuth(
  doc: any,
  source = 'OpenAPI',
): ConnectorAuthDiscovery {
  if (!doc || typeof doc !== 'object') return finish([], 0, []);
  const definitions = (doc.components?.securitySchemes ??
    doc.securityDefinitions ??
    {}) as Record<string, any>;
  const usage = new Map<string, number>();
  const warnings: string[] = [];
  let totalRequests = 0;

  for (const pathItem of Object.values(doc.paths ?? {}) as any[]) {
    if (!pathItem || typeof pathItem !== 'object') continue;
    for (const [method, operation] of Object.entries(pathItem)) {
      if (
        !OPENAPI_METHODS.has(method.toLowerCase()) ||
        !operation ||
        typeof operation !== 'object'
      )
        continue;
      totalRequests++;
      const security =
        (operation as any).security === undefined
          ? doc.security
          : (operation as any).security;
      if (!Array.isArray(security) || security.length === 0) continue;
      const usedHere = new Set<string>();
      for (const requirement of security) {
        if (!requirement || typeof requirement !== 'object') continue;
        const ids = Object.keys(requirement);
        if (ids.length > 1) {
          warnings.push(
            `${source} requires multiple authentication schemes together: ${ids.join(' + ')}`,
          );
        }
        for (const id of ids) usedHere.add(id);
      }
      for (const id of usedHere) usage.set(id, (usage.get(id) ?? 0) + 1);
    }
  }

  const candidates = Object.entries(definitions).map(([id, raw]) =>
    openApiCandidate(id, raw, source, usage.get(id) ?? 0, totalRequests),
  );
  for (const id of usage.keys()) {
    if (!definitions[id])
      warnings.push(`${source} references undefined security scheme "${id}"`);
  }
  return finish(candidates, totalRequests, warnings);
}

interface PostmanAuthLike {
  type?: unknown;
  [key: string]: unknown;
}

function postmanAttributes(
  auth: PostmanAuthLike,
  type: string,
): Map<string, unknown> {
  const raw = auth[type];
  const values = new Map<string, unknown>();
  if (!Array.isArray(raw)) return values;
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const key = stringValue((entry as any).key);
    if (key) values.set(key, (entry as any).value);
  }
  return values;
}

function normalizePostmanType(type: string): DiscoveredAuthScheme {
  const normalized = type.toLowerCase().replace(/[-_]/g, '');
  const map: Record<string, DiscoveredAuthScheme> = {
    noauth: 'none',
    bearer: 'bearer',
    basic: 'basic',
    apikey: 'api_key',
    oauth1: 'oauth1',
    oauth2: 'oauth2',
    digest: 'digest',
    hawk: 'hawk',
    ntlm: 'ntlm',
    awsv4: 'aws_v4',
    edgegrid: 'edgegrid',
    asap: 'asap',
  };
  return map[normalized] ?? 'unknown';
}

function postmanCandidate(
  type: string,
  auth: PostmanAuthLike,
  source: string,
  requestCount: number,
  totalRequests: number,
): ConnectorAuthCandidate {
  const scheme = normalizePostmanType(type);
  const attrs = postmanAttributes(auth, type);
  const parameterNames = [...attrs.keys()];
  const variables = [
    ...new Set([...attrs.values()].flatMap(templateVariables)),
  ].sort();
  let placement: ConnectorAuthCandidate['placement'] = null;
  let parameterName: string | null = null;
  let prefix: string | null = null;
  let mapped: ExecutableConnectorAuth | null = null;
  let oauth: DiscoveredOAuthMetadata | undefined;

  if (scheme === 'none') {
    mapped = executable('none');
  } else if (scheme === 'bearer') {
    placement = 'header';
    parameterName = 'Authorization';
    prefix = 'Bearer';
    mapped = executable('bearer', 'header', parameterName, prefix);
  } else if (scheme === 'basic') {
    placement = 'header';
    parameterName = 'Authorization';
    mapped = executable('basic', 'header', parameterName, null);
  } else if (scheme === 'api_key') {
    const rawPlacement = String(attrs.get('in') ?? 'header').toLowerCase();
    placement =
      rawPlacement === 'query'
        ? 'query'
        : rawPlacement === 'cookie'
          ? 'cookie'
          : 'header';
    parameterName = stringValue(attrs.get('key')) ?? null;
    if (placement !== 'cookie' && parameterName) {
      mapped = executable('custom', placement, parameterName, null);
    }
  } else if (scheme === 'oauth1') {
    placement = 'header';
    parameterName = 'Authorization';
    prefix = 'OAuth';
    mapped = executable('oauth1', 'header', parameterName, prefix);
  } else if (scheme === 'oauth2') {
    placement =
      String(attrs.get('addTokenTo') ?? 'header').toLowerCase() ===
      'queryparams'
        ? 'query'
        : 'header';
    parameterName = placement === 'query' ? 'access_token' : 'Authorization';
    prefix = placement === 'header' ? 'Bearer' : null;
    mapped =
      placement === 'header'
        ? executable('bearer', 'header', parameterName, 'Bearer')
        : executable('custom', 'query', parameterName, null);
    const scopes =
      stringValue(attrs.get('scope'))?.split(/[ ,]+/).filter(Boolean) ?? [];
    oauth = {
      ...(stringValue(attrs.get('authUrl'))
        ? { authorizationUrl: stringValue(attrs.get('authUrl')) }
        : {}),
      ...(stringValue(attrs.get('accessTokenUrl'))
        ? { tokenUrl: stringValue(attrs.get('accessTokenUrl')) }
        : {}),
      ...(stringValue(attrs.get('refreshTokenUrl'))
        ? { refreshUrl: stringValue(attrs.get('refreshTokenUrl')) }
        : {}),
      scopes: [...new Set(scopes)].sort(),
    };
  }

  return {
    id: type || 'unknown',
    source,
    scheme,
    label: type || 'Unknown authentication',
    supported: scheme === 'none' || mapped !== null,
    requestCount,
    totalRequests,
    placement,
    parameterName,
    prefix,
    parameterNames,
    variables,
    ...(oauth ? { oauth } : {}),
    executable: mapped,
  };
}

function postmanAuthSignature(type: string, auth: PostmanAuthLike): string {
  const attrs = postmanAttributes(auth, type);
  const structural = [...attrs.entries()]
    .map(([key, value]) => [
      key,
      key === 'key' || key === 'in' || key.toLowerCase().includes('url')
        ? (stringValue(value) ?? '')
        : templateVariables(value).join(','),
    ])
    .sort(([a], [b]) => String(a).localeCompare(String(b)));
  return JSON.stringify([type.toLowerCase(), structural]);
}

export function discoverPostmanAuth(
  doc: any,
  source = 'Postman collection',
): ConnectorAuthDiscovery {
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.item))
    return finish([], 0, []);
  const occurrences = new Map<
    string,
    { type: string; auth: PostmanAuthLike; count: number; order: number }
  >();
  let totalRequests = 0;
  let order = 0;

  const record = (auth: PostmanAuthLike | null | undefined) => {
    const type = stringValue(auth?.type) ?? 'noauth';
    const normalized = auth ?? { type: 'noauth' };
    const signature = postmanAuthSignature(type, normalized);
    const current = occurrences.get(signature);
    if (current) current.count++;
    else
      occurrences.set(signature, {
        type,
        auth: normalized,
        count: 1,
        order: order++,
      });
  };

  const walk = (
    items: unknown[],
    inherited: PostmanAuthLike | null | undefined,
  ) => {
    for (const raw of items) {
      if (!raw || typeof raw !== 'object' || (raw as any).disabled === true)
        continue;
      const item = raw as any;
      const own =
        item.auth === undefined || item.auth === null ? inherited : item.auth;
      if (Array.isArray(item.item)) {
        walk(item.item, own);
        continue;
      }
      if (!item.request || typeof item.request !== 'object') continue;
      totalRequests++;
      const requestAuth =
        item.request.auth === undefined || item.request.auth === null
          ? own
          : item.request.auth;
      record(requestAuth);
    }
  };
  walk(doc.item, doc.auth);

  const candidates = [...occurrences.values()]
    .sort((a, b) => a.order - b.order)
    .map(({ type, auth, count }) =>
      postmanCandidate(type, auth, source, count, totalRequests),
    );
  const warnings = candidates
    .filter((candidate) => candidate.scheme !== 'none' && !candidate.supported)
    .map(
      (candidate) =>
        `${source} uses unsupported ${candidate.label} authentication for ${candidate.requestCount} request(s)`,
    );
  return finish(candidates, totalRequests, warnings);
}

export function mergeAuthDiscoveries(
  discoveries: ConnectorAuthDiscovery[],
): ConnectorAuthDiscovery {
  const totalRequests = discoveries.reduce(
    (sum, discovery) => sum + discovery.totalRequests,
    0,
  );
  const candidates = discoveries.flatMap((discovery) =>
    discovery.candidates.map((candidate) => ({ ...candidate, totalRequests })),
  );
  return finish(
    candidates,
    totalRequests,
    discoveries.flatMap((discovery) => discovery.warnings),
  );
}

/** Normalize the standard authentication challenge returned by HTTP, GraphQL,
 * and MCP endpoints. Only structural metadata is retained; realms, errors, and
 * other server-provided text are intentionally discarded. */
export function discoverHttpAuthChallenge(
  challenge: string | null | undefined,
  source = 'HTTP endpoint',
): ConnectorAuthDiscovery {
  const raw = challenge?.trim() ?? '';
  const schemeName = raw.match(/^([A-Za-z][A-Za-z0-9_-]*)/)?.[1]?.toLowerCase();
  if (!schemeName) return finish([], 0, []);
  const resourceMetadata = raw.match(
    /(?:^|,)\s*resource_metadata\s*=\s*"([^"]+)"/i,
  )?.[1];
  const bearer = schemeName === 'bearer';
  const basic = schemeName === 'basic';
  const mapped = bearer
    ? executable('bearer', 'header', 'Authorization', 'Bearer')
    : basic
      ? executable('basic', 'header', 'Authorization', null)
      : null;
  const candidate: ConnectorAuthCandidate = {
    id: schemeName,
    source,
    scheme: bearer
      ? 'bearer'
      : basic
        ? 'basic'
        : schemeName === 'digest'
          ? 'digest'
          : 'unknown',
    label: `${schemeName[0]!.toUpperCase()}${schemeName.slice(1)} authentication`,
    supported: mapped !== null,
    requestCount: 1,
    totalRequests: 1,
    placement: 'header',
    parameterName: 'Authorization',
    prefix: bearer ? 'Bearer' : null,
    parameterNames: ['Authorization'],
    variables: [],
    ...(resourceMetadata
      ? {
          oauth: { protectedResourceMetadataUrl: resourceMetadata, scopes: [] },
        }
      : {}),
    executable: mapped,
  };
  return finish(
    [candidate],
    1,
    mapped
      ? []
      : [`${source} advertises unsupported ${schemeName} authentication`],
  );
}
