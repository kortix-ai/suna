#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import ts from 'typescript';

const root = process.cwd();
const srcDir = path.join(root, 'src');
const translationsDir = path.join(root, 'translations');
const locales = ['en', 'de', 'it', 'zh', 'ja', 'pt', 'fr', 'es'];
const defaultLocale = 'en';

const args = new Map(
  process.argv.slice(2).filter((arg) => arg !== '--').map((arg) => {
    const [key, value = 'true'] = arg.replace(/^--/, '').split('=');
    return [key, value];
  }),
);

const maxHardcoded = args.has('max-hardcoded')
  ? Number(args.get('max-hardcoded'))
  : Number.POSITIVE_INFINITY;

const includeGenerated = args.get('include-generated') === 'true';

const ignoredPathParts = [
  '/.next/',
  '/node_modules/',
  '/src/components/ui/',
  '/src/app/fonts/',
  '/src/types/',
];

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
]);

const ignoredAttributes = new Set([
  'className',
  'id',
  'key',
  'type',
  'role',
  'href',
  'src',
  'alt',
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
]);

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function flatten(obj, prefix = '', out = {}) {
  for (const [key, value] of Object.entries(obj)) {
    const next = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      flatten(value, next, out);
    } else {
      out[next] = value;
    }
  }
  return out;
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
    } else if (/\.(tsx|ts)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

function isHumanText(value) {
  const text = value.replace(/\s+/g, ' ').trim();
  if (!text || allowedLiteralValues.has(text)) return false;
  if (text.length < 2) return false;
  if (/^[\W\d_]+$/.test(text)) return false;
  if (/^[a-z0-9_.:/?#\[\]{}()_-]+$/i.test(text) && !/\s/.test(text)) return false;
  if (/^https?:\/\//.test(text)) return false;
  if (/^[A-Z0-9_]+$/.test(text)) return false;
  return /[A-Za-z\u00C0-\uFFFF]/.test(text);
}

function getLine(sourceFile, pos) {
  return sourceFile.getLineAndCharacterOfPosition(pos).line + 1;
}

function scanFile(file) {
  const source = fs.readFileSync(file, 'utf8');
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const findings = [];

  function add(kind, node, text) {
    const normalized = text.replace(/\s+/g, ' ').trim();
    if (!isHumanText(normalized)) return;
    findings.push({
      file: path.relative(root, file),
      line: getLine(sourceFile, node.getStart(sourceFile)),
      kind,
      text: normalized.slice(0, 140),
    });
  }

  function visit(node) {
    if (ts.isJsxText(node)) {
      add('jsx-text', node, node.getText(sourceFile));
    }

    if (ts.isJsxAttribute(node) && node.initializer && !ignoredAttributes.has(node.name.text)) {
      if (ts.isStringLiteral(node.initializer)) {
        add(`jsx-attr:${node.name.text}`, node, node.initializer.text);
      }
    }

    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      ['toast', 'alert', 'confirm', 'prompt'].includes(node.expression.text)
    ) {
      const first = node.arguments[0];
      if (first && ts.isStringLiteralLike(first)) {
        add(`call:${node.expression.text}`, first, first.text);
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

    if (missing.length > 0) failures += 1;
    report.push({
      locale,
      leafKeys: Object.keys(messages).length,
      missing,
      extra,
    });
  }

  return { report, failures };
}

const translationAudit = auditTranslations();
const hardcodedFindings = walkFiles(srcDir).flatMap(scanFile);
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
    `- ${item.locale}: ${item.leafKeys} leaf keys, ${item.missing.length} missing, ${item.extra.length} extra`,
  );
  if (item.missing.length) console.log(`  missing: ${item.missing.slice(0, 30).join(', ')}`);
  if (item.extra.length) console.log(`  extra: ${item.extra.slice(0, 30).join(', ')}`);
}

console.log('\nhardcoded UI text audit');
console.log(`- findings: ${hardcodedFindings.length}`);
for (const [file, count] of topFiles) {
  console.log(`- ${file}: ${count}`);
}

if (args.get('json')) {
  const outputFile = path.resolve(root, args.get('json'));
  fs.writeFileSync(
    outputFile,
    JSON.stringify(
      {
        translations: translationAudit.report,
        hardcoded: hardcodedFindings,
        topFiles: Object.fromEntries(topFiles),
      },
      null,
      2,
    ),
  );
  console.log(`\nwrote ${path.relative(root, outputFile)}`);
}

let failed = translationAudit.failures > 0;
if (hardcodedFindings.length > maxHardcoded) {
  console.error(
    `\nHardcoded UI text findings (${hardcodedFindings.length}) exceed --max-hardcoded=${maxHardcoded}.`,
  );
  failed = true;
}

if (failed) process.exit(1);
