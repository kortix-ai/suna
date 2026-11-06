import { describe, expect, test } from 'bun:test';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import en from '../../translations/en.json';

// "Workspace" is the one container noun (brand kit decision D40, 2026-11-05):
// "project" left the English copy. This ratchet keeps it out. A new English
// value that says "project" fails here, unless the word is code (a command,
// a permission, a path, a placeholder name) or one of the few values below
// where "project" means something else.
//
// To add a value to ALLOWED: the word must not name the Kortix container.
// Write the reason. If you rewrite an allowed value without the word, delete
// its entry: a stale entry fails the second test.

/** Code that legitimately spells "project": stripped before the word check. */
const CODE_PATTERNS: readonly RegExp[] = [
  /`[^`]*`/g, // a code span
  /<\/?[\w-]+[^>]*>/g, // a rich-text tag, e.g. <project></project>
  /\{\s*[A-Za-z_][\w.]*\s*(?=[,}])/g, // an ICU argument name, e.g. {project}
  /"projects?"/g, // a JSON string value, e.g. "scope_type":"project"
  /\bkortix projects? \w+/g, // a CLI command, e.g. kortix projects use
  /--projects?\b/g, // a CLI flag
  /\b[A-Z][A-Z0-9_]*PROJECT[A-Z0-9_]*\b/g, // an environment variable
  /\bprojects?\.[a-z][\w.]*/g, // a permission, e.g. project.gitops.merge
  /\bprojects?:[a-z][\w.:]*/g, // a permission, e.g. projects:access.manage
  /\b\w+_projects?\b|\bprojects?_\w+/gi, // a snake_case identifier
  /~?\/projects?\b[\w/:.-]*/gi, // a path, e.g. /workspaces or ~/Projects/site
  /\bmy-project\b/g, // a directory name in a CLI example
];

/** English values that keep "project" in a sense other than the Kortix container. */
const ALLOWED: Readonly<Record<string, string>> = {
  'showcase.subtitle': 'a piece of work: "from simple requests to mega-complex projects"',
  'tools.getProjectStructure': 'the software project an agent inspects',
  'tools.buildProject': 'the software project an agent builds',
  'hardcodedUi.appHomePage.storyMemoryDescription': "the customer's projects of work",
  'hardcodedUi.appHomePage.storySurfaceTeamsBody': "the customer's projects of work",
  'hardcodedUi.componentsPagesCreditsExplainedPage.line92JsxTextOnceATaskCompletesNoFurtherCreditsAre':
    'projects an agent deployed',
  'hardcodedUi.autoAppPresentationSlidesEngJsxAttrLeadTheFirstOpen3002ec16':
    'Suna, the open-source project',
  'hardcodedUi.i18nComplete.text2a2728fd9252': 'a Docker Compose project',
  'hardcodedUi.i18nComplete.text5fbb9e647dca': 'a Docker Compose project',
  'hardcodedUi.i18nComplete.text6c94c3a6a6fa': 'a Docker Compose project',
  'hardcodedUi.i18nComplete.textab66ce448ad0': 'a Docker Compose project',
  'hardcodedUi.i18nComplete.textc28e1cbeedd6': 'a Docker Compose project',
  'spaces.memory.group.workstreams': 'a memory group for workstreams',
  'goals.templates.prepareProjectHandoff.title': "a goal template about the customer's project",
  'goals.templates.prepareProjectHandoff.description':
    "a goal template about the customer's project",
  'goals.templates.prepareProjectHandoff.prompt': "a goal template about the customer's project",
  'hardcodedUi.componentsIamPermissionBoundaryCard.line181JsxAttrPlaceholderEGProject':
    'code: a permission prefix placeholder, "e.g. project."',
  'hardcodedUi.i18nComplete.text633dcfcb4a68': 'code: the `project:` key of a YAML sample',
  'hardcodedUi.i18nComplete.textbff69807309f': 'code: the analytics bootstrap script',
  'hardcodedUi.i18nComplete.text544792b85010':
    'hidden search keywords: "project" finds the workspace switcher for people who learned the old word',
};

const PROJECT_WORD = /\bprojects?\b/i;

function flatten(value: unknown, path: string, out: Map<string, string>): Map<string, string> {
  if (typeof value === 'string') out.set(path, value);
  else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      flatten(child, path ? `${path}.${key}` : key, out);
    }
  }
  return out;
}

function withoutCode(value: string): string {
  return CODE_PATTERNS.reduce((text, pattern) => text.replace(pattern, ' '), value);
}

const english = flatten(en, '', new Map());

describe('English copy says "workspace", not "project"', () => {
  test('no English value names the container "project"', () => {
    const offenders = [...english]
      .filter(([key, value]) => !(key in ALLOWED) && PROJECT_WORD.test(withoutCode(value)))
      .map(([key, value]) => `${key} = ${value}`);
    expect(offenders).toEqual([]);
  });

  test('every allowed value still needs its entry', () => {
    const stale = Object.keys(ALLOWED).filter((key) => {
      const value = english.get(key);
      return value === undefined || !PROJECT_WORD.test(withoutCode(value));
    });
    expect(stale).toEqual([]);
  });

  test('a code name keeps "project" and the word around it changes', () => {
    expect(withoutCode('Run kortix projects use to pick a workspace.')).not.toMatch(PROJECT_WORD);
    expect(withoutCode('Everyone in {project} can use it.')).not.toMatch(PROJECT_WORD);
    expect(withoutCode('An admin can grant project.gitops.merge.')).not.toMatch(PROJECT_WORD);
    expect(withoutCode('Back to projects')).toMatch(PROJECT_WORD);
    expect(withoutCode('Create a project')).toMatch(PROJECT_WORD);
  });
});

/**
 * Each locale's word for the old container. A value whose English says
 * "workspace" (and not "project") must not say it: a translation that kept
 * the old word after its English changed is the drift this catches.
 */
const LOCALE_PROJECT_WORD: Readonly<Record<string, RegExp>> = {
  de: /\bprojekt/i,
  es: /\bproyectos?\b/i,
  fr: /\bprojets?\b/i,
  it: /\bprogett[oi]\b/i,
  pt: /\bprojetos?\b/i,
  ja: /プロジェクト/,
  zh: /项目/,
  sr: /пројек|\bprojek/i,
};

const WORKSPACE_WORD = /\bworkspaces?\b/i;

function catalog(locale: string): Map<string, string> {
  const raw = readFileSync(join(import.meta.dir, '../../translations', `${locale}.json`), 'utf8');
  return flatten(JSON.parse(raw), '', new Map());
}

describe('every locale follows the English workspace noun', () => {
  for (const [locale, word] of Object.entries(LOCALE_PROJECT_WORD)) {
    test(`${locale}: no value keeps the old container word where English says "workspace"`, () => {
      const offenders = [...catalog(locale)]
        .filter(([key, value]) => {
          const source = english.get(key);
          if (source === undefined || key in ALLOWED) return false;
          const plain = withoutCode(source);
          return WORKSPACE_WORD.test(plain) && !PROJECT_WORD.test(plain) && word.test(withoutCode(value));
        })
        .map(([key, value]) => `${key} = ${value}`);
      expect(offenders).toEqual([]);
    });
  }
});
