#!/usr/bin/env node
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

const root = resolve(process.argv[2] ?? 'test-results');
const outDir = resolve(process.argv[3] ?? join(root, 'allure-results'));

function walk(dir, files = []) {
  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, files);
    else if (entry.isFile() && entry.name.endsWith('.xml')) files.push(path);
  }
  return files;
}

function decodeXml(value = '') {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function attrs(raw = '') {
  const result = {};
  for (const match of raw.matchAll(/([:\w.-]+)\s*=\s*"([^"]*)"/g)) {
    result[match[1]] = decodeXml(match[2]);
  }
  return result;
}

function stripTags(value = '') {
  // Decode entities first, then drop every tag (closing '>' optional, so an
  // unclosed '<tag' is removed too). Plain text for the Allure report.
  return decodeXml(value).replace(/<[^>]*>?/g, '').trim();
}

function statusFor(body) {
  if (/<skipped[\s/>]/.test(body)) return 'skipped';
  if (/<error[\s>]/.test(body)) return 'broken';
  if (/<failure[\s>]/.test(body)) return 'failed';
  return 'passed';
}

function statusDetails(body) {
  const match = body.match(/<(failure|error)([^>]*)>([\s\S]*?)<\/\1>/) || body.match(/<(failure|error)([^/>]*)\/>/);
  if (!match) return undefined;
  const detailAttrs = attrs(match[2] ?? '');
  const trace = stripTags(match[3] ?? '');
  return {
    message: detailAttrs.message || trace.split('\n')[0] || match[1],
    trace,
  };
}

function categoryFromPath(file) {
  const rel = file.slice(root.length).replace(/^[/\\]+/, '');
  return rel.split(/[\\/]/)[0] || basename(dirname(file));
}

function stableId(...parts) {
  return createHash('sha1').update(parts.join('\0')).digest('hex');
}

mkdirSync(outDir, { recursive: true });
const files = walk(root).filter((file) => !file.includes(`${outDir}/`));
let written = 0;

for (const file of files) {
  const xml = readFileSync(file, 'utf8');
  const category = categoryFromPath(file);
  const mtime = statSync(file).mtimeMs;

  for (const match of xml.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const testAttrs = attrs(match[1] ?? '');
    const body = match[2] ?? '';
    const name = testAttrs.name || 'unnamed test';
    const className = testAttrs.classname || category;
    const fullName = `${className} ${name}`.trim();
    const durationMs = Math.max(0, Number(testAttrs.time ?? 0) * 1000);
    const stop = Math.round(mtime);
    const start = Math.max(0, Math.round(stop - durationMs));
    const id = stableId(category, className, name);
    const details = statusDetails(body);
    const uuid = randomUUID();
    const attachments = [];
    if (details?.trace) {
      const source = `${uuid}-failure.txt`;
      writeFileSync(join(outDir, source), `${details.trace}\n`);
      attachments.push({ name: 'Failure output', source, type: 'text/plain' });
    }
    const result = {
      uuid,
      historyId: id,
      testCaseId: id,
      name,
      fullName,
      status: statusFor(body),
      stage: 'finished',
      start,
      stop,
      labels: [
        { name: 'framework', value: 'junit' },
        { name: 'suite', value: category },
        { name: 'package', value: className },
      ],
      ...(attachments.length ? { attachments } : {}),
      ...(details ? { statusDetails: details } : {}),
    };
    writeFileSync(join(outDir, `${uuid}-result.json`), `${JSON.stringify(result, null, 2)}\n`);
    written += 1;
  }
}

// Environments tab: surface the run context (commit, branch, target, runner).
const env = process.env;
const envLines = Object.entries({
  Commit: (env.GITHUB_SHA ?? '').slice(0, 12),
  Branch: env.GITHUB_REF_NAME ?? '',
  Repository: env.GITHUB_REPOSITORY ?? '',
  Run: env.GITHUB_RUN_ID ? `${env.GITHUB_REPOSITORY ?? ''}#${env.GITHUB_RUN_ID}` : '',
  Target: env.QA_WEB_BASE_URL || env.KE2E_API_URL || 'local (no live target)',
  Node: process.version,
}).filter(([, v]) => v);
if (envLines.length) {
  writeFileSync(join(outDir, 'environment.properties'), `${envLines.map(([k, v]) => `${k}=${v}`).join('\n')}\n`);
}

// Defect categories: split real product failures from broken/skipped.
writeFileSync(
  join(outDir, 'categories.json'),
  `${JSON.stringify(
    [
      { name: 'Product defects', matchedStatuses: ['failed'] },
      { name: 'Broken tests', matchedStatuses: ['broken'] },
      { name: 'Skipped', matchedStatuses: ['skipped'] },
    ],
    null,
    2,
  )}\n`,
);

console.log(`junit-to-allure: wrote ${written} result(s) from ${files.length} JUnit file(s) -> ${outDir}`);
