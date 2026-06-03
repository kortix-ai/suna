/**
 * Materialization — map `[[connectors]]` + `[[policies]]` + `[policy]` specs
 * (from kortix.toml) onto the rows the platform stores (executor_connectors,
 * executor_connector_policies, executor_project_policies, executor_project_settings)
 * and onto the gateway's runtime view. Pure mapping + diff here (unit-tested);
 * the DB upsert + network catalog sync (fetch spec/introspection/listTools →
 * normalize → executor_connector_actions) is the integration layer that calls these.
 */
import type { ConnectorSpec } from '../projects/connectors';
import type {
  ProjectPolicySpec,
} from '../projects/policies';

interface DesiredPolicy {
  match: string;
  action: 'always_run' | 'require_approval' | 'block';
  position: number;
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

/** Map a connector's policies → ordered policy rows (authoring order = position). */
export function toPolicyRows(spec: ConnectorSpec): DesiredPolicy[] {
  return spec.policies.map((p, i) => ({ match: p.match, action: p.action, position: i }));
}

/** Map project-level [[policies]] → ordered policy rows (same shape as connector). */
export function toProjectPolicyRows(policies: ProjectPolicySpec[]): DesiredPolicy[] {
  return policies.map((p, i) => ({ match: p.match, action: p.action, position: i }));
}
