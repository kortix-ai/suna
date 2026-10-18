/**
 * The agent editor on a kortix_version 3 manifest. v3 keeps behavior and
 * grants in one YAML block and the prompt in `prompt` or `prompt_file`, so the
 * editor's wire shape (`block` + `block.behavior`) maps onto one block plus at
 * most one prompt file. Pure functions: the route does the git I/O.
 */
import { describe, expect, test } from 'bun:test';
import { validateManifest } from '@kortix/manifest-schema';
import {
  agentConfigViewV3,
  applyAgentBlockV2,
  applyAgentConfigV3,
  applyAgentScopeV2,
  applyDefaultAgentV2,
  grantSecretToAgentV2,
  readAgentBlockV2,
} from '../projects/lib/agent-config-v2';
import { parseManifestString, serializeManifest, synthesizeBlankManifest } from '../projects/triggers';

const V3 = `
kortix_version: 3
default_agent: support
skills:
  triage: skills/triage
commands:
  report:
    prompt: Write the report.
extensions:
  audit:
    opencode: extensions/audit.ts
agents:
  support:
    description: Answers tickets.
    mode: primary
    model: kortix/glm-5.3-flash
    prompt_file: agents/support.md
    permission:
      bash: ask
    skills: [triage]
    subagents: [researcher]
    commands: [report]
    extensions: [audit]
    codemode: only
    connectors: [github]
    secrets: [STRIPE_KEY]
    kortix_permissions: [project.session.start]
  researcher:
    mode: subagent
    prompt: You research accounts.
`;

const manifest = () => parseManifestString(V3, 'yaml', 'kortix.yaml');
const block = (raw: Record<string, unknown>, name: string) =>
  (raw.agents as Record<string, Record<string, unknown>>)[name]!;

describe('readAgentBlockV2 on v3', () => {
  test('reads the declared block of a v3 agent', () => {
    const read = readAgentBlockV2(manifest(), 'support');

    expect(read).toMatchObject({ ok: true, schemaVersion: 3, defaultAgent: 'support' });
    if (!read.ok) return;
    expect(read.block).toMatchObject({ prompt_file: 'agents/support.md', subagents: ['researcher'] });
  });
});

describe('agentConfigViewV3', () => {
  test('splits a block into governance (with the v3 grants and file) and behavior (with the prompt file text)', () => {
    const view = agentConfigViewV3(block(manifest().raw, 'support'), 'Be kind.\n');

    expect(view.behavior).toEqual({
      description: 'Answers tickets.',
      mode: 'primary',
      model: 'kortix/glm-5.3-flash',
      permission: { bash: 'ask' },
      prompt: 'Be kind.\n',
    });
    expect(view.governance).toEqual({
      file: 'agents/support.md',
      skills: ['triage'],
      subagents: ['researcher'],
      commands: ['report'],
      extensions: ['audit'],
      codemode: 'only',
      connectors: ['github'],
      secrets: ['STRIPE_KEY'],
      kortix_permissions: ['project.session.start'],
      repository_access: false,
    });
  });

  test('an inline prompt is the behavior prompt and no file is served', () => {
    const view = agentConfigViewV3(block(manifest().raw, 'researcher'), null);

    expect(view.behavior).toEqual({ mode: 'subagent', prompt: 'You research accounts.' });
    expect(view.governance.file).toBeUndefined();
  });

  test('a workspace choice reads as repository_access', () => {
    const view = agentConfigViewV3({ workspace: { project_repository: false } }, null);

    expect(view.governance).toEqual({ repository_access: false });
  });
});

describe('applyAgentConfigV3', () => {
  test('writes behavior into the YAML block and the prompt into the existing prompt_file', () => {
    const applied = applyAgentConfigV3(manifest(), 'support', {
      governance: { file: 'agents/support.md', skills: 'all', connectors: ['github'], secrets: ['STRIPE_KEY'] },
      behavior: { description: 'Answers tickets fast.', mode: 'primary', temperature: 0.2, prompt: 'Be brief.\n' },
    });

    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.promptWrite).toEqual({ path: 'agents/support.md', content: 'Be brief.\n' });
    expect(block(applied.raw, 'support')).toEqual({
      description: 'Answers tickets fast.',
      mode: 'primary',
      temperature: 0.2,
      prompt_file: 'agents/support.md',
      skills: 'all',
      // v3-only grants the body did not send are kept.
      subagents: ['researcher'],
      commands: ['report'],
      extensions: ['audit'],
      codemode: 'only',
      connectors: ['github'],
      secrets: ['STRIPE_KEY'],
      // An omitted repository choice is pinned to the v3 default.
      workspace: { project_repository: false },
    });
    expect(validateManifest(applied.raw, 'yaml').valid).toBe(true);
  });

  test('a governance-only edit keeps behavior, the prompt and the prompt file untouched', () => {
    const applied = applyAgentConfigV3(manifest(), 'support', { governance: { connectors: 'all' } });

    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.promptWrite).toBeNull();
    expect(block(applied.raw, 'support')).toMatchObject({
      description: 'Answers tickets.',
      model: 'kortix/glm-5.3-flash',
      prompt_file: 'agents/support.md',
      permission: { bash: 'ask' },
      connectors: 'all',
    });
    expect(block(applied.raw, 'support').secrets).toBeUndefined();
  });

  test('an inline prompt stays inline', () => {
    const applied = applyAgentConfigV3(manifest(), 'researcher', {
      governance: {},
      behavior: { mode: 'subagent', prompt: 'You research accounts and cite sources.' },
    });

    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.promptWrite).toBeNull();
    expect(block(applied.raw, 'researcher')).toEqual({ mode: 'subagent', prompt: 'You research accounts and cite sources.', workspace: { project_repository: false } });
  });

  test('a new agent with a prompt gets agents/<name>.md as its prompt file', () => {
    const applied = applyAgentConfigV3(manifest(), 'writer', {
      governance: { skills: ['triage'] },
      behavior: { mode: 'all', prompt: 'You write.\n' },
    });

    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.promptWrite).toEqual({ path: 'agents/writer.md', content: 'You write.\n' });
    expect(block(applied.raw, 'writer')).toEqual({ mode: 'all', prompt_file: 'agents/writer.md', skills: ['triage'], workspace: { project_repository: false } });
  });

  test('clearing an inline prompt removes the key', () => {
    const applied = applyAgentConfigV3(manifest(), 'researcher', { governance: {}, behavior: { mode: 'subagent' } });

    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(block(applied.raw, 'researcher')).toEqual({ mode: 'subagent', workspace: { project_repository: false } });
  });

  test('a v3 grant sent as none clears it', () => {
    const applied = applyAgentConfigV3(manifest(), 'support', {
      governance: { subagents: 'none', commands: 'none', extensions: 'none' },
    });

    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    const next = block(applied.raw, 'support');
    expect(next.subagents).toBeUndefined();
    expect(next.commands).toBeUndefined();
    expect(next.extensions).toBeUndefined();
  });

  test('an omitted repository choice is written explicitly as the v3 default, false', () => {
    const applied = applyAgentConfigV3(manifest(), 'researcher', { governance: { skills: 'all' } });

    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(block(applied.raw, 'researcher').workspace).toEqual({ project_repository: false });
  });

  test('repository_access is written as workspace.project_repository', () => {
    const applied = applyAgentConfigV3(manifest(), 'researcher', { governance: { repository_access: false } });

    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(block(applied.raw, 'researcher').workspace).toEqual({ project_repository: false });
  });

  test('refuses a different file than the current prompt_file', () => {
    const applied = applyAgentConfigV3(manifest(), 'support', { governance: { file: 'agents/other.md' } });

    expect(applied).toMatchObject({ ok: false });
    if (applied.ok) return;
    expect(applied.error).toContain('agents/support.md');
  });

  test('a grant naming an unregistered thing is a validation error', () => {
    const applied = applyAgentConfigV3(manifest(), 'support', { governance: { extensions: ['nope'] } });

    expect(applied).toMatchObject({ ok: false });
    if (applied.ok) return;
    expect(applied.error).toContain('agents.support.extensions');
  });

  test('a v2-only behavior key is refused', () => {
    const applied = applyAgentConfigV3(manifest(), 'support', {
      governance: {},
      behavior: { permission: { skill: { '*': 'allow' } } },
    });

    expect(applied).toMatchObject({ ok: false });
  });
});

describe('the v2 writers accept a v3 manifest', () => {
  test('applyDefaultAgentV2 sets a v3 default agent', () => {
    expect(applyDefaultAgentV2(manifest(), 'support').ok).toBe(true);
  });

  test('applyAgentScopeV2 edits a v3 agent scope', () => {
    const applied = applyAgentScopeV2(manifest(), 'support', { env: 'all' });

    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(block(applied.raw, 'support')).toMatchObject({ secrets: 'all', prompt_file: 'agents/support.md' });
  });

  test('grantSecretToAgentV2 grants a secret to a v3 agent (kortix secrets grant)', () => {
    const granted = grantSecretToAgentV2(manifest(), 'researcher', 'HELPDESK_TOKEN');

    expect(granted).toMatchObject({ ok: true, alreadyGranted: false });
    if (!granted.ok) return;
    expect(block(granted.raw, 'researcher')).toEqual({ mode: 'subagent', prompt: 'You research accounts.', secrets: ['HELPDESK_TOKEN'], workspace: { project_repository: false } });
  });

  test('applyAgentBlockV2 refuses a v1 manifest only', () => {
    expect(applyAgentBlockV2(manifest(), 'support', { connectors: 'all' } as never).ok).toBe(true);
  });
});
