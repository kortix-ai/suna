#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const locales = ['en', 'de', 'it', 'zh', 'ja', 'pt', 'fr', 'es'];
const defaultLocale = 'en';

const sets = [
  { name: 'web', dir: 'apps/web/translations' },
  { name: 'mobile', dir: 'apps/mobile/locales' },
];

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

function stripIcuPluralBlocks(value) {
  let output = '';
  for (let index = 0; index < value.length; index += 1) {
    const start = value.slice(index).match(/^\{([A-Za-z_][\w]*)\s*,\s*plural\s*,/);
    if (!start) {
      output += value[index];
      continue;
    }

    let depth = 0;
    let end = index;
    for (; end < value.length; end += 1) {
      if (value[end] === '{') depth += 1;
      if (value[end] === '}') {
        depth -= 1;
        if (depth === 0) break;
      }
    }

    output += `{${start[1]}}`;
    index = end;
  }
  return output;
}

function placeholders(value) {
  if (typeof value !== 'string') return [];
  const found = new Set();

  for (const match of value.matchAll(/\{\{\s*([^}]+?)\s*\}\}/g)) {
    found.add(`{{${match[1].trim()}}}`);
  }

  const withoutIcu = stripIcuPluralBlocks(value);
  for (const match of withoutIcu.matchAll(/(?<!\{)\{([A-Za-z_][\w]*)\}(?!\})/g)) {
    found.add(`{${match[1]}}`);
  }

  return [...found].sort();
}

function isEmptyValue(value) {
  return typeof value === 'string' && value.trim().length === 0;
}

let failed = false;

for (const set of sets) {
  const dir = path.join(root, set.dir);
  const english = flatten(readJson(path.join(dir, `${defaultLocale}.json`)));
  console.log(`${set.name} translations`);

  for (const locale of locales) {
    const file = path.join(dir, `${locale}.json`);
    if (!fs.existsSync(file)) {
      console.error(`- ${locale}: missing ${path.relative(root, file)}`);
      failed = true;
      continue;
    }

    const messages = flatten(readJson(file));
    const missing = Object.keys(english).filter((key) => !(key in messages));
    const extra = Object.keys(messages).filter((key) => !(key in english));
    const empty = Object.entries(messages)
      .filter(([, value]) => isEmptyValue(value))
      .map(([key]) => key);
    const placeholderMismatches = Object.keys(english).filter((key) => {
      if (!(key in messages)) return false;
      return JSON.stringify(placeholders(english[key])) !== JSON.stringify(placeholders(messages[key]));
    });

    console.log(
      `- ${locale}: ${Object.keys(messages).length} keys, ${missing.length} missing, ${extra.length} extra, ${empty.length} empty, ${placeholderMismatches.length} placeholder mismatches`,
    );

    if (missing.length || extra.length || empty.length || placeholderMismatches.length) {
      failed = true;
      if (missing.length) console.error(`  missing: ${missing.slice(0, 20).join(', ')}`);
      if (extra.length) console.error(`  extra: ${extra.slice(0, 20).join(', ')}`);
      if (empty.length) console.error(`  empty: ${empty.slice(0, 20).join(', ')}`);
      if (placeholderMismatches.length) {
        console.error(
          `  placeholder mismatches: ${placeholderMismatches.slice(0, 20).join(', ')}`,
        );
      }
    }
  }
}

if (failed) process.exit(1);

console.log('Translation audit passed: all locale files have matching keys and placeholders.');
