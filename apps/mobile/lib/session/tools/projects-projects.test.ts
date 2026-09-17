import { describe, expect, test } from 'bun:test';
import {
  projectCreateTrigger,
  projectDeleteTrigger,
  projectGetTrigger,
  projectListSubtitle,
  projectOpenTarget,
  projectSelectTrigger,
} from './projects-projects';
import {
  parseConnectorGetOutput,
  parseConnectorListOutput,
  parseConnectorSetupOutput,
  parseProjectCreateOutput,
  parseProjectListOutput,
  parseProjectSelectOutput,
} from './projects-tool-output';

// Port of apps/web `project-delete-tool.test.tsx`: the row is the whole
// message — title, the disabled notice, the project as its argument — and
// it has no body, so it is never a disclosure.
describe('projectDeleteTrigger', () => {
  test('names the project and says delete is disabled', () => {
    expect(projectDeleteTrigger({ project: 'kortix-web' })).toEqual({
      title: 'Workspace',
      subtitle: 'Workspace delete disabled',
      args: ['kortix-web'],
    });
  });

  test('with no project the message is preserved and there are no args', () => {
    expect(projectDeleteTrigger({})).toEqual({
      title: 'Workspace',
      subtitle: 'Workspace delete disabled',
      args: undefined,
    });
  });
});

describe('project row triggers (web copy)', () => {
  test('create: the parsed name wins over the input; failure falls back to "failed"', () => {
    expect(projectCreateTrigger({ name: 'draft' }, 'Project **Launch** at `/workspace/launch` (proj-abc12)', false)).toEqual({
      title: 'Workspace',
      subtitle: 'Launch',
    });
    expect(projectCreateTrigger({}, 'boom', true)).toEqual({ title: 'Workspace', subtitle: 'failed' });
  });

  test('select: "Workspace Active" when it worked, "Workspace" when it failed', () => {
    expect(projectSelectTrigger({ project: 'launch' }, 'Project **Launch** selected. Path: `/w`', false)).toEqual({
      title: 'Workspace Active',
      subtitle: 'Launch',
    });
    expect(projectSelectTrigger({ project: 'launch' }, '', true)).toEqual({ title: 'Workspace', subtitle: 'launch' });
  });

  test('get: the name, or "Fetching..." until the input names one', () => {
    expect(projectGetTrigger({ name: 'launch' })).toEqual({ title: 'Workspace Details', subtitle: 'launch' });
    expect(projectGetTrigger({})).toEqual({ title: 'Workspace Details', subtitle: 'Fetching...' });
  });

  test('list: "global workspace" only when a project parsed', () => {
    expect(projectListSubtitle(2)).toBe('global workspace');
    expect(projectListSubtitle(0)).toBeUndefined();
  });
});

describe('projectOpenTarget — a completed select/create row opens the project', () => {
  test('create: the proj- id from the output, the parsed name as the title', () => {
    expect(
      projectOpenTarget('project_create', 'completed', { name: 'draft' }, 'Project **Launch** at `/w` (proj-abc12)'),
    ).toEqual({ projectId: 'proj-abc12', displayName: 'Launch' });
  });

  test('select via an oc- dashed alias falls back to the input project', () => {
    expect(projectOpenTarget('oc-project-select', 'completed', { project: 'launch' }, 'done')).toEqual({
      projectId: 'launch',
      displayName: 'launch',
    });
  });

  test('a running call, another tool, or no id opens nothing', () => {
    expect(projectOpenTarget('project_create', 'running', { name: 'x' }, '')).toBeNull();
    expect(projectOpenTarget('project_get', 'completed', { name: 'x' }, 'proj-1')).toBeNull();
    expect(projectOpenTarget('project_select', 'completed', {}, '')).toBeNull();
  });
});

describe('kortix tool output parsers (web lib/utils/kortix-tool-output)', () => {
  test('project list: 4-column table, then the 3-column fallback', () => {
    expect(parseProjectListOutput('| **web** | `/workspace/web` | 3 | The site |')).toEqual([
      { name: 'web', path: '/workspace/web', sessions: 3, description: 'The site' },
    ]);
    expect(parseProjectListOutput('| **api** | `/workspace/api` |  |')).toEqual([
      { name: 'api', path: '/workspace/api', sessions: 0, description: '—' },
    ]);
    expect(parseProjectListOutput('')).toEqual([]);
  });

  test('project select / create', () => {
    expect(parseProjectSelectOutput('Project **Launch** selected\nPath: `/w/launch`')).toEqual({
      name: 'Launch',
      path: '/w/launch',
      success: true,
    });
    expect(parseProjectSelectOutput('nothing')).toBeNull();
    expect(parseProjectCreateOutput('Project **Launch** at `/w/launch` (proj-abc12)')).toEqual({
      name: 'Launch',
      path: '/w/launch',
      id: 'proj-abc12',
      success: true,
    });
  });

  test('connector list skips the header and separator rows', () => {
    const table = ['| Name | Description | Source |', '| --- | --- | --- |', '| slack | Team chat | builtin |'].join('\n');
    expect(parseConnectorListOutput(table)).toEqual([{ name: 'slack', description: 'Team chat', source: 'builtin' }]);
  });

  test('connector get / setup', () => {
    expect(parseConnectorGetOutput('name: slack\ndescription: Team chat\nsource: builtin\nenv: SLACK_TOKEN')).toEqual({
      name: 'slack',
      description: 'Team chat',
      source: 'builtin',
      env: 'SLACK_TOKEN',
      notes: undefined,
    });
    expect(parseConnectorGetOutput('no name here')).toBeNull();
    expect(parseConnectorSetupOutput('Created/updated 2 connectors:\nslack (builtin)\ngithub (oauth)')).toEqual({
      count: 2,
      connectors: ['slack (builtin)', 'github (oauth)'],
      success: true,
    });
  });
});
