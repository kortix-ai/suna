import { describe, expect, test } from 'bun:test';
import { defaultAgentFromSeedFiles } from './seed-files';

// Regression coverage for the "agent-scope model pins silently never apply"
// bug: POST /projects/provision seeds a starter kortix.yaml that declares
// `default_agent: kortix`, but never stamped project.metadata.default_agent
// with it — every session then stored the non-binding 'default' sentinel
// (see sessions.ts createProjectSession), and an agent-scope model pin set on
// 'kortix' was never looked up. This helper extracts the seeded manifest's
// declared default agent so r1.ts's provision route can mirror it into
// project.metadata at creation time, same as PUT /:projectId/default-agent.
describe('defaultAgentFromSeedFiles', () => {
  test('extracts a declared default_agent from the seeded kortix.yaml', () => {
    const files = [
      { path: 'kortix.yaml', content: 'kortix_version: 2\ndefault_agent: kortix\nagents:\n  kortix: {}\n' },
    ];
    expect(defaultAgentFromSeedFiles(files, 'kortix.yaml')).toBe('kortix');
  });

  test('no default_agent declared → null (not every project needs one)', () => {
    const files = [{ path: 'kortix.yaml', content: 'kortix_version: 2\nagents:\n  kortix: {}\n' }];
    expect(defaultAgentFromSeedFiles(files, 'kortix.yaml')).toBeNull();
  });

  test('falls back to a literal "kortix.yaml" path when manifestPath differs', () => {
    const files = [{ path: 'kortix.yaml', content: 'default_agent: release-bot\n' }];
    expect(defaultAgentFromSeedFiles(files, 'config/kortix.toml')).toBe('release-bot');
  });

  test('no manifest file in the seed list → null, never throws', () => {
    const files = [{ path: 'README.md', content: '# hi' }];
    expect(defaultAgentFromSeedFiles(files, 'kortix.yaml')).toBeNull();
  });

  test('malformed YAML → null, never throws (project creation must not fail over this)', () => {
    const files = [{ path: 'kortix.yaml', content: ':::not yaml:::\n  - [unclosed' }];
    expect(defaultAgentFromSeedFiles(files, 'kortix.yaml')).toBeNull();
  });

  test('blank/whitespace-only default_agent is treated as unset', () => {
    const files = [{ path: 'kortix.yaml', content: 'default_agent: "   "\n' }];
    expect(defaultAgentFromSeedFiles(files, 'kortix.yaml')).toBeNull();
  });

  test('non-string default_agent (malformed manifest) → null, never throws', () => {
    const files = [{ path: 'kortix.yaml', content: 'default_agent: 42\n' }];
    expect(defaultAgentFromSeedFiles(files, 'kortix.yaml')).toBeNull();
  });
});
