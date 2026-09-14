#!/usr/bin/env node

import { IntlMessageFormat } from 'intl-messageformat';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import ts from 'typescript';
import { defaultLocale, locales } from '../src/i18n/catalog.mjs';

const root = process.cwd();
const srcDir = path.join(root, 'src');
const translationsDir = path.join(root, 'translations');
const args = new Map(
  process.argv
    .slice(2)
    .filter((arg) => arg !== '--')
    .map((arg) => {
      const [key, value = 'true'] = arg.replace(/^--/, '').split('=');
      return [key, value];
    }),
);

const maxHardcoded = args.has('max-hardcoded')
  ? Number(args.get('max-hardcoded'))
  : Number.POSITIVE_INFINITY;

const includeGenerated = args.get('include-generated') === 'true';

function generatedTranslationText(relativeFile) {
  const file = path.join(srcDir, relativeFile);
  const values = new Set();
  if (!fs.existsSync(file)) return values;
  const source = fs.readFileSync(file, 'utf8');
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  function visit(node) {
    if (
      ts.isPropertyAssignment(node) &&
      ts.isStringLiteralLike(node.initializer) &&
      /^text[0-9a-f]+$/.test(node.initializer.text)
    ) {
      if (ts.isIdentifier(node.name) || ts.isStringLiteralLike(node.name))
        values.add(node.name.text);
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return values;
}

const localizedGuideText = generatedTranslationText(
  'features/sso-setup/guide-translation-keys.generated.ts',
);
const localizedMenuText = generatedTranslationText('lib/menu-translation-keys.generated.ts');
const localizedRoleText = generatedTranslationText('i18n/roles-translation-keys.generated.ts');
const localizedSiteConfigText = generatedTranslationText(
  'i18n/site-config-translation-keys.generated.ts',
);
const localizedAuditTitleText = generatedTranslationText(
  'components/iam/audit-title-translation-keys.generated.ts',
);
const localizedBlogText = generatedTranslationText('i18n/blog-translation-keys.generated.ts');
const localizedPublicMetadataText = generatedTranslationText(
  'i18n/public-metadata-translation-keys.generated.ts',
);
const localizedDesignSystemText = generatedTranslationText(
  'i18n/design-system-translation-keys.generated.ts',
);
const localizedRemainingUiText = generatedTranslationText(
  'i18n/remaining-ui-translation-keys.generated.ts',
);

// Machine translation can alter sentinel spelling instead of preserving it.
// Reject the Latin form and the Cyrillic transliteration observed in production catalogs.
const translationSentinelPattern = /(?:ZXQ|XZQ|ЗКСК|КСЗК)/iu;

function isLikelyUntranslatedProse(key, sourceValue, targetValue, locale) {
  if (locale === defaultLocale || sourceValue !== targetValue) return false;
  if (!/[a-z]/.test(sourceValue) || sourceValue.trim().split(/\s+/).length < 4) return false;
  if (/[{}<>@$=|`\[\]\\/]/.test(sourceValue)) return false;
  if (key.endsWith('Platforms')) return false;
  if (/DesignSystemPage|i18nComplete|JsxAttr(?:Class|Bg|Tint|Content)/.test(key)) return false;
  if (/appHome(?:Berlin|Milano)Page/.test(key)) return false;
  if (
    /^(?:allow-|Claude Code, Cursor, Codex|Stripe · HubSpot · Linear|stripe\.|\d+ N Orange St\.)/.test(
      sourceValue,
    )
  )
    return false;
  return true;
}

function isTechnicalLiteral(key, sourceValue) {
  if (!/DesignSystemPage/.test(key)) return false;
  return (
    /^(?:@|const\s|globals\.css|tone=|Badge variant=)/.test(sourceValue) ||
    /^(?:List & ListRow|SectionCard flush)$/.test(sourceValue) ||
    /^(?:bg-card border border-border\/50|max-w-\[1000px\] · px-6 lg:px-10 · py-10)$/.test(
      sourceValue,
    )
  );
}

function designSystemTokens(key, sourceValue) {
  if (!/DesignSystemPage/.test(key)) return [];
  const knownTokens = [
    'ConfirmDialog',
    'DiffStat',
    'EntityAvatar',
    'InlineMeta',
    'ListRow',
    'SectionCard',
    'UserAvatar',
    'class-variance-authority',
  ];
  const tokens = knownTokens.filter((token) => sourceValue.includes(token));
  for (const match of sourceValue.matchAll(/\b(?:bg-card|rounded-2xl)\b/g)) {
    tokens.push(match[0]);
  }
  return [...new Set(tokens)];
}

const ignoredPathParts = [
  '/.next/',
  '/node_modules/',
  '/src/components/ui/',
  '/src/app/fonts/',
  '/src/app/(system)/debug/',
  '/src/types/',
  '/__harness__/',
];

const ignoredFilePattern = /\.(?:test|spec)\.[cm]?[jt]sx?$/;

const allowedLiteralValues = new Set([
  '',
  ' ',
  '/',
  '-',
  '+',
  '.',
  '..',
  '...',
  ':',
  ';',
  ',',
  'true',
  'false',
  'auto',
  'left',
  'right',
  'top',
  'bottom',
  'center',
  'start',
  'end',
  'button',
  'submit',
  'reset',
  'dialog',
  'menu',
  'listbox',
  'option',
  'checkbox',
  'radio',
  'switch',
  'tab',
  'tabpanel',
  'navigation',
  'main',
  'banner',
  'contentinfo',
  'region',
  'alert',
  'status',
  'presentation',
  'img',
  'link',
  'off',
  'on',
  'Kortix',
  'Plain',
  'Slack',
  'GitHub',
  'Linear',
  'Discover and read Kortix public API and documentation resources.',
]);

const ignoredAttributes = new Set([
  'className',
  'id',
  'key',
  'type',
  'role',
  'href',
  'src',
  'rel',
  'target',
  'method',
  'action',
  'name',
  'value',
  'htmlFor',
  'width',
  'height',
  'size',
  'variant',
  'color',
  'side',
  'style',
  'align',
  'as',
  'asChild',
  'priority',
  'fill',
  'viewBox',
  'xmlns',
  'd',
  'path',
  'pattern',
  'accept',
  'activeHighlightColor',
  'githubManageAllHref',
  'highlightColor',
  'media',
  'parentClass',
  'sizes',
  'transform',
  'url',
  'xlinkHref',
]);

const displayAttributeNames = new Set([
  'alt',
  'aria-description',
  'aria-label',
  'description',
  'emptyText',
  'help',
  'helperText',
  'hint',
  'label',
  'message',
  'placeholder',
  'text',
  'title',
  'tooltip',
]);

function isDisplayAttribute(name) {
  return (
    displayAttributeNames.has(name) ||
    /(?:Description|Label|Message|Placeholder|Text|Title|Tooltip)$/.test(name)
  );
}

const displayPropertyNames = new Set([
  'ask',
  'body',
  'caption',
  'desc',
  'detail',
  'description',
  'emptyLabel',
  'emptyText',
  'errorMessage',
  'eyebrow',
  'helperText',
  'heading',
  'help',
  'label',
  'markdown',
  'message',
  'pitch',
  'prompt',
  'reply',
  'sub',
  'summary',
  'subtitle',
  'successMessage',
  'thinkingLabel',
  'title',
  'tooltip',
  'hint',
]);

const displayCollectionPropertyNames = new Set([
  'bullets',
  'highlights',
  'lines',
  'points',
  'replies',
  'steps',
]);

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function flatten(obj, prefix = '', out = {}) {
  if (Array.isArray(obj)) {
    obj.forEach((value, index) => flatten(value, `${prefix}[${index}]`, out));
    return out;
  }

  if (!obj || typeof obj !== 'object') {
    out[prefix] = obj;
    return out;
  }

  for (const [key, value] of Object.entries(obj)) {
    const next = prefix ? `${prefix}.${key}` : key;
    flatten(value, next, out);
  }
  return out;
}

function templateVariables(message) {
  return [...message.matchAll(/\{\{\s*([\w.-]+)\s*\}\}/g)].map((match) => match[1]).sort();
}

function messageSignature(message, locale) {
  const ast = new IntlMessageFormat(message, locale).getAst();
  const tokens = [];

  function visit(elements) {
    for (const element of elements) {
      if ([1, 2, 3, 4, 5, 6].includes(element.type)) {
        tokens.push(`${element.type}:${element.value}`);
      } else if (element.type === 8) {
        tokens.push(`tag:${element.value}`);
      }

      if ('options' in element && element.options) {
        for (const option of Object.values(element.options)) visit(option.value);
      }
      if ('children' in element && element.children) visit(element.children);
    }
  }

  visit(ast);
  return tokens.sort();
}

function messageIssues(english, messages, locale) {
  const issues = [];

  for (const [key, sourceValue] of Object.entries(english)) {
    const targetValue = messages[key];
    if (typeof sourceValue !== typeof targetValue) {
      if (key in messages)
        issues.push(`${key}: type ${typeof sourceValue} != ${typeof targetValue}`);
      continue;
    }
    if (typeof sourceValue !== 'string') continue;

    if (/[\uE000-\uF8FF]/.test(targetValue)) {
      issues.push(`${key}: contains a private-use character`);
    }

    if (translationSentinelPattern.test(targetValue)) {
      issues.push(`${key}: contains a translation sentinel`);
    }

    if (targetValue.includes('\uFFFD')) {
      issues.push(`${key}: contains a Unicode replacement character`);
    }

    if (/&(?:[a-z][a-z0-9]+|#\d+|#x[0-9a-f]+);/iu.test(targetValue)) {
      issues.push(`${key}: contains an HTML entity instead of rendered text`);
    }

    if (sourceValue.length > 0 && targetValue.length === 0) {
      issues.push(`${key}: translation is blank`);
    }

    if (isLikelyUntranslatedProse(key, sourceValue, targetValue, locale)) {
      issues.push(`${key}: likely untranslated English prose`);
    }

    if (isTechnicalLiteral(key, sourceValue) && targetValue !== sourceValue) {
      issues.push(`${key}: translated a technical literal`);
    }

    const missingDesignSystemTokens = designSystemTokens(key, sourceValue).filter(
      (token) => !targetValue.includes(token),
    );
    if (missingDesignSystemTokens.length > 0) {
      issues.push(`${key}: translated technical token(s): ${missingDesignSystemTokens.join(', ')}`);
    }

    const sourceTemplates = templateVariables(sourceValue);
    const targetTemplates = templateVariables(targetValue);
    if (JSON.stringify(sourceTemplates) !== JSON.stringify(targetTemplates)) {
      issues.push(`${key}: template variables differ`);
    }

    let sourceSignature;
    try {
      sourceSignature = messageSignature(sourceValue, defaultLocale);
    } catch {
      continue;
    }

    try {
      const targetSignature = messageSignature(targetValue, locale);
      if (JSON.stringify(sourceSignature) !== JSON.stringify(targetSignature)) {
        issues.push(`${key}: ICU arguments or rich-text tags differ`);
      }
    } catch (error) {
      issues.push(`${key}: invalid ICU message (${error.message})`);
    }
  }

  return issues;
}

function walkFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const normalized = full.replaceAll(path.sep, '/');
    if (!includeGenerated && ignoredPathParts.some((part) => normalized.includes(part))) {
      continue;
    }
    if (entry.isDirectory()) {
      walkFiles(full, out);
    } else if (
      /\.(tsx|ts)$/.test(entry.name) &&
      !entry.name.endsWith('.d.ts') &&
      !ignoredFilePattern.test(entry.name)
    ) {
      out.push(full);
    }
  }
  return out;
}

function isHumanText(value, kind) {
  const text = value.replace(/\s+/g, ' ').trim();
  if (!text || allowedLiteralValues.has(text)) return false;
  if (text.length < 2) return false;
  if (/^[\W\d_]+$/.test(text)) return false;
  if (
    !['jsx-text', 'display-property'].some((candidate) => kind.startsWith(candidate)) &&
    !kind.startsWith('jsx-attr:') &&
    !kind.startsWith('call:') &&
    /^[a-z0-9.:/?#[\]{}()_-]+$/i.test(text) &&
    !/\s/.test(text)
  )
    return false;
  if (/^https?:\/\//.test(text)) return false;
  if (/^[A-Z0-9_]+$/.test(text)) return false;
  return /[A-Za-z\u00C0-\uFFFF]/.test(text);
}

function getLine(sourceFile, pos) {
  return sourceFile.getLineAndCharacterOfPosition(pos).line + 1;
}

function scanFile(file) {
  const source = fs.readFileSync(file, 'utf8');
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const findings = [];
  const recordedNodes = new Set();
  const localizedCatalogRoots = new Set();

  function collectLocalizedCatalogRoots(node) {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      ['localizeUiCatalog', 'useLocalizedUiCatalog'].includes(node.expression.text)
    ) {
      const value = node.arguments[0];
      if (value && ts.isObjectLiteralExpression(value)) {
        for (const property of value.properties) {
          if (ts.isShorthandPropertyAssignment(property)) {
            localizedCatalogRoots.add(property.name.text);
          } else if (ts.isPropertyAssignment(property) && ts.isIdentifier(property.initializer)) {
            localizedCatalogRoots.add(property.initializer.text);
          }
        }
      } else if (value && ts.isIdentifier(value)) {
        localizedCatalogRoots.add(value.text);
      }
    }
    ts.forEachChild(node, collectLocalizedCatalogRoots);
  }

  collectLocalizedCatalogRoots(sourceFile);
  let expandedCatalogRoots = true;
  while (expandedCatalogRoots) {
    expandedCatalogRoots = false;
    function expandLocalizedCatalogRoots(node) {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        localizedCatalogRoots.has(node.name.text) &&
        node.initializer &&
        ts.isObjectLiteralExpression(node.initializer)
      ) {
        for (const property of node.initializer.properties) {
          const identifier = ts.isShorthandPropertyAssignment(property)
            ? property.name
            : ts.isPropertyAssignment(property) && ts.isIdentifier(property.initializer)
              ? property.initializer
              : undefined;
          if (identifier && !localizedCatalogRoots.has(identifier.text)) {
            localizedCatalogRoots.add(identifier.text);
            expandedCatalogRoots = true;
          }
        }
      }
      ts.forEachChild(node, expandLocalizedCatalogRoots);
    }
    expandLocalizedCatalogRoots(sourceFile);
  }

  function add(kind, node, text) {
    const nodeKey = `${node.pos}:${node.end}`;
    if (recordedNodes.has(nodeKey)) return;
    const normalized = text.replace(/\s+/g, ' ').trim();
    if (!isHumanText(normalized, kind)) return;
    recordedNodes.add(nodeKey);
    findings.push({
      file: path.relative(root, file),
      line: getLine(sourceFile, node.getStart(sourceFile)),
      kind,
      text: normalized,
    });
  }

  function addTechnicalTranslation(node, attributeName) {
    const nodeKey = `${node.pos}:${node.end}`;
    if (recordedNodes.has(nodeKey)) return;
    recordedNodes.add(nodeKey);
    findings.push({
      file: path.relative(root, file),
      line: getLine(sourceFile, node.getStart(sourceFile)),
      kind: `translated-technical:${attributeName}`,
      text: node.getText(sourceFile).replace(/\s+/g, ' ').trim(),
    });
  }

  function propertyName(node) {
    if (ts.isIdentifier(node) || ts.isStringLiteralLike(node)) return node.text;
    return undefined;
  }

  function isInsideFunction(node) {
    let cursor = node.parent;
    while (cursor && !ts.isSourceFile(cursor)) {
      if (ts.isFunctionLike(cursor)) return true;
      cursor = cursor.parent;
    }
    return false;
  }

  function topLevelVariableName(node) {
    let cursor = node.parent;
    while (cursor && !ts.isSourceFile(cursor)) {
      if (ts.isVariableDeclaration(cursor) && ts.isIdentifier(cursor.name)) {
        let owner = cursor.parent;
        while (owner && !ts.isVariableStatement(owner) && !ts.isSourceFile(owner)) {
          owner = owner.parent;
        }
        if (owner && ts.isVariableStatement(owner) && ts.isSourceFile(owner.parent)) {
          return cursor.name.text;
        }
      }
      cursor = cursor.parent;
    }
    return undefined;
  }

  function displayCollectionName(node) {
    let cursor = node.parent;
    while (cursor && !ts.isSourceFile(cursor)) {
      if (ts.isArrayLiteralExpression(cursor)) {
        const property = cursor.parent;
        if (ts.isPropertyAssignment(property)) return propertyName(property.name);
      }
      if (ts.isFunctionLike(cursor) || ts.isPropertyAssignment(cursor)) return undefined;
      cursor = cursor.parent;
    }
    return undefined;
  }

  function containingUiMessageArgument(node) {
    let cursor = node.parent;
    while (cursor && !ts.isFunctionLike(cursor) && !ts.isSourceFile(cursor)) {
      if (ts.isJsxElement(cursor) || ts.isJsxSelfClosingElement(cursor)) return undefined;
      if (ts.isCallExpression(cursor) && ts.isIdentifier(cursor.expression)) {
        const name = cursor.expression.text;
        if (
          (['toast', 'alert', 'confirm', 'prompt'].includes(name) || /Toast$/.test(name)) &&
          cursor.arguments[0] &&
          node.getStart(sourceFile) >= cursor.arguments[0].getStart(sourceFile) &&
          node.getEnd() <= cursor.arguments[0].getEnd()
        ) {
          return name;
        }
      }
      cursor = cursor.parent;
    }
    return undefined;
  }

  function templateText(node) {
    if (ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    if (!ts.isTemplateExpression(node)) return '';
    return [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join(' ');
  }

  function isInsideTranslationCall(node) {
    let cursor = node.parent;
    while (cursor && !ts.isJsxExpression(cursor)) {
      if (
        ts.isCallExpression(cursor) &&
        ((ts.isPropertyAccessExpression(cursor.expression) &&
          ['raw', 'rich'].includes(cursor.expression.name.text)) ||
          (ts.isIdentifier(cursor.expression) &&
            (/^(?:t|t[A-Z][A-Za-z0-9]*)$/.test(cursor.expression.text) ||
              cursor.expression.text === 'localizeUiCatalog')))
      ) {
        return true;
      }
      cursor = cursor.parent;
    }
    return false;
  }

  function isDisplayExpression(node, text) {
    if (isInsideTranslationCall(node)) return false;
    let jsxExpression = node.parent;
    while (
      jsxExpression &&
      !ts.isJsxExpression(jsxExpression) &&
      !ts.isJsxAttribute(jsxExpression) &&
      !ts.isJsxElement(jsxExpression) &&
      !ts.isJsxSelfClosingElement(jsxExpression)
    ) {
      if (ts.isVariableDeclaration(jsxExpression)) return false;
      jsxExpression = jsxExpression.parent;
    }
    if (!jsxExpression || !ts.isJsxExpression(jsxExpression)) return false;
    const attribute = jsxExpression?.parent;
    if (
      attribute &&
      ts.isJsxAttribute(attribute) &&
      (!isDisplayAttribute(attribute.name.text) ||
        ignoredAttributes.has(attribute.name.text) ||
        attribute.name.text.endsWith('ClassName'))
    ) {
      return false;
    }
    if (ts.isJsxElement(attribute)) {
      const parentTag = attribute.openingElement.tagName.getText(sourceFile);
      if (['code', 'pre', 'HighlightedCode'].includes(parentTag)) return false;
    }
    const parent = node.parent;
    if (
      (ts.isPropertyAssignment(parent) && parent.name === node) ||
      ts.isElementAccessExpression(parent) ||
      ts.isImportDeclaration(parent) ||
      ts.isExportDeclaration(parent)
    ) {
      return false;
    }
    if (
      ts.isBinaryExpression(parent) &&
      ['===', '!==', '==', '!='].includes(parent.operatorToken.getText(sourceFile))
    ) {
      return false;
    }
    const normalized = text.trim();
    if (/^SELECT\s+.+\s+LIMIT\s+\d+$/i.test(normalized)) return false;
    return /\s/.test(normalized) || /^[A-Z]/.test(normalized) || /[.!?]$/.test(normalized);
  }

  function visit(node) {
    if (
      ts.isCallExpression(node) &&
      ((ts.isPropertyAccessExpression(node.expression) &&
        ['raw', 'rich'].includes(node.expression.name.text)) ||
        (ts.isIdentifier(node.expression) &&
          /^(?:t|t[A-Z][A-Za-z0-9]*)$/.test(node.expression.text)))
    ) {
      let cursor = node.parent;
      while (cursor && !ts.isJsxExpression(cursor) && !ts.isSourceFile(cursor)) {
        cursor = cursor.parent;
      }
      const attribute = cursor?.parent;
      const owner = attribute?.parent?.parent;
      const ownerTag =
        owner && (ts.isJsxElement(owner) || ts.isJsxSelfClosingElement(owner))
          ? (ts.isJsxElement(owner) ? owner.openingElement : owner).tagName.getText(sourceFile)
          : '';
      if (
        attribute &&
        ts.isJsxAttribute(attribute) &&
        (['style', 'parentClass', 'dangerouslySetInnerHTML'].includes(attribute.name.text) ||
          (attribute.name.text === 'content' && ownerTag === 'meta'))
      ) {
        addTechnicalTranslation(node, attribute.name.text);
      }
    }

    if (ts.isJsxText(node)) {
      const parentTag = ts.isJsxElement(node.parent)
        ? node.parent.openingElement.tagName.getText(sourceFile)
        : '';
      if (!['code', 'pre', 'HighlightedCode'].includes(parentTag)) {
        add('jsx-text', node, node.getText(sourceFile));
      }
    }

    if (
      ts.isJsxAttribute(node) &&
      node.initializer &&
      !ignoredAttributes.has(node.name.text) &&
      !node.name.text.endsWith('ClassName') &&
      isDisplayAttribute(node.name.text)
    ) {
      if (ts.isStringLiteral(node.initializer)) {
        add(`jsx-attr:${node.name.text}`, node, node.initializer.text);
      }
    }

    if (
      ts.isStringLiteralLike(node) &&
      ts.isJsxExpression(node.parent) &&
      isDisplayExpression(node, node.text)
    ) {
      add('jsx-expression', node, node.text);
    }

    if (
      ts.isStringLiteralLike(node) &&
      !ts.isJsxExpression(node.parent) &&
      node.parent &&
      (() => {
        let cursor = node.parent;
        while (cursor && !ts.isJsxExpression(cursor)) cursor = cursor.parent;
        return Boolean(cursor);
      })() &&
      isDisplayExpression(node, node.text)
    ) {
      add('jsx-expression', node, node.text);
    }

    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      (['toast', 'alert', 'confirm', 'prompt'].includes(node.expression.text) ||
        /Toast$/.test(node.expression.text))
    ) {
      const first = node.arguments[0];
      if (first && ts.isStringLiteralLike(first)) {
        add(`call:${node.expression.text}`, first, first.text);
      }
    }

    if (ts.isStringLiteralLike(node) && ts.isPropertyAssignment(node.parent)) {
      const name = propertyName(node.parent.name);
      const coveredGuideText =
        file === path.join(srcDir, 'features/sso-setup/guides.ts') &&
        localizedGuideText.has(node.text);
      const coveredMenuText =
        file === path.join(srcDir, 'lib/menu-registry.ts') && localizedMenuText.has(node.text);
      const catalogRoot = topLevelVariableName(node);
      const coveredUiCatalogText = catalogRoot && localizedCatalogRoots.has(catalogRoot);
      const coveredRoleText =
        file.includes(
          `${path.sep}features${path.sep}marketing${path.sep}solutions${path.sep}roles${path.sep}`,
        ) && localizedRoleText.has(node.text);
      const coveredSiteConfigText =
        file === path.join(srcDir, 'lib/site-config.ts') && localizedSiteConfigText.has(node.text);
      const coveredAuditTitleText =
        file === path.join(srcDir, 'components/iam/audit-display-helpers.ts') &&
        localizedAuditTitleText.has(node.text);
      const coveredStarterPromptText =
        file === path.join(srcDir, 'lib/starter-prompts.ts') && ['label', 'prompt'].includes(name);
      const coveredSessionsCopy =
        file === path.join(srcDir, 'features/workspace/settings/tabs/sessions-tab.tsx') &&
        [
          'SOUND_PACKS',
          'SOUND_EVENTS',
          'DEFAULT_SESSIONS_TAB_COPY',
          'NOTIFICATION_TYPE_TOGGLES',
          'NOTIFICATION_BEHAVIOR_TOGGLES',
        ].includes(catalogRoot);
      const coveredSettingsRail =
        file === path.join(srcDir, 'features/workspace/settings/rail.ts') &&
        ['STATIC_GROUPS', 'RETIRED_RAIL_ITEMS'].includes(catalogRoot);
      const coveredOnboardingProfileFixture =
        file === path.join(srcDir, 'components/projects/onboarding/onboarding-profile.ts') &&
        ['USE_CASE_OPTIONS', 'STARTER_PROMPTS', 'ENGLISH_KICKOFF_COPY'].includes(catalogRoot);
      const coveredCompanyOsMessageKey =
        file === path.join(srcDir, 'features/marketing/company-os-sections.tsx') &&
        ['codePoints', 'runsPoints'].includes(catalogRoot);
      const coveredRoleCapabilityCopy =
        file === path.join(srcDir, 'components/iam/role-capability-matrix.tsx') &&
        catalogRoot === 'AREA_COPY';
      const coveredSnapshotsFallbackCopy =
        file === path.join(srcDir, 'features/workspace/settings/tabs/snapshots-tab.tsx') &&
        catalogRoot === 'DEFAULT_SNAPSHOTS_COPY';
      const coveredBlogMetadata =
        file === path.join(srcDir, 'lib/blog-posts.ts') && localizedBlogText.has(node.text);
      const coveredPublicMetadata =
        file === path.join(srcDir, 'lib/seo/public-content.ts') &&
        localizedPublicMetadataText.has(node.text);
      const coveredWallpaperDownload =
        file === path.join(srcDir, 'lib/wallpaper-downloads.ts') &&
        localizedDesignSystemText.has(node.text);
      const coveredDesignToken =
        file === path.join(srcDir, 'app/(public)/(marketing)/design-system/page.tsx') &&
        catalogRoot === 'SHADOW_SCALE' &&
        /^shadow-/.test(node.text);
      const coveredLocalizedSourceCatalog =
        (file === path.join(srcDir, 'features/marketplace/marketplace-meta.tsx') &&
          ['TYPE_META', 'TYPE_FILTERS', 'TYPE_SECTIONS'].includes(catalogRoot)) ||
        (file === path.join(srcDir, 'features/session/composer/menus/slash-actions.ts') &&
          catalogRoot === 'SLASH_ACTIONS') ||
        (file === path.join(srcDir, 'components/projects/session-label.ts') &&
          ['SESSION_SOURCE_FILTERS', 'SESSION_STATUS_FILTERS'].includes(catalogRoot)) ||
        (file === path.join(srcDir, 'features/changes/change-vocabulary.ts') &&
          ['CHANGE_KIND', 'DIFF_LAYOUT_LABEL', 'PROPOSED_CHANGE_STATE'].includes(catalogRoot)) ||
        (file === path.join(srcDir, 'components/projects/schedule/schedule-copy.ts') &&
          ['KIND_COPY', 'TRIGGERS_COPY'].includes(catalogRoot)) ||
        (file === path.join(srcDir, 'features/workspace/shared/sharing-intent.ts') &&
          catalogRoot === 'DEFAULT_COPY') ||
        (file === path.join(srcDir, 'lib/provisioning-stages.ts') &&
          ['STAGE_PROGRESS', 'STAGE_LABELS'].includes(catalogRoot)) ||
        (file === path.join(srcDir, 'components/home/interactive-demo/chat/scenarios.tsx') &&
          catalogRoot === 'SCENARIOS') ||
        (file === path.join(srcDir, 'app/admin/utils/_components/constants.ts') &&
          ['MAINTENANCE_LEVELS', 'AVAILABLE_SERVICES'].includes(catalogRoot)) ||
        (file === path.join(srcDir, 'app/a1o/content.ts') &&
          ['LAYERS', 'COPY'].includes(catalogRoot)) ||
        (file === path.join(srcDir, 'features/marketing/download/content.ts') &&
          [
            'hero',
            'DESKTOP_CARD',
            'MOBILE_CARD',
            'DESKTOP_ROWS',
            'MOBILE_ROWS',
            'TERMINAL',
          ].includes(catalogRoot)) ||
        (file === path.join(srcDir, 'features/marketing/interludes/content.ts') &&
          ['asking', 'owning'].includes(catalogRoot)) ||
        (file === path.join(srcDir, 'features/marketing/security/content.ts') &&
          ['ACCORDION', 'STAGE_DATA', 'CTA'].includes(catalogRoot)) ||
        (file === path.join(srcDir, 'features/layout/user-menu-shared.tsx') &&
          ['HELP_LINKS', 'LEGAL_LINKS', 'THEME_OPTIONS'].includes(catalogRoot)) ||
        (file === path.join(srcDir, 'components/projects/policies-panel.tsx') &&
          ['ACTION_META', 'DEFAULT_OPTIONS'].includes(catalogRoot)) ||
        (file === path.join(srcDir, 'components/projects/project-access-boundary.tsx') &&
          catalogRoot === 'GATE_COPY_KEYS') ||
        (file === path.join(srcDir, 'features/workspace/shared/access/role-select.tsx') &&
          ['ACCOUNT_ROLE_DESCRIPTORS', 'PROJECT_ROLE_DESCRIPTORS'].includes(catalogRoot)) ||
        (file === path.join(srcDir, 'features/marketing/how-it-work/web-panel-wrapper.tsx') &&
          catalogRoot === 'DEMO_PANEL_TABS') ||
        (file === path.join(srcDir, 'features/marketing/how-it-work/step/step-harness.tsx') &&
          catalogRoot === 'STEPS') ||
        (file === path.join(srcDir, 'features/marketing/component/capability-hero-artifacts.tsx') &&
          ['TREE_ROWS', 'PRESENCE_ROWS', 'POLICY_ROWS', 'PRINCIPALS'].includes(catalogRoot)) ||
        (file ===
          path.join(srcDir, 'features/workspace/customize/sections/view/gateway/_metrics.tsx') &&
          ['RANGES', 'chartConfig'].includes(catalogRoot)) ||
        (file ===
          path.join(
            srcDir,
            'features/workspace/capabilities/connectors/catalog/connector-categories.ts',
          ) &&
          catalogRoot === 'CURATED_SECTIONS') ||
        (file === path.join(srcDir, 'components/home/interactive-demo/data.ts') &&
          catalogRoot === 'AGENTS') ||
        (file === path.join(srcDir, 'features/marketing/capabilities/content.ts') &&
          ['agents', 'channels', 'automations', 'control'].includes(catalogRoot)) ||
        (file ===
          path.join(srcDir, 'features/workspace/project-sidebar/modal/share-session-modal.tsx') &&
          catalogRoot === 'SESSION_SHARING_COPY') ||
        (file === path.join(srcDir, 'features/workspace/settings/tabs/appearance-tab.tsx') &&
          ['DENSITY_OPTIONS', 'DEFAULT_APPEARANCE_TAB_COPY'].includes(catalogRoot)) ||
        (file ===
          path.join(srcDir, 'features/marketing/how-it-work/step/step-source-of-truth.tsx') &&
          catalogRoot === 'NODES' &&
          localizedRemainingUiText.has(node.text)) ||
        (file ===
          path.join(srcDir, 'features/workspace/capabilities/index/customize-index-page.tsx') &&
          catalogRoot === 'CARD_COPY') ||
        (file ===
          path.join(srcDir, 'features/workspace/capabilities/shared/capability-tab-routes.ts') &&
          catalogRoot === 'CAPABILITY_TABS') ||
        (file === path.join(srcDir, 'features/workspace/customize/sections/connectors-view.tsx') &&
          ['POLICY_CHOICES', 'POLICY_LABEL'].includes(catalogRoot)) ||
        (file === path.join(srcDir, 'features/workspace/customize/sections/gateway-view.tsx') &&
          catalogRoot === 'LLM_TABS') ||
        (file === path.join(srcDir, 'features/workspace/settings/tabs/sandbox-tab.tsx') &&
          catalogRoot === 'TEMPLATE_STATE_LABEL') ||
        (file === path.join(srcDir, 'lib/themes.ts') && catalogRoot === 'THEMES') ||
        (file === path.join(srcDir, 'app/(app)/projects/start/landing-terminal.tsx') &&
          catalogRoot === 'COPY') ||
        (file === path.join(srcDir, 'app/admin/analytics/page.tsx') &&
          ['RANGES', 'sessionsConfig', 'accountsConfig', 'burnConfig'].includes(catalogRoot)) ||
        (file === path.join(srcDir, 'features/accounts/settings/branding-tab.tsx') &&
          catalogRoot === 'SLOTS') ||
        (file === path.join(srcDir, 'features/marketing/hero-surfaces.tsx') &&
          catalogRoot === 'SURFACES') ||
        (file === path.join(srcDir, 'features/tunnel/scope-editors/filesystem-scope-editor.tsx') &&
          catalogRoot === 'MAX_FILE_SIZE_OPTIONS') ||
        (file === path.join(srcDir, 'features/tunnel/scope-editors/shell-scope-editor.tsx') &&
          catalogRoot === 'TIMEOUT_OPTIONS') ||
        (file ===
          path.join(
            srcDir,
            'features/workspace/customize/sections/view/gateway/gateway-budgets.tsx',
          ) &&
          ['PERIODS', 'ACTIONS'].includes(catalogRoot)) ||
        (file === path.join(srcDir, 'hooks/projects/session-reload-progress.ts') &&
          catalogRoot === 'RELOAD_PROGRESS_STEPS') ||
        (file === path.join(srcDir, 'lib/kortix/task-meta.ts') && catalogRoot === 'STATUS_META') ||
        (file === path.join(srcDir, 'lib/agent-discovery.ts') &&
          ['API_CATALOG', 'MCP_SERVER_CARD'].includes(catalogRoot)) ||
        (file === path.join(srcDir, 'lib/mcp/public-content-server.ts') &&
          catalogRoot === 'TOOL_DEFINITIONS') ||
        (file === path.join(srcDir, 'components/setup-links/setup-link-button.tsx') &&
          catalogRoot === 'COPY') ||
        (file === path.join(srcDir, 'features/billing/cost-explorer/cost-chart.tsx') &&
          catalogRoot === 'chartConfig') ||
        (file === path.join(srcDir, 'features/file-renderers/show-content-renderer.tsx') &&
          catalogRoot === 'SHOW_TYPE_LABELS') ||
        (file === path.join(srcDir, 'features/marketing/faq/content.ts') &&
          catalogRoot === 'faq' &&
          localizedRemainingUiText.has(node.text)) ||
        (file === path.join(srcDir, 'features/marketing/open-source/content.ts') &&
          catalogRoot === 'openSource' &&
          localizedRemainingUiText.has(node.text)) ||
        (file === path.join(srcDir, 'features/marketing/how-it-work/step/step-computer.tsx') &&
          catalogRoot === 'TOOL_PARTS' &&
          node.text === 'Run the billing suite') ||
        (file === path.join(srcDir, 'features/project-files/components/drive-grid-view.tsx') &&
          catalogRoot === 'ELEVATED_DIR_META') ||
        (file === path.join(srcDir, 'features/sso-setup/setup-wizard.tsx') &&
          catalogRoot === 'FLOW_CONFIG') ||
        (file === path.join(srcDir, 'features/workspace/capabilities/skills/skills-page.tsx') &&
          catalogRoot === 'SCOPE_FILTERS') ||
        (file ===
          path.join(srcDir, 'features/workspace/customize/sections/view/agent-editor-catalog.ts') &&
          ['PERMISSION_ACTION_LABEL', 'PERMISSION_RULE_GROUPS'].includes(catalogRoot)) ||
        (file ===
          path.join(srcDir, 'features/workspace/customize/sections/view/grant-mode-field.tsx') &&
          catalogRoot === 'GRANT_MODES') ||
        (file === path.join(srcDir, 'features/workspace/customize/migrate-to-v2/upgrade-defs.ts') &&
          catalogRoot === 'PROJECT_UPGRADES') ||
        (file ===
          path.join(srcDir, 'features/workspace/customize/migrate-to-v2/upgrade-view.tsx') &&
          catalogRoot === 'DEFAULT_UPGRADES_COPY') ||
        (file === path.join(srcDir, 'features/workspace/settings/tabs/account-memberships.tsx') &&
          catalogRoot === 'DEFAULT_ACCOUNT_MEMBERSHIPS_COPY') ||
        (file === path.join(srcDir, 'features/workspace/settings/tabs/credits-tab.tsx') &&
          catalogRoot === 'DEFAULT_BUCKET_COPY') ||
        (file === path.join(srcDir, 'features/workspace/settings/tabs/profile-tab.tsx') &&
          catalogRoot === 'DEFAULT_PROFILE_TAB_COPY') ||
        (file === path.join(srcDir, 'lib/site-metadata.ts') && catalogRoot === 'siteMetadata') ||
        (file === path.join(srcDir, 'components/home/cli-demo.tsx') && catalogRoot === 'PALETTE');
      const coveredTechnicalCatalog =
        (file === path.join(srcDir, 'components/home/navbar.tsx') &&
          catalogRoot === 'DRAWER_SOCIALS') ||
        (file === path.join(srcDir, 'components/instance/config.ts') &&
          catalogRoot === 'INSTANCE_CONFIG') ||
        (file === path.join(srcDir, 'features/marketing/connectors/policy-section.tsx') &&
          ['TINT', 'DOT'].includes(catalogRoot)) ||
        (file === path.join(srcDir, 'features/marketing/landing/code-panels.tsx') &&
          catalogRoot === 'TOKEN_CLASS') ||
        (file === path.join(srcDir, 'features/marketing/how-it-work/step/step-computer.tsx') &&
          catalogRoot === 'TOOL_PARTS' &&
          node.text === 'bun test apps/api/src/billing') ||
        (file === path.join(srcDir, 'features/session/attachment-mime.ts') &&
          catalogRoot === 'MIME_BY_EXTENSION') ||
        (file === path.join(srcDir, 'features/workspace/settings/tabs/preferences-tab.tsx') &&
          catalogRoot === 'MODIFIER_OPTIONS') ||
        (file.includes(`${path.sep}i18n${path.sep}`) && file.endsWith('.generated.ts')) ||
        (file === path.join(srcDir, 'lib/codemirror-pierre-theme.ts') &&
          ['dark', 'light'].includes(catalogRoot)) ||
        (file === path.join(srcDir, 'lib/utils/memory-search-output.ts') &&
          catalogRoot === 'EMPTY_RESULT');
      const coveredPresentationCatalog =
        (file === path.join(srcDir, 'app/presentations/decks/security.tsx') &&
          catalogRoot === 'ANSWERS') ||
        (file === path.join(srcDir, 'app/presentations/registry.ts') && catalogRoot === 'DECKS');
      const coveredLocalizedLeafCatalog =
        (file === path.join(srcDir, 'features/billing/billing-return.tsx') &&
          catalogRoot === 'RETURNS') ||
        (file === path.join(srcDir, 'features/session/header/session-config-indicator.tsx') &&
          catalogRoot === 'BUSY_COPY') ||
        (file === path.join(srcDir, 'features/session/mobile-tool-drawer.tsx') &&
          catalogRoot === 'TOOL_META') ||
        (file === path.join(srcDir, 'features/session/outcomes/change-request-outcomes.ts') &&
          ['CR_STATUS_WORD', 'FALLBACK_STATUS'].includes(catalogRoot)) ||
        (file === path.join(srcDir, 'features/session/session-starting-loader.tsx') &&
          catalogRoot === 'STEPS') ||
        (file === path.join(srcDir, 'features/session/tool/shared/patch-helpers.tsx') &&
          catalogRoot === 'PATCH_TYPE_STYLE') ||
        (file ===
          path.join(
            srcDir,
            'features/workspace/capabilities/connectors/tools/tool-policy-labels.ts',
          ) &&
          catalogRoot === 'POLICY_SEGMENTS') ||
        (file === path.join(srcDir, 'features/workspace/command-palette.tsx') &&
          catalogRoot === 'DENSITY_PAGE_OPTIONS') ||
        (file === path.join(srcDir, 'features/workspace/customize/sections/view/dev-view.tsx') &&
          catalogRoot === 'LAUNCHERS') ||
        (file ===
          path.join(
            srcDir,
            'features/workspace/customize/sections/view/gateway/gateway-overview.tsx',
          ) &&
          catalogRoot === 'METRICS') ||
        (file === path.join(srcDir, 'app/admin/projects/page.tsx') &&
          catalogRoot === 'STATUS_OPTIONS') ||
        (file === path.join(srcDir, 'components/iam/api-keys-card.tsx') &&
          catalogRoot === 'STATUS_BADGE') ||
        (file === path.join(srcDir, 'components/iam/github-app-setup-card.tsx') &&
          catalogRoot === 'SETUP_METHODS') ||
        (file === path.join(srcDir, 'features/file-renderers/image-renderer.tsx') &&
          catalogRoot === 'BACKDROPS') ||
        (file === path.join(srcDir, 'features/marketing/how-it-work/step/step-models.tsx') &&
          catalogRoot === 'BILLING') ||
        (file === path.join(srcDir, 'features/session/header/session-site-header.tsx') &&
          catalogRoot === 'DEV_TOOLS') ||
        (file === path.join(srcDir, 'features/session/session-changes-shared.tsx') &&
          catalogRoot === 'CHANGE_STATUS_META') ||
        (file === path.join(srcDir, 'features/session/session-files-panel.tsx') &&
          catalogRoot === 'STATUS_BADGE') ||
        (file === path.join(srcDir, 'features/workspace/capabilities/agents/agents-page.tsx') &&
          catalogRoot === 'MODE_FILTERS') ||
        (file ===
          path.join(
            srcDir,
            'features/workspace/customize/sections/component/slack-byo-wizard.tsx',
          ) &&
          catalogRoot === 'STEPS') ||
        (file ===
          path.join(srcDir, 'features/workspace/customize/sections/view/channels-view.tsx') &&
          catalogRoot === 'CONVERSATION_POLICIES') ||
        (file ===
          path.join(
            srcDir,
            'features/workspace/customize/sections/view/gateway/gateway-api-reference.tsx',
          ) &&
          catalogRoot === 'ENDPOINT_TABS') ||
        (file ===
          path.join(
            srcDir,
            'features/workspace/customize/sections/view/gateway/gateway-logs.tsx',
          ) &&
          catalogRoot === 'FILTERS');
      if (
        name &&
        displayPropertyNames.has(name) &&
        !isInsideTranslationCall(node) &&
        !coveredGuideText &&
        !coveredMenuText &&
        !coveredUiCatalogText &&
        !coveredRoleText &&
        !coveredSiteConfigText &&
        !coveredAuditTitleText &&
        !coveredStarterPromptText &&
        !coveredSessionsCopy &&
        !coveredSettingsRail &&
        !coveredOnboardingProfileFixture &&
        !coveredCompanyOsMessageKey &&
        !coveredRoleCapabilityCopy &&
        !coveredSnapshotsFallbackCopy &&
        !coveredBlogMetadata &&
        !coveredPublicMetadata &&
        !coveredWallpaperDownload &&
        !coveredDesignToken &&
        !coveredLocalizedSourceCatalog &&
        !coveredPresentationCatalog &&
        !coveredLocalizedLeafCatalog &&
        !coveredTechnicalCatalog
      ) {
        add(`display-property:${name}`, node, node.text);
      }
    }

    if (ts.isStringLiteralLike(node) && !isInsideTranslationCall(node)) {
      const collectionName = displayCollectionName(node);
      const catalogRoot = topLevelVariableName(node);
      const coveredUiCatalogText = catalogRoot && localizedCatalogRoots.has(catalogRoot);
      const coveredGuideText =
        file === path.join(srcDir, 'features/sso-setup/guides.ts') &&
        localizedGuideText.has(node.text);
      const coveredRoleText =
        file.includes(
          `${path.sep}features${path.sep}marketing${path.sep}solutions${path.sep}roles${path.sep}`,
        ) && localizedRoleText.has(node.text);
      const coveredRoleExampleCode =
        file.includes(
          `${path.sep}features${path.sep}marketing${path.sep}solutions${path.sep}roles${path.sep}`,
        ) && collectionName === 'lines';
      if (
        collectionName &&
        displayCollectionPropertyNames.has(collectionName) &&
        !coveredUiCatalogText &&
        !coveredGuideText &&
        !coveredRoleText &&
        !coveredRoleExampleCode
      ) {
        add(`display-collection:${collectionName}`, node, node.text);
      }
    }

    if (ts.isTemplateExpression(node)) {
      const text = templateText(node);
      if (isDisplayExpression(node, text)) add('jsx-template', node, text);
      const parent = node.parent;
      if (ts.isPropertyAssignment(parent) && isInsideFunction(node)) {
        const name = propertyName(parent.name);
        if (name && displayPropertyNames.has(name)) {
          add(`display-property:${name}`, node, templateText(node));
        }
      }

      const callName = containingUiMessageArgument(node);
      if (callName && !isInsideTranslationCall(node)) {
        add(`call:${callName}`, node, templateText(node));
      }
    }

    if (ts.isStringLiteralLike(node)) {
      const callName = containingUiMessageArgument(node);
      if (callName && !isInsideTranslationCall(node)) add(`call:${callName}`, node, node.text);
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return findings;
}

function scanHardcodedTranslationReferences(file, messages) {
  const source = fs.readFileSync(file, 'utf8');
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const findings = [];

  function hasMessage(key) {
    let value = messages.hardcodedUi;
    for (const part of key.split('.')) {
      if (!value || typeof value !== 'object' || !Object.hasOwn(value, part)) return false;
      value = value[part];
    }
    return true;
  }

  function visit(node) {
    if (
      ts.isCallExpression(node) &&
      node.arguments[0] &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      const expression = node.expression;
      const isHardcodedTranslator =
        (ts.isIdentifier(expression) && expression.text === 'tI18nHardcoded') ||
        (ts.isPropertyAccessExpression(expression) &&
          ts.isIdentifier(expression.expression) &&
          expression.expression.text === 'tI18nHardcoded' &&
          ['raw', 'rich'].includes(expression.name.text));
      const key = node.arguments[0].text;
      if (isHardcodedTranslator && !hasMessage(key)) {
        findings.push({
          file: path.relative(root, file),
          line: getLine(sourceFile, node.arguments[0].getStart(sourceFile)),
          key,
        });
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return findings;
}

function auditTranslations() {
  const english = flatten(readJson(path.join(translationsDir, `${defaultLocale}.json`)));
  const report = [];
  let failures = 0;

  for (const locale of locales) {
    const file = path.join(translationsDir, `${locale}.json`);
    if (!fs.existsSync(file)) {
      report.push({ locale, missingFile: true });
      failures += 1;
      continue;
    }

    const messages = flatten(readJson(file));
    const missing = Object.keys(english).filter((key) => !(key in messages));
    const extra = Object.keys(messages).filter((key) => !(key in english));
    const invalid = messageIssues(english, messages, locale);

    if (missing.length > 0 || extra.length > 0 || invalid.length > 0) failures += 1;
    report.push({
      locale,
      leafKeys: Object.keys(messages).length,
      missing,
      extra,
      invalid,
    });
  }

  return { report, failures };
}

const translationAudit = auditTranslations();
const sourceFiles = walkFiles(srcDir);
const hardcodedFindings = sourceFiles.flatMap(scanFile);
const defaultMessages = readJson(path.join(translationsDir, `${defaultLocale}.json`));
const missingTranslationReferences = sourceFiles.flatMap((file) =>
  scanHardcodedTranslationReferences(file, defaultMessages),
);
const byFile = new Map();

for (const finding of hardcodedFindings) {
  byFile.set(finding.file, (byFile.get(finding.file) ?? 0) + 1);
}

const topFiles = [...byFile.entries()]
  .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  .slice(0, 30);

console.log('i18n translation key audit');
for (const item of translationAudit.report) {
  if (item.missingFile) {
    console.log(`- ${item.locale}: missing translation file`);
    continue;
  }
  console.log(
    `- ${item.locale}: ${item.leafKeys} leaf keys, ${item.missing.length} missing, ${item.extra.length} extra, ${item.invalid.length} invalid`,
  );
  if (item.missing.length) console.log(`  missing: ${item.missing.slice(0, 30).join(', ')}`);
  if (item.extra.length) console.log(`  extra: ${item.extra.slice(0, 30).join(', ')}`);
  if (item.invalid.length) console.log(`  invalid: ${item.invalid.slice(0, 30).join(', ')}`);
}

console.log('\nhardcoded UI text audit');
console.log(`- findings: ${hardcodedFindings.length}`);
for (const [file, count] of topFiles) {
  console.log(`- ${file}: ${count}`);
}

console.log('\ntranslation reference audit');
console.log(`- unresolved: ${missingTranslationReferences.length}`);
for (const finding of missingTranslationReferences.slice(0, 30)) {
  console.log(`- ${finding.file}:${finding.line}: ${finding.key}`);
}

if (args.get('json')) {
  const outputFile = path.resolve(root, args.get('json'));
  fs.writeFileSync(
    outputFile,
    JSON.stringify(
      {
        translations: translationAudit.report,
        hardcoded: hardcodedFindings,
        missingTranslationReferences,
        topFiles: Object.fromEntries(topFiles),
      },
      null,
      2,
    ),
  );
  console.log(`\nwrote ${path.relative(root, outputFile)}`);
}

let failed = translationAudit.failures > 0;
if (missingTranslationReferences.length > 0) failed = true;
if (hardcodedFindings.length > maxHardcoded) {
  console.error(
    `\nHardcoded UI text findings (${hardcodedFindings.length}) exceed --max-hardcoded=${maxHardcoded}.`,
  );
  failed = true;
}

if (failed) process.exit(1);
