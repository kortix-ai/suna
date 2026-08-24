import { describe, expect, test } from 'bun:test';

import { projectDetailLlmGatewayEnabled } from './use-project-llm-gateway';
import type { ProjectDetail } from '../core/rest/projects-client';

const detailWith = (experimental: Record<string, boolean> | undefined): ProjectDetail =>
  ({ project: { experimental } }) as unknown as ProjectDetail;

// The one predicate every gateway-gated query (/model-defaults, /model-picker,
// routing policy) forks on. It must agree with useOpenCodeProviders' provider
// mode: flag off ⇒ native mode ⇒ those routes 404 llm_gateway_disabled and
// must never be fetched.
describe('projectDetailLlmGatewayEnabled', () => {
  test('true only when the effective flag map says so', () => {
    expect(projectDetailLlmGatewayEnabled(detailWith({ llm_gateway: true }))).toBe(true);
  });

  test('false when the flag is off', () => {
    expect(projectDetailLlmGatewayEnabled(detailWith({ llm_gateway: false }))).toBe(false);
  });

  test('false (never fetch) when the map or detail is absent', () => {
    expect(projectDetailLlmGatewayEnabled(detailWith(undefined))).toBe(false);
    expect(projectDetailLlmGatewayEnabled(undefined)).toBe(false);
  });
});
