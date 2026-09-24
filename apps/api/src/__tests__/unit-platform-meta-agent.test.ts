import { describe, expect, test } from 'bun:test';

import {
  addPlatformMetaAgent,
  buildPlatformMetaOpenCodeConfig,
  platformMetaAgentGrant,
  resolvePlatformMetaSandbox,
} from '../projects/lib/platform-meta-agent';
import { resolveFeatureFlag } from '../feature-flags/registry';
import { KORTIX_AGENT_DESCRIPTION, KORTIX_AGENT_PROMPT } from '@kortix/shared';
import { resolveManifestVerdict } from '../projects/lib/manifest-verdict';

describe('platform meta agent', () => {
  test('adds one reserved meta agent and replaces a project collision', () => {
    const config = addPlatformMetaAgent({
      agents: [
        {
          name: 'meta',
          path: '/project/AGENTS.md',
          source: 'opencode',
          description: 'project override',
          mode: 'primary',
        },
      ],
      commands: [],
      skills: [],
      is_kortix_repo: true,
      signals: {},
      manifest_raw: null,
      manifest: {},
      manifest_version: resolveManifestVerdict({
        raw: null,
        format: 'yaml',
        path: null,
      }),
      env: { required: [], optional: [] },
      open_code_raw: null,
      open_code_default_agent: null,
      agent_discovery: 'opencode',
    });

    expect(config.agents.filter((agent) => agent.name === 'meta')).toHaveLength(1);
    expect(config.agents[0]).toMatchObject({
      name: 'meta',
      path: '/workspace/AGENTS.md',
      scope: {
        env: [],
        connectors: [],
        kortix_permissions: 'all',
      },
    });
    expect(config.open_code_default_agent).toBe('meta');
  });

  test('defines the Kortix Agent with the platform prompt', () => {
    expect(JSON.parse(buildPlatformMetaOpenCodeConfig())).toEqual({
      agent: {
        meta: {
          description: KORTIX_AGENT_DESCRIPTION,
          mode: 'primary',
          prompt: KORTIX_AGENT_PROMPT,
        },
      },
    });
  });

  test('the prompt keeps the conversation, routing, and confirmation contract', () => {
    // The behaviors the product promises. A prompt edit that drops one of
    // these changes what users get from the default agent.
    expect(KORTIX_AGENT_PROMPT).toContain('kortix agents list');
    expect(KORTIX_AGENT_PROMPT).toContain('kortix sessions wait-for');
    expect(KORTIX_AGENT_PROMPT).toContain('The worker does not see this conversation');
    expect(KORTIX_AGENT_PROMPT).toContain('Confirm with the user before you delete anything');
    // Delivered through an env var: stay far below Linux's 128 KiB per-var cap.
    expect(buildPlatformMetaOpenCodeConfig().length).toBeLessThan(16 * 1024);
  });

  test('forces the meta sandbox and rejects an explicit alternate sandbox', () => {
    expect(resolvePlatformMetaSandbox(undefined)).toBe('meta');
    expect(resolvePlatformMetaSandbox('meta')).toBe('meta');
    expect(() => resolvePlatformMetaSandbox('node22')).toThrow('META_SANDBOX_LOCKED');
  });

  test('grants the coordinator every project action without secrets or connectors', () => {
    expect(platformMetaAgentGrant()).toEqual({
      agent: 'meta',
      permissions: 'all',
      connectors: [],
      env: [],
    });
  });

  // Read through the canonical registry helper at every call site — the module
  // above must stay free of runtime imports, see its header comment.
  test('is gated on the meta_agent feature flag, default on', () => {
    expect(resolveFeatureFlag(null, 'meta_agent')).toBe(true);
    expect(resolveFeatureFlag({}, 'meta_agent')).toBe(true);
    expect(resolveFeatureFlag({ experimental: {} }, 'meta_agent')).toBe(true);
    expect(resolveFeatureFlag({ experimental: { meta_agent: false } }, 'meta_agent')).toBe(false);
    expect(resolveFeatureFlag({ experimental: { meta_agent: true } }, 'meta_agent')).toBe(true);
  });
});
