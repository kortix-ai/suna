#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const targets = [
  'apps/web/src',
  'apps/mobile',
];

const ignoredPathParts = [
  '/node_modules/',
  '/.next/',
  '/android/',
  '/ios/',
  '/locales/',
  '/translations/',
];

const allowedMatches = new Map([
  ['apps/web/src/components/auth/phone-verification/phone-input.tsx', ['navigator.language']],
  ['apps/web/src/lib/utils/region-currency.ts', ['Intl.DateTimeFormat().resolvedOptions().timeZone']],
]);

const bannedPatterns = [
  'getBrowserLocale',
  'getCookieLocale',
  'getDocumentCookieLocale',
  'getLocalStorageLocale',
  'hasExplicitBrowserLocalePreference',
  'persistBrowserLocale',
  'detectBestLocale',
  'detectLocaleFromBrowser',
  'detectLocaleFromDevice',
  'detectLocaleFromHeaders',
  'detectLocaleFromTimezone',
  'detectBestLocaleFromHeaders',
  'Accept-Language',
  'accept-language',
  'navigator.languages',
  'navigator.language',
  'geo-detected locale',
  'geo-detect',
  'device locale',
  'timezone-detected locale',
  'Saved language preference',
  'AsyncStorage.getItem(LANGUAGE_KEY)',
];

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const normalized = full.replaceAll(path.sep, '/');
    if (ignoredPathParts.some((part) => normalized.includes(part))) continue;
    if (entry.isDirectory()) {
      walk(full, out);
    } else if (/\.(ts|tsx|js|jsx|mts|mjs)$/.test(entry.name)) {
      out.push(full);
    }
  }

  return out;
}

const findings = [];

for (const target of targets) {
  for (const file of walk(path.join(root, target))) {
    const relative = path.relative(root, file).replaceAll(path.sep, '/');
    const source = fs.readFileSync(file, 'utf8');
    const allowed = allowedMatches.get(relative) ?? [];

    source.split('\n').forEach((line, index) => {
      for (const pattern of bannedPatterns) {
        if (!line.includes(pattern)) continue;
        if (allowed.includes(pattern)) continue;
        findings.push({
          file: relative,
          line: index + 1,
          pattern,
          text: line.trim(),
        });
      }
    });
  }
}

if (findings.length > 0) {
  console.error('Explicit-language audit failed. Remove implicit language inference:');
  for (const finding of findings.slice(0, 80)) {
    console.error(
      `- ${finding.file}:${finding.line} [${finding.pattern}] ${finding.text}`,
    );
  }
  if (findings.length > 80) {
    console.error(`...and ${findings.length - 80} more`);
  }
  process.exit(1);
}

console.log('Explicit-language audit passed: no implicit language inference found.');
