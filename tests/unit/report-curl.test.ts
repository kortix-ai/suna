import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { writeResults } from '../src/core/report';
import type { RunResult } from '../src/core/result';

type Req = { method: string; url: string; headers: Record<string, string>; body?: string };

/** The report's own copy-curl builder, lifted out of the inline script it ships in. */
function reportCurlOf(): (r: { req: Req }) => string {
  const dir = mkdtempSync(resolve(tmpdir(), 'ke2e-report-'));
  const htmlPath = resolve(dir, 'report.html');
  const result = {
    target: 'local',
    apiUrl: 'http://localhost:8008/v1',
    flows: [],
    summary: { total: 0, passed: 0, failed: 0, skipped: 0, todo: 0, durationMs: 0 },
  } as unknown as RunResult;
  writeResults(result, resolve(dir, 'results.json'), htmlPath);
  const html = readFileSync(htmlPath, 'utf8');
  const helpers = html.match(/^const shq = .*$/m)?.[0] ?? '';
  const curlOf = html.match(/^function curlOf\(r\)\{[\s\S]*?^\}$/m)?.[0];
  if (!curlOf) throw new Error('report.html has no curlOf');
  return new Function(`${helpers}\n${curlOf}\nreturn curlOf;`)();
}

/** Runs the copied command with `curl` stubbed to print its argv. */
function argvOf(command: string): string[] {
  const out = execFileSync('bash', ['-c', `curl() { printf '%s\\0' "$@"; }\n${command}`], { encoding: 'utf8' });
  return out.split('\0').slice(0, -1);
}

describe('the report copy-curl command', () => {
  const curlOf = reportCurlOf();

  it('round-trips a plain request', () => {
    const req = { method: 'GET', url: 'http://x/v1/health', headers: { accept: 'application/json' } };
    expect(argvOf(curlOf({ req }))).toEqual(['-X', 'GET', req.url, '-H', 'accept: application/json']);
  });

  // KRTX-2668: a single quote in the URL, a header or the body ended the
  // quoted word, so the copied command was invalid shell.
  it('round-trips single quotes in the URL, a header and the body', () => {
    const req = {
      method: 'POST',
      url: "http://x/v1/search?q=it's",
      headers: { 'x-note': "it's 'quoted'" },
      body: `{"text":"it's","sql":"a='b'"}`,
    };
    expect(argvOf(curlOf({ req }))).toEqual([
      '-X', 'POST', req.url, '-H', "x-note: it's 'quoted'", '-d', req.body,
    ]);
  });
});
