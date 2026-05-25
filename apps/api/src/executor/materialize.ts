/**
 * Materialization — map `[[connectors]]` specs (from kortix.toml) onto the rows
 * the platform stores (executor_connectors + executor_connector_policies) and
 * onto the gateway's runtime view. Pure mapping + diff here (unit-tested); the
 * DB upsert + network catalog sync (fetch spec/introspection/listTools →
 * normalize → executor_connector_actions) is the integration layer that calls
 * these. See docs/specs/executor.md §3, §7.
 */
import type { ConnectorSpec } from '../projects/connectors';
import { manifestHashForConnector } from '../projects/connectors';
import type { ExecutorAuth } from './execute';

/** The row shape we persist for a connector (sans ids/timestamps). */
export interface DesiredConnector {
  slug: string;
  name: string;
  providerType: ConnectorSpec['provider'];
  enabled: boolean;
  config: Record<string, unknown>;
  authSecret: string | null;
  manifestHash: string;
}

export interface DesiredPolicy {
  match: string;
  action: 'always_run' | 'require_approval' | 'block';
  position: number;
}

/** Gateway auth view (no secret value — that's resolved server-side at call time). */
export function gatewayAuth(spec: ConnectorSpec): ExecutorAuth {
  return { type: spec.auth.type, in: spec.auth.in, name: spec.auth.name, prefix: spec.auth.prefix };
}

/**
 * The base URL the gateway calls. For openapi it's discovered from the spec doc
 * at sync time (servers[0]) and folded into config; the manifest only holds the
 * spec ref. http/graphql/mcp carry it directly.
 */
export function gatewayBaseUrl(spec: ConnectorSpec, openapiServer?: string | null): string | null {
  switch (spec.provider) {
    case 'http':
      return spec.baseUrl;
    case 'graphql':
      return spec.endpoint;
    case 'mcp':
      return spec.url;
    case 'openapi':
      return openapiServer ?? null;
    default:
      return null;
  }
}

/** Provider-specific config blob stored on the connector row. */
export function connectorConfig(spec: ConnectorSpec, openapiServer?: string | null): Record<string, unknown> {
  const auth = { type: spec.auth.type, in: spec.auth.in, name: spec.auth.name, prefix: spec.auth.prefix };
  switch (spec.provider) {
    case 'pipedream':
      return { app: spec.app, account: spec.account };
    case 'mcp':
      return { url: spec.url, transport: spec.transport, auth };
    case 'graphql':
      return { endpoint: spec.endpoint, spec: spec.spec, auth };
    case 'http':
      return { baseUrl: spec.baseUrl, spec: spec.spec, auth };
    case 'openapi':
      return { spec: spec.spec, server: openapiServer ?? null, auth };
    default:
      return {};
  }
}

/** Map a ConnectorSpec → the row we persist. */
export function toDesiredConnector(spec: ConnectorSpec, openapiServer?: string | null): DesiredConnector {
  return {
    slug: spec.slug,
    name: spec.name,
    providerType: spec.provider,
    enabled: spec.enabled,
    config: connectorConfig(spec, openapiServer),
    authSecret: spec.auth.secret,
    manifestHash: manifestHashForConnector(spec),
  };
}

/** Map a connector's policies → ordered policy rows (authoring order = position). */
export function toPolicyRows(spec: ConnectorSpec): DesiredPolicy[] {
  return spec.policies.map((p, i) => ({ match: p.match, action: p.action, position: i }));
}

export interface DiffResult<T> {
  toCreate: T[];
  toUpdate: T[];
  toDeleteSlugs: string[];
}

/**
 * Diff desired connectors against what's stored (by slug). `existing` maps
 * slug → manifestHash so we only update when the config actually changed.
 */
export function diffConnectors(
  desired: DesiredConnector[],
  existing: Map<string, string>,
): DiffResult<DesiredConnector> {
  const toCreate: DesiredConnector[] = [];
  const toUpdate: DesiredConnector[] = [];
  const desiredSlugs = new Set(desired.map((d) => d.slug));

  for (const d of desired) {
    const prevHash = existing.get(d.slug);
    if (prevHash === undefined) toCreate.push(d);
    else if (prevHash !== d.manifestHash) toUpdate.push(d);
    // else unchanged — skip
  }
  const toDeleteSlugs = [...existing.keys()].filter((slug) => !desiredSlugs.has(slug));
  return { toCreate, toUpdate, toDeleteSlugs };
}
