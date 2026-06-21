import { describe, expect, test } from 'bun:test';
import {
  getStarterFiles,
  normalizeStarterTemplateId,
  listGeneralKnowledgeWorkerSkills,
  STARTER_TEMPLATE_IDS,
  DEFAULT_STARTER_TEMPLATE_ID,
  type StarterFile,
} from './index';

function byPath(files: StarterFile[]): Map<string, string> {
  return new Map(files.map((f) => [f.path, f.content]));
}

describe('STARTER_TEMPLATE_IDS', () => {
  test('contains the two known templates', () => {
    expect([...STARTER_TEMPLATE_IDS]).toEqual(['minimal', 'general-knowledge-worker']);
  });

  test('default template is the general knowledge worker', () => {
    expect(DEFAULT_STARTER_TEMPLATE_ID).toBe('general-knowledge-worker');
  });
});

describe('normalizeStarterTemplateId', () => {
  test('returns a known id unchanged', () => {
    expect(normalizeStarterTemplateId('minimal')).toBe('minimal');
    expect(normalizeStarterTemplateId('general-knowledge-worker')).toBe('general-knowledge-worker');
  });

  test('falls back to the default for an unknown string', () => {
    expect(normalizeStarterTemplateId('nope')).toBe(DEFAULT_STARTER_TEMPLATE_ID);
  });

  test('falls back to the default for undefined', () => {
    expect(normalizeStarterTemplateId(undefined)).toBe(DEFAULT_STARTER_TEMPLATE_ID);
  });

  test('falls back to the default for null', () => {
    expect(normalizeStarterTemplateId(null)).toBe(DEFAULT_STARTER_TEMPLATE_ID);
  });

  test('falls back to the default for a non-string value', () => {
    expect(normalizeStarterTemplateId(42)).toBe(DEFAULT_STARTER_TEMPLATE_ID);
  });

  test('falls back to the default for an empty string', () => {
    expect(normalizeStarterTemplateId('')).toBe(DEFAULT_STARTER_TEMPLATE_ID);
  });
});

describe('getStarterFiles', () => {
  test('returns a non-empty list of files for the minimal template', () => {
    const files = getStarterFiles({ projectName: 'Acme', template: 'minimal' });
    expect(files.length).toBeGreaterThan(0);
  });

  test('every file carries a posix relative path and string content', () => {
    const files = getStarterFiles({ projectName: 'Acme', template: 'minimal' });
    for (const file of files) {
      expect(file.path.startsWith('/')).toBe(false);
      expect(file.path.includes('\\')).toBe(false);
      expect(typeof file.content).toBe('string');
    }
  });

  test('files are sorted by path for stable ordering', () => {
    const files = getStarterFiles({ projectName: 'Acme', template: 'minimal' });
    const paths = files.map((f) => f.path);
    const sorted = [...paths].sort((a, b) => a.localeCompare(b));
    expect(paths).toEqual(sorted);
  });

  test('paths are unique', () => {
    const files = getStarterFiles({ projectName: 'Acme', template: 'minimal' });
    const paths = files.map((f) => f.path);
    expect(new Set(paths).size).toBe(paths.length);
  });

  test('interpolates the projectName placeholder', () => {
    const files = getStarterFiles({ projectName: 'My Cool Project', template: 'general-knowledge-worker' });
    const memory = byPath(files).get('.kortix/memory/MEMORY.md');
    expect(memory).toBeDefined();
    expect(memory!).toContain('My Cool Project');
    expect(memory!).not.toContain('{{projectName}}');
  });

  test('defaults repoFullName when omitted', () => {
    const withoutRepo = getStarterFiles({ projectName: 'X', template: 'minimal' });
    const withRepo = getStarterFiles({ projectName: 'X', template: 'minimal', repoFullName: 'me/mine' });
    const joinedDefault = withoutRepo.map((f) => f.content).join('\n');
    const joinedCustom = withRepo.map((f) => f.content).join('\n');
    if (joinedDefault.includes('your-org/your-repo') || joinedCustom.includes('me/mine')) {
      expect(joinedCustom).toContain('me/mine');
    } else {
      expect(joinedDefault).not.toContain('{{repoFullName}}');
    }
  });

  test('an unknown template value falls back to the default template layers', () => {
    const fallback = getStarterFiles({ projectName: 'X', template: 'bogus' as never });
    const general = getStarterFiles({ projectName: 'X', template: 'general-knowledge-worker' });
    expect(fallback.map((f) => f.path)).toEqual(general.map((f) => f.path));
  });

  test('general-knowledge-worker includes more files than minimal', () => {
    const minimal = getStarterFiles({ projectName: 'X', template: 'minimal' });
    const general = getStarterFiles({ projectName: 'X', template: 'general-knowledge-worker' });
    expect(general.length).toBeGreaterThanOrEqual(minimal.length);
  });

  test('minimal template files are a subset of general-knowledge-worker paths', () => {
    const minimalPaths = new Set(getStarterFiles({ projectName: 'X', template: 'minimal' }).map((f) => f.path));
    const generalPaths = new Set(getStarterFiles({ projectName: 'X', template: 'general-knowledge-worker' }).map((f) => f.path));
    for (const p of minimalPaths) {
      expect(generalPaths.has(p)).toBe(true);
    }
  });

  test('leaves unknown placeholders intact', () => {
    const files = getStarterFiles({ projectName: 'X', template: 'general-knowledge-worker' });
    const joined = files.map((f) => f.content).join('\n');
    expect(joined).not.toContain('{{projectName}}');
  });

  test('produces no content containing a leftover {{projectName}} token', () => {
    const files = getStarterFiles({ projectName: 'Determinism', template: 'general-knowledge-worker' });
    for (const file of files) {
      expect(file.content.includes('{{projectName}}')).toBe(false);
    }
  });

  test('is deterministic across repeated calls', () => {
    const a = getStarterFiles({ projectName: 'Same', template: 'general-knowledge-worker' });
    const b = getStarterFiles({ projectName: 'Same', template: 'general-knowledge-worker' });
    expect(a).toEqual(b);
  });

  test('always includes the base kortix.toml', () => {
    const files = getStarterFiles({ projectName: 'X', template: 'minimal' });
    expect(byPath(files).has('kortix.toml')).toBe(true);
  });
});

describe('listGeneralKnowledgeWorkerSkills', () => {
  test('returns a non-empty, sorted list of skill directory names', () => {
    const skills = listGeneralKnowledgeWorkerSkills();
    expect(skills.length).toBeGreaterThan(0);
    const sorted = [...skills].sort((a, b) => a.localeCompare(b));
    expect(skills).toEqual(sorted);
  });

  test('entries are plain directory names, not nested paths', () => {
    for (const skill of listGeneralKnowledgeWorkerSkills()) {
      expect(skill.includes('/')).toBe(false);
      expect(skill.length).toBeGreaterThan(0);
    }
  });

  test('entries are unique', () => {
    const skills = listGeneralKnowledgeWorkerSkills();
    expect(new Set(skills).size).toBe(skills.length);
  });
});
