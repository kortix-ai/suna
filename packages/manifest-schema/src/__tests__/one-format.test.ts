import { describe, expect, test } from 'bun:test';
import { usableManifest, validateManifest } from '../index.ts';

const check = (input: string | Record<string, unknown>) => validateManifest(input);

describe('kortix_version is obsolete', () => {
  test('no kortix_version is valid', () => {
    expect(check('project:\n  name: x\n').issues).toEqual([]);
  });

  test('kortix_version: 3 is valid with exactly one warning on kortix_version', () => {
    const result = check('kortix_version: 3\nproject:\n  name: x\n');
    expect(result.valid).toBe(true);
    expect(result.issues.map((i) => [i.path, i.severity])).toEqual([['kortix_version', 'warning']]);
  });

  test('kortix_version: 2 is the legacy format: one warning, the body is left to the converter', () => {
    const result = check('kortix_version: 2\nnot_a_key: 1\nagents: nope\n');
    expect(result.valid).toBe(true);
    expect(result.issues.map((i) => [i.path, i.severity, i.fix])).toEqual([['kortix_version', 'warning', 'legacy-format']]);
  });

  test('a version that never existed is one error', () => {
    const result = check('kortix_version: 7\n');
    expect(result.valid).toBe(false);
    expect(result.issues.map((i) => [i.path, i.severity])).toEqual([['kortix_version', 'error']]);
  });
});

describe('issue locations', () => {
  test('a YAML syntax error carries a line', () => {
    const [issue] = check('project:\n  name: a: b\n').issues;
    expect(issue?.path).toBe('<yaml>');
    expect(issue?.line).toBe(2);
  });

  test('an unknown agent key gets "Did you mean"', () => {
    const issue = check('agents:\n  a:\n    prompt: hi\n    tols: all\n').issues.find((i) => i.path === 'agents.a.tols');
    expect(issue?.message).toContain('Did you mean');
    expect(issue?.message).toContain('tools');
  });

  test('a nested issue points at its key: line and column', () => {
    const issue = check('agents:\n  a:\n    prompt: hi\n    tols: all\n').issues.find((i) => i.path === 'agents.a.tols');
    expect(issue?.line).toBe(4);
    expect(issue?.column).toBe(5);
  });
});

test('agents and default_agent are optional', () => {
  expect(check('triggers: []\n').valid).toBe(true);
  expect(check({}).valid).toBe(true);
});

describe('usableManifest', () => {
  const apply = (raw: Record<string, unknown>) => usableManifest(raw, validateManifest(raw).issues);
  const agents = { a: { prompt: 'go', tools: 'all' } };

  test('an unknown key is ignored and the agent stays enabled', () => {
    const out = apply({ agents: { a: { ...agents.a, tols: 'all' } } }) as { agents: { a: { enabled?: boolean } } };
    expect(out.agents.a.enabled).not.toBe(false);
  });

  test('an agent with a bad model is turned off', () => {
    const out = apply({ agents: { a: { ...agents.a, model: 5 } } }) as { agents: { a: { enabled?: boolean } } };
    expect(out.agents.a.enabled).toBe(false);
  });

  test('a trigger with a bad cron is turned off', () => {
    const out = apply({ agents, triggers: [{ slug: 't', type: 'cron', cron: 'nope', prompt: 'go' }] }) as { triggers: Array<{ enabled?: boolean }> };
    expect(out.triggers[0]?.enabled).toBe(false);
  });

  test('a bad connector is dropped', () => {
    const out = apply({ agents, connectors: [{ slug: 'x', provider: 'made-up' }] }) as { connectors: unknown[] };
    expect(out.connectors).toEqual([]);
  });

  test('a bad sandbox template is dropped', () => {
    const out = apply({ agents, sandbox: { templates: [{ slug: 'ok', image: 'python:3.12' }, { slug: 'bad', image: 'ubuntu' }] } }) as {
      sandbox: { templates: Array<{ slug: string }> };
    };
    expect(out.sandbox.templates.map((t) => t.slug)).toEqual(['ok']);
  });

  test('a bad default_agent is deleted', () => {
    const out = apply({ agents, default_agent: 'ghost' });
    expect('default_agent' in out).toBe(false);
    expect(out.agents).toEqual(agents);
  });

  test('an error in sandbox outside a template gives {}', () => {
    expect(apply({ agents, sandbox: { default: 'ghost' } })).toEqual({});
  });

  test('an unconverted legacy format gives {}: the reader converts it first', () => {
    expect(apply({ kortix_version: 2, agents })).toEqual({});
  });

  test('null gives {}', () => {
    expect(usableManifest(null, [])).toEqual({});
  });

  test('raw is not mutated', () => {
    const raw = { agents: { a: { ...agents.a, model: 5 } }, default_agent: 'ghost' };
    const before = structuredClone(raw);
    apply(raw);
    expect(raw).toEqual(before);
  });
});

describe('policy, policies, approvals: checked like the runtime reads them', () => {
  test('a bad default_mode is an error (the runtime would fall back to allow_all) and the run is built-ins only', () => {
    const r = validateManifest('policy:\n  default_mode: rsik\n');
    expect(r.issues.map((i) => [i.severity, i.path])).toEqual([['error', 'policy.default_mode']]);
    expect(usableManifest(r.parsed, r.issues)).toEqual({});
  });

  test('a bad rule is an error per field: match, action, conditions', () => {
    const r = validateManifest("policies:\n  - match: '/(a+)+/'\n    action: blok\n    conditions:\n      - arg: __proto__.x\n        match: a\n");
    expect(r.issues.map((i) => i.path)).toEqual(['policies[0].match', 'policies[0].action', 'policies[0].conditions']);
  });

  test('a bad approvals.ttl is a warning: the 24h default applies', () => {
    const r = validateManifest('approvals:\n  ttl: 1w\n');
    expect(r.valid).toBe(true);
    expect(r.issues.map((i) => [i.severity, i.path])).toEqual([['warning', 'approvals.ttl']]);
  });
});
