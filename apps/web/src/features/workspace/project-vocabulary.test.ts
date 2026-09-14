import { describe, expect, test } from 'bun:test';
import { readFileSync } from '@/i18n/test-source';
import { join } from 'node:path';

import de from '../../../translations/de.json';
import en from '../../../translations/en.json';
import es from '../../../translations/es.json';
import fr from '../../../translations/fr.json';
import it from '../../../translations/it.json';
import ja from '../../../translations/ja.json';
import pt from '../../../translations/pt.json';
import sr from '../../../translations/sr.json';
import zh from '../../../translations/zh.json';

/**
 * One product, one word: the thing under `/projects/<id>` is a PROJECT.
 *
 * The web app called it "Workspace" for a month (2026-08 → 2026-09) while
 * mobile, the CLI, the docs, the URLs and the comms rules all said "Project",
 * so the same screen could offer "Whole workspace" beside "One project". Code
 * identifiers keep their names — translation keys (`newWorkspace.*`,
 * `sidebar.workspace.*`), `features/workspace/`, SDK exports and query keys are
 * a contract this change does not rename. Only what a person reads changes.
 *
 * "workspace" is still correct copy for OTHER things, and those stay:
 * the sandbox's `/workspace` directory and runtime ("Waking up the workspace…"),
 * a Slack workspace, Google Workspace, a Postman workspace, marketing prose, and
 * search keyword bags that must keep matching the old word. Every en.json value
 * that still says "workspace" is on the allowlist below with its reason, so a
 * new one is a decision someone makes, not a drift nobody notices.
 */

type Catalog = Record<string, unknown>;

function leaves(node: unknown, prefix = ''): Array<[string, string]> {
  if (typeof node === 'string') return [[prefix, node]];
  if (!node || typeof node !== 'object' || Array.isArray(node)) return [];
  return Object.entries(node as Catalog).flatMap(([key, value]) =>
    leaves(value, prefix ? `${prefix}.${key}` : key),
  );
}

function valueAt(catalog: Catalog, path: string): unknown {
  return path.split('.').reduce<unknown>((node, key) => (node as Catalog | undefined)?.[key], catalog);
}

const WORKSPACE_WORD = /\bworkspaces?\b/i;

/** Every key that names THE project. Subtrees are expanded to their leaves. */
const PROJECT_CONCEPT_PATHS = [
  'sidebar.workspaces',
  'sidebar.workspace',
  'newWorkspace',
  'settings.workspace',
  'settings.rail.groups.workspace',
  'settings.rail.items.workspace.description',
  'settings.tokens.wholeWorkspace',
  'settings.preferences.shortcuts.switchWorkspace',
  // The command palette's switcher and the landing terminal.
  'hardcodedUi.i18nComplete.text9ad6baffd025',
  'hardcodedUi.i18nComplete.text5c192a3e6f23',
  'hardcodedUi.i18nComplete.text97d0b1171f3e',
  'hardcodedUi.i18nComplete.textec70b4a614bf',
  'hardcodedUi.i18nComplete.textab95d456c6bb',
  'hardcodedUi.i18nComplete.texte51ebf3dc9f6',
  'hardcodedUi.i18nComplete.text954bd1fe66b4',
  'hardcodedUi.i18nComplete.text133e716aadbe',
  'hardcodedUi.i18nComplete.text50d5797e87c0',
  'hardcodedUi.i18nComplete.text9a0da87b2e56',
  'hardcodedUi.i18nComplete.text2d2600dad4ce',
  'hardcodedUi.i18nComplete.textde181455a329',
];

function conceptLeaves(catalog: Catalog): Array<[string, string]> {
  return PROJECT_CONCEPT_PATHS.flatMap((path) => leaves(valueAt(catalog, path), path));
}

/** The word each locale used for "workspace" before this change. */
const OLD_LOCALE_NOUN: Record<string, { catalog: Catalog; noun: RegExp }> = {
  de: { catalog: de, noun: /Arbeitsbereich/i },
  es: { catalog: es, noun: /espacios? de trabajo/i },
  fr: { catalog: fr, noun: /espaces? de travail/i },
  it: { catalog: it, noun: /spazi[oi] di lavoro|aree? di lavoro/i },
  ja: { catalog: ja, noun: /ワークスペース/ },
  pt: { catalog: pt, noun: /espaços? de trabalho/i },
  sr: { catalog: sr, noun: /радн\p{L}* простор/iu },
  zh: { catalog: zh, noun: /工作区|工作空间/ },
};

/**
 * en.json values that correctly still say "workspace", by reason. A value
 * matching the word that is NOT here fails the sweep below.
 */
const ALLOWED_WORKSPACE_VALUES: Record<string, readonly string[]> = {
  // The sandbox: its `/workspace` directory, its runtime, its lifecycle.
  sandbox: [
    'hardcodedUi.appHomeVariant2Page.line420JsxTextWorkspace',
    'hardcodedUi.componentsFileEditorsMarkdownToolbar.line869JsxTextWillBeUploadedToWorkspace',
    'hardcodedUi.componentsFileEditorsMarkdownToolbar.line878JsxTextImageWillBeUploadedToWorkspace',
    'hardcodedUi.componentsProjectsTriggersView.line1162JsxAttrPlaceholderGenerateTheDailyStatusReportAndSaveIt',
    'hardcodedUi.componentsScheduledTasksTaskConfigDialog.line408JsxAttrPlaceholderGenerateTheDailyStatusReportAndSaveIt',
    'hardcodedUi.componentsSessionToolRenderers.line6211JsxTextWorkspaceDeleteDisabled',
    'hardcodedUi.componentsSessionToolRenderers.line6168JsxTextWorkspaceDeleteDisabled',
    'hardcodedUi.componentsThreadToolViewsPresentationToolsListpresentationstoolview.line109JsxAttrFilepathScanningWorkspace',
    'hardcodedUi.featuresFilesComponentsFileTree.line936JsxAttrTitleBackToWorkspace',
    'hardcodedUi.featuresProjectFilesComponentsFileTree.line936JsxAttrTitleBackToWorkspace',
    'hardcodedUi.i18nComplete.text2438ee64fbf9',
    'hardcodedUi.i18nComplete.text2a0be92cc91f',
    'hardcodedUi.i18nComplete.text42b3d52014ba',
    'hardcodedUi.i18nComplete.text456600bc8f21',
    'hardcodedUi.i18nComplete.text5a4db0bfccdc',
    'hardcodedUi.i18nComplete.text5e3de76869f3',
    'hardcodedUi.i18nComplete.text8591ccff74ef',
    'hardcodedUi.i18nComplete.text87bb59ba2f92',
    'hardcodedUi.i18nComplete.texta4c128e48978',
    'hardcodedUi.i18nComplete.textc52ddf65534b',
    'hardcodedUi.i18nComplete.textd83085ac907e',
    'hardcodedUi.i18nComplete.textd94a83e48b64',
    'hardcodedUi.i18nComplete.textde996979df5c',
    'hardcodedUi.i18nComplete.texte10d01e3b40c',
    'hardcodedUi.i18nComplete.texte26a38466159',
    'hardcodedUi.i18nComplete.texte48034ba91dd',
    'hardcodedUi.i18nComplete.textf7db0cb35bc2',
  ],
  // A Slack workspace, and the self-hosted Slack install copy.
  slack: [
    'hardcodedUi.appProjectsIdCustomizeChannelsPage.line54JsxTextInviteTheBotToAnyChannelInYour',
    'hardcodedUi.appProjectsIdCustomizeChannelsPage.line65JsxTextConnectASlackWorkspaceToThisProjectTokens',
    'hardcodedUi.componentsChannelsChannelsDialog.line46JsxTextConnectSlackSoTheAgentCanPostInto',
    'hardcodedUi.componentsChannelsChannelsDialog.line88JsxTextAddKortixToYourSlackWorkspace',
    'hardcodedUi.componentsChannelsChannelsDialog.line90JsxTextOneClickApproveScopesInSlackAndWe',
    'hardcodedUi.autoComponentsHomeInteractiveDemoPagesChannelsPageJsxAttrSub03b65d67',
    'hardcodedUi.autoComponentsHomeInteractiveDemoPagesChannelsPageJsxTextAdd56167f5a',
    'hardcodedUi.autoComponentsHomeInteractiveDemoPagesChannelsPageJsxTextOne406c5eb7',
    'hardcodedUi.autoComponentsHomeInteractiveDemoSectionJsxAttrSubRunThisb0deafba',
    'hardcodedUi.autoComponentsProjectsCustomizeSectionsChannelsViewJsxTextAddKortix0e416aa2',
    'hardcodedUi.autoComponentsProjectsCustomizeSectionsChannelsViewJsxTextOneClick68f102dc',
    'hardcodedUi.autoComponentsProjectsCustomizeSectionsChannelsViewJsxTextOneClicke1160263',
    'hardcodedUi.i18nComplete.text0e671041e03f',
    'hardcodedUi.i18nComplete.text15b963086594',
    'hardcodedUi.i18nComplete.text52141cfb5b12',
    'hardcodedUi.i18nComplete.text690ee10ca19e',
    'hardcodedUi.i18nComplete.text78dbeb914e19',
    'hardcodedUi.i18nComplete.text8b3305c40176',
    'hardcodedUi.i18nComplete.text8e8d76bd474e',
    'hardcodedUi.i18nComplete.text98d27bdc2fa7',
    'hardcodedUi.i18nComplete.textbd5a646673af',
    'hardcodedUi.i18nComplete.textc8772b3662ab',
    'hardcodedUi.i18nComplete.textcf885bfcd8a4',
    'hardcodedUi.i18nComplete.textf981bd62fb8b',
    'hardcodedUi.i18nComplete.textff5091ba4fe1',
    'projectOnboarding.slack.customDescription',
    'projectOnboarding.slack.bringOwnDescription',
  ],
  // Google Workspace and Postman workspaces — product names.
  thirdParty: [
    'hardcodedUi.i18nComplete.text1a146e36d3fc',
    'hardcodedUi.i18nComplete.text1f94b32a5f82',
    'hardcodedUi.i18nComplete.text5918414053b3',
    'hardcodedUi.i18nComplete.text874113eebba4',
    'hardcodedUi.i18nComplete.textc26ca4369200',
    'hardcodedUi.i18nComplete.textcd8dd219cc48',
    'hardcodedUi.i18nComplete.textde3bf9cc102d',
  ],
  // Search keyword bags: they must keep matching the word people still type.
  keywords: [
    'hardcodedUi.i18nComplete.text1b85843d53b1',
    'hardcodedUi.i18nComplete.text544792b85010',
    'hardcodedUi.i18nComplete.text592dbd5acab8',
    'hardcodedUi.i18nComplete.text9a1647988c99',
    'hardcodedUi.i18nComplete.texta6dc82e13869',
    'hardcodedUi.i18nComplete.textcb97e7f77a44',
  ],
  // Marketing and sales prose using the generic noun, plus non-copy values.
  marketing: [
    'modes.prompts.image.7',
    'hardcodedUi.appHomeHomeWipPage.line273JsxTextAiWorkspace',
    'hardcodedUi.appHomeHomeWipPage.line636JsxTextAnAiWorkspaceYourWholeCompanyCanShare',
    'hardcodedUi.appHomeHomeWipPage.line643JsxTextStartATeamWorkspace',
    'hardcodedUi.appHomeHomeWipPage.line653JsxAttrLabelScreenshotTeamWorkspace',
    'hardcodedUi.appHomeHomeWipPage.line673JsxTextEverySunaWorkspaceIsAFullLinuxEnvironment',
    'hardcodedUi.appHomePage.surfacesChips',
    'hardcodedUi.appHomePage.differentScreenSectionDescription',
    'hardcodedUi.appHomePage.surfaceWebWorkspace',
    'hardcodedUi.appHomePage.enterpriseAccordionIsolationTitle',
    'hardcodedUi.appHomePage.enterpriseAccordionIsolationTeaser',
    'hardcodedUi.appHomeUseCasesPage.line377JsxTextSpinUpAWorkspaceConnectYourToolsAnd',
    'hardcodedUi.appHomeVariant2Page.line287JsxTextDoneReportDeliveredSavedToWorkspaceForFuture',
    'hardcodedUi.appHome2Page.line291JsxTextKortixTurnsOneRepoIntoAnAiCommand',
    'hardcodedUi.appHome2Page.line397JsxTextKortixIsTheOperatingFrameworkForAutonomousCompany',
    'hardcodedUi.appHome2Page.line497JsxTextItTurnsAProjectRepoIntoALiving',
    'hardcodedUi.autoAppPresentationSlidesPlatformJsxAttrLeadYourTeamTalkse4dd114d',
    'hardcodedUi.autoFeaturesMarketingHowItWorkStepStep4ShipCli291a9f3d',
    'hardcodedUi.autoFeaturesMarketingHowItWorkStepStep5RunCli99e75001',
    'hardcodedUi.i18nComplete.text8c03a1555d80',
    'hardcodedUi.i18nComplete.texta535409d22df',
    'hardcodedUi.i18nComplete.textb3432a9b2814',
    'hardcodedUi.i18nComplete.textbff69807309f',
    'hardcodedUi.i18nComplete.textc7fd29b5b470',
  ],
};

describe('project vocabulary — the catalog', () => {
  test('every project-concept key says Project in English, never Workspace', () => {
    const concept = conceptLeaves(en);
    // The subtrees must resolve: an empty list would make the next line vacuous.
    expect(concept.length).toBeGreaterThan(60);
    expect(concept.filter(([, value]) => WORKSPACE_WORD.test(value))).toEqual([]);
  });

  test('the switcher, the create page and Delete say the word', () => {
    expect(en.sidebar.workspace.switchMenu).toBe('Switch Project');
    expect(en.sidebar.workspace.create).toBe('Create a project…');
    expect(en.newWorkspace.title).toBe('Create a project');
    expect(en.settings.workspace.deleteWorkspace).toBe('Delete project');
    expect(en.settings.tokens.wholeWorkspace).toBe('Whole project');
  });

  for (const [locale, { catalog, noun }] of Object.entries(OLD_LOCALE_NOUN)) {
    test(`${locale} dropped its old noun from every project-concept key`, () => {
      const concept = conceptLeaves(catalog);
      expect(concept.length).toBeGreaterThan(60);
      expect(
        concept.filter(([, value]) => noun.test(value) || WORKSPACE_WORD.test(value)),
      ).toEqual([]);
    });
  }

  test('every en value that still says workspace is allowlisted with a reason', () => {
    const allowed = new Set(Object.values(ALLOWED_WORKSPACE_VALUES).flat());
    const unlisted = leaves(en)
      .filter(([, value]) => WORKSPACE_WORD.test(value))
      .map(([path]) => path)
      .filter((path) => !allowed.has(path));
    expect(unlisted).toEqual([]);
  });

  test('the allowlist names real keys', () => {
    const missing = Object.values(ALLOWED_WORKSPACE_VALUES)
      .flat()
      .filter((path) => typeof valueAt(en, path) !== 'string');
    expect(missing).toEqual([]);
  });
});

/**
 * Line comments first, then block comments — a `//` comment that contains `/*`
 * would otherwise open a match that swallows real code (see
 * `account-hub-section-gating.test.ts`).
 */
function stripComments(source: string): string {
  return source.replace(/^[ \t]*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * Quoted PROSE literals that say "workspace". A literal with no whitespace is a
 * key, an id or a path (`'workspace.find'`, `"workspace-name"`), never copy a
 * person reads, and `/workspace` is the sandbox directory.
 */
function workspaceLiterals(source: string): string[] {
  const literals = stripComments(source).match(/(['"`])(?:(?!\1)[^\\\n]|\\.)*\1/g) ?? [];
  return literals.filter(
    (literal) =>
      WORKSPACE_WORD.test(literal) && /\s/.test(literal) && !literal.includes('/workspace'),
  );
}

const read = (relative: string) => readFileSync(join(import.meta.dir, relative), 'utf8');

describe('project vocabulary — English fallbacks and hardcoded labels', () => {
  // Each of these renders English copy straight from source (a fallback when a
  // catalog is not wired, or a label looked up by its English text). A drift
  // here shows "workspace" even though every catalog says "project".
  // `connecting-screen.tsx` is deliberately absent: its "Workspace offline" /
  // "unreachable" copy names the SANDBOX runtime, not the project.
  const FALLBACK_SURFACES = [
    'settings/tabs/general-tab.tsx',
    'settings/tabs/appearance-tab.tsx',
    'settings/tabs/snapshots-tab.tsx',
    'customize/migrate-to-v2/upgrade-view.tsx',
    'shared/sandbox-template-menu.tsx',
    'new/use-create-workspace.ts',
    'new/new-workspace-page.tsx',
    'new/advanced-fields.tsx',
    'new/account-picker.tsx',
    'project-sidebar/workspace-menu-section.tsx',
    '../../app/(app)/projects/start/landing-terminal.tsx',
    '../session/session-starting-loader.tsx',
    '../session/composer/animated-placeholder.tsx',
    '../../components/projects/onboarding/onboarding-profile.ts',
    '../../lib/provisioning-stages.ts',
  ];

  for (const relative of FALLBACK_SURFACES) {
    test(`${relative} renders no "workspace" for the project`, () => {
      expect(workspaceLiterals(read(relative))).toEqual([]);
    });
  }

  test('the palette row and the members row say Project', () => {
    const registry = stripComments(read('../../lib/menu-registry.ts'));
    expect(registry).toContain("label: 'Switch project'");
    expect(registry).toContain("label: 'Project members'");
    expect(registry).not.toContain("label: 'Switch workspace'");
    expect(registry).not.toContain("label: 'Workspace members'");
  });

  test('the command palette groups projects under "Projects"', () => {
    const palette = stripComments(read('command-palette.tsx'));
    expect(palette).toContain('<CommandGroup heading="Projects"');
    expect(palette).not.toContain('heading="Workspaces"');
    // The switcher page reads its title, placeholder and empty state from the
    // catalog keys pinned above.
    expect(palette).toContain("if (page === 'workspaces') return tI18nComplete.raw('text9ad6baffd025')");
    expect(palette).toContain("if (page === 'workspaces') return tI18nComplete.raw('text5c192a3e6f23')");
    expect(palette).toContain("tHardcodedUi.raw('i18nComplete.text97d0b1171f3e')");
  });

  test('the /new surfaces call the owning org "Account", never Organization', () => {
    for (const relative of ['new/new-workspace-page.tsx', 'new/advanced-fields.tsx', 'new/account-picker.tsx']) {
      const code = stripComments(read(relative));
      expect({ file: relative, organization: /Organi[sz]ation/.test(code) }).toEqual({
        file: relative,
        organization: false,
      });
    }
  });
});
