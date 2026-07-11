import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_STARTER_TEMPLATE_ID,
  KORTIX_MANAGED_SKILL_NAMES,
  SKILL_PACKS,
  SKILL_PACK_IDS,
  STARTER_TEMPLATE_IDS,
  type StarterFile,
  getMarketplaceFiles,
  getSkillPack,
  getStarterFiles,
  isKortixManagedSkillName,
  listGeneralKnowledgeWorkerSkills,
  normalizeStarterTemplateId,
  resolveSkillPackSkills,
} from './index';

function byPath(files: StarterFile[]): Map<string, string> {
  return new Map(files.map((f) => [f.path, f.content]));
}

describe('STARTER_TEMPLATE_IDS', () => {
  test('contains the two known templates', () => {
    expect([...STARTER_TEMPLATE_IDS]).toEqual(['minimal', 'general-knowledge-worker']);
  });

  test('default template is the minimal Kortix runtime floor', () => {
    expect(DEFAULT_STARTER_TEMPLATE_ID).toBe('minimal');
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
    const files = getStarterFiles({
      projectName: 'My Cool Project',
      template: 'general-knowledge-worker',
    });
    const memory = byPath(files).get('.kortix/memory/MEMORY.md');
    expect(memory).toBeDefined();
    expect(memory!).toContain('My Cool Project');
    expect(memory!).not.toContain('{{projectName}}');
  });

  test('defaults repoFullName when omitted', () => {
    const withoutRepo = getStarterFiles({ projectName: 'X', template: 'minimal' });
    const withRepo = getStarterFiles({
      projectName: 'X',
      template: 'minimal',
      repoFullName: 'me/mine',
    });
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
    const minimal = getStarterFiles({ projectName: 'X', template: 'minimal' });
    expect(fallback.map((f) => f.path)).toEqual(minimal.map((f) => f.path));
  });

  test('general-knowledge-worker includes more files than minimal', () => {
    const minimal = getStarterFiles({ projectName: 'X', template: 'minimal' });
    const general = getStarterFiles({ projectName: 'X', template: 'general-knowledge-worker' });
    expect(general.length).toBeGreaterThanOrEqual(minimal.length);
  });

  test('minimal template files are a subset of general-knowledge-worker paths', () => {
    const minimalPaths = new Set(
      getStarterFiles({ projectName: 'X', template: 'minimal' }).map((f) => f.path),
    );
    const generalPaths = new Set(
      getStarterFiles({ projectName: 'X', template: 'general-knowledge-worker' }).map(
        (f) => f.path,
      ),
    );
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
    const files = getStarterFiles({
      projectName: 'Determinism',
      template: 'general-knowledge-worker',
    });
    for (const file of files) {
      expect(file.content.includes('{{projectName}}')).toBe(false);
    }
  });

  test('is deterministic across repeated calls', () => {
    const a = getStarterFiles({ projectName: 'Same', template: 'general-knowledge-worker' });
    const b = getStarterFiles({ projectName: 'Same', template: 'general-knowledge-worker' });
    expect(a).toEqual(b);
  });

  test('always includes the base kortix.yaml', () => {
    const files = getStarterFiles({ projectName: 'X', template: 'minimal' });
    expect(byPath(files).has('kortix.yaml')).toBe(true);
  });

  test('default starter does not ship general knowledge worker skills', () => {
    const files = getStarterFiles({ projectName: 'X' });
    expect(files.some((f) => f.path === '.kortix/opencode/skills/account-research/SKILL.md')).toBe(
      false,
    );
    expect(files.some((f) => f.path === '.kortix/opencode/skills/pdf/SKILL.md')).toBe(false);
  });

  test('minimal starter includes the default runtime tools but not optional marketplace skills', () => {
    const files = getStarterFiles({ projectName: 'X', template: 'minimal' });
    const paths = new Set(files.map((f) => f.path));

    expect(paths.has('.kortix/opencode/tools/show.ts')).toBe(true);
    expect(paths.has('.kortix/opencode/skills/kortix-system/SKILL.md')).toBe(true);
    expect(paths.has('.kortix/opencode/skills/agent-browser/SKILL.md')).toBe(false);
    expect(paths.has('.kortix/opencode/plugins/pty.ts')).toBe(true);
    expect(paths.has('.kortix/opencode/plugins/opencode-pty/src/plugin/pty/manager.ts')).toBe(true);
    expect(paths.has('.kortix/opencode/tools/memory.ts')).toBe(true);
    expect(paths.has('.kortix/opencode/tools/web_search.ts')).toBe(true);
    expect(paths.has('.kortix/opencode/tools/scrape_webpage.ts')).toBe(true);
    expect(paths.has('.kortix/opencode/tools/image_search.ts')).toBe(true);
    expect(paths.has('.kortix/opencode/tools/lib/get-env.ts')).toBe(true);
  });

  test('marketplace source contains optional first-party skills only', () => {
    const paths = new Set(getMarketplaceFiles().map((f) => f.path));

    expect(paths.has('kortix.registry.json')).toBe(true);
    expect(paths.has('runtime/skills/agent-browser/SKILL.md')).toBe(true);
    expect(paths.has('runtime/pty/pty-tools.ts')).toBe(false);
    expect(paths.has('runtime/tools/memory.ts')).toBe(false);
    expect(paths.has('runtime/tools/web_search.ts')).toBe(false);
    expect(paths.has('runtime/tools/scrape_webpage.ts')).toBe(false);
    expect(paths.has('runtime/tools/image_search.ts')).toBe(false);
    expect(paths.has('runtime/tools/lib/get-env.ts')).toBe(false);
  });
});

describe('KORTIX_MANAGED_SKILL_NAMES', () => {
  test('tracks only the first-party kortix-* skill directories', () => {
    expect([...KORTIX_MANAGED_SKILL_NAMES]).toEqual([
      'kortix-computer',
      'kortix-executor',
      'kortix-memory',
      'kortix-slack',
      'kortix-system',
    ]);

    expect(isKortixManagedSkillName('kortix-system')).toBe(true);
    expect(isKortixManagedSkillName('agent-browser')).toBe(false);
    expect(isKortixManagedSkillName('kortix')).toBe(false);
    expect(isKortixManagedSkillName('memory-reflector')).toBe(false);
    expect(isKortixManagedSkillName('web_search')).toBe(false);
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

describe('SKILL_PACKS', () => {
  test('every pack references only real general-knowledge-worker skills', () => {
    const known = new Set(listGeneralKnowledgeWorkerSkills());
    for (const pack of SKILL_PACKS) {
      expect(pack.skills.length).toBeGreaterThan(0);
      for (const skill of pack.skills) {
        expect(known.has(skill)).toBe(true);
      }
    }
  });

  test('SKILL_PACK_IDS matches the pack ids and getSkillPack resolves', () => {
    expect([...SKILL_PACK_IDS]).toEqual(SKILL_PACKS.map((p) => p.id));
    expect(getSkillPack('legal-pack')?.title).toBe('Legal');
    expect(getSkillPack('nope')).toBeUndefined();
  });

  test('resolveSkillPackSkills unions + dedupes and throws on an unknown id', () => {
    const union = resolveSkillPackSkills(['documents-pack', 'legal-pack']);
    expect(union.has('pdf')).toBe(true);
    expect(union.has('legal-writer')).toBe(true);
    expect(() => resolveSkillPackSkills(['made-up-pack'])).toThrow();
  });
});

describe('getStarterFiles with skillPacks', () => {
  test('injects only the selected pack skills on top of the minimal floor', () => {
    const files = getStarterFiles({
      projectName: 'X',
      template: 'minimal',
      skillPacks: ['legal-pack'],
    });
    const paths = new Set(files.map((f) => f.path));
    // base runtime floor still present
    expect(paths.has('kortix.yaml')).toBe(true);
    expect(paths.has('.kortix/opencode/skills/kortix-system/SKILL.md')).toBe(true);
    // legal-pack skills present
    expect(paths.has('.kortix/opencode/skills/legal-writer/SKILL.md')).toBe(true);
    expect(paths.has('.kortix/opencode/skills/contract-review/SKILL.md')).toBe(true);
    // unrelated general-knowledge-worker skills absent
    expect(paths.has('.kortix/opencode/skills/campaign-planning/SKILL.md')).toBe(false);
    expect(paths.has('.kortix/opencode/skills/pdf/SKILL.md')).toBe(false);
  });

  test('unions multiple packs', () => {
    const files = getStarterFiles({
      projectName: 'X',
      template: 'minimal',
      skillPacks: ['legal-pack', 'documents-pack'],
    });
    const paths = new Set(files.map((f) => f.path));
    expect(paths.has('.kortix/opencode/skills/legal-writer/SKILL.md')).toBe(true);
    expect(paths.has('.kortix/opencode/skills/pdf/SKILL.md')).toBe(true);
  });

  test('no skillPacks is byte-identical to plain minimal', () => {
    const withEmpty = getStarterFiles({ projectName: 'X', template: 'minimal', skillPacks: [] });
    const plain = getStarterFiles({ projectName: 'X', template: 'minimal' });
    expect(withEmpty).toEqual(plain);
  });

  test('skillPacks is ignored when the full general-knowledge-worker template is selected', () => {
    const full = getStarterFiles({ projectName: 'X', template: 'general-knowledge-worker' });
    const fullWithPacks = getStarterFiles({
      projectName: 'X',
      template: 'general-knowledge-worker',
      skillPacks: ['legal-pack'],
    });
    expect(fullWithPacks.map((f) => f.path)).toEqual(full.map((f) => f.path));
  });

  test('an unknown pack id throws', () => {
    expect(() =>
      getStarterFiles({ projectName: 'X', template: 'minimal', skillPacks: ['not-real'] }),
    ).toThrow();
  });
});
