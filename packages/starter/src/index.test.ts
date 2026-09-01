import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_STARTER_TEMPLATE_ID,
  KORTIX_MANAGED_SKILL_NAMES,
  STARTER_TEMPLATE_IDS,
  type StarterFile,
  getManagedSkillFiles,
  getStarterFiles,
  isKortixManagedSkillName,
  listGeneralKnowledgeWorkerSkills,
  normalizeStarterTemplateId,
} from './index';

function byPath(files: StarterFile[]): Map<string, string> {
  return new Map(files.map((f) => [f.path, f.content]));
}

describe('STARTER_TEMPLATE_IDS', () => {
  test('contains the two OpenCode templates', () => {
    expect([...STARTER_TEMPLATE_IDS]).toEqual([
      'minimal',
      'general-knowledge-worker',
    ]);
  });

  test('default template is the general knowledge worker (base + all domain skills)', () => {
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
    const dflt = getStarterFiles({ projectName: 'X', template: DEFAULT_STARTER_TEMPLATE_ID });
    expect(fallback.map((f) => f.path)).toEqual(dflt.map((f) => f.path));
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

  test('ships scheduled starter automation disabled by default', () => {
    const manifest = byPath(getStarterFiles({ projectName: 'X', template: 'minimal' })).get(
      'kortix.yaml',
    );
    expect(manifest).toBeDefined();
    if (!manifest) throw new Error('minimal starter is missing kortix.yaml');
    const lines = manifest.split('\n');
    const start = lines.findIndex((line) => line.trim() === '- slug: harness-reflector');
    expect(start).toBeGreaterThanOrEqual(0);
    const enabled = lines.slice(start + 1).find((line) => line.trim().startsWith('enabled:'));
    expect(enabled?.trim()).toBe('enabled: false');
  });

  test('default starter ships the general knowledge worker skills; internal minimal does not', () => {
    // The one user-facing starter (the default) carries the domain skill kit.
    const dflt = getStarterFiles({ projectName: 'X' });
    expect(dflt.some((f) => f.path === '.kortix/opencode/skills/presentations/SKILL.md')).toBe(
      true,
    );
    expect(dflt.some((f) => f.path === '.kortix/opencode/skills/pdf/SKILL.md')).toBe(true);

    // `minimal` stays base-only (used internally by the project-clone seed path).
    const minimal = getStarterFiles({ projectName: 'X', template: 'minimal' });
    expect(minimal.some((f) => f.path === '.kortix/opencode/skills/presentations/SKILL.md')).toBe(
      false,
    );
    expect(minimal.some((f) => f.path === '.kortix/opencode/skills/pdf/SKILL.md')).toBe(false);
  });

  /**
   * `walk()` here and the snapshot generator filter independently, so a filter
   * added to only one of them means the compiled binary and a source checkout
   * scaffold different files. That drift shipped three `__pycache__/*.pyc` files
   * into every API-created project.
   */
  test('scaffolds no build artifacts or OS cruft', () => {
    const junk = getStarterFiles({ projectName: 'X' }).filter((f) =>
      /(^|\/)(__pycache__|node_modules|\.venv|\.mypy_cache|\.pytest_cache|\.ruff_cache|\.tox|\.cache)\//.test(
        f.path,
      ) || /(^|\/)(\.DS_Store|Thumbs\.db)$/.test(f.path) || f.path.endsWith('.pyc'),
    );
    expect(junk.map((f) => f.path)).toEqual([]);
  });

  /**
   * The config summary matches skills with a GREEDY `skills/(.+)/SKILL.md`, so a
   * SKILL.md nested inside another skill registers as a phantom entity named
   * `parent/child` and pads the Skills UI. Keep SKILL.md exactly one level deep.
   */
  test('no SKILL.md is nested inside another skill', () => {
    const nested = getStarterFiles({ projectName: 'X' })
      .map((f) => f.path.match(/^\.kortix\/opencode\/skills\/(.+)\/SKILL\.md$/)?.[1])
      .filter((slug): slug is string => typeof slug === 'string' && slug.includes('/'));
    expect(nested).toEqual([]);
  });

  /**
   * The scaffold floor. Anything beyond this is an optional install — the
   * point of the cut, and the thing most likely to creep back one "surely this
   * one is universal" skill at a time.
   */
  test('the scaffold ships exactly the agreed skill floor', () => {
    const prefix = '.kortix/opencode/skills/';
    const names = new Set<string>();
    for (const f of getStarterFiles({ projectName: 'X' })) {
      if (!f.path.startsWith(prefix)) continue;
      const name = f.path.slice(prefix.length).split('/')[0];
      if (name) names.add(name);
    }
    expect([...names].sort()).toEqual([
      // Design quality for every artifact below (CSS, PPT, matplotlib, PDF).
      'design-foundations',
      // Documents & decks.
      'convert-documents-to-markdown',
      'docx',
      'pdf',
      'presentations',
      'xlsx',
      // Platform front door.
      'kortix-cli',
      // Computer basics — driving a real browser.
      'agent-browser',
      // Web artifacts, and the skill that puts them on a public URL.
      'web-publishing-and-deployments',
      'webapp',
      'website-building',
    ].sort());
  });

  test('minimal starter includes the default runtime tools but not optional skills', () => {
    const files = getStarterFiles({ projectName: 'X', template: 'minimal' });
    const paths = new Set(files.map((f) => f.path));

    expect(paths.has('.kortix/opencode/tools/show.ts')).toBe(true);
    // `kortix-cli` is the sole managed skill left in the scaffold; the rest of the
    // `kortix-*` family lives in `templates/managed/` and is injected at boot.
    expect(paths.has('.kortix/opencode/skills/kortix-cli/SKILL.md')).toBe(true);
    expect(paths.has('.kortix/opencode/skills/kortix-system/SKILL.md')).toBe(false);
    expect(paths.has('.kortix/opencode/skills/agent-browser/SKILL.md')).toBe(false);
    expect(paths.has('.kortix/opencode/plugins/pty.ts')).toBe(true);
    expect(paths.has('.kortix/opencode/plugins/opencode-pty/src/plugin/pty/manager.ts')).toBe(true);
    expect(paths.has('.kortix/opencode/tools/memory.ts')).toBe(true);
    expect(paths.has('.kortix/opencode/tools/web_search.ts')).toBe(true);
    expect(paths.has('.kortix/opencode/tools/scrape_webpage.ts')).toBe(true);
    expect(paths.has('.kortix/opencode/tools/image_search.ts')).toBe(true);
    expect(paths.has('.kortix/opencode/tools/lib/get-env.ts')).toBe(true);
  });

});

describe('KORTIX_MANAGED_SKILL_NAMES', () => {
  test('tracks only the first-party kortix-* skill directories', () => {
    expect([...KORTIX_MANAGED_SKILL_NAMES]).toEqual([
      'kortix-cli',
      'kortix-apps',
      'kortix-computer',
      'kortix-connectors',
      'kortix-harness-refinement',
      'kortix-memory',
      'kortix-onboarding',
      'kortix-slack',
      'kortix-system',
      'kortix-teams',
    ]);

    expect(isKortixManagedSkillName('kortix-system')).toBe(true);
    expect(isKortixManagedSkillName('agent-browser')).toBe(false);
    expect(isKortixManagedSkillName('kortix')).toBe(false);
    expect(isKortixManagedSkillName('harness-reflector')).toBe(false);
    expect(isKortixManagedSkillName('web_search')).toBe(false);
  });

  /**
   * Being LISTED as managed does not inject anything — the baked
   * `/opt/kortix/managed-skills` set is built by walking template roots, so a
   * managed skill living in a root the bake does not walk is declared managed and
   * reaches no sandbox at all. That silently stranded `kortix-computer` under the
   * since-removed `templates/marketplace/` root for its entire life.
   *
   * `templates/managed/` now owns the family and `scripts/write-managed-skills.ts`
   * walks it alongside the starter roots (which still carry `kortix-cli`), so the
   * gap is closed by construction. This test is the guard: adding a managed name
   * without putting its SKILL.md in a walked root fails here.
   */
  test('every managed skill is actually in the injected set', () => {
    const prefix = '.kortix/opencode/skills/';
    const injected = new Set<string>();
    for (const f of [
      ...getManagedSkillFiles(),
      ...getStarterFiles({ projectName: 'K', template: 'general-knowledge-worker' }),
    ]) {
      if (!f.path.startsWith(prefix)) continue;
      const name = f.path.slice(prefix.length).split('/')[0];
      if (name && isKortixManagedSkillName(name)) injected.add(name);
    }

    const missing = KORTIX_MANAGED_SKILL_NAMES.filter((n) => !injected.has(n));
    expect(missing).toEqual([]);
  });

  /**
   * The managed family is injected at boot (force-overwriting whatever the repo
   * holds), so committing a second copy into every new project bought nothing and
   * padded the Skills UI with ~10 entries the user cannot meaningfully edit.
   * `kortix-cli` is the deliberate exception — the visible front door to the rest.
   */
  test('only kortix-cli is scaffolded into a new project', () => {
    const prefix = '.kortix/opencode/skills/';
    const scaffolded = new Set<string>();
    for (const f of getStarterFiles({ projectName: 'K', template: 'general-knowledge-worker' })) {
      if (!f.path.startsWith(prefix)) continue;
      const name = f.path.slice(prefix.length).split('/')[0];
      if (name && isKortixManagedSkillName(name)) scaffolded.add(name);
    }
    expect([...scaffolded]).toEqual(['kortix-cli']);
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
