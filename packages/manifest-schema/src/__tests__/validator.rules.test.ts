import { describe, expect, test } from 'bun:test';
import { resolveGrantSet, validateManifest } from '../index.ts';

// Rules that apply to the `agents.<name>` block and the sections it references.

function summarize(input: string | Record<string, unknown>) {
  const result = validateManifest(input);
  const errorPaths = result.issues.filter((i) => i.severity === 'error').map((i) => i.path);
  const warningPaths = result.issues.filter((i) => i.severity === 'warning').map((i) => i.path);
  return { ...result, errorPaths, warningPaths };
}

describe('validateManifest — per-agent sandbox templates', () => {
  test('accepts a declared template and the reserved platform default', () => {
    const { valid, issues } = summarize(`
default_agent: researcher
sandbox:
  default: node
  templates:
    - slug: node
      name: Node
      image: node:22
    - slug: ml
      name: ML
      image: python:3.12
agents:
  researcher:
    sandbox: ml
  fallback:
    sandbox: default
`);
    expect(valid).toBe(true);
    expect(issues.filter((issue) => issue.severity === 'error')).toEqual([]);
  });

  test('accepts a valid dashboard-managed template slug', () => {
    const { valid, issues } = summarize(`
default_agent: researcher
sandbox:
  templates:
    - slug: node
      name: Node
      image: node:22
agents:
  researcher:
    sandbox: missing
`);
    expect(valid).toBe(true);
    expect(issues.filter((issue) => issue.severity === 'error')).toEqual([]);
  });

  test('rejects an invalid agent sandbox slug', () => {
    const { valid, issues } = summarize(`
default_agent: researcher
agents:
  researcher:
    sandbox: "Not Valid!"
`);
    expect(valid).toBe(false);
    expect(issues).toContainEqual(
      expect.objectContaining({
        path: 'agents.researcher.sandbox',
        severity: 'error',
      }),
    );
  });
});

// `per_user` connector credential mode was removed 2026-07-05:
// legacy value; it is an error now, same pattern as the removed CLI actions.
describe('validateManifest — connector `credential: per_user` removal', () => {
  test('rejects "per_user" outright', () => {
    const { valid, errorPaths, issues } = summarize(`
default_agent: w
agents:
  w: {}
connectors:
  - slug: gmail
    provider: pipedream
    app: gmail
    credential: per_user
`);
    expect(valid).toBe(false);
    expect(errorPaths).toContain('connectors[0].credential');
    expect(issues.find((i) => i.path === 'connectors[0].credential')?.message).toContain('removed');
  });

  test('accepts "shared" (the only mode) cleanly', () => {
    const { valid } = summarize(`
default_agent: w
agents:
  w: {}
connectors:
  - slug: gmail
    provider: pipedream
    app: gmail
    credential: shared
`);
    expect(valid).toBe(true);
  });

  test('hard-rejects a garbage credential value (not just "per_user")', () => {
    const { valid, errorPaths } = summarize(`
default_agent: w
agents:
  w: {}
connectors:
  - slug: gmail
    provider: pipedream
    app: gmail
    credential: team
`);
    expect(valid).toBe(false);
    expect(errorPaths).toContain('connectors[0].credential');
  });
});

describe('validateManifest — connector authorization strategy', () => {
  test('accepts project and user connectors for the same provider app', () => {
    const { valid, errorPaths } = summarize(`
default_agent: worker
agents:
  worker: {}
connectors:
  - slug: gmail-read
    name: Gmail read only
    provider: pipedream
    app: gmail
    authorization_strategy: project
  - slug: gmail-send
    name: Gmail send
    provider: pipedream
    app: gmail
    authorization_strategy: user
`);
    expect(valid).toBe(true);
    expect(errorPaths).toEqual([]);
  });

  test('rejects a both authorization strategy', () => {
    const { valid, errorPaths } = summarize(`
default_agent: worker
agents:
  worker: {}
connectors:
  - slug: gmail
    provider: pipedream
    app: gmail
    authorization_strategy: both
`);
    expect(valid).toBe(false);
    expect(errorPaths).toContain('connectors[0].authorization_strategy');
  });

  test('defaults an omitted authorization strategy without a warning', () => {
    const { valid, issues } = summarize(`
default_agent: worker
agents:
  worker: {}
connectors:
  - slug: gmail
    provider: pipedream
    app: gmail
`);
    expect(valid).toBe(true);
    expect(issues.find((issue) => issue.path === 'connectors[0].authorization_strategy')).toBeUndefined();
  });
});

// The connector-side agent gate (`[[connectors]].agent_scope`) was removed
// 2026-07 (wave-2 of the agent-first cut): connector access is now
// purely the agent's own `connectors` grant. The runtime (apps/api's
// connectors.ts `parseConnectorEntry`) no longer parses `agent_scope` at all —
// it is silently ignored, never round-tripped back into git. Same
// pattern as `credential: per_user`: an error.
describe('validateManifest — connector `agent_scope` removal', () => {
  test('rejects agent_scope outright', () => {
    const { valid, errorPaths, issues } = summarize(`
default_agent: w
agents:
  w: {}
connectors:
  - slug: gmail
    provider: pipedream
    app: gmail
    agent_scope: [support]
`);
    expect(valid).toBe(false);
    expect(errorPaths).toContain('connectors[0].agent_scope');
    expect(issues.find((i) => i.path === 'connectors[0].agent_scope')?.message).toBeDefined();
  });

});

// The 10 actions removed from IAM enforcement (dead-catalog cleanup) are
// are rejected: no tolerance.
describe('validateManifest — kortix_permissions LEGACY_TOLERATED_KORTIX_PERMISSIONS clean break', () => {
  test('hard-rejects the same legacy-removed action', () => {
    const { valid, errorPaths } = summarize(`
default_agent: w
agents:
  w:
    kortix_permissions: [project.schedule.read]
`);
    expect(valid).toBe(false);
    expect(errorPaths).toContain('agents.w.kortix_permissions[0]');
  });

  test('still hard-rejects a truly unknown (never-was-valid) action, same as before', () => {
    const { valid, errorPaths } = summarize(`
default_agent: w
agents:
  w:
    kortix_permissions: [project.frobnicate]
`);
    expect(valid).toBe(false);
    expect(errorPaths).toContain('agents.w.kortix_permissions[0]');
  });
});

describe('validateManifest — channels removal', () => {
  test('`channels` is invalid', () => {
    const { errorPaths, issues } = summarize(`
default_agent: w
agents:
  w: {}
channels:
  - platform: slack
`);
    expect(errorPaths).toContain('channels');
    expect(issues.find((i) => i.path === 'channels')?.message).toContain('connector');
  });
});

describe('validateManifest — default_agent', () => {
  test('default_agent referencing an undeclared agent is rejected', () => {
    const { errorPaths } = summarize(`
default_agent: ghost
agents:
  w: {}
`);
    expect(errorPaths).toContain('default_agent');
  });

  test('default_agent naming a declared agent passes', () => {
    const { valid } = summarize(`
default_agent: w
agents:
  w: {}
`);
    expect(valid).toBe(true);
  });

  test('default_agent naming a disabled agent is rejected', () => {
    const { errorPaths } = summarize(`
default_agent: w
agents:
  w:
    enabled: false
`);
    expect(errorPaths).toContain('default_agent');
  });
});

describe('validateManifest — trigger agent references', () => {
  test('a trigger agent naming an undeclared agent is rejected', () => {
    const { errorPaths } = summarize(`
default_agent: w
agents:
  w: {}
triggers:
  - slug: t
    type: cron
    cron: "0 9 * * *"
    prompt: go
    agent: ghost
`);
    expect(errorPaths).toContain('triggers[0].agent');
  });

  test('a trigger with no agent falls back to default_agent (valid)', () => {
    const { valid } = summarize(`
default_agent: w
agents:
  w: {}
triggers:
  - slug: t
    type: cron
    cron: "0 9 * * *"
    prompt: go
`);
    expect(valid).toBe(true);
  });

  test('a trigger agent naming a declared agent passes', () => {
    const { valid } = summarize(`
default_agent: w
agents:
  w: {}
  other: {}
triggers:
  - slug: t
    type: cron
    cron: "0 9 * * *"
    prompt: go
    agent: other
`);
    expect(valid).toBe(true);
  });
});

describe('validateManifest — grant sets are shape-optional', () => {
  test('omitting connectors, secrets, and kortix_permissions on an agent is still valid shape', () => {
    const { valid } = summarize(`
default_agent: w
agents:
  w: {}
`);
    expect(valid).toBe(true);
  });

  test('kortix_permissions rejects a non-grantable action, same enum', () => {
    const { errorPaths } = summarize(`
default_agent: w
agents:
  w:
    kortix_permissions: [billing.read]
`);
    expect(errorPaths).toContain('agents.w.kortix_permissions[0]');
  });

  test('workspace accepts the declared enum', () => {
    for (const w of ['runtime', 'read', 'branch']) {
      const { valid } = summarize(`
default_agent: a
agents:
  a:
    workspace: ${w}
`);
      expect(valid).toBe(true);
    }
  });

  test('an unknown workspace value is rejected', () => {
    const { errorPaths } = summarize(`
default_agent: w
agents:
  w:
    workspace: everywhere
`);
    expect(errorPaths).toContain('agents.w.workspace');
  });
});

describe('validateManifest — required connectors', () => {
  test('accepts the canonical field when every required connector is granted', () => {
    const { valid, issues } = summarize(`
default_agent: w
agents:
  w:
    connectors: [gmail, slack]
    connectors_required: [gmail]
    tools: all
`);
    expect(valid).toBe(true);
    expect(issues).toEqual([]);
  });

  test('rejects conflicting canonical and deprecated values', () => {
    const { errorPaths } = summarize(`
default_agent: w
agents:
  w:
    connectors: [gmail, slack]
    connectors_required: [gmail]
    connectors_personal: [slack]
`);
    expect(errorPaths).toContain('agents.w.connectors_personal');
  });

  test('rejects a required connector outside the resolved connector grant', () => {
    const { errorPaths } = summarize(`
default_agent: w
agents:
  w:
    connectors: [gmail]
    connectors_required: [slack]
`);
    expect(errorPaths).toContain('agents.w.connectors_required');
  });

  test('rejects required connectors when the connector grant resolves to none', () => {
    const { errorPaths } = summarize(`
default_agent: w
agents:
  w:
    connectors_required: [gmail]
`);
    expect(errorPaths).toContain('agents.w.connectors_required');
  });
});

describe('validateManifest — `skills` governance grant', () => {
  test('"all" and "none" string sentinels are accepted', () => {
    for (const v of ['all', 'none']) {
      const { valid } = summarize(`
default_agent: w
agents:
  w:
    skills: ${v}
`);
      expect(valid).toBe(true);
    }
  });

  test('{ exclude: [...] } is accepted; a malformed exclude is rejected', () => {
    const yaml = (skills: string) => `
default_agent: w
agents:
  w:
    skills: ${skills}
`;
    expect(summarize(yaml('{ exclude: [kortix-goals] }')).errorPaths).toEqual([]);
    expect(summarize(yaml('{ exclude: kortix-goals }')).errorPaths).toContain('agents.w.skills');
    expect(summarize(yaml('{ exclude: [42] }')).errorPaths).toContain('agents.w.skills');
    expect(summarize(yaml('{ exclude: [], also: [] }')).errorPaths).toContain('agents.w.skills');
  });

  test('omitting `skills` is still valid shape (deny-by-default applies at resolution time)', () => {
    const { valid } = summarize(`
default_agent: w
agents:
  w: {}
`);
    expect(valid).toBe(true);
  });

  test('a non-string entry is rejected, same shape rule as connectors', () => {
    const { errorPaths } = summarize(`
default_agent: w
agents:
  w:
    skills: [42]
`);
    expect(errorPaths).toContain('agents.w.skills[0]');
  });

  test('an invalid sentinel string is rejected', () => {
    const { errorPaths } = summarize(`
default_agent: w
agents:
  w:
    skills: everything
`);
    expect(errorPaths).toContain('agents.w.skills');
  });
});

describe('validateManifest — `apps` governance grant (spec 2.5)', () => {
  test('an explicit App slug list is accepted', () => {
    const { valid, errorPaths } = summarize(`
default_agent: w
agents:
  w:
    kortix_permissions: [project.app.read]
    apps: [reports-dashboard]
`);
    expect(valid).toBe(true);
    expect(errorPaths).toEqual([]);
  });

  test('"all" and "none" string sentinels are accepted', () => {
    for (const v of ['all', 'none']) {
      const { valid } = summarize(`
default_agent: w
agents:
  w:
    apps: ${v}
`);
      expect(valid).toBe(true);
    }
  });

  test('a non-string entry is rejected', () => {
    const { errorPaths } = summarize(`
default_agent: w
agents:
  w:
    apps: [42]
`);
    expect(errorPaths).toContain('agents.w.apps[0]');
  });

  test('an invalid sentinel string is rejected', () => {
    const { errorPaths } = summarize(`
default_agent: w
agents:
  w:
    apps: everything
`);
    expect(errorPaths).toContain('agents.w.apps');
  });

  test('an entry that is not an App slug is rejected', () => {
    const { errorPaths } = summarize(`
default_agent: w
agents:
  w:
    apps: ["Reports Dashboard"]
`);
    expect(errorPaths).toContain('agents.w.apps[0]');
  });
});

describe('resolveGrantSet', () => {
  test('"*" is a synonym of "all", alone or inside a list', () => {
    expect(resolveGrantSet('*', 'none')).toBe('all');
    expect(resolveGrantSet(['*'], 'none')).toBe('all');
    expect(resolveGrantSet(['*', 'project.gitops.merge'], 'none')).toBe('all');
    expect(resolveGrantSet(['github', ' * '], 'none')).toBe('all');
  });
  test('an omitted grant with default all resolves to "all"', () => {
    expect(resolveGrantSet(undefined, 'all')).toBe('all');
    expect(resolveGrantSet(null, 'all')).toBe('all');
  });

  test('semantics: an omitted grant resolves to "none"', () => {
    expect(resolveGrantSet(undefined, 'none')).toBe('none');
    expect(resolveGrantSet(null, 'none')).toBe('none');
  });

  test('an explicit "all" resolves to "all" regardless of the omitted-default', () => {
    expect(resolveGrantSet('all', 'none')).toBe('all');
  });

  test('an explicit "none" resolves to "none" regardless of the omitted-default', () => {
    expect(resolveGrantSet('none', 'all')).toBe('none');
  });

  test('an explicit empty string resolves to "none" (runtime treats "" as deny)', () => {
    expect(resolveGrantSet('', 'all')).toBe('none');
  });

  test('an explicit array resolves to its trimmed, filtered entries', () => {
    expect(resolveGrantSet(['github', ' slack ', ''], 'none')).toEqual(['github', 'slack']);
  });
});

describe('project tools', () => {
  const base = 'default_agent: w\nagents:\n  w: { tools: all }\n';

  test('maps tool names to repo-relative modules in any folder', () => {
    const result = summarize(base + 'tools:\n  lookup_order: tools/lookup_order.ts\n  crm_note: integrations/crm/note.mjs\n  ping: ping.js\n');
    expect(result.errorPaths).toEqual([]);
  });

  test('rejects bad names, harness names, unsafe paths and non-modules', () => {
    const result = summarize(
      base +
        'tools:\n  Lookup: tools/a.ts\n  bash: tools/bash.ts\n  pty_x: tools/pty.ts\n  up: ../outside.ts\n  abs: /etc/tool.ts\n  readme: tools/README.md\n  dir: tools/\n',
    );
    expect(result.errorPaths.sort()).toEqual(['tools.Lookup', 'tools.abs', 'tools.bash', 'tools.dir', 'tools.pty_x', 'tools.readme', 'tools.up']);
    expect(summarize(base + 'tools: [tools/a.ts]\n').errorPaths).toEqual(['tools']);
  });

  test('a Kortix tool name is allowed: the project tool replaces it', () => {
    expect(summarize(base + 'tools:\n  memory: tools/memory.ts\n').errorPaths).toEqual([]);
  });

});
